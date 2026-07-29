// Beat-3 REAL agent loop (plan §2.1b: "the agent drives, the host constrains").
//
// Each turn: the drafted agent (hosted helper brain pre-power-up, marker-routed
// past Eddy's persona) receives the setup goal checklist, the CLOSED integration
// catalog, and the current host state, and picks its next action as a
// structured tool call. The host then:
//   - validates the action against the catalog enum        (unknown → clamp)
//   - enforces dedupe (never re-ask granted/declined/asked) (violation → clamp)
//   - enforces the ask budget (MAX_ASKS)                    (exhausted → close)
//   - renders through the SAME PowerUpAsk cards, with template-owned
//     sensitivity warnings — the agent authors the WHY, never the warning.
// A clamped or failed turn falls back to the deterministic script ask — the
// conversation degrades, it never dead-ends.

import {
  IntegrationKey,
  getIntegrationEntry,
  getTopIntegrationsForRole,
  isIntegrationKey,
} from "./integrationCatalog";
import {
  MAX_ASKS,
  PowerUpAsk,
  PowerUpScriptInput,
  findJargon,
} from "./powerUpScript";
import type { HeartbeatSuggestion } from "./heartbeats";

const MESSAGE_CHAR_BUDGET = 3800;

export type AgentActionType =
  | "request_channel"
  | "request_connection"
  | "propose_heartbeat"
  | "propose_custom_heartbeat"
  | "confirm_brain"
  | "request_brain_setup"
  | "ready_to_deploy"
  | "say_only";

export type AgentAction = {
  type: AgentActionType;
  key?: string;   // request_connection
  name?: string;  // propose_heartbeat (template list)
  // propose_custom_heartbeat — AI-generated routine, host-validated:
  title?: string;
  interval?: string;
  promptText?: string;
};

/** Whitelisted cadences for AI-generated routines. */
export const CUSTOM_HEARTBEAT_INTERVALS: Record<string, string> = {
  "4h": "A few times a day",
  "1d": "Every day",
  "2d": "Every other day",
  "7d": "Every week",
};

export type AgentTurn = {
  say: string;
  action: AgentAction;
};

/** Host-owned conversation state — the source of truth for what may be asked. */
export type PowerUpHostState = {
  scriptInput: PowerUpScriptInput;
  connected: Set<string>;
  declined: Set<string>;
  /** Everything already asked this conversation (dedupe), by stable id. */
  asked: Set<string>;
  budgetUsed: number;
  maxAsks: number;
  channelResolved: boolean;
  brainResolved: boolean;
};

export function createHostState(scriptInput: PowerUpScriptInput): PowerUpHostState {
  return {
    scriptInput,
    connected: new Set((scriptInput.connectedIntegrations || []).map(String)),
    declined: new Set((scriptInput.declinedIntegrations || []).map(String)),
    asked: new Set(),
    budgetUsed: 0,
    maxAsks: scriptInput.maxAsks ?? MAX_ASKS,
    channelResolved: Boolean(scriptInput.channelConnected),
    brainResolved: false,
  };
}

export function buildAgentTurnMessage(
  state: PowerUpHostState,
  transcript: Array<{ role: "user" | "agent"; text: string }>,
  userMessage: string | null,
): string {
  const s = state.scriptInput;
  const name = s.agentName?.trim() || "the agent";
  const role = s.displayRole || s.role || "specialist";
  const seed = (s.discoveryInput || "").trim().slice(0, 300);
  const heartbeats = (s.readyHeartbeats || []).slice(0, 4);

  const catalogLines = getCatalogForPrompt(state)
    .map(e => `- ${e.key}: ${e.label} — ${e.desc}`)
    .join("\n");
  const heartbeatLines = heartbeats
    .filter(hb => !state.asked.has(`heartbeat-${hb.name}`))
    .map(hb => `- ${hb.name}: ${hb.title} (${hb.scheduleLabel})`)
    .join("\n");
  const recent = transcript.slice(-6)
    .map(t => `${t.role === "user" ? "USER" : "YOU"}: ${t.text.slice(0, 240)}`)
    .join("\n")
    .slice(0, 1100);

  const remainingBudget = Math.max(0, state.maxAsks - state.budgetUsed);
  const stateLines = [
    `- asks remaining before you must wrap up: ${remainingBudget}`,
    `- communication channel: ${state.channelResolved ? "RESOLVED (do not ask again)" : "not set up — high value, ask early"}`,
    `- model/brain: ${s.brainDetected ? `auto-detected (${s.brainProviderName || "provider"}) — confirm it in passing, don't ask` : state.brainResolved ? "RESOLVED" : "not configured — needs a guided setup before deploy"}`,
    state.connected.size ? `- already connected (NEVER re-ask): ${[...state.connected].join(", ")}` : "",
    state.declined.size ? `- declined this conversation (NEVER re-ask): ${[...state.declined].join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const parts = [
    `AGENT SESSION: POWER-UP SETUP. You are ${name}, a drafted ${role}, walking your new human through the few grants that make you genuinely useful. Warm, concrete, zero jargon (never say: container, sandbox, API key, OAuth, token, cron, webhook, endpoint). Reference their actual situation. One thing at a time.`,
    seed ? `WHAT THEY NEED FROM YOU:\n"${seed}"` : "",
    `THINGS YOU MAY REQUEST (closed list — keys outside it are invalid):\n${catalogLines || "(none left)"}`,
    heartbeatLines ? `ROUTINES YOU MAY PROPOSE (closed list):\n${heartbeatLines}` : "",
    `CURRENT STATE:\n${stateLines}`,
    recent ? `CONVERSATION SO FAR:\n${recent}` : "",
    userMessage === null
      ? `This is your OPENING turn: greet in ONE short line grounded in their words, then immediately take your FIRST action. No mission statements, no lists of what you'll do; SHOW it by asking for what makes it real.`
      : `USER JUST RESPONDED: ${userMessage.trim().slice(0, 400)}`,
    `PRIORITY ARC (adapt the words, not the order): (1) if your thinking isn't configured, request_brain_setup FIRST — without it you'll be deployed but unable to think, everything else is pointless; if it was auto-detected, confirm_brain in passing. (2) The channel — so work continues while they're away. (3) 1-2 connections, most valuable first. (4) Your FINALE: 1-2 propose_custom_heartbeat routines vividly specific to THEIR situation and what just got connected (a deliverable they'd be excited to receive on a schedule — never a generic "check-in"). (5) ready_to_deploy.`,
    `EVERY message must name the concrete value the ask unlocks FOR THEM, in their context — the pattern is "I'd love X so that I can DO-THIS-FOR-YOU", e.g. "I'd love a way to reach you so I can keep pushing your coding projects forward while you're on the move." Never ask for access without saying what it buys them.`,
    `Pick exactly ONE action:\n` +
    `- {"type":"request_connection","key":"<catalog key>"} — ask for one connection\n` +
    `- {"type":"request_channel"} — ask where to reach them (phone/Telegram/Slack)\n` +
    `- {"type":"propose_custom_heartbeat","title":"<≤60 chars, exciting and specific>","interval":"4h|1d|2d|7d","promptText":"<≤280 chars: the exact recurring job, referencing their real context>"} — YOUR signature move: a tailored recurring deliverable\n` +
    `- {"type":"propose_heartbeat","name":"<routine name from the list>"} — a stock routine (only if it genuinely fits better than a custom one)\n` +
    `- {"type":"confirm_brain"} — briefly confirm the auto-detected setup\n` +
    `- {"type":"request_brain_setup"} — ask them to do the one-minute guided setup\n` +
    `- {"type":"ready_to_deploy"} — everything valuable is covered; offer to get to work\n` +
    `- {"type":"say_only"} — LAST RESORT only. Every turn should move setup forward: if the user asked a question, answer it inside "say" AND still take your next action in the same turn.`,
    `Reply with ONLY this JSON (no code fences):\n{"say":"<what you say, 1-4 short sentences>","action":{...one action above...}}`,
  ].filter(Boolean);

  let message = parts.join("\n\n");
  if (message.length > MESSAGE_CHAR_BUDGET) message = message.slice(0, MESSAGE_CHAR_BUDGET);
  return message;
}

function getCatalogForPrompt(state: PowerUpHostState) {
  // Persona-relevant keys first, then the rest — all filtered by dedupe.
  const roleKeys = getTopIntegrationsForRole(state.scriptInput.role);
  const all = [...roleKeys, ...(["email", "calendar", "slack", "github", "folders", "imessage", "photos", "telegram"] as IntegrationKey[])];
  const seen = new Set<string>();
  return all
    .filter(k => {
      if (seen.has(k)) return false;
      seen.add(k);
      return !state.connected.has(k) && !state.declined.has(k) && !state.asked.has(`connection-${k}`);
    })
    .map(k => getIntegrationEntry(k)!)
    .slice(0, 8);
}

export function parseAgentTurn(raw: string): AgentTurn | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    // Prose-only reply: degrade to say_only rather than failing the turn.
    return { say: text.slice(0, 800), action: { type: "say_only" } };
  }
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    const say = typeof parsed.say === "string" ? parsed.say.trim().slice(0, 800) : "";
    if (!say) return null;
    const rawAction = parsed.action && typeof parsed.action === "object" ? parsed.action : { type: "say_only" };
    const type = String(rawAction.type || "say_only") as AgentActionType;
    const valid: AgentActionType[] = ["request_channel", "request_connection", "propose_heartbeat", "confirm_brain", "request_brain_setup", "ready_to_deploy", "say_only"];
    const valid2: AgentActionType[] = [...valid, "propose_custom_heartbeat"];
    return {
      say,
      action: {
        type: valid2.includes(type) ? type : "say_only",
        key: typeof rawAction.key === "string" ? rawAction.key.trim().toLowerCase() : undefined,
        name: typeof rawAction.name === "string" ? rawAction.name.trim() : undefined,
        title: typeof rawAction.title === "string" ? rawAction.title.trim() : undefined,
        interval: typeof rawAction.interval === "string" ? rawAction.interval.trim() : undefined,
        promptText: typeof rawAction.promptText === "string" ? rawAction.promptText.trim() : undefined,
      },
    };
  } catch {
    return { say: text.slice(0, 800), action: { type: "say_only" } };
  }
}

export type ValidatedTurn =
  | { kind: "ask"; ask: PowerUpAsk }
  | { kind: "say"; text: string }
  | { kind: "close" };

/**
 * The host gate. Converts the agent's chosen action into a renderable ask —
 * or clamps it. Every rule here is enforcement, not suggestion:
 * catalog enum, dedupe, budget, jargon scrub on the say-text, template-owned
 * warnings. Returns null when the action is invalid (caller falls back to
 * the deterministic script).
 */
export function validateAndBuildAsk(
  turn: AgentTurn,
  state: PowerUpHostState,
): ValidatedTurn | null {
  // Jargon ban applies to the agent's copy too — a violating turn is rejected
  // (fallback copy is clean by construction).
  if (findJargon(turn.say).length > 0) return null;

  const budgetExhausted = state.budgetUsed >= state.maxAsks;
  const a = turn.action;

  switch (a.type) {
    case "say_only":
      return { kind: "say", text: turn.say };

    case "ready_to_deploy":
      return { kind: "close" };

    case "request_channel": {
      if (state.channelResolved || state.asked.has("channel") || budgetExhausted) return null;
      return {
        kind: "ask",
        ask: {
          id: "channel",
          type: "channel",
          message: turn.say,
          chips: [
            { id: "channel-mobile", label: "Canopy on my phone", kind: "accept" },
            { id: "channel-telegram", label: "Telegram", kind: "alt" },
            { id: "channel-slack", label: "Slack", kind: "alt" },
            { id: "channel-later", label: "Later", kind: "decline" },
          ],
          source: "llm",
        },
      };
    }

    case "request_connection": {
      const key = a.key || "";
      if (!isIntegrationKey(key)) return null;                       // enum
      if (state.connected.has(key) || state.declined.has(key)) return null; // dedupe
      if (state.asked.has(`connection-${key}`) || budgetExhausted) return null;
      const entry = getIntegrationEntry(key)!;
      return {
        kind: "ask",
        ask: {
          id: `connection-${key}`,
          type: "connection",
          integrationKey: key as IntegrationKey,
          sensitivityWarning: entry.sensitivity,                      // template-owned
          message: turn.say,
          chips: [
            { id: `connect-${key}`, label: `Connect ${entry.label}`, kind: "accept" },
            { id: `skip-${key}`, label: "Not now", kind: "decline" },
          ],
          source: "llm",
        },
      };
    }

    case "propose_heartbeat": {
      const name = a.name || "";
      const hb = (state.scriptInput.readyHeartbeats || []).find((h: HeartbeatSuggestion) => h.name === name);
      if (!hb) return null;                                          // closed list
      if (state.asked.has(`heartbeat-${name}`) || budgetExhausted) return null;
      return {
        kind: "ask",
        ask: {
          id: `heartbeat-${name}`,
          type: "heartbeat",
          heartbeatName: name,
          message: turn.say,
          chips: [
            { id: `hb-yes-${name}`, label: "Yes, do that", kind: "accept" },
            { id: `hb-no-${name}`, label: "Skip", kind: "decline" },
          ],
          source: "llm",
        },
      };
    }

    case "propose_custom_heartbeat": {
      // AI-generated routine — the compelling closer. Host validation:
      // bounded fields, whitelisted cadence, jargon scrub (say already
      // checked above; scrub the routine text too), budget.
      const title = (a.title || "").trim();
      const promptText = (a.promptText || "").trim();
      const interval = (a.interval || "").trim();
      if (!title || title.length > 80 || !promptText || promptText.length > 300) return null;
      if (!CUSTOM_HEARTBEAT_INTERVALS[interval]) return null;
      if (findJargon(title).length > 0 || findJargon(promptText).length > 0) return null;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";
      const id = `heartbeat-custom-${slug}`;
      if (state.asked.has(id) || budgetExhausted) return null;
      const scheduleLabel = CUSTOM_HEARTBEAT_INTERVALS[interval];
      return {
        kind: "ask",
        ask: {
          id,
          type: "heartbeat",
          heartbeatName: `custom-${slug}`,
          customHeartbeat: {
            id: `custom-${slug}`,
            name: `custom-${slug}`,
            title,
            interval,
            prompt: promptText,
            scheduleLabel,
            dependencies: [],
          },
          message: turn.say,
          chips: [
            { id: `hb-yes-custom-${slug}`, label: "Yes — set that up", kind: "accept" },
            { id: `hb-no-custom-${slug}`, label: "Skip", kind: "decline" },
          ],
          source: "llm",
        },
      };
    }

    case "confirm_brain": {
      if (state.brainResolved || state.asked.has("brain")) return null;
      return {
        kind: "ask",
        ask: {
          id: "brain",
          type: "brain",
          message: turn.say,
          chips: [{ id: "brain-ok", label: "Great", kind: "accept" }],
          source: "llm",
        },
      };
    }

    case "request_brain_setup": {
      if (state.brainResolved || state.asked.has("brain")) return null;
      return {
        kind: "ask",
        ask: {
          id: "brain",
          type: "brain",
          message: turn.say,
          chips: [
            { id: "brain-setup", label: "Set up my thinking", kind: "accept" },
            { id: "brain-later", label: "Decide later", kind: "decline" },
          ],
          source: "llm",
        },
      };
    }

    default:
      return null;
  }
}

/** Host bookkeeping after an ask is rendered. */
export function recordAskShown(state: PowerUpHostState, ask: PowerUpAsk): void {
  state.asked.add(ask.id);
  if (ask.type === "channel" || ask.type === "connection" || ask.type === "heartbeat") {
    state.budgetUsed += 1;
  }
  if (ask.type === "brain") state.brainResolved = true;
  if (ask.type === "channel") state.channelResolved = true;
}

/** Host bookkeeping after the user answers. */
export function recordAnswer(state: PowerUpHostState, ask: PowerUpAsk, accepted: boolean): void {
  if (ask.type === "connection" && ask.integrationKey) {
    if (accepted) state.connected.add(ask.integrationKey);
    else state.declined.add(ask.integrationKey);
  }
}
