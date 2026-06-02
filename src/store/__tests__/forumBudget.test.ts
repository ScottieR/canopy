import { describe, expect, it } from "vitest";
import { applyForumBudgetIncrement } from "../forumBudget";

const baseBudget = {
  tokenLimit: 1000,
  tokensUsed: 100,
  usdLimit: 1,
  usdUsed: 0.25,
  circuitBreakerFired: false,
};

describe("applyForumBudgetIncrement", () => {
  it("updates aggregate totals and trust budget usage together", () => {
    const next = applyForumBudgetIncrement(
      {
        totalTokens: 50,
        totalCost: 0.1,
        trustBudget: baseBudget,
      },
      200,
      0.2
    );

    expect(next.totalTokens).toBe(250);
    expect(next.totalCost).toBeCloseTo(0.3);
    expect(next.trustBudget.tokensUsed).toBe(300);
    expect(next.trustBudget.usdUsed).toBeCloseTo(0.45);
    expect(next.trustBudget.circuitBreakerFired).toBe(false);
  });

  it("fires when usd limit is reached", () => {
    expect(
      applyForumBudgetIncrement(
        { trustBudget: baseBudget },
        0,
        0.75
      ).trustBudget.circuitBreakerFired
    ).toBe(true);
  });
});
