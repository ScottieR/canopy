// Dequeue decision for chat messages queued while the agent was busy or waking.
//
// Extracted from ChatTab's flush effect after the PR #72 review caught a silent
// drop: a "same"-thread queued message with a null sessionId (brand-new
// conversation — exactly the first-message flow) passed the old
// `nextMsg.sessionId && isSessionLoading(nextMsg.sessionId)` hold check while
// the first send was still in flight, got popped, and then died on
// handleSendMessage's loading guard — after it had already left the queue.
//
// The rule: a "same"-thread message may only leave the queue when the session
// it will actually send into — its own recorded session, or failing that the
// conversation that is active at flush time — is not mid-run. "new"-thread
// messages always dequeue; they create their own session.

export interface QueuedMessageLike {
  threadMode: "same" | "new";
  sessionId?: string | null;
}

export function shouldDequeueQueuedMessage(
  next: QueuedMessageLike,
  activeConversationId: string | null,
  isSessionLoading: (sessionId?: string | null) => boolean
): boolean {
  if (next.threadMode === "new") return true;
  const targetSession = next.sessionId || activeConversationId;
  if (!targetSession) return true;
  return !isSessionLoading(targetSession);
}
