// The closed catalog of connectable integrations. This is THE enum that every
// suggestion system (deterministic script today, LLM tool-calling loop next)
// must validate against — an integration key that isn't here is
// unrepresentable downstream. See IMPLEMENTATION_PLAN_ONBOARDING_POLISH
// section 2.1b: "generative selection, deterministic disposal."
//
// Keys match the wizard's `plugins` state and `handleSetupIntegration` switch.

export type IntegrationKey =
  | "email"
  | "calendar"
  | "slack"
  | "github"
  | "folders"
  | "imessage"
  | "photos"
  | "telegram"
  | "discord"
  | "twilio";

export type IntegrationCatalogEntry = {
  key: IntegrationKey;
  label: string;
  icon: string;
  /** Short capability description, agent-neutral. */
  desc: string;
  /** Template-owned sensitivity warning shown on the bridge card. NEVER LLM-authored. */
  sensitivity?: string;
};

export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = [
  { key: "email",    label: "Gmail",             icon: "📧", desc: "Read and send email on your behalf", sensitivity: "Grants read/send access to your email. Approve only if you want this agent handling mail." },
  { key: "calendar", label: "Google Calendar",   icon: "📅", desc: "View and create calendar events" },
  { key: "slack",    label: "Slack",             icon: "💬", desc: "Join your workspace as a dedicated bot" },
  { key: "github",   label: "GitHub",            icon: "🐙", desc: "Access repos, issues, and pull requests", sensitivity: "Can read private repositories you grant. Scope the token to what this agent needs." },
  { key: "folders",  label: "File access",       icon: "📁", desc: "Read and write files in a folder you pick", sensitivity: "The agent can read and modify files inside the folder you choose. Pick a specific folder, not your whole disk." },
  { key: "imessage", label: "iMessage",          icon: "💬", desc: "Read your iMessage conversations", sensitivity: "Requires Full Disk Access and exposes personal message history. Sensitive — only for agents you fully trust." },
  { key: "photos",   label: "Apple Photos",      icon: "🖼️", desc: "Browse and reference your photo library", sensitivity: "Exposes your photo library to this agent." },
  { key: "telegram", label: "Telegram",          icon: "✈️", desc: "Message you through a Telegram bot" },
  { key: "discord",  label: "Discord",           icon: "🎮", desc: "Respond in Discord channels and DMs" },
  { key: "twilio",   label: "Twilio Voice & SMS",icon: "📞", desc: "A phone number for calls and texts" },
];

const CATALOG_BY_KEY = new Map(INTEGRATION_CATALOG.map(e => [e.key, e]));

export function isIntegrationKey(value: string): value is IntegrationKey {
  return CATALOG_BY_KEY.has(value as IntegrationKey);
}

export function getIntegrationEntry(key: string): IntegrationCatalogEntry | null {
  return CATALOG_BY_KEY.get(key as IntegrationKey) ?? null;
}

/** Filters arbitrary strings down to valid catalog keys (order-preserving, deduped). */
export function sanitizeIntegrationKeys(keys: string[]): IntegrationKey[] {
  const seen = new Set<string>();
  const out: IntegrationKey[] = [];
  for (const raw of keys) {
    const key = String(raw ?? "").trim().toLowerCase();
    if (!seen.has(key) && isIntegrationKey(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** Role → highest-value integration keys. Deterministic fallback + eval baseline
 *  for the generative selector. (Extracted from OnboardingWizard step 4.) */
export const TOP_INTEGRATIONS_BY_ROLE: Record<string, IntegrationKey[]> = {
  Researcher:  ["folders", "slack"],
  Tutor:       ["folders", "slack"],
  Assistant:   ["calendar", "email"],
  Therapist:   ["imessage", "slack"],
  Chef:        ["photos", "folders"],
  Accountant:  ["folders", "slack"],
  Educator:    ["folders", "slack"],
  Artist:      ["photos", "folders"],
  Coder:       ["github", "folders"],
  Architect:   ["github", "folders"],
  Musician:    ["folders", "imessage"],
  Trainer:     ["imessage", "photos"],
  Strategist:  ["slack", "folders"],
  Negotiator:  ["slack", "imessage"],
  Engineer:    ["github", "folders"],
  Editor:      ["folders", "slack"],
  Coach:       ["imessage", "slack"],
  Custom:      ["slack", "folders"],
};

export function getTopIntegrationsForRole(role: string | null | undefined): IntegrationKey[] {
  return (role && TOP_INTEGRATIONS_BY_ROLE[role]) || TOP_INTEGRATIONS_BY_ROLE.Custom;
}
