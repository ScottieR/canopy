// accessTiers — single source of truth for the Guarded / Balanced / Unrestricted preset.
//
// Lives outside of ConnectionsTab.tsx so the Overview gauge, the merged Skills & Access
// tab, and any future onboarding-time selector all agree on what each tier means.
// Permissions not listed in a tier's map are simply left untouched when that tier is
// applied — so a future per-archetype permission (e.g. tutor-specific scoping) won't
// be silently flipped off by an "apply tier" action.

import { invoke } from "@tauri-apps/api/core";
import type { AgentData, Permission } from "../../store/worldStore";
import { useWorldStore, AGENT_TYPE_INFO } from "../../store/worldStore";

export type AccessTierId = "guarded" | "balanced" | "unrestricted";

export type AccessTier = {
  id: AccessTierId;
  label: string;
  summary: string;          // 1-sentence what-it-does for the card.
  rationale: string;        // Why an agent might want this tier — used in hover-overs.
  color: string;            // Tier accent color (matches Overview gauge).
  enabled: Record<string, boolean>;
  recommended?: boolean;
  highRisk?: boolean;
};

// Risk-band for each permission. Surfaced as a chip next to the per-permission toggle
// and used to decide whether a confirmation modal fires when turning something on.
export const PERMISSION_RISK_BAND: Record<string, "low" | "medium" | "high"> = {
  // low — stays inside the agent's sandbox
  memory_write: "low",
  summarize: "low",
  vision: "low",
  canvas: "low",
  scheduled: "low",
  file_read: "low",          // reading is generally safe — write is the dangerous side
  int_network: "low",

  // medium — reaches beyond the sandbox but no autonomous real-world action
  ext_network: "medium",
  browser: "medium",
  coding: "medium",
  gog: "medium",
  photos: "medium",
  computer_control: "medium",

  // high — can take real-world actions on the user's behalf or intercept traffic
  autonomous: "high",
  proxy: "high",
  file_write: "high",
  payments: "high",
  spend_auto: "high",
  imessage: "high",
  screen_record: "high",
  host_control: "high",
};

// The full unified tier definitions. Listing a permission as `false` means "turn off
// when this tier is applied"; listing it as `true` means "turn on". Anything not in
// the map is left at whatever the agent currently has.
//
// Strict escalation: anything Guarded enables is also enabled in Balanced and Unrestricted.
// Anything Balanced enables (without Guarded enabling it) is also enabled in Unrestricted.
export const ACCESS_TIERS: AccessTier[] = [
  {
    id: "guarded",
    label: "Guarded",
    summary: "Read and reason only. No web, no autonomy, no writes.",
    rationale:
      "Best for agents handling money, secrets, or sensitive data. They can think and summarize " +
      "but can't reach the web, write files, send messages, or take actions on their own.",
    color: "#218380",
    enabled: {
      // Always-allowed basics
      memory_write: true,
      file_read: true,
      vision: true,
      summarize: true,
      // Everything that reaches outside or takes action — off
      ext_network: false,
      int_network: false,
      autonomous: false,
      scheduled: false,
      file_write: false,
      payments: false,
      spend_auto: false,
      imessage: false,
      photos: false,
      browser: false,
      computer_control: false,
      host_control: false,
      screen_record: false,
      proxy: false,
      canvas: false,
      coding: false,
      gog: false,
    },
  },
  {
    id: "balanced",
    label: "Balanced",
    summary: "Full autonomous execution — web, browsing, code, and scheduled tasks. No writes, no payments.",
    rationale:
      "The right default for most agents. They can research, browse, run code, and chain actions on your " +
      "behalf without interrupting you at every step. File writes, payments, and external messaging still " +
      "require explicit permission — those are the real risk controls.",
    color: "#3c6663",
    recommended: true,
    enabled: {
      // Carry forward Guarded
      memory_write: true,
      file_read: true,
      vision: true,
      summarize: true,
      // Add productive capabilities
      ext_network: true,
      int_network: true,
      browser: true,
      coding: true,
      gog: true,
      canvas: true,
      computer_control: false,
      host_control: false,
      screen_record: false,
      // Autonomous execution + scheduling on by default — defense-in-depth
      // comes from capability permissions (payments/file_write/imessage all off).
      // Agents can chain reasoning loops; they just can't spend money or write files.
      autonomous: true,
      scheduled: true,
      // Still off: real-world write/send/pay actions
      file_write: false,
      payments: false,
      spend_auto: false,
      imessage: false,
      photos: false,
      proxy: false,
    },
  },
  {
    id: "unrestricted",
    label: "Unrestricted",
    summary: "Full access, including autonomy, file writes, payments, and traffic interception.",
    rationale:
      "Only for agents you've fully vetted. They can act on your behalf without asking, write files, " +
      "request payments, intercept network traffic, and read/send messages. Requires confirmation.",
    color: "#C62828",
    highRisk: true,
    enabled: {
      memory_write: true, file_read: true, vision: true, summarize: true,
      ext_network: true, int_network: true, browser: true, coding: true, gog: true, canvas: true,
      computer_control: false, host_control: false, screen_record: false,
      autonomous: true, scheduled: true, file_write: true, payments: true, spend_auto: true,
      imessage: true, photos: true, proxy: true,
    },
  },
];

// Returns the tier the agent currently matches, or null if its permissions are a
// custom blend that doesn't line up with any preset.
export function detectCurrentTier(permissions: Permission[]): AccessTier | null {
  return (
    ACCESS_TIERS.find(tier =>
      Object.entries(tier.enabled).every(([id, desired]) => {
        const perm = permissions.find(p => p.id === id);
        // If the permission doesn't exist on this agent, treat that as "matches" — the
        // tier only constrains permissions that are actually present.
        if (!perm) return true;
        return perm.enabled === desired;
      })
    ) || null
  );
}

// Apply a tier preset to an agent. Only flips permissions that (a) are in the tier's
// map AND (b) actually exist on the agent. Other permissions are untouched.
// Persists via the existing `update_agent_capabilities` Tauri command.
export async function applyAccessTier(agent: AgentData, tier: AccessTier): Promise<void> {
  const toggle = useWorldStore.getState().togglePermission;

  // Flip everything in one pass. togglePermission is a flip — we have to compare
  // current vs desired and only call it when they differ.
  Object.entries(tier.enabled).forEach(([id, desired]) => {
    const perm = agent.permissions.find(x => x.id === id);
    if (perm && perm.enabled !== desired) toggle(agent.id, id);
  });

  // Wait a tick for the store update to flush, then sync to the backend.
  await new Promise(r => setTimeout(r, 100));
  const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
  if (!currentAgent) return;
  const capabilitiesObj: Record<string, boolean> = {};
  currentAgent.permissions.forEach(px => (capabilitiesObj[px.id] = px.enabled));
  try {
    await invoke("update_agent_capabilities", {
      agentId: agent.id,
      capabilities: capabilitiesObj,
    });
  } catch (e) {
    console.error("Failed to persist tier change:", e);
  }
}

// Human-readable summary of what changes when applying a tier — used in hover-overs
// and in the confirmation modal for high-risk transitions.
export function summarizeTierChange(
  fromPermissions: Permission[],
  tier: AccessTier,
): { turningOn: string[]; turningOff: string[] } {
  const turningOn: string[] = [];
  const turningOff: string[] = [];
  Object.entries(tier.enabled).forEach(([id, desired]) => {
    const perm = fromPermissions.find(p => p.id === id);
    if (!perm) return;
    if (perm.enabled === desired) return;
    if (desired) turningOn.push(perm.label);
    else turningOff.push(perm.label);
  });
  return { turningOn, turningOff };
}

export function getRecommendedTierForAgent(agentRole: string): AccessTier {
  const recommendedTierId = AGENT_TYPE_INFO[agentRole]?.recommended_tier || "balanced";
  return ACCESS_TIERS.find(t => t.id === recommendedTierId) || ACCESS_TIERS.find(t => t.id === "balanced")!;
}
