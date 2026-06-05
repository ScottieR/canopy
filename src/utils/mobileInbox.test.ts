import { describe, expect, it } from "vitest";
import { deriveMobileInboxEffects } from "./mobileInbox";
import type { InboxItem } from "../store/worldStore";

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox_1",
    type: "voice_note",
    content: "Remember to follow up",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("deriveMobileInboxEffects", () => {
  it("routes approved voice notes into a project space when an agent is available", () => {
    const effects = deriveMobileInboxEffects({
      item: makeInboxItem({ type: "voice_note" }),
      resolution: "approved",
      fallbackAgentId: "agent_researcher",
    });

    expect(effects).toEqual({
      removeId: "inbox_1",
      createForumForAgentId: "agent_researcher",
      navigateToCanopy: true,
    });
  });

  it("does not create a project space for non-voice approvals", () => {
    const effects = deriveMobileInboxEffects({
      item: makeInboxItem({ type: "agent_request" }),
      resolution: "approved",
      fallbackAgentId: "agent_assistant",
    });

    expect(effects).toEqual({
      removeId: "inbox_1",
    });
  });

  it("treats dismissals as remove-only", () => {
    const effects = deriveMobileInboxEffects({
      item: makeInboxItem(),
      resolution: "dismissed",
      fallbackAgentId: "agent_assistant",
    });

    expect(effects).toEqual({
      removeId: "inbox_1",
    });
  });
});
