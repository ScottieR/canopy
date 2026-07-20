// ─── The Keeper (Eddy) — persistent helper pill + chat panel ─────────────────
// Spec: spec-helper-agent-and-orchestrator.md Part 1 / F-K1.
// Provider-direct or on-device inference with a local rule-based fallback.
// Once the user connects a provider, Eddy calls it directly from this Mac;
// before then, common setup failures are diagnosed without sending anything
// to the Canopy server. The Tauri layer assembles the same minimized context
// the wrench icon sees and applies a strict allowlist before provider calls.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { useWorldStore } from "../../store/worldStore";
import { LobsterIcon } from "../World/LobsterIcon";

const EDDY_GOLD = "#D4A843";
const EDDY_GOLD_LIGHT = "#E8C060";
const EDDY_TEAL = "#4AADBE";

const invoke = async <T,>(cmd: string, args?: any): Promise<T> => {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    return tauriInvoke(cmd, args);
  }
  return Promise.reject(new Error("Tauri unavailable"));
};

type KeeperAction = {
  type: "navigate" | "view";
  agentName?: string;
  tab?: string;
  view?: string;
  highlightText?: string;
};

type FeedbackKind = "bug" | "feature_request";
type KeeperFeedbackDraft = {
  kind: FeedbackKind;
  title: string;
  description: string;
  agentId: string | null;
  prompt: string;
};
type KeeperMsg = {
  role: "user" | "assistant";
  content: string;
  ts: number;
  action?: KeeperAction;
  feedbackDraft?: KeeperFeedbackDraft;
  feedbackSent?: boolean;
};
type SubmittedFeedbackReport = {
  id: string;
  kind: string;
  title: string;
  description: string;
  agentId?: string | null;
  context?: Record<string, unknown>;
};

type ProviderHealth = { provider: string; status: string; detail?: string; model: string };
type HelperMode = "offline" | "provider" | "local";
type HelperConfig = { mode: HelperMode; provider?: string; model?: string; credentialPresent: boolean };
type HelperContinuity = { topic?: "provider_setup" | "integration_setup" | "diagnostics" | "onboarding"; target_agent?: string; provider?: "openai" | "anthropic" | "gemini" | "xai"; expires_at: number };

const BUG_RELAY_PROMPT = "Do you want me to send this to the Canopy developers so they can fix the app?";
const IDEA_RELAY_PROMPT = "If you want, I can relay this idea to the Canopy developers so they can improve your experience.";
const EDDY_FEEDBACK_NUDGE = "If you ever have an idea about how this whole experience could be better, let me know, and I'll relay it so that Canopy can improve your experience.";

// ── Guided actions: Eddy takes the user there ────────────────────────────────
// The server (and the offline fallback) can attach an <ACTION>{json}</ACTION>
// directive. We strip it from the prose, render a "Take me there" button, and
// on click navigate + pulse-highlight the matching control. Eddy guides with
// his claws, not just words.

function parseKeeperReply(raw: string): { text: string; action?: KeeperAction } {
  const m = raw.match(/<ACTION>([\s\S]*?)<\/ACTION>/i);
  if (!m) return { text: raw.trim() };
  const text = raw.replace(m[0], "").trim();
  try {
    const action = JSON.parse(m[1]);
    if (action && (action.type === "navigate" || action.type === "view")) return { text, action };
  } catch { /* malformed directive — show prose only */ }
  return { text };
}

let highlightStyleInjected = false;
function ensureHighlightStyle() {
  if (highlightStyleInjected) return;
  highlightStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes keeperPulse {
      0%, 100% { box-shadow: 0 0 0 3px rgba(212,168,67,0.85), 0 0 24px 6px rgba(212,168,67,0.35); }
      50%      { box-shadow: 0 0 0 6px rgba(212,168,67,0.45), 0 0 32px 10px rgba(212,168,67,0.2); }
    }
    .keeper-highlight {
      animation: keeperPulse 1.1s ease-in-out 4;
      border-radius: 10px;
      position: relative;
      z-index: 50;
    }`;
  document.head.appendChild(style);
}

// Find the on-screen element whose visible text best matches the label and
// pulse it. Generic text-match so no per-tab instrumentation is needed.
function highlightByText(label: string) {
  ensureHighlightStyle();
  const needle = label.toLowerCase().trim();
  if (!needle) return;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,label,button,span,div")
  ).filter(el => {
    if (el.closest("[data-keeper-panel]")) return false; // never highlight Eddy's own panel
    const t = (el.textContent || "").trim().toLowerCase();
    if (!t || t.length > 80) return false; // section labels, not paragraphs
    if (!t.includes(needle)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight * 1.5;
  });
  // Prefer the shortest match (tightest label), then the highest on screen.
  candidates.sort((a, b) =>
    (a.textContent!.trim().length - b.textContent!.trim().length) ||
    (a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  );
  const target = candidates[0];
  if (!target) return;
  // Pulse the nearest reasonable container so the glow has some body to it.
  const box = (target.closest("section,fieldset,[class]") as HTMLElement) || target;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  box.classList.add("keeper-highlight");
  setTimeout(() => box.classList.remove("keeper-highlight"), 4800);
}

function runKeeperAction(action: KeeperAction) {
  const store = useWorldStore.getState() as any;
  if (action.type === "view" && action.view) {
    store.setActiveView(action.view);
  } else if (action.type === "navigate" && action.agentName) {
    const ag = store.agents.find((a: any) =>
      String(a.name || "").toLowerCase() === String(action.agentName).toLowerCase());
    if (ag) {
      store.setSelectedAgent(ag.id);
      if (typeof store.setArchitectTab === "function") store.setArchitectTab(action.tab || "overview");
      store.setActiveView("architect");
    }
  }
  if (action.highlightText) {
    // Give the destination view a beat to mount before searching the DOM.
    setTimeout(() => highlightByText(action.highlightText!), 800);
    setTimeout(() => highlightByText(action.highlightText!), 1800); // retry after slow mounts
  }
}

const CHAT_KEY = "canopy_helper_chat";
const LEGACY_CHAT_KEY = "canopy_keeper_chat";
const ONBOARDING_AUTOOPEN_KEY = "canopy_helper_onboarding_opened";
const LEGACY_ONBOARDING_AUTOOPEN_KEY = "canopy_keeper_onboarding_opened";
const CONTINUITY_KEY = "canopy_helper_continuity";

const loadChat = (): KeeperMsg[] => {
  try {
    const raw = localStorage.getItem(CHAT_KEY) || localStorage.getItem(LEGACY_CHAT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (raw && !localStorage.getItem(CHAT_KEY)) localStorage.setItem(CHAT_KEY, raw);
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch { return []; }
};

const loadContinuity = (): HelperContinuity => {
  try {
    const value = JSON.parse(localStorage.getItem(CONTINUITY_KEY) || "null");
    if (value?.expires_at > Date.now()) return value;
  } catch { /* ignore */ }
  return { expires_at: 0 };
};

function updateContinuity(previous: HelperContinuity, message: string, agents: any[]): HelperContinuity {
  const lower = message.toLowerCase();
  const next: HelperContinuity = previous.expires_at > Date.now() ? { ...previous } : { expires_at: 0 };
  const named = agents.find(a => a.name && lower.includes(String(a.name).toLowerCase()));
  if (named) next.target_agent = String(named.name).slice(0, 200);
  if (/\b(openai|gpt)\b/.test(lower)) next.provider = "openai";
  else if (/\b(anthropic|claude)\b/.test(lower)) next.provider = "anthropic";
  else if (/\b(gemini|google ai)\b/.test(lower)) next.provider = "gemini";
  else if (/\b(xai|grok)\b/.test(lower)) next.provider = "xai";
  if (/\b(key|provider|model)\b/.test(lower)) next.topic = "provider_setup";
  else if (/\b(slack|github|telegram|discord|calendar|gmail|connect)\b/.test(lower)) next.topic = "integration_setup";
  else if (/\b(broken|error|diagnos|repair|not responding)\b/.test(lower)) next.topic = "diagnostics";
  else if (/\b(onboard|setup wizard|new agent)\b/.test(lower)) next.topic = "onboarding";
  next.expires_at = Date.now() + 30 * 60_000;
  return next;
}

function inferFeedbackKind(message: string): FeedbackKind | null {
  const lower = message.toLowerCase();
  if (/\b(bug|broken|broke|error|issue|problem|stuck|freeze|frozen|hang|crash|crashed|not working|doesn't work|isn't working|not responding|failed|failure)\b/.test(lower)) {
    return "bug";
  }
  if (/\b(feature|idea|wish|better|improve|improvement|should|could you|would love|it would be nice|request)\b/.test(lower)) {
    return "feature_request";
  }
  return null;
}

function summarizeFeedbackTitle(message: string, kind: FeedbackKind): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/(?<=[.!?])\s/)[0] || normalized;
  const title = firstSentence.slice(0, 120).trim();
  if (title) return title;
  return kind === "bug" ? "App issue reported to Eddy" : "Feature idea shared with Eddy";
}

function pickEngineerAgent(agents: any[]) {
  const matches = agents.filter((agent) => {
    const role = String(agent.role || "").toLowerCase();
    const name = String(agent.name || "").toLowerCase();
    return role === "engineer" || role === "developer" || role === "coder" || name.includes("engineer") || name.includes("developer");
  });

  return matches.sort((a, b) => {
    const aScore = (a.paused ? 0 : 2) + (a.status === "active" ? 2 : 0) + (String(a.role || "").toLowerCase() === "engineer" ? 2 : 0);
    const bScore = (b.paused ? 0 : 2) + (b.status === "active" ? 2 : 0) + (String(b.role || "").toLowerCase() === "engineer" ? 2 : 0);
    return bScore - aScore;
  })[0] ?? null;
}

function resolveFeedbackAgentId(
  selectedAgentId: string | null,
  continuity: HelperContinuity,
  agents: any[],
): string | null {
  if (continuity.target_agent) {
    const match = agents.find((agent) =>
      String(agent.name || "").toLowerCase() === String(continuity.target_agent || "").toLowerCase()
    );
    if (match?.id) return match.id;
  }
  return selectedAgentId;
}

function buildFeedbackDraft(
  message: string,
  kind: FeedbackKind,
  selectedAgentId: string | null,
  continuity: HelperContinuity,
  agents: any[],
): KeeperFeedbackDraft {
  return {
    kind,
    title: summarizeFeedbackTitle(message, kind),
    description: message.trim(),
    agentId: resolveFeedbackAgentId(selectedAgentId, continuity, agents),
    prompt: kind === "bug" ? BUG_RELAY_PROMPT : IDEA_RELAY_PROMPT,
  };
}

// ── Context payload (same data the wrench icon sees) ─────────────────────────
function useKeeperContext() {
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const agents = useWorldStore(s => s.agents);
  const activeView = useWorldStore(s => s.activeView);
  const healthCacheRef = useRef<{ at: number; data: ProviderHealth[] } | null>(null);

  return async () => {
    // Provider health — cached 60s, never blocks more than the ping timeout.
    let providerHealth: ProviderHealth[] = [];
    const cache = healthCacheRef.current;
    if (cache && Date.now() - cache.at < 60_000) {
      providerHealth = cache.data;
    } else {
      try {
        providerHealth = await invoke<ProviderHealth[]>("check_model_health", {});
        healthCacheRef.current = { at: Date.now(), data: providerHealth };
      } catch { /* tauri unavailable or command failed — omit */ }
    }

    let onboardingStep: number | null = null;
    try {
      const draft = localStorage.getItem("canopy_onboarding_draft");
      if (draft) onboardingStep = JSON.parse(draft)?.step ?? null;
    } catch { /* ignore */ }

    // Per-agent Slack pairing flags (keychain-backed, cheap reads).
    const slackPaired: Record<string, boolean> = {};
    await Promise.all(agents.map(async a => {
      try {
        const v = await invoke<string>("get_secret_cmd", { key: `agent_${a.id}_slack_paired` });
        slackPaired[a.id] = String(v) === "true";
      } catch { slackPaired[a.id] = false; }
    }));

    return {
      runtime_ready: gatewayReady,
      active_view: activeView,
      onboarding: { in_onboarding: activeView === "onboarding", draft_step: onboardingStep },
      agents: agents.map(a => ({
        name: a.name,
        status: a.status,
        paused: a.paused || false,
        isolated: (a as any).isolated || false,
        model: (a as any).personality?.active_model || (a as any).active_model || undefined,
        integrations: (a as any).integrations || [],
        slack_paired: slackPaired[a.id] ?? false,
      })),
      usage: { agent_count: agents.length, errored_agents: agents.filter(a => a.status === "error").length },
      provider_health: providerHealth.map(({ provider, status, model }) => ({ provider, status, model })),
    };
  };
}

// ── Rule-based fallback (offline Eddy) ───────────────────────────────────────
// Mirrors the Part 1D playbook detect stage: lead with the most severe
// confirmed problem in the context, with concrete in-app next steps. Takes the
// user's question so we can answer topic-specific things (Slack, a named
// agent) instead of reciting overall health at someone asking about Patch.
function offlineDiagnosis(ctx: any, question: string = ""): string {
  const q = question.toLowerCase();

  if (!ctx.runtime_ready) {
    return "I can't reach Canopy's local runtime right now — that's why things look frozen. Open the OrbStack app (it's in your Applications folder); once it's running, your agents wake up on their own. If OrbStack isn't installed, grab it from orbstack.dev and I'll take it from there.";
  }

  // Question names a specific agent? Diagnose that agent first. Replies embed
  // <ACTION> directives — the same protocol as cloud Eddy — so offline Eddy
  // can still walk the user to the right screen.
  const named = (ctx.agents || []).find((a: any) => a.name && q.includes(String(a.name).toLowerCase()));
  const navTo = (tab: string, highlight: string) =>
    named ? `\n<ACTION>{"type":"navigate","agentName":"${named.name}","tab":"${tab}","highlightText":"${highlight}"}</ACTION>` : "";
  if (named && (q.includes("slack") || q.includes("connect"))) {
    if (!Array.isArray(named.integrations) || !named.integrations.includes("slack")) {
      return `${named.name} doesn't have Slack turned on. Open ${named.name} → Skills & Access and enable the Slack connection there, then follow the pairing step (DM the bot in Slack, it replies with a code you enter in Canopy).${navTo("connections", "Slack")}`;
    }
    if (!named.slack_paired) {
      return `${named.name} has Slack enabled but the pairing was never completed — that's the missing link. Send a direct message to ${named.name}'s bot in your Slack workspace; it replies with a pairing code, and you enter that code in ${named.name} → Skills & Access → Slack. Until that handshake happens, messages won't flow either direction.${navTo("connections", "Slack")}`;
    }
    return `${named.name}'s Slack looks enabled and paired from here. The usual remaining suspects: the bot was removed from the channel (re-invite it), or the workspace tokens expired (re-enter them under Integrations). If neither helps, open Diagnostics and run the connection check — tell me what it says.${navTo("diagnostics", "Diagnostics")}`;
  }
  if (named && q.includes("github")) {
    if (!Array.isArray(named.integrations) || !named.integrations.includes("github")) {
      return `${named.name} doesn't have GitHub connected yet. Open ${named.name} → Skills & Access, connect GitHub from that agent's page, and finish the repo selection step so the token and bindings stay isolated to ${named.name}.${navTo("connections", "GitHub")}`;
    }
    return `${named.name} has GitHub enabled. If it still can't work with a repo, the usual fixes are: reconnect the PAT from ${named.name}'s Skills & Access page, confirm the repo is selected in the GitHub setup step, and make sure the token still has repo access.${navTo("connections", "GitHub")}`;
  }
  if (named && q.includes("telegram")) {
    if (!Array.isArray(named.integrations) || !named.integrations.includes("telegram")) {
      return `${named.name} doesn't have Telegram connected yet. Telegram is configured per-agent, so open ${named.name} → Skills & Access and run the Telegram companion from there.${navTo("connections", "Telegram")}`;
    }
    return `${named.name} has Telegram enabled. If messages still aren't flowing, re-open ${named.name}'s Telegram setup, regenerate the BotFather token, and save it again for this specific agent.${navTo("connections", "Telegram")}`;
  }
  if (named && q.includes("discord")) {
    if (!Array.isArray(named.integrations) || !named.integrations.includes("discord")) {
      return `${named.name} doesn't have Discord connected yet. Discord is configured per-agent, so open ${named.name} → Skills & Access and run the Discord setup from there.${navTo("connections", "Discord")}`;
    }
    return `${named.name} has Discord enabled. If it still can't respond, re-open the Discord setup for ${named.name}, regenerate the bot token, and confirm the bot still has access to the server and channel you expect.${navTo("connections", "Discord")}`;
  }
  if (named && (q.includes("calendar") || q.includes("gmail") || q.includes("drive"))) {
    const target =
      q.includes("calendar") ? "Google Calendar" :
      q.includes("drive") ? "Google Drive" :
      "Gmail";
    return `${named.name}'s ${target} access is configured per-agent. Open ${named.name} → Skills & Access and reconnect that Google permission there if the token expired or the scope needs to change.${navTo("connections", target)}`;
  }
  if (named) {
    if (named.status === "error") {
      return `${named.name} is in an error state${named.last_action ? ` (${String(named.last_action).replace(/Docker|Container|OpenClaw/gi, "runtime")})` : ""}. Open ${named.name}'s Diagnostics tab and run repair — that fixes most startup problems. Tell me what it reports if it doesn't.${navTo("diagnostics", "Diagnostics")}`;
    }
    if (named.paused) {
      return `${named.name} is paused — that's why nothing's happening. Un-pause them from their card or their Home tab.${navTo("overview", named.name)}`;
    }
    return `${named.name} looks healthy from here (status: ${named.status || "idle"}${named.model ? `, model: ${named.model}` : ""}). If they're not responding the way you expect, tell me what you asked and what came back — or check the runtime log in Diagnostics for clues.${navTo("diagnostics", "Diagnostics")}`;
  }
  const limited = (ctx.provider_health || []).filter((p: any) => p.status === "rate_limited");
  if (limited.length > 0) {
    const names: Record<string, string> = { gemini: "Google Gemini", anthropic: "Anthropic", openai: "OpenAI", xai: "xAI" };
    const n = limited.map((p: any) => names[p.provider] || p.provider).join(" and ");
    return `Your ${n} key is out of quota right now, so any agent using it will sit silent. That's the provider's limit, not Canopy. Three ways out: wait for the quota to reset, upgrade that key's plan, or switch the affected agent to a different model under Skills & Access → AI model.\n<ACTION>{"type":"view","view":"integrations","highlightText":"AI Providers"}</ACTION>`;
  }
  const invalid = (ctx.provider_health || []).filter((p: any) => p.status === "invalid_key");
  if (invalid.length > 0) {
    return `One of your provider keys is being rejected as invalid. Open Integrations → AI Providers and re-paste it — keys sometimes pick up stray characters when copied.\n<ACTION>{"type":"view","view":"integrations","highlightText":"AI Providers"}</ACTION>`;
  }
  const errored = (ctx.agents || []).filter((a: any) => a.status === "error");
  if (errored.length > 0) {
    const a = errored[0];
    return `${a.name} hit a problem${a.last_action ? ` (${String(a.last_action).replace(/Docker|Container|OpenClaw/gi, "runtime")})` : ""}. Open ${a.name}'s page and try the Diagnostics tab — the "repair" action there fixes most startup issues. If it keeps failing, tell me what Diagnostics says.`;
  }
  if (ctx.onboarding?.in_onboarding) {
    return "I'm here while you set up — ask me anything about choosing an agent, connecting a provider key, or what happens after you deploy. If a step looks stuck, describe it and I'll point you at the fix.";
  }
  return "Everything looks healthy from where I sit — runtime up, no key problems, no agents in trouble. Ask me anything about Canopy, or describe what's not working and I'll dig in. (Note: I couldn't reach my full brain just now, so I'm running on local diagnostics only.)";
}

// ── Panel ────────────────────────────────────────────────────────────────────
export function KeeperPanel() {
  const activeView = useWorldStore(s => s.activeView);
  const selectedAgentId = useWorldStore(s => s.selectedAgent);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<KeeperMsg[]>(loadChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [submittingFeedbackTs, setSubmittingFeedbackTs] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [helperConfig, setHelperConfig] = useState<HelperConfig>({ mode: "offline", credentialPresent: false });
  const [settingsMode, setSettingsMode] = useState<HelperMode>("offline");
  const [settingsProvider, setSettingsProvider] = useState("openai");
  const [settingsModel, setSettingsModel] = useState("");
  const [settingsCredential, setSettingsCredential] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const continuityRef = useRef<HelperContinuity>(loadContinuity());
  const getContext = useKeeperContext();
  const scrollRef = useRef<HTMLDivElement>(null);
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const agents = useWorldStore(s => s.agents);
  const hasTrouble = !gatewayReady || agents.some(a => a.status === "error");

  useEffect(() => {
    invoke<HelperConfig>("get_canopy_helper_config").then(config => {
      setHelperConfig(config);
      setSettingsMode(config.mode);
      setSettingsProvider(config.provider || "openai");
      setSettingsModel(config.model || "");
    }).catch(() => { /* offline remains default */ });
  }, []);

  // Eddy in the world (or anything else) can open the panel via this event.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("canopy:open-keeper", onOpen);
    return () => window.removeEventListener("canopy:open-keeper", onOpen);
  }, []);

  // During onboarding the panel opens by default — once.
  useEffect(() => {
    if (
      activeView === "onboarding" &&
      !localStorage.getItem(ONBOARDING_AUTOOPEN_KEY) &&
      !localStorage.getItem(LEGACY_ONBOARDING_AUTOOPEN_KEY)
    ) {
      localStorage.setItem(ONBOARDING_AUTOOPEN_KEY, "1");
      setOpen(true);
      if (messages.length === 0) {
        setMessages([{
          role: "assistant",
          ts: Date.now(),
          content: `Hey — I'm Eddy. I keep the reef running around here. I'll hang out in the corner while you set up; if anything gets confusing or stuck, just ask. ${EDDY_FEEDBACK_NUDGE}`,
        }]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

  useEffect(() => {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-40))); } catch { /* ignore */ }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput("");
    const userMsg: KeeperMsg = { role: "user", content, ts: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setBusy(true);

    const ctx = await getContext();
    const continuity = updateContinuity(continuityRef.current, content, agents);
    const feedbackKind = inferFeedbackKind(content);
    const feedbackDraft = feedbackKind
      ? buildFeedbackDraft(content, feedbackKind, selectedAgentId, continuity, agents)
      : undefined;
    continuityRef.current = continuity;
    try { localStorage.setItem(CONTINUITY_KEY, JSON.stringify(continuity)); } catch { /* ignore */ }
    try {
      // Refresh on every send so Eddy switches to a newly connected provider
      // immediately, without requiring an app restart or reopening the panel.
      const activeConfig = await invoke<HelperConfig>("get_canopy_helper_config").catch(() => helperConfig);
      setHelperConfig(activeConfig);
      if (activeConfig.mode === "offline") throw new Error("provider not connected");
      const reply = String((await invoke<any>("send_canopy_helper_message", { message: content, context: ctx, continuity }))?.reply || "").trim();
      if (!reply) throw new Error("empty reply");
      const parsed = parseKeeperReply(reply);
      const assistantContent = feedbackDraft ? `${parsed.text}\n\n${feedbackDraft.prompt}` : parsed.text;
      setMessages(prev => [...prev, { role: "assistant", content: assistantContent, action: parsed.action, feedbackDraft, ts: Date.now() }]);
    } catch (e) {
      // Offline fallback: rule-based diagnosis from live context. Eddy must
      // never be the thing that's broken with no explanation.
      console.warn("Keeper endpoint unreachable, using local diagnosis:", e);
      const parsed = parseKeeperReply(offlineDiagnosis(ctx, content));
      const assistantContent = feedbackDraft ? `${parsed.text}\n\n${feedbackDraft.prompt}` : parsed.text;
      setMessages(prev => [...prev, { role: "assistant", content: assistantContent, action: parsed.action, feedbackDraft, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  };

  const relayFeedbackToEngineer = async (report: SubmittedFeedbackReport) => {
    const engineer = pickEngineerAgent(agents);
    if (!engineer) return null;

    const contextText = JSON.stringify(report.context ?? {}, null, 2).slice(0, 4000);
    const message = [
      `A user asked Eddy to relay a ${report.kind.replace(/_/g, " ")} about the Canopy product experience.`,
      `Report ID: ${report.id}`,
      `Title: ${report.title}`,
      report.agentId ? `Related agent: ${report.agentId}` : "",
      `Description:\n${report.description}`,
      contextText ? `Diagnostics context:\n${contextText}` : "",
      "Please triage this, reproduce it if needed, and either fix it or propose the smallest correct implementation plan.",
    ]
      .filter(Boolean)
      .join("\n\n");

    await invoke("send_message", {
      agentId: engineer.id,
      message,
      sessionId: null,
    });
    await invoke("mark_feedback_report_dispatched", {
      reportId: report.id,
      agentId: engineer.id,
    });

    return engineer;
  };

  const submitFeedbackDraft = async (messageTs: number, draft: KeeperFeedbackDraft) => {
    if (submittingFeedbackTs === messageTs) return;
    setSubmittingFeedbackTs(messageTs);
    try {
      const report = await invoke<SubmittedFeedbackReport>("submit_feedback_report", {
        submission: {
          kind: draft.kind,
          title: draft.title,
          description: draft.description,
          agentId: draft.agentId,
          currentView: activeView,
          includeDiagnostics: true,
        },
      });
      const engineer = await relayFeedbackToEngineer(report);
      setMessages((prev) => [
        ...prev.map((msg) => msg.ts === messageTs ? { ...msg, feedbackSent: true } : msg),
        {
          role: "assistant",
          ts: Date.now(),
          content: engineer
            ? `I sent that to the Canopy developers and handed it to ${engineer.name} inside this workspace.`
            : "I sent that to the Canopy developers. Slack notifications will still fire if a webhook is configured, but there isn't an engineer agent available in this workspace right now.",
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          ts: Date.now(),
          content: `I couldn't relay that just now: ${String(error)}`,
        },
      ]);
    } finally {
      setSubmittingFeedbackTs(null);
    }
  };

  const saveHelperSettings = async () => {
    setSettingsError("");
    try {
      const config = await invoke<HelperConfig>("configure_canopy_helper", {
        mode: settingsMode,
        provider: settingsMode === "provider" ? settingsProvider : null,
        credential: settingsMode === "provider" && settingsCredential ? settingsCredential : null,
        model: settingsMode === "offline" ? null : (settingsModel || null),
      });
      setHelperConfig(config);
      setSettingsCredential("");
      setShowSettings(false);
    } catch (error) { setSettingsError(String(error)); }
  };

  const statusDot = useMemo(() => (
    hasTrouble ? "#E07A3F" : "#4A9E96"
  ), [hasTrouble]);

  if (activeView === "loading") return null;

  // On the Canopy view, Eddy's reef cave (bottom-left, EddyCorner) is the
  // opener — the pill would be a duplicate affordance, so it hides there.
  // Hidden on canopy (embodied Eddy lives there) and during onboarding (the
  // wizard has its own Eddie surface — one Eddie per screen).
  const showPill = !open && activeView !== "canopy" && activeView !== "onboarding";

  return (
    <>
      {/* Pill */}
      {showPill && (
        <button
          onClick={() => setOpen(true)}
          title="Eddy — your Canopy guide"
          style={{
            position: "fixed", bottom: 20, right: 20, zIndex: 9000,
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 14px 8px 8px", borderRadius: 999,
            border: `1.5px solid ${EDDY_GOLD}55`,
            background: "var(--surface-card, #fff)",
            boxShadow: "0 8px 28px rgba(48,51,48,0.16)",
            cursor: "pointer", fontFamily: "inherit",
          }}
        >
          <span style={{ position: "relative", display: "inline-flex" }}>
            <LobsterIcon size={28} shellColor={EDDY_GOLD} accentColor={EDDY_GOLD_LIGHT} />
            <span style={{
              position: "absolute", top: -1, right: -1, width: 9, height: 9, borderRadius: "50%",
              background: statusDot, border: "1.5px solid var(--surface-card, #fff)",
            }} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main, #303330)" }}>Eddy</span>
        </button>
      )}

      {/* Panel */}
      {open && (
        <div data-keeper-panel="true" style={{
          position: "fixed", bottom: 20, right: 20, zIndex: 9000,
          width: 320, height: "min(480px, calc(100vh - 80px))",
          display: "flex", flexDirection: "column",
          background: "var(--surface-card, #fff)",
          border: `1.5px solid ${EDDY_GOLD}40`,
          borderRadius: 18, overflow: "hidden",
          boxShadow: "0 20px 60px rgba(48,51,48,0.22)",
          fontFamily: "'Manrope', system-ui, sans-serif",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
            background: `linear-gradient(135deg, ${EDDY_TEAL}18, ${EDDY_GOLD}14)`,
            borderBottom: "1px solid rgba(0,0,0,0.06)",
          }}>
            <LobsterIcon size={30} shellColor={EDDY_GOLD} accentColor={EDDY_GOLD_LIGHT} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-main, #303330)" }}>Eddy</div>
              <div style={{ fontSize: 11, color: "var(--text-sub, #636E72)", display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusDot, display: "inline-block" }} />
                {hasTrouble ? "Something needs attention" : `All systems healthy · ${helperConfig.mode === "local" ? "On-device" : helperConfig.mode === "provider" ? "Your provider" : "Local guidance"}`}
              </div>
            </div>
            <button onClick={() => setShowSettings(v => !v)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: "var(--text-sub, #636E72)", padding: 4 }} title="Eddy privacy and model settings">⚙</button>
            <button onClick={() => setOpen(false)} style={{
              border: "none", background: "transparent", cursor: "pointer",
              fontSize: 18, color: "var(--text-sub, #636E72)", padding: 4, lineHeight: 1,
            }} title="Close">×</button>
          </div>

          {showSettings && (
            <div style={{ padding: 12, borderBottom: "1px solid rgba(0,0,0,0.08)", background: "var(--surface-base, #faf9f6)", fontSize: 11.5 }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Eddy privacy mode</div>
              <select value={settingsMode} onChange={e => setSettingsMode(e.target.value as HelperMode)} style={{ width: "100%", padding: 7, borderRadius: 8, marginBottom: 7 }}>
                <option value="offline">Local guidance — no model</option>
                <option value="provider">My provider — direct from this Mac</option>
                <option value="local">On-device — Ollama</option>
              </select>
              {settingsMode === "provider" && <>
                <select value={settingsProvider} onChange={e => setSettingsProvider(e.target.value)} style={{ width: "100%", padding: 7, borderRadius: 8, marginBottom: 7 }}>
                  <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="xai">xAI Grok</option>
                </select>
                <input type="password" value={settingsCredential} onChange={e => setSettingsCredential(e.target.value)} placeholder={helperConfig.credentialPresent ? "Connected key found — blank keeps it" : "Optional dedicated Eddy API key"} style={{ width: "100%", boxSizing: "border-box", padding: 7, borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)", marginBottom: 7 }} />
              </>}
              {settingsMode !== "offline" && <input value={settingsModel} onChange={e => setSettingsModel(e.target.value)} placeholder={settingsMode === "local" ? "Ollama model, e.g. llama3.2:3b" : "Model (optional)"} style={{ width: "100%", boxSizing: "border-box", padding: 7, borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)", marginBottom: 7 }} />}
              <div style={{ color: "var(--text-sub, #636E72)", lineHeight: 1.4, marginBottom: 8 }}>{settingsMode === "offline" ? "No message leaves this Mac. Eddy uses built-in setup diagnostics." : settingsMode === "provider" ? "Uses an already connected provider key automatically, or the optional dedicated key above. Requests go directly from this Mac." : "Requests stay on this Mac through Ollama."}</div>
              {settingsError && <div style={{ color: "#b42318", marginBottom: 7 }}>{settingsError}</div>}
              <button onClick={saveHelperSettings} style={{ width: "100%", padding: 7, border: "none", borderRadius: 8, background: "#3c6663", color: "#fff", fontWeight: 800, cursor: "pointer" }}>Save privacy mode</button>
            </div>
          )}

          {/* Messages */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-sub, #636E72)", lineHeight: 1.6, padding: "8px 4px" }}>
                I'm Eddy — I keep the reef running. Ask me about setup, why an agent isn't responding, or what to try next. {EDDY_FEEDBACK_NUDGE}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={m.ts + ":" + i} style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%", display: "flex", flexDirection: "column", gap: 6,
              }}>
                <div style={{
                  padding: "8px 12px", borderRadius: 12,
                  fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap",
                  background: m.role === "user" ? "#3c6663" : "rgba(212,168,67,0.10)",
                  color: m.role === "user" ? "#fff" : "var(--text-main, #303330)",
                  border: m.role === "user" ? "none" : `1px solid ${EDDY_GOLD}30`,
                }}>{m.content}</div>
                {m.action && (
                  <button
                    onClick={() => runKeeperAction(m.action!)}
                    style={{
                      alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "7px 12px", borderRadius: 10, cursor: "pointer",
                      border: `1.5px solid ${EDDY_GOLD}66`, background: `${EDDY_GOLD}14`,
                      color: "#8A6614", fontSize: 12, fontWeight: 800, fontFamily: "inherit",
                    }}
                  >
                    Take me there
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                  </button>
                )}
                {m.feedbackDraft && !m.feedbackSent && (
                  <button
                    onClick={() => submitFeedbackDraft(m.ts, m.feedbackDraft!)}
                    disabled={submittingFeedbackTs === m.ts}
                    style={{
                      alignSelf: "flex-start",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 12px",
                      borderRadius: 10,
                      cursor: submittingFeedbackTs === m.ts ? "default" : "pointer",
                      border: "1px solid rgba(60,102,99,0.24)",
                      background: "rgba(60,102,99,0.08)",
                      color: "#3c6663",
                      fontSize: 12,
                      fontWeight: 800,
                      fontFamily: "inherit",
                      opacity: submittingFeedbackTs === m.ts ? 0.75 : 1,
                    }}
                  >
                    {submittingFeedbackTs === m.ts ? "Sending to Canopy..." : "Send to Canopy developers"}
                  </button>
                )}
              </div>
            ))}
            {busy && (
              <div style={{ alignSelf: "flex-start", padding: "8px 12px", borderRadius: 12, background: "rgba(212,168,67,0.10)", border: `1px solid ${EDDY_GOLD}30`, fontSize: 12.5, color: "var(--text-sub, #636E72)" }}>
                <span style={{ display: "inline-block", width: 10, height: 10, border: `2px solid ${EDDY_GOLD}50`, borderTopColor: EDDY_GOLD, borderRadius: "50%", animation: "spin 1s linear infinite", marginRight: 6, verticalAlign: -1 }} />
                thinking…
              </div>
            )}
          </div>

          {/* Quick actions when trouble is visible */}
          {hasTrouble && !busy && (
            <div style={{ padding: "0 12px 8px" }}>
              <button onClick={() => send("Something seems broken — can you check my setup and tell me what's wrong?")} style={{
                width: "100%", padding: "8px 10px", borderRadius: 10, cursor: "pointer",
                border: "1px solid rgba(224,122,63,0.4)", background: "rgba(224,122,63,0.08)",
                color: "#B25426", fontSize: 12, fontWeight: 700, fontFamily: "inherit",
              }}>Diagnose what's wrong</button>
            </div>
          )}

          {/* Input */}
          <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Tell Eddy what's wrong or what you wish worked better…"
              style={{
                flex: 1, padding: "10px 12px", borderRadius: 10, fontSize: 13,
                border: "1px solid rgba(0,0,0,0.12)", outline: "none",
                background: "var(--surface-base, #faf9f6)", color: "var(--text-main, #303330)",
                fontFamily: "inherit",
              }}
            />
            <button onClick={() => send()} disabled={busy || !input.trim()} style={{
              padding: "10px 14px", borderRadius: 10, border: "none",
              background: busy || !input.trim() ? "var(--border-subtle, #e5e0d8)" : "#3c6663",
              color: busy || !input.trim() ? "var(--text-muted, #9aa)" : "#fff",
              fontSize: 13, fontWeight: 700, cursor: busy || !input.trim() ? "default" : "pointer",
              fontFamily: "inherit",
            }}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}
