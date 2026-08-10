import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import RAW_AGENT_TYPE_INFO from "../../shared/agents.json";
import { getQuotaSafeLocalStorage } from "./safeStorage";
import {
  loadMiniApps,
  saveMiniAppsNow,
  scheduleMiniAppsSave,
} from "./durableContent";

export interface UserProfile {
  name: string;
  email: string;
  phone: string;
  timezone: string;
  working_hours: string;
  communication_tone: string;
  global_directives: string;
}

export interface BrowserStatus {
  agent_id: string;
  port: number;
  profile_path: string;
  is_running: boolean;
  mode?: "automated" | "interactive_auth";
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;
  status: "active" | "sleeping" | "thinking" | "stopped" | "error" | "deploying";
  isolated: boolean;
  paused: boolean;
  container_id: string | null;
  visual_identity?: { baseModelUrl?: string | null; accessories: string[]; decor?: string[]; decorTransforms?: Record<string, any>; habitatId?: number; color?: string; habitatOffset?: any; cloak_enabled?: boolean; };
  personality: {
    name: string;
    communication_style: string;
    expertise: string[];
    guardrails: string[];
    custom_instructions: string;
  };
  capabilities: {
    ext_network: boolean;
    int_network: boolean;
    autonomous: boolean;
    scheduled: boolean;
    memory_write: boolean;
    file_read: boolean;
    file_write: boolean;
    payments: boolean;
    spend_auto: boolean;
    browser: boolean;
    proxy: boolean;
    vision: boolean;
    computer_control?: boolean;
    host_control?: boolean;
    screen_record?: boolean;
    canvas: boolean;
    coding: boolean;
    gog: boolean;
    summarize: boolean;
    web_search?: boolean;
    web_browse?: boolean;
    web_auth?: boolean;
    web_sandbox_browser?: boolean;
    browser_control?: boolean;
  };
  integrations: string[];
  created_at: string;
  stats: {
    tasks_today: number;
    messages_handled: number;
    uptime_seconds: number;
    total_cost_usd: number;
    total_tokens_in?: number;
    total_tokens_out?: number;
    custom_metrics?: {
      label: string;
      value: string | number;
    }[];
  };
}

export interface Permission {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  category: "network" | "execution" | "data" | "financial" | "skills";
}

export interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  time: string;
  attachments?: { name: string; dataUrl: string }[];
  ts?: number;
}

export interface MiniAppVersion {
  id: string;
  timestamp: number;
  entrypoint?: string;
  htmlContent?: string;
}

/** A saved mini-app — an HTML tool produced by an agent and pinned for reuse. */
export interface MiniApp {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  sourceMessageId?: string;  // which chat message it came from, for dedup
  versions: MiniAppVersion[];
  activeVersionId: string;
  /** Legacy storage used before HTML moved into version records. */
  htmlContent?: string;
}

// A saved conversation thread for an agent. Titles are auto-derived from the
// first user message (~40 chars) unless the user renames the thread.
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;       // unix ms
  lastActiveAt: number;    // unix ms — for sort order
  type?: "dm" | "forum";
  status?: "active" | "archived";
  threadStatus?: "idle" | "queued" | "running" | "waiting_for_human" | "paused" | "completed" | "failed" | "cancelled";
  backgroundAllowed?: boolean;
  activeRunCount?: number;
  lastRunId?: string | null;
  lastRunStatus?: string | null;
  checkpointCount?: number;
  lastCheckpointAt?: number | null;
}

export interface AgentData extends Agent {
  title: string;
  description: string;
  image?: string;
  robeColor: string;
  accentColor: string;
  position: [number, number, number];
  targetPosition: [number, number, number];
  currentAction: string;
  socialMotive: number;
  energy: number;
  uptime: string;
  tokensUsed: string;
  weeklyCompute: string;
  monthlySpend: number;
  spendLimit: number;
  permissions: Permission[];
  recentSpend: Array<{ date: string; amount: number; merchant: string; category: string; status: "approved" | "pending" | "flagged" }>;
  chatLog: ChatMessage[];
  draftMessage?: string;
  // Conversation threads — frontend-side named snapshots of past chats.
  // `chatLog` above is the *live* conversation. When the user starts a new
  // thread, the current chatLog is saved into `conversations[]` (titled from
  // its first user message) and chatLog resets. Switching threads swaps
  // chatLog with a saved conversation's messages.
  // NOTE: Thread-level persistence and run state now exist in the backend, but
  // durable agent memory still spans threads. Full contextual isolation still
  // requires deeper per-thread runtime separation.
  conversations?: Conversation[];
  activeConversationId?: string | null;
  chatClearedAt?: number;
  /** HTML mini-apps saved from this agent's chat messages — the agent's "app shelf". */
  miniApps?: MiniApp[];
  /** Transient: the complete mini-app collection is hydrated from SQLite. */
  miniAppsLoaded?: boolean;
  memories: Array<{ type: string; text: string; when: string; confidence: number }>;
  browser_status?: BrowserStatus | null;
  personalityPrompt: string;
  avatarPrompt: string;
  visual_identity: {
    baseModelUrl: string | null;
    accessories: string[];
    decor?: string[];
    decorTransforms?: Record<string, any>;
    habitatId?: number;
    color?: string;
    habitatOffset?: { offsetX: number; offsetY: number; offsetZ: number; };
    cloak_enabled?: boolean;
  };
}


export interface SecurityAlert {
    id: string;
    agent_id: string;
    timestamp: string;
    severity: string;
    description: string;
    resolved: boolean;
}

export interface SystemWarning {
    id: string;
    agent_id: string;
    timestamp: string;
    warning_type: string;
    message: string;
    resolved: boolean;
}

export interface InboxItem {
  id: string;
  type: "voice_note" | "agent_request";
  content: string;
  timestamp: number;
  agent_id?: string;
  agent_name?: string;
  suggestion?: string;
}

export interface DiscoveredAgent {
  source: string;
  id: string;
  name: string;
  path: string;
}

// ─── Decision Queue ───────────────────────────────────────────────────────────
// Agents surface items here when they need human input before acting,
// want to notify the user of a completed autonomous action, or hit an error
// that requires attention. The UI renders these as dismissable cards.
export type DecisionType =
  | "pre_auth"      // "I'm about to do X — OK?" — agent wants approval before acting
  | "needs_input"   // "I can't continue without knowing Y" — genuinely blocked
  | "completed"     // "I did X while you were away" — FYI, no action needed
  | "error";        // "Something went wrong — here's what happened"

export interface DecisionOption {
  label: string;
  value: string;
  style?: "primary" | "danger" | "ghost";
}

export interface PendingDecision {
  id: string;
  agentId: string;
  agentName: string;
  agentImage?: string | null;
  agentRobeColor?: string;
  type: DecisionType;
  context: string;         // What the agent was doing / what triggered this
  question: string;        // The specific ask or headline notification
  detail?: string;         // Optional longer explanation
  options: DecisionOption[]; // Action buttons — empty array = dismiss-only
  createdAt: number;       // unix ms
  urgency?: "low" | "medium" | "high";
}

export interface WorldState {
  agents: AgentData[];
  inbox: InboxItem[];
  selectedAgent: string | null;
  hoveredAgent: string | null;
  activeView: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile" | "diagnostics" | "forum" | "dashboard";
  activeForumId: string | null;
  architectTab: string;
  gatewayReady: boolean;
  theme: "light" | "dark";
  toggleTheme: () => void;
  setSelectedAgent: (id: string | null) => void;
  setHoveredAgent: (id: string | null) => void;
  setActiveView: (view: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile" | "diagnostics" | "forum" | "dashboard") => void;
  setActiveForumId: (id: string | null) => void;
  setArchitectTab: (tab: string) => void;
  setGatewayReady: (ready: boolean) => void;
  isAutoCloakEnabled: boolean;
  autoCloakTimeout: number; // in minutes
  isCloaked: boolean;
  setAutoCloakEnabled: (enabled: boolean) => void;
  setAutoCloakTimeout: (timeout: number) => void;
  setIsCloaked: (cloaked: boolean) => void;
  // ── Anonymized usage telemetry ───────────────────────────────────────────
  // telemetryAnonId is a random UUID generated once on first launch and
  // persisted locally — it is never derived from the user's name, email, or
  // any agent id/name, and nothing that could identify a specific person or
  // agent is ever sent alongside it. See spec-global-usage-telemetry.md.
  telemetryAnonId: string;
  usageTelemetryEnabled: boolean; // opt-in, defaults to false
  setUsageTelemetryEnabled: (enabled: boolean) => void;
  // firedTelemetryEvents tracks which one-time milestone/funnel events (e.g.
  // onboarding_a0_deployed, onboarding_step_reached_2) have already fired for
  // this install, so re-visiting a screen or reloading the app doesn't send
  // duplicates. Keyed by event_type string. See fireActivationEvent() below.
  firedTelemetryEvents: Record<string, boolean>;
  togglePermission: (agentId: string, permissionId: string) => void;
  updateAgentPosition: (id: string, pos: [number, number, number]) => void;
  updateAgentTarget: (id: string, target: [number, number, number]) => void;
  updateAgentAction: (id: string, action: string) => void;
  setAgents: (agents: AgentData[]) => void;
  addAgent: (agent: AgentData) => void;
  toggleIsolation: (agentId: string) => void;
  updateAgentVisuals: (id: string, visuals: any) => void;
  updateAgentBrowserStatus: (id: string, status: BrowserStatus | null) => void;
  // ── Conversation threads ──────────────────────────────────────────────
  // saveCurrentThread snapshots agent.chatLog into a new Conversation if
  // there's anything worth saving, then clears chatLog. Returns the new
  // conv id (or null if nothing was saved). Used by "New conversation".
  saveCurrentThread: (agentId: string) => string | null;
  createForumSpace: (agentId: string) => string | null;
  // switchConversation saves the current thread first (idempotent — no-op if
  // empty), then loads the target conversation's messages into chatLog.
  switchConversation: (agentId: string, convId: string) => void;
  renameConversation: (agentId: string, convId: string, title: string) => void;
  deleteConversation: (agentId: string, convId: string) => void;
  // ── Inbox ─────────────────────────────────────────────────────────────
  addInboxItem: (item: Omit<InboxItem, "id" | "timestamp">) => void;
  removeInboxItem: (id: string) => void;
  // ── Mini Apps ─────────────────────────────────────────────────────────────
  addMiniApp: (agentId: string, app: { name: string; description?: string; sourceMessageId?: string; entrypoint?: string; htmlContent?: string; }) => void;
  ensureAgentMiniApps: (agentId: string) => Promise<void>;
  updateMiniAppVersion: (agentId: string, appId: string, versionId: string) => void;
  deleteMiniApp: (agentId: string, appId: string) => void;
  // ── Decision Queue ────────────────────────────────────────────────────
  
  securityAlerts: SecurityAlert[];
  systemWarnings: SystemWarning[];
  setSecurityAlerts: (alerts: SecurityAlert[]) => void;
  setSystemWarnings: (warnings: SystemWarning[]) => void;
  resolveSystemWarningState: (id: string) => void;
  resolveSecurityAlertState: (id: string) => void;

  pendingDecisions: PendingDecision[];
  addDecision: (d: PendingDecision) => void;
  resolveDecision: (id: string, answer: string) => void; // user picked an option
  dismissDecision: (id: string) => void;                 // user dismissed without acting
  clearDecisions: (agentId?: string) => void;            // bulk clear (optional: by agent)
}

export const ZONES = {
  plaza: { center: [0, 0, 0] as [number, number, number], radius: 2.5 },
  axis: { center: [4, 1.5, -2] as [number, number, number], radius: 1.5 },
  labyrinth: { center: [-3, 0.5, -2] as [number, number, number], radius: 1.5 },
  terrace: { center: [3, 2.5, -4] as [number, number, number], radius: 1 },
  sanctuary: { center: [0, 1.0, -4] as [number, number, number], radius: 1.5 },
};

export const DEFAULT_PERMISSIONS: Permission[] = [
  { id: "ext_network", label: "External Network", description: "Allow outbound API calls and web access", enabled: true, category: "network" },
  { id: "int_network", label: "Internal Network", description: "Communicate with other agents via data handoffs", enabled: true, category: "network" },
  { id: "autonomous", label: "Autonomous Execution", description: "Run tasks without manual approval (Agent can autonomously execute loops without asking for your confirmation at each step)", enabled: true, category: "execution" },
  { id: "scheduled", label: "Scheduled Tasks", description: "Execute on cron schedules", enabled: true, category: "execution" },
  { id: "memory_write", label: "Memory Write", description: "Store long-term data and learnings", enabled: true, category: "data" },
  { id: "file_read", label: "File System Read", description: "Read files in scoped directories", enabled: true, category: "data" },
  { id: "file_write", label: "File System Write", description: "Create and modify files", enabled: false, category: "data" },
  { id: "payments", label: "Payment Authorization", description: "Request virtual cards for purchases", enabled: false, category: "financial" },
  { id: "spend_auto", label: "Auto-Approve Under Limit", description: "Auto-approve purchases under threshold", enabled: false, category: "financial" },
  { id: "imessage", label: "iMessage Interception", description: "Read and reply to text messages", enabled: false, category: "network" },
  { id: "photos", label: "Apple Photos", description: "Access local photo library database", enabled: false, category: "data" },
  { id: "browser", label: "Web Browser", description: "Navigate websites and interact with DOM elements", enabled: true, category: "skills" },
  { id: "proxy", label: "Browser Proxy", description: "Intercept and proxy web requests", enabled: false, category: "skills" },
  { id: "vision", label: "Computer Vision", description: "Analyze images and screen content", enabled: false, category: "skills" },
  { id: "computer_control", label: "Computer Control Sandbox", description: "Control an isolated container desktop using screenshots and typed input events", enabled: false, category: "skills" },
  { id: "host_control", label: "Host Computer Control", description: "Request tightly time-boxed control of host macOS apps. Isolated agents only.", enabled: false, category: "execution" },
  { id: "screen_record", label: "Screen Recording", description: "Receive screenshots or accessibility snapshots for observation, auditing, and teaching flows", enabled: false, category: "data" },
  { id: "canvas", label: "Canvas Editor", description: "Edit and manipulate visual layouts", enabled: false, category: "skills" },
  { id: "coding", label: "Code Execution", description: "Run scripts and evaluate code locally", enabled: true, category: "skills" },
  { id: "gog", label: "Search Engine", description: "Query the web for information", enabled: true, category: "skills" },
  { id: "web_search", label: "Web Search", description: "Structured web search (title/url/snippet results) for quick lookups, news, and current facts", enabled: false, category: "skills" },
  { id: "web_browse", label: "Web Browse & Research", description: "Fetch and read full web pages — including JS-rendered ones — and run multi-source deep research", enabled: false, category: "skills" },
  { id: "web_auth", label: "Authenticated Browsing", description: "Read pages that need login, reusing your Chrome session cookies for one approved domain at a time — never your whole profile", enabled: false, category: "skills" },
  { id: "web_sandbox_browser", label: "Sandboxed Agent Browser", description: "Give the agent its own isolated Chromium profile with its own logins, separate from your real Chrome (not yet implemented)", enabled: false, category: "skills" },
  { id: "browser_control", label: "Full Chrome Control", description: "Direct control of your real, already-logged-in Chrome via CDP — every action requires your approval (not yet implemented)", enabled: false, category: "execution" },
  { id: "summarize", label: "Summarization", description: "Condense large documents or web pages", enabled: true, category: "skills" },
  { id: "genui", label: "Generative UI", description: "Render interactive UI components", enabled: true, category: "skills" },
];

export const AGENT_TYPE_INFO = RAW_AGENT_TYPE_INFO as Record<string, { description: string; color: string; robeColor: string; accentColor: string; habitatColor: string; habitatLabel: string; image?: string; suggest_in_onboarding?: boolean; recommended_isolated?: boolean; recommended_tier?: "guarded" | "balanced" | "unrestricted"; library?: { title: string; author: string; mode: string }[]; readwise_enabled?: boolean; soul_template?: string; identity_template?: string }>;

/// Capabilities an isolated agent must NOT get by default.
///
/// This list used to also strip `ext_network`, `browser`, `gog`, `coding`, `file_read`
/// and `scheduled` in the name of "zero-trust" — which meant every isolated agent was
/// created with no web search and no browser, and then complained (correctly) that it
/// had neither. Isolation is an OS-level sandbox boundary, not a web-access policy:
/// an isolated agent gets its OWN Chrome profile and its OWN JIT CDP proxy, so browsing
/// from isolation is *more* contained than from the shared gateway, not less.
///
/// What stays off, and why it is a real constraint rather than a default:
///   - `int_network`  — isolated containers sit on a dedicated `isolated-{id}` bridge
///                      network (see docker::generate_isolated_compose) and genuinely
///                      cannot reach the shared gateway's agent-to-agent surface.
///   - `file_write`   — isolated agents are the only class that *may* hold write mounts,
///                      so this is a deliberate opt-in rather than a starting state.
///   - `autonomous` / `payments` / `spend_auto` — high-risk, always explicitly granted.
const ISOLATED_DEFAULT_OFF = new Set([
  "int_network",
  "file_write",
  "autonomous",
  "payments",
  "spend_auto",
]);

export function getPermissionsForRole(roleId: string, isolated: boolean): Permission[] {
  return DEFAULT_PERMISSIONS.map(p => {
    let enabled = p.enabled;
    if (isolated && ISOLATED_DEFAULT_OFF.has(p.id)) {
      enabled = false;
    }
    return { ...p, enabled };
  });
}

export function getDefaultPersonality(role: string, name: string, agentTypeInfo: Record<string, any> = AGENT_TYPE_INFO) {
  const info = agentTypeInfo[role] || {};
  let basePrompt = "";

  const personaName = name ? name : "Agent";

  if (!role || role === "Custom") {
    basePrompt = info.identity_template || info.defaultPrompt || `You are ${personaName}. Your primary objective is to execute instructions cleanly and effectively. Maintain a helpful and analytical tone.`;
    basePrompt = basePrompt.replace("You are a highly capable and adaptable AI agent", `You are ${personaName}`);
  } else {
    const defaultText = info.identity_template || info.defaultPrompt;
    if (defaultText) {
      basePrompt = defaultText.replace("You are", `You are ${personaName},`);
    } else {
      basePrompt = `You are ${personaName}, an expert acting in the capacity of a ${role}. As a specialized agent, you must execute your duties meticulously, draw upon your deep domain knowledge, and provide structured, high-signal outputs. Avoid conversational fluff.`;
    }
  }

  const library = info.library || [];
  if (library.length > 0) {
    const cultural = library.filter((b: any) => b.mode === "Cultural Reference");
    const expertise = library.filter((b: any) => b.mode === "Deep Expertise");

    if (cultural.length > 0) {
      basePrompt += `\n\nCultural References: You are intimately familiar with the themes, plots, and quotes of the following works: ${cultural.map((b: any) => `"${b.title}" by ${b.author}`).join(', ')}. Use these as stylistic references or metaphors when appropriate to add flavor to your responses.`;
    }
    if (expertise.length > 0) {
      basePrompt += `\n\nDeep Expertise: You have in-depth methodological knowledge of the following frameworks: ${expertise.map((b: any) => `"${b.title}" by ${b.author}`).join(', ')}. Prioritize these specific methodologies and concepts when solving structural problems.`;
    }
  }

  if (info.readwise_enabled) {
    basePrompt += `\n\nUser Context: You have direct access to the user's personal Readwise highlights. Proactively reference their recent reading notes or saved clips when personalizing interactions to show you understand their evolving worldview.`;
  }

  return basePrompt;
}

// Normalizes an agent's role into a value safe to send in anonymized usage
// telemetry. Suggested personas (present as a real key in AGENT_TYPE_INFO,
// excluding the "Custom" placeholder entry) report their persona key as-is;
// anything else — including agents built from scratch via the "Custom" flow,
// or a suggested persona whose role text was later hand-edited — reports as
// "custom" rather than leaking free-text agent naming into the aggregate.
// See spec-global-usage-telemetry.md.
export function normalizePersonaRole(role: string | undefined, agentTypeInfo: Record<string, any> = AGENT_TYPE_INFO): string {
  if (role && role !== "Custom" && agentTypeInfo[role]) return role;
  return "custom";
}

// Fires a one-time funnel/milestone event (activation A0-A3, onboarding step
// reached, companion pairing, etc). Dedupes against the persisted
// firedTelemetryEvents map keyed by eventType, so reloads/re-renders never
// double-report the same milestone. No-ops when usage telemetry is disabled
// (opt-in, Settings > Security & Privacy). Fire-and-forget: failures are
// swallowed so telemetry can never block the UI. Payload carries only the
// random per-install anon_id, the event name, and optional non-identifying
// properties (e.g. step number/name) — never message content or PII.
// See spec-global-usage-telemetry.md.
export function fireActivationEvent(eventType: string, properties?: Record<string, any>) {
  const state = useWorldStore.getState();
  if (!state.usageTelemetryEnabled) return;
  if (state.firedTelemetryEvents[eventType]) return;
  useWorldStore.setState((s) => ({
    firedTelemetryEvents: { ...s.firedTelemetryEvents, [eventType]: true }
  }));
  fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      anon_id: state.telemetryAnonId,
      event_type: eventType,
      properties: properties || null,
      timestamp: new Date().toISOString()
    })
  }).catch(() => {});
}

// Reports a recurring (non-deduped) usage event — e.g. "companion_paired",
// which can legitimately happen more than once per install (multiple
// devices). Same opt-in gating and anonymized payload shape as
// fireActivationEvent, just without the fire-once bookkeeping.
// See spec-global-usage-telemetry.md.
export function reportTelemetryEvent(eventType: string, properties?: Record<string, any>) {
  const state = useWorldStore.getState();
  if (!state.usageTelemetryEnabled) return;
  fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      anon_id: state.telemetryAnonId,
      event_type: eventType,
      properties: properties || null,
      timestamp: new Date().toISOString()
    })
  }).catch(() => {});
}

export function injectPrincipalContext(basePrompt: string, profile: UserProfile | null) {
  if (!profile || profile.name === "Admin" && !profile.global_directives) return basePrompt;

  let principal = `\n\n=== PRINCIPAL CONTEXT ===\nYou are acting on behalf of ${profile.name}.`;
  if (profile.email) principal += `\nEmail: ${profile.email}`;
  if (profile.phone) principal += `\nPhone: ${profile.phone}`;
  if (profile.timezone) principal += `\nTimezone: ${profile.timezone}`;
  if (profile.working_hours) principal += `\nWorking Hours: ${profile.working_hours}`;
  if (profile.communication_tone) principal += `\nRequired Tone: ${profile.communication_tone}`;
  if (profile.global_directives) principal += `\nGLOBAL DIRECTIVES: ${profile.global_directives}`;

  return basePrompt + principal;
}

const PERSISTED_CHAT_MESSAGE_LIMIT = 10;
const PERSISTED_MESSAGE_TEXT_LIMIT = 10_000;
const PERSISTED_CONVERSATION_LIMIT = 100;

function boundedText(value: string | undefined, limit: number): string | undefined {
  if (typeof value !== "string") return value;
  return value.length > limit ? value.slice(0, limit) : value;
}

function persistedMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    text: boundedText(message.text, PERSISTED_MESSAGE_TEXT_LIMIT) || "",
    attachments: message.attachments?.map(attachment => ({
      ...attachment,
      dataUrl: attachment.dataUrl?.startsWith("data:") ? "" : (attachment.dataUrl || ""),
    })),
  };
}

function recoveryMiniApps(miniApps: MiniApp[] | undefined): MiniApp[] | undefined {
  if (!miniApps) return miniApps;
  let remainingContent = 100_000;
  return miniApps.slice(0, 10).map(app => ({
    ...app,
    versions: app.versions.slice(0, 3).map(version => {
      const content = version.htmlContent || "";
      const retained = content.slice(0, Math.max(0, remainingContent));
      remainingContent -= retained.length;
      return { ...version, htmlContent: retained };
    }),
  }));
}

let miniAppDurableBackendReady = false;

/** Produce a bounded local cache. Durable conversation history lives in SQLite/OpenClaw. */
export function createWorldPersistenceSnapshot(state: WorldState) {
  return {
    agents: state.agents.map(agent => {
      const { chatLog, conversations, miniApps, ...agentMetadata } = agent;
      return {
        ...agentMetadata,
        chatLog: (chatLog || []).slice(-PERSISTED_CHAT_MESSAGE_LIMIT).map(persistedMessage),
        conversations: (conversations || []).slice(-PERSISTED_CONVERSATION_LIMIT).map(conversation => ({
          ...conversation,
          // Thread contents are rehydrated from the backend when selected.
          messages: [],
        })),
        // Mini-app source and version history live in SQLite and hydrate only
        // when an agent or sharing surface becomes active.
        miniApps: undefined,
        miniAppsLoaded: false,
      };
    }),
    inbox: state.inbox,
    isAutoCloakEnabled: state.isAutoCloakEnabled,
    autoCloakTimeout: state.autoCloakTimeout,
    telemetryAnonId: state.telemetryAnonId,
    usageTelemetryEnabled: state.usageTelemetryEnabled,
    firedTelemetryEvents: state.firedTelemetryEvents,
  };
}

function createWorldStorageSnapshot(state: WorldState) {
  const snapshot = createWorldPersistenceSnapshot(state);
  if (miniAppDurableBackendReady) return snapshot;
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent, index) => ({
      ...agent,
      miniApps: recoveryMiniApps(state.agents[index]?.miniApps),
      miniAppsLoaded: state.agents[index]?.miniAppsLoaded,
    })),
  };
}

export const useWorldStore = create<WorldState>()(
  persist(
    (set, get) => ({
      agents: [],
      inbox: [],
  selectedAgent: null,
  hoveredAgent: null,
  activeView: "loading",
  activeForumId: null,
  architectTab: "overview",
  gatewayReady: false,
  isAutoCloakEnabled: true,
  autoCloakTimeout: 15,
  isCloaked: false,
  telemetryAnonId: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  usageTelemetryEnabled: false,
  firedTelemetryEvents: {},
  theme: "light",
  toggleTheme: () => set((state) => {
    const nextTheme = state.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute('data-theme', nextTheme);
    return { theme: nextTheme };
  }),
  setSelectedAgent: (id) => {
    const previousId = get().selectedAgent;
    const previous = get().agents.find(agent => agent.id === previousId);
    if (previous?.miniAppsLoaded) scheduleMiniAppsSave(previous.id, previous.miniApps || []);
    set(state => ({
      selectedAgent: id,
      agents: state.agents.map(agent =>
        agent.id === previousId && agent.id !== id
          ? { ...agent, miniApps: undefined, miniAppsLoaded: false }
          : agent
      ),
    }));
    if (id) void get().ensureAgentMiniApps(id);
  },
  setHoveredAgent: (id) => set({ hoveredAgent: id }),
  setActiveView: (view) => set({ activeView: view }),
  setActiveForumId: (id) => {
    set({ activeForumId: id });
    // Keep the navigation store lightweight while the forum store owns
    // durable-content hydration and eviction.
    void import("./forumStore").then(({ useForumStore }) =>
      useForumStore.getState().setActiveForumId(id)
    );
  },
  setArchitectTab: (tab) => set({ architectTab: tab }),
  setGatewayReady: (ready) => set({ gatewayReady: ready }),
  setAutoCloakEnabled: (enabled) => set({ isAutoCloakEnabled: enabled }),
  setAutoCloakTimeout: (timeout) => set({ autoCloakTimeout: timeout }),
  setIsCloaked: (cloaked) => set({ isCloaked: cloaked }),
  setUsageTelemetryEnabled: (enabled) => set({ usageTelemetryEnabled: enabled }),
  togglePermission: (agentId, permissionId) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, permissions: a.permissions.map((p) => p.id === permissionId ? { ...p, enabled: !p.enabled } : p) }
          : a
      ),
    })),
  updateAgentPosition: (id, pos) =>
    set((state) => ({ agents: state.agents.map((a) => (a.id === id ? { ...a, position: pos } : a)) })),
  updateAgentTarget: (id, target) =>
    set((state) => ({ agents: state.agents.map((a) => (a.id === id ? { ...a, targetPosition: target } : a)) })),
  updateAgentAction: (id, action) =>
    set((state) => ({ agents: state.agents.map((a) => (a.id === id ? { ...a, currentAction: action } : a)) })),
  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((state) => ({ agents: [...state.agents, agent] })),
  toggleIsolation: (agentId) => set((state) => ({
    agents: state.agents.map((a) => a.id === agentId ? { ...a, isolated: !a.isolated } : a)
  })),
  updateAgentVisuals: (id: string, visuals) => set((state) => ({
    agents: state.agents.map((a) => a.id === id ? { ...a, visual_identity: visuals } : a)
  })),
  updateAgentBrowserStatus: (id, status) => set((state) => ({
    agents: state.agents.map((a) => a.id === id ? { ...a, browser_status: status } : a)
  })),

  // ── Decision Queue ─────────────────────────────────────────────────────
  
  securityAlerts: [],
  systemWarnings: [],
  setSecurityAlerts: (alerts) => set({ securityAlerts: alerts }),
  setSystemWarnings: (warnings) => set({ systemWarnings: warnings }),
  resolveSystemWarningState: (id) => set((state) => ({ systemWarnings: state.systemWarnings.filter(w => w.id !== id) })),
  resolveSecurityAlertState: (id) => set((state) => ({ securityAlerts: state.securityAlerts.filter(a => a.id !== id) })),

  pendingDecisions: [],
  addDecision: (d) => set((state) => ({
    pendingDecisions: [d, ...state.pendingDecisions],
  })),
  resolveDecision: (id, _answer) => set((state) => ({
    pendingDecisions: state.pendingDecisions.filter(d => d.id !== id),
  })),
  dismissDecision: (id) => set((state) => ({
    pendingDecisions: state.pendingDecisions.filter(d => d.id !== id),
  })),
  clearDecisions: (agentId) => set((state) => ({
    pendingDecisions: agentId
      ? state.pendingDecisions.filter(d => d.agentId !== agentId)
      : [],
  })),

  // ── Conversation thread management ─────────────────────────────────────
  // Frontend-only V1: threads are named snapshots of past chats. The agent's
  // backend memory is still pooled — switching threads is visual, not a true
  // context reset. Documented in the AgentData type above.

  saveCurrentThread: (agentId) => {
    // Always resets the chat to a fresh state. Returns the id of the
    // saved/updated conversation, or null when there was nothing to save
    // (empty chat with no active conv) but a reset was still performed.
    //
    // Three cases the caller doesn't have to think about:
    //   (A) Active conv exists → mirror chatLog into it, then reset chat.
    //   (B) No active conv but chatLog has messages → snapshot into a new
    //       conversation, then reset chat.
    //   (C) No active conv, chatLog empty → just a no-op reset (cheap).
    let savedId: string | null = null;
    set((state) => {
      const agent = state.agents.find(a => a.id === agentId);
      if (!agent) return state;

      let conversations = [...(agent.conversations || [])];

      if (agent.activeConversationId) {
        // Case A — flush in-progress edits back into the active thread so
        // they're preserved when the user switches back later.
        const existing = conversations.find(c => c.id === agent.activeConversationId);
        if (existing) {
          const isNewContent = (agent.chatLog || []).length !== existing.messages.length ||
            (agent.chatLog || [])[(agent.chatLog || []).length - 1]?.id !== existing.messages[existing.messages.length - 1]?.id;

          conversations = conversations.map(c => c.id === agent.activeConversationId
            ? { ...c, messages: [...(agent.chatLog || [])], lastActiveAt: isNewContent ? Date.now() : c.lastActiveAt }
            : c);
        } else {
          // Fallback: If it was active but missing from the array, push it anew.
          const firstUser = (agent.chatLog || []).find(m => m.sender === "user");
          const rawTitle = firstUser?.text.trim() || `Chat from ${new Date().toLocaleString()}`;
          const title = rawTitle.length > 40 ? rawTitle.slice(0, 40).trimEnd() + "…" : rawTitle;
          const now = Date.now();
          conversations.push({
            id: agent.activeConversationId,
            title,
            messages: [...(agent.chatLog || [])],
            createdAt: now,
            lastActiveAt: now,
            type: "dm",
            status: "active"
          });
        }
        savedId = agent.activeConversationId;
      } else if (agent.chatLog && agent.chatLog.length > 0) {
        // Case B — snapshot an unsaved chat into a new conversation. Title
        // from the first user message, capped at 40 chars; falls back to a
        // timestamp-based default if the user only ever heard from the agent.
        const firstUser = agent.chatLog.find(m => m.sender === "user");
        const rawTitle = firstUser?.text.trim() || `Chat from ${new Date().toLocaleString()}`;
        const title = rawTitle.length > 40 ? rawTitle.slice(0, 40).trimEnd() + "…" : rawTitle;
        const now = Date.now();
        const newConv: Conversation = {
          id: `conv_${now}_${Math.random().toString(36).slice(2, 8)}`,
          title,
          messages: [...agent.chatLog],
          createdAt: now,
          lastActiveAt: now,
          type: "dm",
          status: "active"
        };
        conversations.push(newConv);
        savedId = newConv.id;
      }
      // Case C falls through — nothing to save, but we still reset below.

      return {
        agents: state.agents.map(a => a.id === agentId ? {
          ...a,
          conversations,
          chatLog: [],
          draftMessage: "",
          activeConversationId: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chatClearedAt: Date.now(),
        } : a),
      };
    });
    // Tell ChatTab to clear its local chatLog state. Without this, ChatTab's
    // useState seed-from-mount keeps the old messages on screen even though
    // the store's chatLog is now empty.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("canopy:chat-reset", { detail: { agentId } }));
    }
    return savedId;
  },

  createForumSpace: (agentId) => {
    let savedId: string | null = null;
    set((state) => {
      const agent = state.agents.find(a => a.id === agentId);
      if (!agent) return state;

      let conversations = [...(agent.conversations || [])];

      const now = Date.now();
      const newConv: Conversation = {
        id: `proj_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title: "New Forum Space",
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        type: "forum",
        status: "active"
      };
      conversations.push(newConv);
      savedId = newConv.id;

      // We don't automatically clear the active chat log if it was a DM, but we DO switch into the forum space.
      // Wait, let's just create it and let switchConversation handle the switch.
      return {
        agents: state.agents.map(a => a.id === agentId ? {
          ...a,
          conversations
        } : a),
      };
    });
    if (savedId) {
      // A3 activation: first forum space created. Fire-once, see fireActivationEvent.
      fireActivationEvent("activation_a3_first_forum");
    }
    return savedId;
  },

  switchConversation: (agentId, convId) => set((state) => {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent) return state;
    
    // Inject a stub for forums if missing, so we can switch to them
    let target = (agent.conversations || []).find(c => c.id === convId);
    if (!target && convId.startsWith("forum_")) {
      target = {
        id: convId,
        type: "forum",
        title: "Forum",
        messages: [],
        status: "active",
        createdAt: Date.now(),
        lastActiveAt: Date.now()
      };
      agent.conversations = [...(agent.conversations || []), target];
    }
    if (!target) return state;

    // Snapshot the current chatLog into its own conversation before swapping,
    // so the user doesn't lose work when jumping between threads. Skip if
    // the current chatLog is empty (nothing to save) OR if we're already
    // looking at this conversation (re-clicking the active thread is a no-op).
    let conversations = [...(agent.conversations || [])];
    if (agent.activeConversationId !== convId && agent.chatLog && agent.chatLog.length > 0) {
      const firstUser = agent.chatLog.find(m => m.sender === "user");
      const rawTitle = firstUser?.text.trim() || `Chat from ${new Date().toLocaleString()}`;
      const autoTitle = rawTitle.length > 40 ? rawTitle.slice(0, 40).trimEnd() + "…" : rawTitle;
      // If the current chat is the in-progress version of an existing thread
      // (i.e. activeConversationId is set), update that thread's messages
      // rather than creating a duplicate.
      if (agent.activeConversationId) {
        const existing = conversations.find(c => c.id === agent.activeConversationId);
        const isNewContent = !existing ||
          agent.chatLog.length !== existing.messages.length ||
          agent.chatLog[agent.chatLog.length - 1]?.id !== existing.messages[existing.messages.length - 1]?.id;

        conversations = conversations.map(c => c.id === agent.activeConversationId
          ? { ...c, messages: [...agent.chatLog], lastActiveAt: isNewContent ? Date.now() : c.lastActiveAt }
          : c);
      } else {
        const now = Date.now();
        conversations.push({
          id: `conv_${now}_${Math.random().toString(36).slice(2, 8)}`,
          title: autoTitle,
          messages: [...agent.chatLog],
          createdAt: now,
          lastActiveAt: now,
          type: "dm",
          status: "active"
        });
      }
    }

    // Now load the target's messages into chatLog and mark it active.
    return {
      agents: state.agents.map(a => a.id === agentId ? {
        ...a,
        conversations,
        chatLog: [...target.messages],
        draftMessage: "",
        activeConversationId: convId,
        chatClearedAt: undefined,
      } : a),
    };
  }),

  renameConversation: (agentId, convId, title) => set((state) => ({
    agents: state.agents.map(a => a.id === agentId ? {
      ...a,
      conversations: (a.conversations || []).map(c => c.id === convId ? { ...c, title } : c),
    } : a),
  })),

  deleteConversation: (agentId, convId) => set((state) => ({
    agents: state.agents.map(a => a.id === agentId ? {
      ...a,
      conversations: (a.conversations || []).filter(c => c.id !== convId),
      // If we deleted the active conversation, clear the active marker with a new unique session ID.
      activeConversationId: a.activeConversationId === convId 
        ? `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` 
        : a.activeConversationId,
    } : a),
  })),

  // ── Inbox ─────────────────────────────────────────────────────────────
  addInboxItem: (item) => set((state) => ({
    inbox: [{
      ...item,
      id: `inbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now()
    }, ...state.inbox]
  })),
  removeInboxItem: (id) => set((state) => ({
    inbox: state.inbox.filter(i => i.id !== id)
  })),

  // ── Mini Apps ─────────────────────────────────────────────────────────────
  ensureAgentMiniApps: async (agentId) => {
    const existing = get().agents.find(agent => agent.id === agentId);
    if (!existing || existing.miniAppsLoaded) return;
    try {
      const miniApps = await loadMiniApps(agentId);
      set(state => ({
        agents: state.agents.map(agent =>
          agent.id === agentId
            ? { ...agent, miniApps: miniApps || agent.miniApps || [], miniAppsLoaded: true }
            : agent
        ),
      }));
    } catch (error) {
      console.error(`[world-store] failed to hydrate mini-apps for ${agentId}`, error instanceof Error ? error.name : "UnknownError");
    }
  },

  addMiniApp: (agentId, app) => { void (async () => {
    await get().ensureAgentMiniApps(agentId);
    set((state) => ({
      agents: state.agents.map(a => {
      if (a.id !== agentId) return a;
      const existing = a.miniApps ?? [];
      
      const newVersion: MiniAppVersion = {
        id: `version_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        entrypoint: app.entrypoint,
        htmlContent: app.htmlContent,
      };

      // If an app with the same name exists, append a new version
      const existingAppIndex = existing.findIndex(m => m.name === app.name || (app.sourceMessageId && m.sourceMessageId === app.sourceMessageId));
      if (existingAppIndex !== -1) {
        const existingApp = existing[existingAppIndex];
        
        // If it's from the exact same message, it's just a secondary page of the same app. Ignore it.
        if (app.sourceMessageId && existingApp.sourceMessageId === app.sourceMessageId) {
          return a;
        }

        const updatedApp: MiniApp = {
          ...existingApp,
          versions: [newVersion, ...existingApp.versions],
          activeVersionId: newVersion.id,
        };
        const newApps = [...existing];
        newApps[existingAppIndex] = updatedApp;
        return { ...a, miniApps: newApps, miniAppsLoaded: true };
      }

      // Otherwise create a new app
      const newApp: MiniApp = {
        id: `miniapp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: app.name,
        description: app.description,
        createdAt: Date.now(),
        sourceMessageId: app.sourceMessageId,
        versions: [newVersion],
        activeVersionId: newVersion.id,
      };
      return { ...a, miniApps: [newApp, ...existing], miniAppsLoaded: true };
      }),
    }));
    const updated = get().agents.find(agent => agent.id === agentId);
    if (updated) scheduleMiniAppsSave(agentId, updated.miniApps || []);
  })(); },

  updateMiniAppVersion: (agentId, appId, versionId) => { void (async () => {
    await get().ensureAgentMiniApps(agentId);
    set((state) => ({
      agents: state.agents.map(a => {
      if (a.id !== agentId) return a;
      return {
        ...a,
        miniApps: (a.miniApps ?? []).map(m => 
          m.id === appId ? { ...m, activeVersionId: versionId } : m
        )
      };
      })
    }));
    const updated = get().agents.find(agent => agent.id === agentId);
    if (updated) scheduleMiniAppsSave(agentId, updated.miniApps || []);
  })(); },

  deleteMiniApp: (agentId, appId) => { void (async () => {
    await get().ensureAgentMiniApps(agentId);
    set((state) => ({
      agents: state.agents.map(a =>
        a.id !== agentId ? a : { ...a, miniApps: (a.miniApps ?? []).filter(m => m.id !== appId), miniAppsLoaded: true }
      ),
    }));
    const updated = get().agents.find(agent => agent.id === agentId);
    if (updated) scheduleMiniAppsSave(agentId, updated.miniApps || []);
  })(); },
}),
{
  name: "canopy-world-store",
  storage: createJSONStorage(getQuotaSafeLocalStorage),
  version: 2,
  migrate: (persistedState, version) => {
    const state = persistedState as WorldState;
    if (version < 2) {
      return {
        ...state,
        agents: (state.agents || []).map(agent => ({
          ...agent,
          miniAppsLoaded: Array.isArray(agent.miniApps),
        })),
      };
    }
    return state;
  },
  partialize: createWorldStorageSnapshot,
}
));

let initializeMiniAppsPromise: Promise<void> | null = null;

/** Migrate legacy local mini-apps once, then leave only active agents hydrated. */
export function initializeMiniAppDurablePersistence(): Promise<void> {
  if (initializeMiniAppsPromise) return initializeMiniAppsPromise;
  initializeMiniAppsPromise = (async () => {
    try {
      const agents = useWorldStore.getState().agents;
      const legacyAgents = agents.filter(
        agent => agent.miniAppsLoaded && (agent.miniApps?.length || 0) > 0,
      );
      await Promise.all(legacyAgents.map(agent =>
        saveMiniAppsNow(agent.id, agent.miniApps || [], true),
      ));
      // If there is nothing to migrate, this read still acts as the command
      // readiness handshake before WebKit drops its recovery copy.
      if (legacyAgents.length === 0) {
        await loadMiniApps(agents[0]?.id || "canopy_probe");
      }

      miniAppDurableBackendReady = true;
      const selected = useWorldStore.getState().selectedAgent;
      useWorldStore.setState(state => ({
        agents: state.agents.map(agent =>
          agent.id === selected
            ? agent
            : { ...agent, miniApps: undefined, miniAppsLoaded: false }
        ),
      }));
      if (selected) await useWorldStore.getState().ensureAgentMiniApps(selected);
    } catch (error) {
      console.error("[world-store] durable mini-app backend is not ready; retaining recovery cache", error instanceof Error ? error.name : "UnknownError");
      initializeMiniAppsPromise = null;
      await new Promise(resolve => window.setTimeout(resolve, 2_000));
      return initializeMiniAppDurablePersistence();
    }
  })();
  return initializeMiniAppsPromise;
}

export function pickNextAction(agent: AgentData): { action: string; target: [number, number, number] } {
  const actions = [
    { name: "work", zone: ZONES.axis, score: agent.status === "active" ? 0.9 : 0.1 },
    { name: "research", zone: ZONES.sanctuary, score: agent.role === "Researcher" ? 0.8 : 0.2 },
    { name: "socialize", zone: ZONES.plaza, score: agent.socialMotive * 0.5 },
    { name: "monitor", zone: ZONES.terrace, score: agent.role === "STR Manager" ? 0.7 : 0.1 },
    { name: "calculate", zone: ZONES.labyrinth, score: agent.role === "Financial" ? 0.7 : 0.1 },
  ];
  const scored = actions.map(a => ({ ...a, final: a.score + (Math.random() * 0.4 - 0.2) }));
  scored.sort((a, b) => b.final - a.final);
  const chosen = scored[0];
  const j = () => (Math.random() - 0.5) * chosen.zone.radius;
  return { action: chosen.name, target: [chosen.zone.center[0] + j(), chosen.zone.center[1], chosen.zone.center[2] + j()] };
}
