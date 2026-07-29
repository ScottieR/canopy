import { describe, expect, it } from "vitest";

import {
  composeSetupConversationPrompt,
  getEnabledConnectionIds,
  getNextUnlockForRole,
  getRosterCoverageRoles,
  getRosterGapSuggestions,
  getRosterGapSuggestionDetails,
  getCollaboratorSuggestions,
} from "./agentSetupRecommendations";

describe("getEnabledConnectionIds", () => {
  it("normalizes stored integration aliases into connection recommendations", () => {
    expect(getEnabledConnectionIds({
      enabledIntegrations: ["email_read", "calendar_write", "apple_photos"],
      enabledPermissions: ["file_read"],
    })).toEqual(expect.arrayContaining(["email", "calendar", "photos", "folders"]));
  });
});

describe("getNextUnlockForRole", () => {
  it("recommends the next missing connection before permissions for most roles", () => {
    expect(getNextUnlockForRole("Assistant", {
      enabledIntegrations: ["email_read"],
      enabledPermissions: ["scheduled"],
      isolated: false,
    })).toMatchObject({ kind: "connection", id: "calendar" });
  });

  it("recommends isolation first for sensitive accountant workflows", () => {
    expect(getNextUnlockForRole("Accountant", {
      enabledIntegrations: ["email_read", "slack"],
      enabledPermissions: ["file_read", "scheduled"],
      isolated: false,
    })).toMatchObject({ kind: "workspace", id: "isolated" });
  });
});

describe("composeSetupConversationPrompt", () => {
  it("asks for a single concrete next unlock in the agent's first message", () => {
    const prompt = composeSetupConversationPrompt({
      agentName: "Atlas",
      role: "Researcher",
      userNeed: "I need fast market scans.",
      state: {
        enabledIntegrations: ["slack"],
        enabledPermissions: ["memory_write"],
        isolated: false,
      },
    });

    expect(prompt).toContain("Atlas");
    expect(prompt).toContain("I need fast market scans.");
    expect(prompt).toContain("ask for ONE concrete next unlock");
  });
});

describe("roster-aware suggestions", () => {
  it("surfaces missing core roles first", () => {
    const roles = getRosterGapSuggestions(
      [{ name: "Atlas", role: "Researcher" }],
      {
        Assistant: { description: "Calendar, email & logistics" },
        Researcher: { description: "Deep dives and sources" },
        Coder: { description: "Writes code and fixes bugs" },
        Strategist: { description: "Decision memos and planning" },
        Custom: {},
      },
    );

    expect(roles[0]).toBe("Assistant");
    expect(roles).not.toContain("Researcher");
  });

  it("counts imported custom agents toward roster coverage when their description clearly matches a known role", () => {
    const coverage = getRosterCoverageRoles(
      [{ name: "Sloane", role: "Custom", description: "Calendar, inbox, scheduling, and logistics support" }],
      {
        Assistant: { description: "Calendar, email & logistics" },
        Researcher: { description: "Deep dives and sources" },
        Coder: { description: "Writes code and fixes bugs" },
        Strategist: { description: "Decision memos and planning" },
        Custom: {},
      },
    );

    expect(coverage).toContain("Assistant");
  });

  it("returns hover-friendly why text for team-gap suggestions", () => {
    const suggestions = getRosterGapSuggestionDetails(
      [{ name: "Atlas", role: "Researcher" }],
      {
        Assistant: { description: "Calendar, email & logistics" },
        Researcher: { description: "Deep dives and sources" },
        Strategist: { description: "Decision memos and planning" },
        Custom: {},
      },
      1,
    );

    expect(suggestions[0]).toMatchObject({
      role: "Assistant",
      label: "Keep things from slipping",
    });
    expect(suggestions[0]?.reason).toContain("nobody on your current team");
  });

  it("finds likely collaborator pairings for the drafted role", () => {
    const suggestions = getCollaboratorSuggestions("Coder", [
      { name: "Atlas", role: "Researcher" },
      { name: "Marlowe", role: "Strategist" },
    ]);

    expect(suggestions).toEqual([
      { name: "Atlas", role: "Researcher", reason: "scope and verify before building" },
      { name: "Marlowe", role: "Strategist", reason: "tie shipping work to the bigger plan" },
    ]);
  });
});
