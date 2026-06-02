import type { TrustBudget } from "./forumStore";

export interface ForumBudgetTotals {
  totalTokens?: number;
  totalCost?: number;
  trustBudget: TrustBudget;
}

export function applyForumBudgetIncrement(
  current: ForumBudgetTotals,
  tokens: number,
  cost: number
): ForumBudgetTotals {
  const tokensUsed = (current.trustBudget?.tokensUsed || 0) + tokens;
  const usdUsed = (current.trustBudget?.usdUsed || 0) + cost;
  const usdLimit = current.trustBudget?.usdLimit || Infinity;

  return {
    totalTokens: (current.totalTokens || 0) + tokens,
    totalCost: (current.totalCost || 0) + cost,
    trustBudget: {
      ...current.trustBudget,
      tokensUsed,
      usdUsed,
      circuitBreakerFired: usdUsed >= usdLimit,
    },
  };
}
