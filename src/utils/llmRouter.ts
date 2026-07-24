export interface RouteRequest {
  query: string;
  contextLength: number;
  costLimit?: number;
  latencyBudgetMs?: number;
}

export interface RouteResponse {
  modelId: string;
  provider: string;
  confidenceScore: number;
  reason: string;
}

/**
 * Intelligent Dynamic Model Router
 * Evaluates a request and dynamically selects the optimal model 
 * based on predictive complexity scoring and cost/latency budgets.
 */
export class LLMRouter {
  private static readonly MODELS = {
    FAST: { id: 'gemini-3.5-flash', provider: 'google', costPer1M: 1.31, latency: 'fast' },
    BALANCED: { id: 'claude-haiku-4.5', provider: 'anthropic', costPer1M: 1.50, latency: 'fast' },
    HEAVY: { id: 'claude-opus-4.7', provider: 'anthropic', costPer1M: 4.10, latency: 'slow' },
    COMPLEX: { id: 'gemini-3.5-pro', provider: 'google', costPer1M: 3.50, latency: 'medium' }
  };

  /**
   * Predicts complexity based on query heuristics and context length.
   * A real implementation would use a lightweight classifier/embedder.
   */
  private static calculateComplexityScore(req: RouteRequest): number {
    let score = 0;
    // Base score from context length
    score += req.contextLength / 1000;
    
    // Keyword heuristics indicating architectural/heavy tasks
    const complexKeywords = ['architecture', 'refactor', 'design pattern', 'system', 'analyze', 'evaluate'];
    const queryLower = req.query.toLowerCase();
    for (const kw of complexKeywords) {
      if (queryLower.includes(kw)) {
        score += 3;
      }
    }
    
    return Math.min(score, 10); // 0-10 scale
  }

  public static route(req: RouteRequest): RouteResponse {
    const score = this.calculateComplexityScore(req);

    // Cascading selection logic
    if (score > 7) {
      // Heavy architecture or deep logic refactoring
      if (req.costLimit && req.costLimit < this.MODELS.HEAVY.costPer1M) {
        // Fallback to Pro if budget is tight
        return {
          modelId: this.MODELS.COMPLEX.id,
          provider: this.MODELS.COMPLEX.provider,
          confidenceScore: 0.85,
          reason: 'High complexity but constrained budget'
        };
      }
      return {
        modelId: this.MODELS.HEAVY.id,
        provider: this.MODELS.HEAVY.provider,
        confidenceScore: 0.95,
        reason: 'High complexity task requires heavy reasoning'
      };
    } else if (score > 4) {
      return {
        modelId: this.MODELS.COMPLEX.id,
        provider: this.MODELS.COMPLEX.provider,
        confidenceScore: 0.88,
        reason: 'Moderate complexity, using balanced capable model'
      };
    } else {
      // Simple task, favor speed and cost
      if (req.latencyBudgetMs && req.latencyBudgetMs < 2000) {
         return {
          modelId: this.MODELS.FAST.id,
          provider: this.MODELS.FAST.provider,
          confidenceScore: 0.92,
          reason: 'Low complexity with strict latency budget'
        };
      }
      return {
        modelId: this.MODELS.BALANCED.id,
        provider: this.MODELS.BALANCED.provider,
        confidenceScore: 0.9,
        reason: 'Low complexity, default fast model'
      };
    }
  }
}
