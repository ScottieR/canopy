// Remote-tunable onboarding knobs (the admin-console tuning loop).
//
// The admin Dashboard edits this config (canopy-admin /api/onboarding-config);
// clients fetch it at wizard mount. Every powerup telemetry event and eval
// report carries `config_variant`, so the funnel and the eval history can be
// compared per variant — tweak a knob in the admin, watch accept rates and
// eval results move. Fail-safe: unreachable admin → hard-coded defaults
// (identical to shipped behavior), cached last-known-good in localStorage.

export type OnboardingConfig = {
  /** Label that tags telemetry + eval reports. Change it when you change knobs. */
  variant: string;
  /** Budget for channel/connection/heartbeat asks in beat 3 (2–8). */
  maxAsks: number;
  /** Live agent loop on/off (off = deterministic script only). */
  liveAgentEnabled: boolean;
  /** Auto-advance pure confirmations (no "Let's go" clicks). */
  autoAdvanceConfirmations: boolean;
  notes?: string;
};

export const DEFAULT_ONBOARDING_CONFIG: OnboardingConfig = {
  variant: "default",
  maxAsks: 5,
  liveAgentEnabled: true,
  autoAdvanceConfirmations: true,
};

const CACHE_KEY = "canopy_onboarding_config";
const FETCH_TIMEOUT_MS = 3_000;

export function sanitizeOnboardingConfig(raw: unknown): OnboardingConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const maxAsks = Number(cfg.maxAsks);
  return {
    variant: typeof cfg.variant === "string" && cfg.variant.trim()
      ? cfg.variant.trim().slice(0, 40)
      : DEFAULT_ONBOARDING_CONFIG.variant,
    maxAsks: Number.isFinite(maxAsks)
      ? Math.min(8, Math.max(2, Math.round(maxAsks)))
      : DEFAULT_ONBOARDING_CONFIG.maxAsks,
    liveAgentEnabled: typeof cfg.liveAgentEnabled === "boolean"
      ? cfg.liveAgentEnabled
      : DEFAULT_ONBOARDING_CONFIG.liveAgentEnabled,
    autoAdvanceConfirmations: typeof cfg.autoAdvanceConfirmations === "boolean"
      ? cfg.autoAdvanceConfirmations
      : DEFAULT_ONBOARDING_CONFIG.autoAdvanceConfirmations,
    notes: typeof cfg.notes === "string" ? cfg.notes.slice(0, 500) : undefined,
  };
}

/** Synchronous read: cached last-known-good, else defaults. */
export function getOnboardingConfig(): OnboardingConfig {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) return sanitizeOnboardingConfig(JSON.parse(cached));
  } catch { /* fall through */ }
  return DEFAULT_ONBOARDING_CONFIG;
}

/** Background refresh; resolves the freshest config (or cache/defaults). */
export async function refreshOnboardingConfig(): Promise<OnboardingConfig> {
  const base = (import.meta as any).env?.VITE_API_URL || "http://localhost:3001";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${base}/api/onboarding-config`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return getOnboardingConfig();
    const config = sanitizeOnboardingConfig(await res.json());
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(config)); } catch { /* best-effort */ }
    return config;
  } catch {
    return getOnboardingConfig();
  }
}
