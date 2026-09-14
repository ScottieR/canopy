import { describe, expect, it } from "vitest";

import { deriveAgentDisplayStatus } from "./worldStore";

const base = { paused: false, status: "active" as const, conversations: [] as any[] };

describe("deriveAgentDisplayStatus", () => {
  it("reports working when any thread run is live, even if the health poll says sleeping", () => {
    const agent = {
      ...base,
      status: "sleeping" as const,
      conversations: [{ threadStatus: "running" }] as any[],
    };
    expect(deriveAgentDisplayStatus(agent, true).state).toBe("working");
  });

  it("does not report working from recent gateway activity when the run has failed", () => {
    // The 2026-08-24 CUJ desync: a run crashed, gateway activity was <60s old,
    // and the header claimed Thinking… beside a FAILED thread badge.
    const agent = {
      ...base,
      conversations: [{ threadStatus: "failed", activeRunCount: 0 }] as any[],
    };
    expect(deriveAgentDisplayStatus(agent, true).state).toBe("idle");
  });

  it("queued runs and nonzero activeRunCount both count as working", () => {
    expect(
      deriveAgentDisplayStatus({ ...base, conversations: [{ threadStatus: "queued" }] as any[] }, true).state
    ).toBe("working");
    expect(
      deriveAgentDisplayStatus({ ...base, conversations: [{ threadStatus: "idle", activeRunCount: 2 }] as any[] }, true).state
    ).toBe("working");
  });

  it("paused beats everything; waking beats runs; offline only without runs", () => {
    expect(
      deriveAgentDisplayStatus({ ...base, paused: true, conversations: [{ threadStatus: "running" }] as any[] }, true).state
    ).toBe("paused");
    expect(deriveAgentDisplayStatus(base, false).state).toBe("waking");
    expect(deriveAgentDisplayStatus({ ...base, status: "error" as const }, true).state).toBe("offline");
  });
});
