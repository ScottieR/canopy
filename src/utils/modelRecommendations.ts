export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  strategy: string;
  description: string;
};

const ULTRA_ROLES = new Set([
  "Architect",
  "Coder",
  "Data Analyst",
  "Engineer",
  "Financial",
  "Investment Manager",
  "Researcher",
  "Strategist",
]);

const HEAVY_ROLES = new Set([
  ...ULTRA_ROLES,
  "Accountant",
  "Analyst",
  "Business Strategist",
]);

const PROVIDER_PREFERENCES: Record<string, Record<"ultra" | "heavy" | "light", string[]>> = {
  "Anthropic": {
    ultra: [
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
    ],
    heavy: [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
    ],
    light: [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
    ],
  },
  "OpenAI": {
    ultra: [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ],
    heavy: [
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
    ],
    light: [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
    ],
  },
  "Google Gemini": {
    ultra: [
      "google/gemini-3.6-flash",
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash-lite",
    ],
    heavy: [
      "google/gemini-3.6-flash",
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash-lite",
    ],
    light: [
      "google/gemini-3.5-flash-lite",
      "google/gemini-3.6-flash",
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
    ],
  },
  "xAI": {
    ultra: ["xai/grok-4.5"],
    heavy: ["xai/grok-4.5"],
    light: ["xai/grok-4.5"],
  },
};

const GLOBAL_PROVIDER_ORDER: Record<"ultra" | "heavy" | "light", string[]> = {
  ultra: ["Anthropic", "OpenAI", "Google Gemini", "xAI"],
  heavy: ["Anthropic", "OpenAI", "Google Gemini", "xAI"],
  light: ["Anthropic", "OpenAI", "Google Gemini", "xAI"],
};

const FALLBACK_MODELS: Record<string, ModelInfo> = {
  "Anthropic": {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "Anthropic",
    strategy: "heavy",
    description: "Best balance for most production work",
  },
  "OpenAI": {
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "OpenAI",
    strategy: "heavy",
    description: "Balances intelligence and cost",
  },
  "Google Gemini": {
    id: "google/gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    provider: "Google Gemini",
    strategy: "heavy",
    description: "Latest GA Flash model for agentic work",
  },
  "xAI": {
    id: "xai/grok-4.5",
    name: "Grok 4.5",
    provider: "xAI",
    strategy: "heavy",
    description: "Latest xAI flagship",
  },
};

export function normalizeProviderName(provider: string): string {
  return provider === "xAI Grok" ? "xAI" : provider;
}

function getRoleTier(role: string): "ultra" | "heavy" | "light" {
  if (ULTRA_ROLES.has(role)) return "ultra";
  if (HEAVY_ROLES.has(role)) return "heavy";
  return "light";
}

function getStrategyForTier(tier: "ultra" | "heavy" | "light"): "heavy" | "light" {
  return tier === "light" ? "light" : "heavy";
}

function selectFromProvider(models: ModelInfo[], provider: string, role: string): ModelInfo | null {
  const tier = getRoleTier(role);
  const strategy = getStrategyForTier(tier);
  const providerModels = models.filter((model) => model.provider === provider);
  if (providerModels.length === 0) return null;

  const rankedIds = PROVIDER_PREFERENCES[provider]?.[tier] ?? [];
  for (const id of rankedIds) {
    const match = providerModels.find((model) => model.id === id);
    if (match) return match;
  }

  return (
    providerModels.find((model) => model.strategy === strategy) ??
    providerModels[0] ??
    null
  );
}

export function getRecommendedModel(
  models: ModelInfo[] | null | undefined,
  role: string,
  preferredProvider?: string,
): ModelInfo {
  // The models catalog is loaded from the control plane and can be null while
  // loading or if the fetch failed — never crash the caller over that.
  const catalog = Array.isArray(models) ? models : [];
  const normalizedProvider = preferredProvider ? normalizeProviderName(preferredProvider) : "";
  const tier = getRoleTier(role);
  const strategy = getStrategyForTier(tier);

  if (normalizedProvider) {
    const match = selectFromProvider(catalog, normalizedProvider, role);
    if (match) return match;
    return FALLBACK_MODELS[normalizedProvider] ?? FALLBACK_MODELS["Anthropic"];
  }

  for (const provider of GLOBAL_PROVIDER_ORDER[tier]) {
    const match = selectFromProvider(catalog, provider, role);
    if (match) return match;
  }

  return (
    catalog.find((model) => model.strategy === strategy) ??
    catalog[0] ??
    FALLBACK_MODELS["Anthropic"]
  );
}

export function formatRecommendedModel(model: ModelInfo): string {
  return `${model.name} — ${model.description}`;
}
