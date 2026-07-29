import { describe, expect, it } from "vitest";

import {
  buildInterviewMessage,
  fallbackOpeningQuestion,
  mergeIdentityNotes,
  parseInterviewReply,
} from "./draftInterview";

describe("parseInterviewReply", () => {
  it("parses a valid reply", () => {
    const r = parseInterviewReply(`{"say":"Which subjects?","identity_notes":"You are tutoring three boys.","done":false}`);
    expect(r.say).toBe("Which subjects?");
    expect(r.identityNotes).toBe("You are tutoring three boys.");
    expect(r.done).toBe(false);
  });

  it("handles code fences and null notes", () => {
    const r = parseInterviewReply("```json\n{\"say\":\"Great, we're set.\",\"identity_notes\":null,\"done\":true}\n```");
    expect(r.say).toBe("Great, we're set.");
    expect(r.identityNotes).toBeNull();
    expect(r.done).toBe(true);
  });

  it("degrades unparseable replies to plain conversation", () => {
    const r = parseInterviewReply("Sure — which subjects are the boys working on?");
    expect(r.say).toContain("which subjects");
    expect(r.identityNotes).toBeNull();
    expect(r.done).toBe(false);
  });
});

describe("mergeIdentityNotes", () => {
  const base = "You are Hastings, a patient tutor.";

  it("creates the section on first merge", () => {
    const merged = mergeIdentityNotes(base, "You are tutoring Jack, Hastings, and Brooks.");
    expect(merged).toContain("What you know about your human:");
    expect(merged).toContain("- You are tutoring Jack, Hastings, and Brooks.");
  });

  it("appends without duplicating and stays bounded", () => {
    let p = base;
    for (let i = 0; i < 10; i++) p = mergeIdentityNotes(p, `Fact number ${i}.`);
    p = mergeIdentityNotes(p, "Fact number 9."); // exact duplicate
    const bullets = p.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBeLessThanOrEqual(6);
    expect(p.match(/Fact number 9\./g)!.length).toBe(1);
  });
});

describe("buildInterviewMessage", () => {
  it("stays under the helper cap with maximal inputs", () => {
    const message = buildInterviewMessage({
      agentName: "Hastings",
      roleTitle: "Tutor",
      personality: "x".repeat(5000),
      discoveryInput: "y".repeat(2000),
      transcript: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "user" as const : "agent" as const, text: "z".repeat(500) })),
      userMessage: "w".repeat(1000),
      questionsAsked: 1,
    });
    expect(message.length).toBeLessThanOrEqual(3800);
    expect(message.startsWith("AGENT SESSION:")).toBe(true);
  });
});

describe("fallbackOpeningQuestion", () => {
  it("references the user's own words when present", () => {
    expect(fallbackOpeningQuestion("Hastings", "Tutor", "tutor my three boys")).toContain("tutor my three boys");
  });
  it("draws out the need when there's no seed", () => {
    expect(fallbackOpeningQuestion("Fern", "Assistant", "")).toContain("hand off");
  });
});
