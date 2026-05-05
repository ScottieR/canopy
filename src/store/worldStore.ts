import { create } from "zustand";
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

export interface DiscoveredAgent {
  source: string;
  id: string;
  name: string;
  path: string;
}

export interface WorldState {
  agents: AgentData[];
  selectedAgent: string | null;
  hoveredAgent: string | null;
  activeView: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile" | "diagnostics";
  architectTab: string;
  gatewayReady: boolean;
  theme: "light" | "dark";
  toggleTheme: () => void;
  setSelectedAgent: (id: string | null) => void;
  setHoveredAgent: (id: string | null) => void;
  setActiveView: (view: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile" | "diagnostics") => void;
  setArchitectTab: (tab: string) => void;
  setGatewayReady: (ready: boolean) => void;
  togglePermission: (agentId: string, permissionId: string) => void;
  updateAgentPosition: (id: string, pos: [number, number, number]) => void;
  updateAgentTarget: (id: string, target: [number, number, number]) => void;
  updateAgentAction: (id: string, action: string) => void;
  setAgents: (agents: AgentData[]) => void;
  addAgent: (agent: AgentData) => void;
  toggleIsolation: (agentId: string) => void;
  updateAgentVisuals: (id: string, visuals: any) => void;
  updateAgentBrowserStatus: (id: string, status: BrowserStatus | null) => void;
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
  { id: "autonomous", label: "Autonomous Execution", description: "Run tasks without manual approval (Agent can autonomously execute loops without asking for your confirmation at each step)", enabled: false, category: "execution" },
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

export const AGENT_TYPE_INFO = RAW_AGENT_TYPE_INFO as Record<string, { description: string; color: string; robeColor: string; accentColor: string; habitatColor: string; habitatLabel: string; image?: string; suggest_in_onboarding?: boolean; recommended_isolated?: boolean; library?: { title: string; author: string; mode: string }[]; readwise_enabled?: boolean; soul_template?: string; identity_template?: string }>;

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
    basePrompt = info.defaultPrompt || `You are ${personaName}. Your primary objective is to execute instructions cleanly and effectively. Maintain a helpful and analytical tone.`;
    basePrompt = basePrompt.replace("You are a highly capable and adaptable AI agent", `You are ${personaName}`);
  } else {
    if (info.defaultPrompt) {
      basePrompt = info.defaultPrompt.replace("You are", `You are ${personaName},`);
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

export const useWorldStore = create<WorldState>((set) => ({
  agents: [],
  selectedAgent: null,
  hoveredAgent: null,
  activeView: "loading",
  architectTab: "overview",
  gatewayReady: false,
  theme: "light",
  toggleTheme: () => set((state) => {
    const nextTheme = state.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute('data-theme', nextTheme);
    return { theme: nextTheme };
  }),
  setSelectedAgent: (id) => set({ selectedAgent: id }),
  setHoveredAgent: (id) => set({ hoveredAgent: id }),
  setActiveView: (view) => set({ activeView: view }),
  setArchitectTab: (tab) => set({ architectTab: tab }),
  setGatewayReady: (ready) => set({ gatewayReady: ready }),
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
}));

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
