import { describe, expect, it } from "vitest";

import { shouldDequeueQueuedMessage } from "./messageQueue";

const loadingSessions = (ids: string[]) => (sessionId?: string | null) =>
  !!sessionId && ids.includes(sessionId);

describe("shouldDequeueQueuedMessage", () => {
  it("holds a null-session 'same' message while the active conversation is loading (PR #72 drop bug)", () => {
    // Brand-new conversation: the queued message recorded sessionId null, the
    // first send is in flight on the now-active conversation. The old check
    // dequeued this and the send guard silently dropped it.
    expect(
      shouldDequeueQueuedMessage(
        { threadMode: "same", sessionId: null },
        "conv_active",
        loadingSessions(["conv_active"])
      )
    ).toBe(false);
  });

  it("dequeues once the active conversation finishes loading", () => {
    expect(
      shouldDequeueQueuedMessage(
        { threadMode: "same", sessionId: null },
        "conv_active",
        loadingSessions([])
      )
    ).toBe(true);
  });

  it("holds on the message's own recorded session when set", () => {
    expect(
      shouldDequeueQueuedMessage(
        { threadMode: "same", sessionId: "conv_a" },
        "conv_b",
        loadingSessions(["conv_a"])
      )
    ).toBe(false);
    expect(
      shouldDequeueQueuedMessage(
        { threadMode: "same", sessionId: "conv_a" },
        "conv_b",
        loadingSessions(["conv_b"])
      )
    ).toBe(true);
  });

  it("always dequeues 'new'-thread messages — they create their own session", () => {
    expect(
      shouldDequeueQueuedMessage(
        { threadMode: "new", sessionId: null },
        "conv_active",
        loadingSessions(["conv_active"])
      )
    ).toBe(true);
  });

  it("dequeues when there is no session anywhere to wait on", () => {
    expect(
      shouldDequeueQueuedMessage({ threadMode: "same", sessionId: null }, null, loadingSessions([]))
    ).toBe(true);
  });
});
