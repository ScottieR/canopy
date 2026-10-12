// app-analytics kit v8: shared by every app. Change it through the app-analytics skill, not by hand.
// The collector's half of this file (parseBatch, ownerMark) is in canopy-admin, where the kit's server
// files live: canopy-admin/analytics/collect.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { carriedDevice, manifestWithDevice, routePattern, trackedLink } from "./client";

const device = "0f8c2a51-7d3e-4b6a-9c1f-2e5d8a7b6c40";

describe("routePattern", () => {
  it("groups records by route", () => {
    expect(routePattern("/readings/0f8c2a51-7d3e-4b6a-9c1f-2e5d8a7b6c40")).toBe("/readings/[id]");
    expect(routePattern("/people/123")).toBe("/people/[id]");
    expect(routePattern("/cards/the-fool")).toBe("/cards/the-fool");
    expect(routePattern("/")).toBe("/");
    expect(routePattern("/chart/")).toBe("/chart");
  });
});

describe("trackedLink", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives a link its kind and its own id, ahead of the #fragment", () => {
    vi.stubGlobal("window", {});
    const link = trackedLink("reading", "https://app.example.com/r/abc?x=1&via=old#private-data");
    expect(link.id).toMatch(/^[a-z0-9]{10}$/);
    expect(link.url).toBe(`https://app.example.com/r/abc?x=1&via=reading&s=${link.id}#private-data`);
    expect(trackedLink("app", "https://app.example.com/").url).toMatch(/^https:\/\/app\.example\.com\/\?via=app&s=[a-z0-9]{10}$/);
    // A new id for every share
    expect(trackedLink("reading", "/r/abc").id).not.toBe(link.id);
  });

  it("leaves the id out where nothing is tracked", () => {
    // No window: the server, or a device that has opted out (removed here, since some apps test in a DOM)
    vi.stubGlobal("window", undefined);
    const link = trackedLink("daily", "/d/xyz#f");
    expect(link.id).toBeNull();
    expect(link.url).toBe("/d/xyz?via=daily#f");
  });
});

describe("carrying the device id", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  it("is taken on by storage that has no id yet: a Home Screen app's first launch, a backup opened somewhere new", () => {
    expect(carriedDevice(`?aid=${device.toUpperCase()}`, null)).toEqual({ carried: device, adopt: device, pending: null });
  });

  it("is held, not taken, where the browser already has a different id", () => {
    expect(carriedDevice(`?via=backup&aid=${device}`, other)).toEqual({ carried: device, adopt: null, pending: device });
  });

  it("changes nothing when it's the id already here, missing, or not an id", () => {
    expect(carriedDevice(`?aid=${device}`, device)).toEqual({ carried: device, adopt: null, pending: null });
    expect(carriedDevice("?via=app", other)).toEqual({ carried: null, adopt: null, pending: null });
    expect(carriedDevice("?aid=off", null)).toEqual({ carried: null, adopt: null, pending: null });
  });

  it("makes the address of this browser's own copy of the manifest", () => {
    const page = "https://app.example.com/readings/1?x=1#f";
    expect(manifestWithDevice("/manifest.webmanifest", page, device)).toBe(`/manifest.webmanifest?aid=${device}`);
    expect(manifestWithDevice("manifest.json?v=3", "https://app.example.com/", device)).toBe(`/manifest.json?v=3&aid=${device}`);
    // A browser that took on another id, and one that has since opted out
    expect(manifestWithDevice(`/manifest.webmanifest?aid=${other}`, page, device)).toBe(`/manifest.webmanifest?aid=${device}`);
    expect(manifestWithDevice(`/manifest.webmanifest?aid=${device}`, page, null)).toBe("/manifest.webmanifest?track=off");
    // Never sent to another origin
    expect(manifestWithDevice("https://cdn.example.net/manifest.json", page, device)).toBeNull();
  });

  it("travels in a link to yourself, and only there", () => {
    vi.stubGlobal("window", {});
    const backup = trackedLink("backup", "https://app.example.com/open#data", { self: true });
    expect(backup.url).toMatch(new RegExp(`^https://app\\.example\\.com/open\\?via=backup&s=${backup.id}&aid=[0-9a-f-]{36}#data$`));
    expect(trackedLink("reading", "https://app.example.com/r/abc").url).not.toContain("aid=");
    // The same device id every time
    const again = trackedLink("backup", "https://app.example.com/open", { self: true });
    expect(new URL(again.url).searchParams.get("aid")).toBe(new URL(backup.url).searchParams.get("aid"));
  });

  it("stays out of a link made where nothing is tracked", () => {
    vi.stubGlobal("window", undefined);
    expect(trackedLink("backup", "/open#data", { self: true }).url).toBe("/open?via=backup#data");
  });
});
