import { create } from "zustand";
import { persist } from "zustand/middleware";
import RAW_AGENT_TYPE_INFO from "../../shared/agents.json";

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
  visual_identity?: { baseModelUrl?: string | null; accessories: string[]; decor?: string[]; habitatId?: number; color?: string; habitatOffset?: any; };
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
    canvas: boolean;
    coding: boolean;
    gog: boolean;
    summarize: boolean;
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

// A saved conversation thread for an agent. Titles are auto-derived from the
// first user message (~40 chars) unless the user renames the thread.
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;       // unix ms
  lastActiveAt: number;    // unix ms — for sort order
  type?: "dm" | "project";
  status?: "active" | "archived";
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
  // NOTE: The agent's underlying SQLite memory is still a single pool —
  // threads are visual partitioning, not contextual isolation. Real isolation
  // requires a per-conversation backend, which is a focused next session.
  conversations?: Conversation[];
  activeConversationId?: string | null;
  chatClearedAt?: number;
  memories: Array<{ type: string; text: string; when: string; confidence: number }>;
  browser_status?: BrowserStatus | null;
  personalityPrompt: string;
  avatarPrompt: string;
  visual_identity: {
    baseModelUrl: string | null;
    accessories: string[];
    habitatId?: number;
    color?: string;
    habitatOffset?: { offsetX: number; offsetY: number; offsetZ: number; };
  };
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
  activeView: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile" | "diagnostics" | "forum";
  activeForumId: string | null;
  architectTab: string;
  gatewayReady: boolean;
  theme: "light" | "dark";
  toggleTheme: () => void;
  setSelectedAgent: (id: string | null) => void;
  setHoveredAgent: (id: string | null) => void;
  setActiveView: (view: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile" | "diagnostics" | "forum") => void;
  setActiveForumId: (id: string | null) => void;
  setArchitectTab: (tab: string) => void;
  setGatewayReady: (ready: boolean) => void;
  isAutoCloakEnabled: boolean;
  autoCloakTimeout: number; // in minutes
  isCloaked: boolean;
  setAutoCloakEnabled: (enabled: boolean) => void;
  setAutoCloakTimeout: (timeout: number) => void;
  setIsCloaked: (cloaked: boolean) => void;
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
  createProjectSpace: (agentId: string) => string | null;
  // switchConversation saves the current thread first (idempotent — no-op if
  // empty), then loads the target conversation's messages into chatLog.
  switchConversation: (agentId: string, convId: string) => void;
  renameConversation: (agentId: string, convId: string, title: string) => void;
  deleteConversation: (agentId: string, convId: string) => void;
  // ── Inbox ─────────────────────────────────────────────────────────────
  addInboxItem: (item: Omit<InboxItem, "id" | "timestamp">) => void;
  removeInboxItem: (id: string) => void;
  // ── Decision Queue ────────────────────────────────────────────────────
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
  { id: "canvas", label: "Canvas Editor", description: "Edit and manipulate visual layouts", enabled: false, category: "skills" },
  { id: "coding", label: "Code Execution", description: "Run scripts and evaluate code locally", enabled: true, category: "skills" },
  { id: "gog", label: "Search Engine", description: "Query the web for information", enabled: true, category: "skills" },
  { id: "summarize", label: "Summarization", description: "Condense large documents or web pages", enabled: true, category: "skills" },
];

export const AGENT_TYPE_INFO = RAW_AGENT_TYPE_INFO as Record<string, { description: string; color: string; robeColor: string; accentColor: string; habitatColor: string; habitatLabel: string; image?: string; suggest_in_onboarding?: boolean; recommended_isolated?: boolean; recommended_tier?: "guarded" | "balanced" | "unrestricted"; library?: { title: string; author: string; mode: string }[]; readwise_enabled?: boolean; soul_template?: string; identity_template?: string }>;

export function getPermissionsForRole(roleId: string, isolated: boolean): Permission[] {
  return DEFAULT_PERMISSIONS.map(p => {
    let enabled = p.enabled;
    if (isolated) {
      // For isolated agents, default network and global read to OFF for zero-trust
      if (
        p.id === "ext_network" || 
        p.id === "int_network" || 
        p.id === "file_read" || 
        p.id === "browser" || 
        p.id === "coding" ||
        p.id === "gog" ||
        p.id === "scheduled" ||
        p.id === "file_write" ||
        p.id === "autonomous" ||
        p.id === "payments" ||
        p.id === "spend_auto"
      ) {
        enabled = false;
      }
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

export const useWorldStore = create<WorldState>()(
  persist(
    (set) => ({
      agents: [],
      inbox: [],
  selectedAgent: null,
  hoveredAgent: null,
  activeView: "loading",
  activeForumId: null,
  architectTab: "overview",
  gatewayReady: false,
  isAutoCloakEnabled: false,
  autoCloakTimeout: 15,
  isCloaked: false,
  theme: "light",
  toggleTheme: () => set((state) => {
    const nextTheme = state.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute('data-theme', nextTheme);
    return { theme: nextTheme };
  }),
  setSelectedAgent: (id) => set({ selectedAgent: id }),
  setHoveredAgent: (id) => set({ hoveredAgent: id }),
  setActiveView: (view) => set({ activeView: view }),
  setActiveForumId: (id) => set({ activeForumId: id }),
  setArchitectTab: (tab) => set({ architectTab: tab }),
  setGatewayReady: (ready) => set({ gatewayReady: ready }),
  setAutoCloakEnabled: (enabled) => set({ isAutoCloakEnabled: enabled }),
  setAutoCloakTimeout: (timeout) => set({ autoCloakTimeout: timeout }),
  setIsCloaked: (cloaked) => set({ isCloaked: cloaked }),
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
          conversations = conversations.map(c => c.id === agent.activeConversationId
            ? { ...c, messages: [...(agent.chatLog || [])], lastActiveAt: Date.now() }
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
          activeConversationId: null,
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

  createProjectSpace: (agentId) => {
    let savedId: string | null = null;
    set((state) => {
      const agent = state.agents.find(a => a.id === agentId);
      if (!agent) return state;

      let conversations = [...(agent.conversations || [])];

      const now = Date.now();
      const newConv: Conversation = {
        id: `proj_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title: "New Project Space",
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        type: "project",
        status: "active"
      };
      conversations.push(newConv);
      savedId = newConv.id;

      // We don't automatically clear the active chat log if it was a DM, but we DO switch into the project space.
      // Wait, let's just create it and let switchConversation handle the switch.
      return {
        agents: state.agents.map(a => a.id === agentId ? {
          ...a,
          conversations
        } : a),
      };
    });
    return savedId;
  },

  switchConversation: (agentId, convId) => set((state) => {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent) return state;
    const target = (agent.conversations || []).find(c => c.id === convId);
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
        conversations = conversations.map(c => c.id === agent.activeConversationId
          ? { ...c, messages: [...agent.chatLog], lastActiveAt: Date.now() }
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
      // If we deleted the active conversation, clear the active marker.
      activeConversationId: a.activeConversationId === convId ? null : a.activeConversationId,
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
}),
{
  name: "canopy-world-store",
  partialize: (state) => ({ 
    agents: state.agents, 
    inbox: state.inbox,
    isAutoCloakEnabled: state.isAutoCloakEnabled, 
    autoCloakTimeout: state.autoCloakTimeout 
  }),
}
));

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
