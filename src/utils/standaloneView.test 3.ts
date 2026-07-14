import { describe, expect, it } from "vitest";

import { resolveStandaloneViewKind } from "./standaloneView";

describe("resolveStandaloneViewKind", () => {
  it("routes figma companions to the dedicated figma window", () => {
    expect(
      resolveStandaloneViewKind({
        miniappPayload: null,
        genuiPayload: null,
        browserAgentId: null,
        chatCompanionAgentId: null,
        companionType: "figma",
      })
    ).toBe("figma");
  });

  it("falls back to the generic companion guide for unknown companion types", () => {
    expect(
      resolveStandaloneViewKind({
        miniappPayload: null,
        genuiPayload: null,
        browserAgentId: null,
        chatCompanionAgentId: null,
        companionType: "custom-plugin",
      })
    ).toBe("companionGuide");
  });

  it("prioritizes specialized popout payloads ahead of companion routing", () => {
    expect(
      resolveStandaloneViewKind({
        miniappPayload: "%7B%7D",
        genuiPayload: null,
        browserAgentId: null,
        chatCompanionAgentId: null,
        companionType: "github",
      })
    ).toBe("miniapp");
  });
});
