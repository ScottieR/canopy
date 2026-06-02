import { beforeEach, describe, expect, it } from "vitest";
import { useForumStore, type ForumAgent } from "../forumStore";

const agent: ForumAgent = {
  agentId: "agent-alpha",
  name: "Alpha",
  role: "Research",
  robeColor: "#123456",
  accentColor: "#abcdef",
  confidence: 90,
  forumRole: "Research and synthesis",
};

describe("Forum trust budget regression coverage", () => {
  beforeEach(() => {
    useForumStore.setState({ forums: [], activeForumId: null });
  });

  it("keeps aggregate totals and trust budget usage in sync", () => {
    const id = useForumStore.getState().createForum("Prepare a launch plan", [agent], ["planning"]);

    useForumStore.getState().incrementTokensAndCost(id, 1200, 0.42);
    useForumStore.getState().incrementTokensAndCost(id, 800, 0.18);

    const forum = useForumStore.getState().forums.find((candidate) => candidate.id === id);
    expect(forum?.totalTokens).toBe(2000);
    expect(forum?.totalCost).toBeCloseTo(0.6);
    expect(forum?.trustBudget.tokensUsed).toBe(2000);
    expect(forum?.trustBudget.usdUsed).toBeCloseTo(0.6);
    expect(forum?.trustBudget.circuitBreakerFired).toBe(false);
  });

  it("fires the circuit breaker when spend limits are reached", () => {
    const id = useForumStore.getState().createForum("Model cost stress test", [agent], ["budget"]);

    useForumStore.getState().updateTrustBudget(id, {
      usdLimit: 1,
    });
    useForumStore.getState().incrementTokensAndCost(id, 100, 1.25);

    let forum = useForumStore.getState().forums.find((candidate) => candidate.id === id);
    expect(forum?.trustBudget.circuitBreakerFired).toBe(true);
  });
});
