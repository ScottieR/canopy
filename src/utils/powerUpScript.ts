// Beat 3 ("Give {Name} power") conversational ask sequence.
//
// Role per IMPLEMENTATION_PLAN_ONBOARDING_POLISH_2026-07-28 §2.1/2.1b: this is
// the agent's briefing checklist, the offline/endpoint-failure FALLBACK, and
// the EVAL BASELINE. The live conversation will eventually be driven by a real
// agent loop (hosted helper token pre-power-up); until that ships, this script
// drives the UI directly. Everything here is deterministic and testable.
//
// Hard rules encoded (host-owned, never prompt-owned):
// - ask budget: at most MAX_ASKS asks between mission and close
// - never ask for something already connected/granted (dedupe)
// - integration keys validated against the closed catalog
// - zero infrastructure vocabulary in user-facing copy (jargon ban, tested)
// - every ask skippable; skip copy acknowledges without guilt-tripping

import {
  IntegrationKey,
  getIntegrationEntry,
  getTopIntegrationsForRole,
  sanitizeIntegrationKeys,
} from "./integrationCatalog";
import type { HeartbeatSuggestion, HeartbeatTask } from "./heartbeats";

export const MAX_ASKS = 5;

export type PowerUpAskType = "mission" | "channel" | "connection" | "heartbeat" | "brain" | "close";

export type PowerUpChip = {
  id: string;
  label: string;
  kind: "accept" | "decline" | "alt" | "adjust";
};

export type PowerUpAsk = {
  id: string;
  type: PowerUpAskType;
  /** Agent-voiced message. Template-composed; an in-voice rewrite may replace
   *  it later but never alters chips/keys/warnings. */
  message: string;
  /** For connection asks: catalog-validated key. */
  integrationKey?: IntegrationKey;
  /** Template-owned sensitivity warning (from the catalog). Never generated. */
  sensitivityWarning?: string;
  /** For heartbeat asks: the suggestion's stable name. */
  heartbeatName?: string;
  /** AI-generated routine (agent loop, host-validated) — written to
   *  HEARTBEAT.md at deploy when accepted. */
  customHeartbeat?: HeartbeatTask;
  chips: PowerUpChip[];
  /** Provenance for telemetry/evals: which system picked this ask. */
  source: "role_table" | "llm";
};

export type PowerUpScriptInput = {
  agentName: string;
  role: string | null;
  /** Persona title when the generative pipeline produced one (e.g. "Garden Sommelier"). */
  displayRole?: string | null;
  discoveryInput?: string;
  /** Already-connected integration keys — never re-asked. */
  connectedIntegrations?: string[];
  /** Integration keys the user has already declined this run — never re-asked. */
  declinedIntegrations?: string[];
  /** LLM-suggested keys (validated here against the catalog). Empty/absent → role table. */
  suggestedIntegrations?: string[];
  /** Ready (unlocked) heartbeat suggestions for this profile. */
  readyHeartbeats?: HeartbeatSuggestion[];
  /** Whether a comms channel is already connected (skips the channel ask). */
  channelConnected?: boolean;
  /** Provider auto-detection result (July 18 build): collapses brain to a confirmation. */
  brainDetected?: boolean;
  brainProviderName?: string;
  /** Ask-budget override (admin onboarding-config knob). Defaults to MAX_ASKS. */
  maxAsks?: number;
};

// Words that must never appear in user-facing copy on the default path.
// Mirrors the engineStatus jargon-ban test.
export const JARGON_BAN = [
  "container", "sandbox", "api key", "oauth", "bot app", "heartbeat.md",
  "cron", "daemon", "webhook", "token", "endpoint",
];

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function trimDiscovery(discoveryInput: string | undefined, max = 140): string {
  const seed = (discoveryInput || "").trim().replace(/\s+/g, " ");
  if (!seed) return "";
  // Echo-safety: discovery text is untrusted user input that we quote back
  // into agent-voiced copy. If it smuggles banned infrastructure vocabulary,
  // tag syntax ([request_*]), or instruction-injection tells, don't echo it —
  // the script falls back to generic role copy. (Caught by the
  // prompt-injection-discovery eval case.)
  const lower = seed.toLowerCase();
  const unsafe =
    JARGON_BAN.some(term => lower.includes(term)) ||
    /[\[\]{}<>]/.test(seed) ||
    /ignore (all |previous |prior )?instructions/i.test(seed) ||
    /\b(password|credential|secret)\b/i.test(seed);
  if (unsafe) return "";
  return seed.length > max ? `${seed.slice(0, max - 1)}…` : seed;
}

/** Benefit line per integration, phrased in the user's context when we have one. */
function connectionBenefit(key: IntegrationKey, agentName: string, seed: string): string {
  const withSeed = (generic: string, seeded: string) => (seed ? seeded : generic);
  switch (key) {
    case "calendar":
      return withSeed(
        `If you connect your calendar, I can prep you for what's coming and plan around your real schedule.`,
        `To stay ahead of "${seed}", I'd like to see your calendar so I can plan around your real schedule.`,
      );
    case "email":
      return withSeed(
        `With your email connected, I can flag what needs a reply and draft responses for your approval.`,
        `For "${seed}", connecting email lets me flag what needs a reply and draft responses for your approval.`,
      );
    case "folders":
      return withSeed(
        `Give me a folder to work in and I can actually read and produce files for you, not just talk about them.`,
        `For "${seed}", give me a folder to work in and I can produce real files, not just advice.`,
      );
    case "slack":
      return `If I join your Slack, I can post updates and answer questions where you already work.`;
    case "github":
      return `With GitHub connected, I can review pull requests, watch issues, and flag what's stuck.`;
    case "imessage":
      return `If you share iMessage, I can keep an eye on important conversations you tell me to watch.`;
    case "photos":
      return `With Photos connected, I can pull references from your own library when we work together.`;
    case "telegram":
      return `Connecting Telegram gives me a direct line to you for updates and quick questions.`;
    case "discord":
      return `If I join your Discord, I can respond in the channels you care about.`;
    case "twilio":
      return `With a phone line, I can call and text on your behalf.`;
    default:
      return `Connecting ${key} makes me more useful right away.`;
  }
}

/** The opening "what I'll take on for you" mission lines. */
export function buildMissionLines(input: PowerUpScriptInput): string[] {
  const seed = trimDiscovery(input.discoveryInput);
  const roleWord = (input.displayRole || input.role || "specialist").toLowerCase();
  const lines: string[] = [];
  if (seed) {
    lines.push(`Take "${seed}" off your plate — that's my job now.`);
  } else {
    lines.push(`Handle the day-to-day ${roleWord} work so you don't have to.`);
  }
  const hbs = (input.readyHeartbeats || []).slice(0, 2);
  for (const hb of hbs) {
    lines.push(`${hb.scheduleLabel}: ${hb.title.toLowerCase()}, delivered without you asking.`);
  }
  lines.push(`Come to you the moment something needs your eyes — and stay quiet when it doesn't.`);
  return lines.slice(0, 4);
}

export function buildPowerUpScript(input: PowerUpScriptInput): PowerUpAsk[] {
  const name = input.agentName?.trim() || "your agent";
  const seed = trimDiscovery(input.discoveryInput);
  const connected = new Set(sanitizeIntegrationKeys(input.connectedIntegrations || []));
  const declined = new Set(sanitizeIntegrationKeys(input.declinedIntegrations || []));

  const asks: PowerUpAsk[] = [];
  let budget = input.maxAsks ?? MAX_ASKS;

  // No mission monologue (Scottie, July 28): open by DOING. Priority order
  // (Scottie, same day): BRAIN first — without it the agent is deployed but
  // unable to think — then channel, then connections, then routines. Every
  // ask's copy leads with the value it unlocks for the user, in their words.

  // ── 1. Brain: the existential one. Detected → zero-click confirmation. ──
  if (input.brainDetected) {
    asks.push({
      id: "brain",
      type: "brain",
      message: `Good news — I found your ${input.brainProviderName || "model"} setup on this Mac, so my thinking is ready from minute one${seed ? ` and I can get straight to work on "${seed}"` : ""}. ✓`,
      chips: [{ id: "brain-ok", label: "Great", kind: "accept" }],
      source: "role_table",
    });
  } else {
    asks.push({
      id: "brain",
      type: "brain",
      message: seed
        ? `First things first: my thinking. Every plan, draft, and check-in I make for "${seed}" runs on it — one minute of setup and I'm alive, not a statue.`
        : `First things first: my thinking. Everything I'll ever do for you runs on it — one minute of setup and I'm alive, not a statue.`,
      chips: [
        { id: "brain-setup", label: "Set up my thinking", kind: "accept" },
        { id: "brain-later", label: "Decide later", kind: "decline" },
      ],
      source: "role_table",
    });
  }

  // ── 2. Channel: value = work continues while they're away. ──
  if (!input.channelConnected && budget > 0) {
    budget -= 1;
    asks.push({
      id: "channel",
      type: "channel",
      message: seed
        ? `Once I'm on "${seed}", progress shouldn't stop the moment you close this app. Where should I send updates and quick questions, so I can keep going while you're on the move?`
        : `Progress shouldn't stop the moment you close this app. Where should I send updates and quick questions, so I can keep going while you're on the move?`,
      chips: [
        { id: "channel-mobile", label: "Canopy on my phone", kind: "accept" },
        { id: "channel-telegram", label: "Telegram", kind: "alt" },
        { id: "channel-slack", label: "Slack", kind: "alt" },
        { id: "channel-later", label: "Later", kind: "decline" },
      ],
      source: "role_table",
    });
  }

  // ── 3. Connections: LLM-selected when provided (validated), else role table. ──
  const llmKeys = sanitizeIntegrationKeys(input.suggestedIntegrations || []);
  const usingLlm = llmKeys.length > 0;
  const candidateKeys = (usingLlm ? llmKeys : getTopIntegrationsForRole(input.role))
    .filter(k => !connected.has(k) && !declined.has(k));
  for (const key of candidateKeys.slice(0, 2)) {
    if (budget <= 0) break;
    budget -= 1;
    const entry = getIntegrationEntry(key)!;
    asks.push({
      id: `connection-${key}`,
      type: "connection",
      integrationKey: key,
      sensitivityWarning: entry.sensitivity,
      message: connectionBenefit(key, name, seed),
      chips: [
        { id: `connect-${key}`, label: `Connect ${entry.label}`, kind: "accept" },
        { id: `skip-${key}`, label: "Not now", kind: "decline" },
      ],
      source: usingLlm ? "llm" : "role_table",
    });
  }

  // ── 4. Heartbeats as promises (ready ones only; locked ones surface later). ──
  for (const hb of (input.readyHeartbeats || []).slice(0, 2)) {
    if (budget <= 0) break;
    budget -= 1;
    asks.push({
      id: `heartbeat-${hb.name}`,
      type: "heartbeat",
      heartbeatName: hb.name,
      message: `${cap(hb.scheduleLabel.toLowerCase())}, I can ${hb.title.toLowerCase()} — done before you think to ask. Want that?`,
      chips: [
        { id: `hb-yes-${hb.name}`, label: "Yes, do that", kind: "accept" },
        { id: `hb-no-${hb.name}`, label: "Skip", kind: "decline" },
      ],
      source: "role_table",
    });
  }

  // ── Close: deploy. Always present, always works (engine gate handled by caller). ──
  asks.push({
    id: "close",
    type: "close",
    message: `That's everything I need${seed ? ` to start on "${seed}"` : ""}. Ready when you are.`,
    chips: [
      { id: "deploy", label: `Put me to work →`, kind: "accept" },
      { id: "review", label: "Review everything first", kind: "adjust" },
    ],
    source: "role_table",
  });

  return asks;
}

/** Routes a free-text reply at an ask to one of its chips, or null when
 *  unmatched (caller responds with the graceful "after I'm deployed" copy —
 *  never a dead end). Deliberately simple keyword matching. */
export function routeFreeTextToChip(text: string, ask: PowerUpAsk): PowerUpChip | null {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;
  const yes = /\b(yes|yeah|yep|sure|ok(ay)?|do it|sounds good|please|go ahead|let'?s)\b/.test(t);
  const no = /\b(no|nope|not now|later|skip|nah|don'?t|pass)\b/.test(t);
  // Channel ask: match channel names first.
  if (ask.type === "channel") {
    if (/telegram/.test(t)) return ask.chips.find(c => c.id === "channel-telegram") ?? null;
    if (/slack/.test(t)) return ask.chips.find(c => c.id === "channel-slack") ?? null;
    if (/\b(phone|mobile|app|qr)\b/.test(t)) return ask.chips.find(c => c.id === "channel-mobile") ?? null;
  }
  if (no) return ask.chips.find(c => c.kind === "decline") ?? null;
  if (yes) return ask.chips.find(c => c.kind === "accept") ?? null;
  return null;
}

/** Copy for unmatched free text — acknowledges and moves on. */
export function unmatchedFreeTextReply(agentName: string): string {
  return `Good note — I'll hold onto that and we can sort it out once I'm deployed. For now:`;
}

/** Skip acknowledgement, in voice, no guilt-tripping. */
export function skipReply(ask: PowerUpAsk, agentName: string): string {
  switch (ask.type) {
    case "channel": return `No problem — I'll deliver everything in the app, and you can point me at your phone whenever you like.`;
    case "connection": return `Skipping that for now — I'll work with what I have, and I'll only bring it up again if a task truly needs it.`;
    case "heartbeat": return `Understood — nothing on a schedule. You can always ask me to start one later.`;
    case "brain": return `Alright — you can set that up from my page later. I won't be able to think until then, so don't wait too long!`;
    default: return `Got it.`;
  }
}

/** Lints user-facing copy for banned infrastructure vocabulary. Used by tests/evals. */
export function findJargon(text: string): string[] {
  const lower = text.toLowerCase();
  return JARGON_BAN.filter(term => lower.includes(term));
}
