import { describe, expect, it } from "vitest";

import { detectTaskPreflightGaps } from "./taskPreflight";

// The exact CUJ message that surfaced this feature (2026-08-24): find a school
// email, log into a portal, download forms, email the pediatrician.
const CUJ_MESSAGE =
  "Hi Sloane - The Willows emailed me about two health forms our kids need on file. " +
  "Can you: 1) find that email in my inbox for the details, 2) log into my Veracross parent portal " +
  "and open Magnus Health from there, 3) download the two required health forms, and " +
  "4) email them to our pediatrician's office asking them to fill them out and send them back?";

describe("detectTaskPreflightGaps", () => {
  it("flags email sending and dead browser for the original CUJ message (Sloane's config)", () => {
    const gaps = detectTaskPreflightGaps(CUJ_MESSAGE, {
      capabilities: { browser: true },
      integrations: ["email_read", "imessage", "drive_write"],
      browser_status: { is_running: false },
    });
    const keys = gaps.map(g => g.key);
    expect(keys).toContain("email_write");
    expect(keys).toContain("browser_down");
  });

  it("is quiet when the agent has everything the task needs", () => {
    const gaps = detectTaskPreflightGaps(CUJ_MESSAGE, {
      capabilities: { browser: true },
      integrations: ["email_read", "email_write"],
      browser_status: { is_running: true },
    });
    expect(gaps).toEqual([]);
  });

  it("flags missing email access entirely when neither read nor write is connected", () => {
    const gaps = detectTaskPreflightGaps("Check my inbox for the invoice", {
      capabilities: {},
      integrations: [],
    });
    expect(gaps.map(g => g.key)).toEqual(["email_read"]);
  });

  it("flags browsing capability off for portal tasks", () => {
    const gaps = detectTaskPreflightGaps("Log into my bank portal and download the statement", {
      capabilities: { browser: false },
      integrations: [],
    });
    expect(gaps.map(g => g.key)).toContain("browser");
  });

  it("does not warn about a stopped browser when browser_status is unknown", () => {
    const gaps = detectTaskPreflightGaps("Open the website and summarize it", {
      capabilities: { browser: true },
      integrations: [],
      browser_status: null,
    });
    expect(gaps).toEqual([]);
  });

  it("stays quiet for chatty messages that need nothing", () => {
    expect(
      detectTaskPreflightGaps("What kind of things should I bring to you?", {
        capabilities: {},
        integrations: [],
      })
    ).toEqual([]);
  });

  it("flags slack and calendar mentions without the integrations", () => {
    expect(
      detectTaskPreflightGaps("Post the summary to slack", { capabilities: {}, integrations: [] }).map(g => g.key)
    ).toEqual(["slack"]);
    expect(
      detectTaskPreflightGaps("Schedule a meeting with the teacher", { capabilities: {}, integrations: [] }).map(g => g.key)
    ).toEqual(["calendar"]);
  });
});
