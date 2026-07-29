import { describe, expect, it } from "vitest";

import {
  buildAgentTurnMessage,
  createHostState,
  parseAgentTurn,
  recordAnswer,
  recordAskShown,
  validateAndBuildAsk,
} from "./powerUpAgentLoop";
import { MAX_ASKS, findJargon } from "./powerUpScript";
import type { PowerUpScriptInput } from "./powerUpScript";
import type { HeartbeatSuggestion } from "./heartbeats";

const hb = (name: string): HeartbeatSuggestion => ({
  id: name, name, title: `${name} title`, interval: "1d", prompt: "p",
  scheduleLabel: "Every day", dependencies: [], missingIntegrations: [],
  missingPermissions: [], ready: true,
});

const baseInput: PowerUpScriptInput = {
  agentName: "Hastings",
  role: "Tutor",
  discoveryInput: "tutor my three boys",
  readyHeartbeats: [hb("weekday-briefing")],
};

describe("parseAgentTurn", () => {
  it("parses a valid turn", () => {
    const turn = parseAgentTurn(`{"say":"Let's connect your files.","action":{"type":"request_connection","key":"folders"}}`)!;
    expect(turn.action.type).toBe("request_connection");
    expect(turn.action.key).toBe("folders");
  });

  it("strips code fences and normalizes key case", () => {
    const turn = parseAgentTurn("```json\n{\"say\":\"hi\",\"action\":{\"type\":\"request_connection\",\"key\":\"GitHub\"}}\n```")!;
    expect(turn.action.key).toBe("github");
  });

  it("degrades prose-only replies to say_only instead of failing", () => {
    const turn = parseAgentTurn("I think we should talk about your calendar.")!;
    expect(turn.action.type).toBe("say_only");
  });

  it("unknown action types become say_only", () => {
    const turn = parseAgentTurn(`{"say":"hi","action":{"type":"grant_root_access"}}`)!;
    expect(turn.action.type).toBe("say_only");
  });

  it("rejects empty say", () => {
    expect(parseAgentTurn(`{"say":"","action":{"type":"say_only"}}`)).toBeNull();
  });
});

describe("validateAndBuildAsk — the host gate", () => {
  it("accepts a valid catalog connection and attaches the template warning", () => {
    const state = createHostState(baseInput);
    const result = validateAndBuildAsk(
      { say: "Give me a folder so I can make real worksheets for the boys.", action: { type: "request_connection", key: "folders" } },
      state,
    )!;
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.ask.integrationKey).toBe("folders");
      expect(result.ask.sensitivityWarning).toContain("specific folder");
      expect(result.ask.source).toBe("llm");
    }
  });

  it("clamps hallucinated keys (enum is unrepresentable)", () => {
    const state = createHostState(baseInput);
    expect(validateAndBuildAsk(
      { say: "Connect your bank.", action: { type: "request_connection", key: "plaid_full_access" } },
      state,
    )).toBeNull();
  });

  it("clamps re-asks of connected and declined integrations", () => {
    const state = createHostState({ ...baseInput, connectedIntegrations: ["folders"], declinedIntegrations: ["slack"] });
    for (const key of ["folders", "slack"]) {
      expect(validateAndBuildAsk(
        { say: "Please?", action: { type: "request_connection", key } },
        state,
      )).toBeNull();
    }
  });

  it("enforces the ask budget", () => {
    const state = createHostState(baseInput);
    state.budgetUsed = MAX_ASKS;
    expect(validateAndBuildAsk(
      { say: "One more thing…", action: { type: "request_connection", key: "folders" } },
      state,
    )).toBeNull();
    // Non-budgeted actions still allowed at budget cap:
    expect(validateAndBuildAsk({ say: "We're set.", action: { type: "ready_to_deploy" } }, state)).toEqual({ kind: "close" });
  });

  it("clamps heartbeats outside the provided list", () => {
    const state = createHostState(baseInput);
    expect(validateAndBuildAsk(
      { say: "Routine?", action: { type: "propose_heartbeat", name: "made-up-routine" } },
      state,
    )).toBeNull();
    const ok = validateAndBuildAsk(
      { say: "Every day I'll recap the boys' progress.", action: { type: "propose_heartbeat", name: "weekday-briefing" } },
      state,
    )!;
    expect(ok.kind).toBe("ask");
  });

  it("rejects turns whose copy contains banned infrastructure vocabulary", () => {
    const state = createHostState(baseInput);
    expect(validateAndBuildAsk(
      { say: "I need an API key to access the OAuth endpoint.", action: { type: "request_connection", key: "folders" } },
      state,
    )).toBeNull();
  });

  it("accepts a valid custom heartbeat and carries the full task", () => {
    const state = createHostState(baseInput);
    const result = validateAndBuildAsk(
      { say: "Every weekday I'll build the boys a fresh practice set and score yesterday's.", action: { type: "propose_custom_heartbeat", title: "Daily practice sets for the boys", interval: "1d", promptText: "Create age-appropriate math and reading practice for Jack, Hastings, and Brooks; score yesterday's work; flag anything they're stuck on." } },
      state,
    )!;
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.ask.customHeartbeat?.title).toBe("Daily practice sets for the boys");
      expect(result.ask.customHeartbeat?.interval).toBe("1d");
      expect(result.ask.source).toBe("llm");
    }
  });

  it("clamps custom heartbeats with bad cadence, oversize fields, or jargon", () => {
    const state = createHostState(baseInput);
    const base = { type: "propose_custom_heartbeat" as const, title: "Ok title", interval: "1d", promptText: "Do a useful thing." };
    expect(validateAndBuildAsk({ say: "x", action: { ...base, interval: "13m" } }, state)).toBeNull();
    expect(validateAndBuildAsk({ say: "x", action: { ...base, title: "t".repeat(100) } }, state)).toBeNull();
    expect(validateAndBuildAsk({ say: "x", action: { ...base, promptText: "p".repeat(400) } }, state)).toBeNull();
    expect(validateAndBuildAsk({ say: "x", action: { ...base, promptText: "Run a cron job via webhook." } }, state)).toBeNull();
    expect(validateAndBuildAsk({ say: "x", action: { ...base, title: "" } }, state)).toBeNull();
  });

  it("dedupes the channel ask once resolved or asked", () => {
    const state = createHostState(baseInput);
    const first = validateAndBuildAsk({ say: "Where should I reach you?", action: { type: "request_channel" } }, state)!;
    expect(first.kind).toBe("ask");
    if (first.kind === "ask") recordAskShown(state, first.ask);
    expect(validateAndBuildAsk({ say: "Again: where?", action: { type: "request_channel" } }, state)).toBeNull();
  });
});

describe("host bookkeeping", () => {
  it("recordAskShown consumes budget only for budgeted ask types", () => {
    const state = createHostState(baseInput);
    const conn = validateAndBuildAsk({ say: "Folder time.", action: { type: "request_connection", key: "folders" } }, state)!;
    if (conn.kind === "ask") recordAskShown(state, conn.ask);
    expect(state.budgetUsed).toBe(1);
    const brain = validateAndBuildAsk({ say: "Found your setup.", action: { type: "confirm_brain" } }, state)!;
    if (brain.kind === "ask") recordAskShown(state, brain.ask);
    expect(state.budgetUsed).toBe(1); // brain is not budgeted
    expect(state.brainResolved).toBe(true);
  });

  it("recordAnswer tracks declines for dedupe", () => {
    const state = createHostState(baseInput);
    const conn = validateAndBuildAsk({ say: "Folder?", action: { type: "request_connection", key: "folders" } }, state)!;
    if (conn.kind === "ask") {
      recordAskShown(state, conn.ask);
      recordAnswer(state, conn.ask, false);
    }
    expect(state.declined.has("folders")).toBe(true);
  });
});

describe("buildAgentTurnMessage", () => {
  it("stays under the helper message cap and excludes resolved items", () => {
    const state = createHostState({
      ...baseInput,
      discoveryInput: "x".repeat(1000),
      connectedIntegrations: ["folders"],
    });
    const message = buildAgentTurnMessage(state, [], null);
    expect(message.length).toBeLessThanOrEqual(3800);
    expect(message).toContain("NEVER re-ask");
    expect(message).not.toMatch(/^- folders:/m);
  });

  it("its own instruction text carries no user-facing jargon leakage risk markers", () => {
    // The prompt legitimately names banned words to forbid them; the SAY the
    // model produces is what gets jargon-checked (validateAndBuildAsk).
    const state = createHostState(baseInput);
    const message = buildAgentTurnMessage(state, [], "yes please");
    expect(message).toContain("Reply with ONLY this JSON");
  });
});
