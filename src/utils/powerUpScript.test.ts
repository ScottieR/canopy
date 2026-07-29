import { describe, expect, it } from "vitest";

import {
  MAX_ASKS,
  buildMissionLines,
  buildPowerUpScript,
  findJargon,
  routeFreeTextToChip,
  skipReply,
} from "./powerUpScript";
import { POWER_UP_EVAL_CASES } from "./powerUpEvalCases";
import { sanitizeIntegrationKeys, isIntegrationKey, INTEGRATION_CATALOG } from "./integrationCatalog";

const BUDGETED = new Set(["channel", "connection", "heartbeat"]);

describe("integrationCatalog", () => {
  it("sanitizes unknown keys and preserves order", () => {
    expect(sanitizeIntegrationKeys(["GitHub", "neuralink", "folders", "github"])).toEqual(["github", "folders"]);
  });

  it("rejects non-catalog values", () => {
    expect(isIntegrationKey("custom_oauth")).toBe(false);
    expect(isIntegrationKey("slack")).toBe(true);
  });

  it("sensitive integrations carry template-owned warnings", () => {
    for (const key of ["imessage", "folders", "email", "github", "photos"]) {
      const entry = INTEGRATION_CATALOG.find(e => e.key === key)!;
      expect(entry.sensitivity, `${key} must have a sensitivity warning`).toBeTruthy();
    }
  });
});

describe("buildPowerUpScript — golden eval cases", () => {
  for (const evalCase of POWER_UP_EVAL_CASES) {
    it(`${evalCase.id}: ${evalCase.description}`, () => {
      const asks = buildPowerUpScript(evalCase.input);

      expect(asks.map(a => a.type)).toEqual(evalCase.expect.askTypeOrder);

      const connectionAsks = asks.filter(a => a.type === "connection");
      for (const ask of connectionAsks) {
        expect(evalCase.expect.allowedConnectionKeys).toContain(ask.integrationKey);
        if (evalCase.expect.connectionSource) {
          expect(ask.source).toBe(evalCase.expect.connectionSource);
        }
      }
      for (const forbidden of evalCase.expect.forbiddenConnectionKeys || []) {
        expect(connectionAsks.map(a => a.integrationKey)).not.toContain(forbidden);
      }

      const budgeted = asks.filter(a => BUDGETED.has(a.type));
      expect(budgeted.length).toBeLessThanOrEqual(evalCase.expect.maxAsks ?? MAX_ASKS);

      // Jargon ban across every user-facing string, every case.
      for (const ask of asks) {
        expect(findJargon(ask.message), `jargon in "${ask.id}": ${ask.message}`).toEqual([]);
        for (const chip of ask.chips) {
          expect(findJargon(chip.label)).toEqual([]);
        }
      }

      // Structural invariants: no mission monologue (July 28 — open by
      // doing), close last, close always has deploy.
      expect(asks[0].type).not.toBe("mission");
      expect(asks[asks.length - 1].type).toBe("close");
      expect(asks[asks.length - 1].chips.some(c => c.id === "deploy")).toBe(true);

      // Every non-close ask must be skippable or a pure confirmation.
      for (const ask of asks.slice(0, -1)) {
        const skippable = ask.chips.some(c => c.kind === "decline");
        const confirmation = ask.chips.length === 1 && ask.chips[0].kind === "accept";
        expect(skippable || confirmation, `${ask.id} must be skippable or a confirmation`).toBe(true);
      }

      // Connection asks carry the catalog's sensitivity warning verbatim when one exists.
      for (const ask of connectionAsks) {
        const entry = INTEGRATION_CATALOG.find(e => e.key === ask.integrationKey)!;
        expect(ask.sensitivityWarning).toBe(entry.sensitivity);
      }
    });
  }
});

describe("mission lines", () => {
  it("uses the user's own words when present", () => {
    const lines = buildMissionLines({
      agentName: "Hastings",
      role: "Tutor",
      discoveryInput: "tutor my three boys",
    });
    expect(lines[0]).toContain("tutor my three boys");
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("caps runaway discovery input", () => {
    const lines = buildMissionLines({
      agentName: "A",
      role: "Tutor",
      discoveryInput: "x".repeat(500),
    });
    expect(lines[0].length).toBeLessThan(200);
  });
});

describe("free-text routing", () => {
  const script = buildPowerUpScript({
    agentName: "Hastings",
    role: "Tutor",
    discoveryInput: "tutoring",
    readyHeartbeats: [],
  });
  const channelAsk = script.find(a => a.type === "channel")!;
  const connectionAsk = script.find(a => a.type === "connection")!;

  it("routes channel names", () => {
    expect(routeFreeTextToChip("telegram please", channelAsk)?.id).toBe("channel-telegram");
    expect(routeFreeTextToChip("send it to my phone", channelAsk)?.id).toBe("channel-mobile");
    expect(routeFreeTextToChip("we use slack at work", channelAsk)?.id).toBe("channel-slack");
  });

  it("routes yes/no", () => {
    expect(routeFreeTextToChip("sure, go ahead", connectionAsk)?.kind).toBe("accept");
    expect(routeFreeTextToChip("not now thanks", connectionAsk)?.kind).toBe("decline");
  });

  it("returns null on unmatched text (caller handles gracefully)", () => {
    expect(routeFreeTextToChip("what's your favorite color?", connectionAsk)).toBeNull();
  });

  it("skip replies never guilt-trip or contain jargon", () => {
    for (const ask of script) {
      expect(findJargon(skipReply(ask, "Hastings"))).toEqual([]);
    }
  });
});
