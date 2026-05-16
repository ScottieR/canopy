import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, ChevronDown,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, Github, MessageCircle, Cloud, Link, MapPin, Camera, Bell, Home, Bluetooth
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, MultiPicker, glass } from "../../App";
import { PasswordInput } from "../../components/shared/PasswordInput";
import { ConfirmDisconnectModal } from "../../components/shared/ConfirmDisconnectModal";
import {
  ACCESS_TIERS,
  AccessTier,
  applyAccessTier,
  detectCurrentTier,
  PERMISSION_RISK_BAND,
  summarizeTierChange,
  getRecommendedTierForAgent
} from "./accessTiers";

// ─── Per-agent disconnect modal config ────────────────────────────────────────
//
// Per-agent disconnects (Slack / GitHub) only affect THIS agent — other agents'
// connections are unaffected. The Tauri commands (`disconnect_slack_for_agent`,
// `disconnect_github`) take an `agentId` arg, wipe the per-agent keychain entries,
// rebuild bindings, and restart the gateway.
type AgentDisconnectKey = "slack-agent" | "github-agent";

const AGENT_DISCONNECT_CONFIG: Record<AgentDisconnectKey, {
  displayName: string;
  command: string;
  tokens: string[];
  extraNote?: string;
}> = {
  "slack-agent": {
    displayName: "Slack",
    command: "disconnect_slack_for_agent",
    tokens: ["This agent's Slack Bot Token", "This agent's Slack App Token"],
  },
  "github-agent": {
    displayName: "GitHub",
    command: "disconnect_github",
    tokens: ["This agent's GitHub Personal Access Token", "This agent's GitHub username"],
    extraNote: "Also wipes the agent's gh CLI wrapper script and .github_env file inside the gateway workspace.",
  },
};

export function ConnectionsTab({ agent: _agent, onOpenTerminal }: { agent: AgentData, onOpenTerminal?: (cmd: string) => void }) {
  const fallbackIntegrations = useMemo(() => [], []);
  const fallbackPermissions = useMemo(() => [], []);
  const agent = { 
    ..._agent, 
    integrations: _agent.integrations || fallbackIntegrations,
    permissions: _agent.permissions || fallbackPermissions
  };
  const { setActiveView } = useWorldStore();

  // Gateway connection statuses (read-only here)
  const [slackConnected, setSlackConnected] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [calConnected, setCalConnected] = useState(false);
  const [gDriveConnected, setGDriveConnected] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [iMsgConnected, setIMsgConnected] = useState(false);
  const [allowedDirs, setAllowedDirs] = useState<string[]>([]);
  const [foldersExpanded, setFoldersExpanded] = useState(false);
  const [pluginSetupTarget, setPluginSetupTarget] = useState<string | null>(null);

  // Fetch allowed directories for the agent
  useEffect(() => {
    let active = true;
    const fetchDirs = async () => {
      try {
        const dirs = await invoke<string[]>("get_agent_allowed_directories", { agentId: agent.id });
        if (active) setAllowedDirs(dirs || []);
      } catch (e) {
        console.error("Failed to fetch allowed directories:", e);
      }
    };
    fetchDirs();
    return () => { active = false; };
  }, [agent.id]);

  // Web Credentials
  const [webCredentials, setWebCredentials] = useState<Array<{ domain: string; username: string }>>([]);
  const [webCredSearch, setWebCredSearch] = useState("");
  const [pluginSearch, setPluginSearch] = useState("");

  // Dynamic Connectors
  const [connectors, setConnectors] = useState<any[]>([
    { id: "slack", name: "Slack", subtitle: "Control which Slack channels route messages to this agent", icon: "slack", isGlobal: false, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "gmail", name: "Gmail", subtitle: "Read and send emails using your Google account", icon: "mail", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "imessage", name: "iMessage", subtitle: "Choose which contacts and group threads this agent can read and reply to", icon: "message-circle", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "filesystem", name: "Workspace (File System)", subtitle: "Allow agent to read and mutate local files in their designated workspace directory.", icon: "folder", isGlobal: false, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "calendar", name: "Google Calendar", subtitle: "Allow agent to view and schedule events on your Google Calendar", icon: "calendar", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "drive", name: "Google Drive", subtitle: "Allow agent to read, write, and organize files in your Google Drive", icon: "hard-drive", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "github", name: "GitHub", subtitle: "Allow agent to read repositories, create PRs, and review code", icon: "github", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "telegram", name: "Telegram", subtitle: "Connect a Telegram bot so this agent can chat in channels or DMs", icon: "send", isGlobal: false, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "discord", name: "Discord", subtitle: "Connect a Discord bot to respond in channels and DMs.", icon: "message-circle", isGlobal: false, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "figma", name: "Figma", subtitle: "A design agent can co-create and modify design files directly in Figma.", icon: "figma", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true, type: "oauth" },
    { id: "twilio", name: "Twilio Voice & SMS", subtitle: "Connect a Twilio phone number so this agent can make and receive calls or texts.", icon: "message-circle", isGlobal: false, isVisible: true, isSuggested: true, needsCompanion: false },
    { id: "apple_health", name: "Apple Health", subtitle: "Allow agent to read and analyze your Apple Health data", icon: "activity", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "live_location", name: "Live Location & Geofencing", subtitle: "Agent knows when you leave home or arrive at work", icon: "map-pin", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "shortcuts", name: "Apple Shortcuts", subtitle: "Allow the agent to trigger Siri Intents and Shortcuts", icon: "zap", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "vision", name: "Vision & Photo Sync", subtitle: "Agent silently indexes your recent camera roll for context", icon: "camera", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "notifications", name: "Actionable Push Notifications", subtitle: "Approve agent actions directly from your lock screen", icon: "bell", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true },
    { id: "homekit", name: "Smart Home / HomeKit", subtitle: "Bridge HomeKit access so the agent can control lights", icon: "home", isGlobal: true, isVisible: true, isSuggested: true, needsCompanion: true }
  ]);
  const [dynamicEnabled, setDynamicEnabled] = useState<Record<string, boolean>>({});
  const [dynamicStatuses, setDynamicStatuses] = useState<Record<string, boolean>>({});
  const [dynamicSetupState, setDynamicSetupState] = useState<Record<string, boolean>>({});
  const [dynamicSetupValue, setDynamicSetupValue] = useState<Record<string, string>>({});
  const [dynamicSetupLoading, setDynamicSetupLoading] = useState<Record<string, boolean>>({});

  const [showHighRiskModal, setShowHighRiskModal] = useState(false);
  const [pendingHighRiskAction, setPendingHighRiskAction] = useState<(() => void) | null>(null);
  const [pendingHighRiskLabel, setPendingHighRiskLabel] = useState("");

  const executeOrConfirmHighRisk = (isHighRisk: boolean, label: string, action: () => void) => {
    if (isHighRisk) {
      setPendingHighRiskLabel(label);
      setPendingHighRiskAction(() => action);
      setShowHighRiskModal(true);
    } else {
      action();
    }
  };

  useEffect(() => {
    if (typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function') {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
      invoke("get_connectors_config")
        .then((data: any) => {
           if (Array.isArray(data)) {
             setConnectors(data);
             const initialEnabled: Record<string, boolean> = {};
             data.forEach(c => {
               initialEnabled[c.id] = agent.integrations.includes(c.id);
             });
             setDynamicEnabled(initialEnabled);
           }
        })
        .catch((e: any) => console.error("Failed to load connectors:", e));
    }
  }, [agent.integrations]);

  const toggleIntegration = async (id: string, enabled: boolean, toRemove: string[] = []) => {
    let newIntegrations = [...agent.integrations];
    toRemove.forEach(rm => {
      newIntegrations = newIntegrations.filter(i => i !== rm);
    });
    if (enabled && !newIntegrations.includes(id)) {
      newIntegrations.push(id);
    } else if (!enabled) {
      newIntegrations = newIntegrations.filter(i => i !== id);
    }
    
    if (typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function') {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
      await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
      useWorldStore.getState().setAgents(
        useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
      );
    }
  };

  // Per-agent Slack channel allowlist
  const [slackEnabled, setSlackEnabled] = useState(agent.integrations.includes("slack"));
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; member_count: number }>>([]);
  const [allowedSlack, setAllowedSlack] = useState<string[]>([]);
  const [slackPickerOpen, setSlackPickerOpen] = useState(false);
  const [slackSearch, setSlackSearch] = useState("");
  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackTokensSaving, setSlackTokensSaving] = useState(false);
  const [slackPairingCode, setSlackPairingCode] = useState("");
  const [slackPairingStatus, setSlackPairingStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [slackPairingError, setSlackPairingError] = useState("");

  const [githubToken, setGithubToken] = useState("");

  // Per-agent disconnect-confirmation modal state.
  const [agentDisconnectTarget, setAgentDisconnectTarget] = useState<AgentDisconnectKey | null>(null);
  const [agentDisconnectBusy, setAgentDisconnectBusy] = useState(false);

  const handleAgentDisconnect = useCallback(async () => {
    if (!agentDisconnectTarget) return;
    const cfg = AGENT_DISCONNECT_CONFIG[agentDisconnectTarget];
    setAgentDisconnectBusy(true);
    try {
      await invoke(cfg.command, { agentId: agent.id });
      // Clear the corresponding token field in the form so the UI reflects disconnect.
      if (agentDisconnectTarget === "slack-agent") {
        setSlackBotToken("");
        setSlackAppToken("");
      } else if (agentDisconnectTarget === "github-agent") {
        setGithubToken("");
      }
      // Also turn the integration toggle off so the skills list is updated.
      try {
        if (agentDisconnectTarget === "slack-agent") {
          await invoke("update_agent_integrations", {
            agentId: agent.id,
            integrations: (agent.integrations || []).filter((i: string) => !i.startsWith("slack")),
          });
        } else if (agentDisconnectTarget === "github-agent") {
          await invoke("update_agent_integrations", {
            agentId: agent.id,
            integrations: (agent.integrations || []).filter((i: string) => i !== "github"),
          });
        }
        await invoke("sync_gateway_channels");
      } catch (e) { console.warn("Failed to update integrations after disconnect:", e); }
    } catch (e) {
      console.error(`${cfg.displayName} disconnect failed for ${agent.id}:`, e);
    } finally {
      setAgentDisconnectBusy(false);
      setAgentDisconnectTarget(null);
    }
  }, [agentDisconnectTarget, agent.id, agent.integrations]);

  useEffect(() => {
    if (typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function') {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
      invoke("get_secret_cmd", { key: `agent_${agent.id}_slack_app_token` }).then((t: any) => setSlackAppToken(t as string)).catch(() => {});
      invoke("get_secret_cmd", { key: `agent_${agent.id}_slack_bot_token` }).then((t: any) => setSlackBotToken(t as string)).catch(() => {});
      invoke("get_secret_cmd", { key: `github-access-token-${agent.id}` }).then((t: any) => setGithubToken(t as string)).catch(() => {});
    }
  }, [agent.id]);

  // Per-agent iMessage thread allowlist
  const [iMsgEnabled, setIMsgEnabled] = useState(agent.integrations.includes("imessage"));
  const [iMsgThreads, setIMsgThreads] = useState<Array<{ chat_identifier: string; display_name: string; last_message_date: string }>>([]);
  const [allowedThreads, setAllowedThreads] = useState<string[]>([]);
  const [iMsgPickerOpen, setIMsgPickerOpen] = useState(false);
  const [iMsgSearch, setIMsgSearch] = useState("");

  // Per-agent email mode
  const [emailMode, setEmailMode] = useState<"none" | "read" | "write">(
    agent.integrations.includes("email_write") ? "write"
    : agent.integrations.includes("email_read") ? "read"
    : "none"
  );
  
  const [calendarMode, setCalendarMode] = useState<"none" | "read" | "write">(
    agent.integrations.includes("calendar_write") ? "write"
    : agent.integrations.includes("calendar_read") ? "read"
    : agent.integrations.includes("calendar") ? "write" // Legacy fallback
    : "none"
  );
  
  const [driveMode, setDriveMode] = useState<"none" | "read" | "write">(
    agent.integrations.includes("drive_write") ? "write"
    : agent.integrations.includes("drive_read") ? "read"
    : agent.integrations.includes("drive") ? "write" // Legacy fallback
    : "none"
  );
  const [driveAccessScope, setDriveAccessScope] = useState<"all" | "granular">(
    agent.integrations.includes("drive_granular") ? "granular" : "all"
  );

  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  const [allowlistsLoaded, setAllowlistsLoaded] = useState(false);
  const [hasScrolledToSlack, setHasScrolledToSlack] = useState(false);
  const [isSlackPaired, setIsSlackPaired] = useState(false);

  // ── Budget & Spend ──
  const [budget, setBudget] = useState<any>(null);
  const [budgetLoading, setBudgetLoading] = useState(true);
  const [budgetSaving, setBudgetSaving] = useState(false);

  useEffect(() => {
    const fetchBudget = async () => {
      setBudgetLoading(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const budgetRes = await invoke('get_agent_budget', { agentId: agent.id });
        setBudget(budgetRes);
      } catch (e) {
        console.error("Failed to load budget data", e);
      }
      setBudgetLoading(false);
    };
    fetchBudget();
  }, [agent.id]);

  const updateBudgetProp = (key: string, val: any) => {
    if (!budget) return;
    setBudget({ ...budget, [key]: val });
  };

  const handleSaveBudget = async () => {
    if (!budget) return;
    setBudgetSaving(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('update_agent_budget', { budget });
      setTimeout(() => setBudgetSaving(false), 800);
    } catch (e) {
      console.error("Failed to save budget", e);
      setBudgetSaving(false);
    }
  };

  // ── Cognitive Engines (LLM) ──
  const [brainModels, setBrainModels] = useState<any[]>([]);
  useEffect(() => {
    invoke<any[]>("get_available_models")
      .then(models => setBrainModels(models))
      .catch(() => { /* gateway not yet up, will retry on next render */ });
  }, []);

  const [keys, setKeys] = useState<{ [provider: string]: string }>({
    "OpenAI": "", "Anthropic": "", "Gemini": "", "Grok": ""
  });
  const [selectedModel, setSelectedModel] = useState<string>((agent.personality as any)?.active_model || "");
  const [llmSaveStatus, setLlmSaveStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const HEAVY_ROLES_BRAIN = ["Strategist", "Analyst", "Researcher", "Engineer"];
  const getDynamicRecommendedModel = () => {
    const isHeavy = HEAVY_ROLES_BRAIN.includes(agent.role);
    const availableProviders = Object.entries(keys)
      .filter(([_, v]) => v && v.trim().length > 0)
      .map(([k]) => k === "Gemini" ? "Google Gemini" : k);

    let match = null;
    if (availableProviders.length > 0 && brainModels && brainModels.length > 0) {
      const prov = availableProviders[0];
      const strategy = isHeavy ? "heavy" : "light";
      match = brainModels.find((m: any) => m.provider === prov && m.strategy === strategy)
           || brainModels.find((m: any) => m.provider === prov);
    }
    if (!match && brainModels && brainModels.length > 0) {
      match = brainModels.find((m: any) => m.strategy === (isHeavy ? "heavy" : "light"))
           || brainModels[0];
    }
    return { provider: match?.provider || "Google Gemini", model: `${match?.name || "Gemini 3.1 Flash Lite"} — ${match?.description || "Fastest Gemini 3 model (Preview)"}`, id: match?.id || "google/gemini-3.1-flash-lite-preview" };
  };

  const defaultModelInfo = getDynamicRecommendedModel();

  useEffect(() => {
    if (typeof invoke === 'function') {
      const providers = ["OpenAI", "Anthropic", "Gemini", "Grok"];
      providers.forEach(prov => {
        invoke("get_secret_cmd", { key: `agent_${agent.id}_${prov.toLowerCase()}_key` })
          .then(k => setKeys(prev => ({ ...prev, [prov]: k as string })))
          .catch(() => { });
      });
    }
  }, [agent.id]);

  const saveOverrides = async () => {
    setLlmSaveStatus("loading");
    try {
      if (typeof invoke === 'function') {
        const providers = ["OpenAI", "Anthropic", "Gemini", "Grok"];
        for (const prov of providers) {
          const val = keys[prov];
          try {
            if (val && val.trim()) {
              await invoke("store_secret_cmd", { key: `agent_${agent.id}_${prov.toLowerCase()}_key`, value: val.trim() });
            } else {
              await invoke("delete_secret_cmd", { key: `agent_${agent.id}_${prov.toLowerCase()}_key` });
            }
          } catch (err) {}
        }

        const finalModel = selectedModel || defaultModelInfo?.id || "google/gemini-3.1-flash-lite-preview";

        // Synchronize keys to auth-profiles.json for THIS agent only via
        // `sync_agent_api_keys`. The Rust side reads the keychain and applies the
        // per-agent → global precedence (`get_creds_for_agent`), which means clearing
        // a per-agent override correctly falls back to the global key instead of
        // dropping the provider entirely (which is what the older `sync_credentials`
        // path would do when given an empty `mappedKeys` value). No other agents are
        // touched.
        await invoke("sync_agent_api_keys", { agentId: agent.id });
        await invoke("update_agent_personality", {
          agentId: agent.id,
          personality: { ...agent.personality, active_model: finalModel }
        });

        // CRITICAL: Model format must be object { primary: "provider/model-id" }
        // NOT a bare string. Bare string causes silent failure (agent never responds).
        const modelConfig = typeof finalModel === 'string'
          ? { primary: finalModel }
          : finalModel;

        await invoke("update_agent_model", { agentId: agent.id, model: modelConfig });
      }
      setLlmSaveStatus("success");
      setTimeout(() => setLlmSaveStatus("idle"), 2000);
    } catch (e) {
      console.error(e);
      setLlmSaveStatus("error");
    }
  };


  // ── Companion listener ──
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;

    async function setupCompanion() {
      if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (!isMounted) return;
        
        const unlisten = await listen('companion-finished', async (e: any) => {
          const { type, key, appToken, botToken } = e.payload || {};
          if (type) {
            checkDynamicStatuses();
            if (type === "slack") {
              setSlackEnabled(true);
              toggleIntegration("slack", true);
              setSlackConnected(true);
              if (appToken) setSlackAppToken(appToken);
              if (botToken) setSlackBotToken(botToken);
            } else if (["openai", "anthropic", "gemini", "xai", "grok"].includes(type)) {
              let provName = "";
              if (type === "openai") provName = "OpenAI";
              if (type === "anthropic") provName = "Anthropic";
              if (type === "gemini") provName = "Gemini";
              if (type === "xai" || type === "grok") provName = "Grok";
              
              if (provName && key) {
                setKeys(prev => ({ ...prev, [provName]: key }));
              }
            } else {
              setDynamicEnabled(prev => ({ ...prev, [type]: true }));
              toggleIntegration(type, true);
            }
          }
        });

        if (isMounted) {
          unlistenFn = unlisten;
        } else {
          try { unlisten(); } catch (e) {}
        }
      } catch (e) {
        console.warn("Companion listener setup failed:", e);
      }
    }
    setupCompanion();

    return () => {
      isMounted = false;
      if (unlistenFn) {
        try { unlistenFn(); } catch (e) {}
        unlistenFn = undefined;
      }
    };
  }, [agent.id]);

  const checkDynamicStatuses = async () => {
    if (typeof (window as any).__TAURI_INTERNALS__?.invoke !== 'function') return;
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    const obj: Record<string, boolean> = {};
    for (const c of connectors) {
      if (['slack', 'gmail', 'imessage', 'filesystem', 'github'].includes(c.id)) continue;
      let key = c.id.toUpperCase() + "_TOKEN";
      if (c.id === 'calendar') key = `agent_${agent.id}_google_calendar_access_token`;
      if (c.id === 'drive') key = `agent_${agent.id}_google_drive_access_token`;
      if (c.id === 'apple_health') key = `agent_${agent.id}_APPLE_HEALTH_TOKEN`;
      if (c.id === 'live_location') key = `agent_${agent.id}_LIVE_LOCATION_TOKEN`;
      if (c.id === 'shortcuts') key = `agent_${agent.id}_SHORTCUTS_TOKEN`;
      if (c.id === 'vision') key = `agent_${agent.id}_VISION_TOKEN`;
      if (c.id === 'notifications') key = `agent_${agent.id}_NOTIFICATIONS_TOKEN`;
      if (c.id === 'homekit') key = `agent_${agent.id}_HOMEKIT_TOKEN`;
      if (c.id === 'bluetooth') key = `agent_${agent.id}_BLUETOOTH_TOKEN`;
      try {
        const tok = await invoke("get_secret_cmd", { key });
        obj[c.id] = !!tok;
      } catch {
        obj[c.id] = false;
      }
    }
    setDynamicStatuses(obj);
  };

  useEffect(() => {
    checkGatewayStatus();
    loadAllowlists();
  }, [agent.id]);

  useEffect(() => {
    if (connectors.length > 0) {
      checkDynamicStatuses();
    }
    
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;

    const setupRefreshListener = async () => {
      if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (!isMounted) return;

        const unlisten = await listen('refresh_integrations', () => {
          checkGatewayStatus();
          checkDynamicStatuses();
        });

        if (isMounted) {
          unlistenFn = unlisten;
        } else {
          try { unlisten(); } catch (e) {}
        }
      } catch (e) {
        console.warn("Refresh listener setup failed:", e);
      }
    };
    setupRefreshListener();

    return () => {
      isMounted = false;
      if (unlistenFn) {
        try { unlistenFn(); } catch (e) {}
        unlistenFn = undefined;
      }
    };
  }, [agent.id, connectors]);

  const checkGatewayStatus = async () => {
    try {
      const appTok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_slack_app_token` }).catch(() => "");
      const botTok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_slack_bot_token` }).catch(() => "");
      const isConnected = !!(appTok && botTok);
      setSlackConnected(isConnected);
      if (isConnected) {
        const chs = await invoke<Array<{ id: string; name: string; member_count: number }>>("list_slack_channels", { agentId: agent.id }).catch(() => []);
        setSlackChannels(chs);
      }
    } catch { setSlackConnected(false); }

    try {
      const tok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_google_email_access_token` });
      setGmailConnected(!!tok);
    } catch { setGmailConnected(false); }

    try {
      const tok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_google_calendar_access_token` });
      setCalConnected(!!tok);
    } catch { setCalConnected(false); }

    try {
      const tok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_google_drive_access_token` });
      setGDriveConnected(!!tok);
    } catch { setGDriveConnected(false); }

    try {
      const granted = await invoke<boolean>("check_full_disk_access");
      setIMsgConnected(granted);
      if (granted) {
        const threads = await invoke<Array<{ chat_identifier: string; display_name: string; last_message_date: string }>>("list_imessage_threads").catch(() => []);
        setIMsgThreads(threads);
      }
    } catch { setIMsgConnected(false); }

    try {
      const creds = await invoke<Array<{ domain: string; username: string }>>("get_web_credentials_cmd");
      setWebCredentials(creds);
    } catch { setWebCredentials([]); }
  };

  const loadAllowlists = async () => {
    try {
      const sl = await invoke<string[]>("get_allowed_slack_channels", { agentId: agent.id });
      setAllowedSlack(sl || []);
    } catch {}
    try {
      const im = await invoke<string[]>("get_allowed_imessage_threads", { agentId: agent.id });
      setAllowedThreads(im || []);
    } catch {}

    try {
      const paired = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_slack_paired` });
      if (paired === "true") setIsSlackPaired(true);
    } catch {}
    setAllowlistsLoaded(true);
  };

  const saveSlackAllowlist = async (ids: string[]) => {
    try {
      await invoke("update_allowed_slack_channels", { agentId: agent.id, channelIds: ids });
      setAllowedSlack(ids);
      await invoke("sync_gateway_channels");
    } catch (e) { console.error(e); }
  };

  const saveIMsgAllowlist = async (ids: string[]) => {
    try {
      await invoke("update_allowed_imessage_threads", { agentId: agent.id, chatIdentifiers: ids });
      setAllowedThreads(ids);
      await invoke("sync_gateway_channels");
    } catch (e) { console.error(e); }
  };



  useEffect(() => {
    if (allowlistsLoaded && agent.integrations.includes("slack") && allowedSlack.length === 0 && !isSlackPaired && !hasScrolledToSlack) {
      if (sessionStorage.getItem("scrollToSlack") === "true") {
        setHasScrolledToSlack(true);
        sessionStorage.removeItem("scrollToSlack");
        setTimeout(() => {
          const el = document.getElementById("slack-pairing-section");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 300); // Give accordion time to expand
      }
    }
  }, [allowlistsLoaded, agent.integrations, allowedSlack.length, isSlackPaired, hasScrolledToSlack]);

  // ── Row component for each service


  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0", flexShrink: 0 }}>Skills & Access</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 24, flexShrink: 0 }}>What {agent.name} can reach and what they're allowed to do.</p>

      {/* ── Isolation ───────────────────────────────────────────────────────
          Lifted from the old Permissions tab. Lives at the top because it
          frames everything below — the agent's container scope is more
          fundamental than any individual capability.                       */}
      <div style={{
        ...glass(0.5), padding: "12px 18px", borderRadius: 12, marginBottom: 16,
        display: "flex", alignItems: "center", gap: 12,
        borderLeft: `3px solid ${agent.isolated ? "#6B6BAE" : "var(--text-muted)"}`,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={agent.isolated ? "#6B6BAE" : "var(--text-muted)"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>
            {agent.isolated ? "Isolated workspace" : "Shared workspace"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-sub)" }}>
            {agent.isolated
              ? `${agent.name} runs in its own container. No shared memory with other agents, and folders you grant are scoped just to them.`
              : `${agent.name} shares a workspace with your other agents. Switch to isolated for OS-level sandboxing — recommended for money or secrets.`}
          </div>
        </div>
        <button
          onClick={async () => {
            const wasIsolated = agent.isolated;
            try {
              if (typeof invoke === 'function') {
                await invoke("toggle_agent_isolation", { agentId: agent.id, isolated: !wasIsolated });
                useWorldStore.getState().toggleIsolation(agent.id);
              }
            } catch (e) {
              console.error("Failed to toggle isolation:", e);
            }
          }}
          style={{
            padding: "6px 14px", borderRadius: 8, border: "1px solid #6B6BAE",
            background: agent.isolated ? "#6B6BAE" : "transparent",
            color: agent.isolated ? "var(--surface-card)" : "#6B6BAE",
            fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            transition: "all 0.2s", whiteSpace: "nowrap",
          }}
        >{agent.isolated ? "Make shared" : "Isolate"}</button>
      </div>

      {/* ── Access Level ────────────────────────────────────────────────────
          The single tier preset for the whole agent. Replaces the previous
          Capabilities-only tier selector and the Permissions tab's profile
          cards. Source of truth: src/pages/ArchitectView/accessTiers.ts     */}
      {(() => {
        const currentTier = detectCurrentTier(agent.permissions);
        const handleApply = (tier: AccessTier) => {
          // Confirmation modal only fires when escalating TO unrestricted.
          // Stepping down (e.g. Balanced → Guarded) just applies — losing
          // capabilities is never the dangerous direction.
          const isEscalation = tier.highRisk && currentTier?.id !== "unrestricted";
          const apply = () => applyAccessTier(agent, tier);
          executeOrConfirmHighRisk(!!isEscalation, tier.label, apply);
        };
        return (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
              Access Level
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {ACCESS_TIERS.map(tier => {
                const selected = currentTier?.id === tier.id;
                const change = summarizeTierChange(agent.permissions, tier);
                // Tooltip lists exactly what flipping to this tier would change.
                const tooltipParts = [tier.rationale];
                if (change.turningOn.length > 0) tooltipParts.push(`Turns on: ${change.turningOn.join(", ")}`);
                if (change.turningOff.length > 0) tooltipParts.push(`Turns off: ${change.turningOff.join(", ")}`);
                if (change.turningOn.length === 0 && change.turningOff.length === 0) tooltipParts.push("(No changes — already at this level.)");
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => handleApply(tier)}
                    title={tooltipParts.join("\n\n")}
                    style={{
                      padding: "12px 14px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                      background: selected ? `${tier.color}15` : "var(--surface-card)",
                      border: selected ? `2px solid ${tier.color}` : "1px solid var(--border-subtle)",
                      boxShadow: selected ? `0 2px 8px ${tier.color}20` : "none",
                      fontFamily: "inherit", transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{tier.label}</span>
                      {tier.id === getRecommendedTierForAgent(agent.role)?.id && !selected && (
                        <span style={{ fontSize: 9, background: tier.color, color: "white", padding: "1px 5px", borderRadius: 4, fontWeight: 700, letterSpacing: "0.02em" }}>RECOMMENDED</span>
                      )}
                      {tier.highRisk && (
                        <span style={{ fontSize: 9, background: `${tier.color}20`, color: tier.color, padding: "1px 5px", borderRadius: 4, fontWeight: 700, letterSpacing: "0.02em" }}>HIGH RISK</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>{tier.summary}</div>
                  </button>
                );
              })}
            </div>
            {!currentTier && (
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-sub)", fontStyle: "italic" }}>
                Custom — your current settings don't match a preset. Pick one above to reset, or fine-tune individual capabilities below.
              </div>
            )}
            {/* Dangerous-combination warning, lifted from the old Permissions tab. */}
            {agent.permissions.find(p => p.id === "file_write")?.enabled && agent.permissions.find(p => p.id === "browser")?.enabled && (
              <div style={{ marginTop: 14, padding: 14, background: "rgba(212,160,74,0.08)", border: "1px solid rgba(212,160,74,0.3)", borderRadius: 10, display: "flex", gap: 12, alignItems: "flex-start" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D4A04A" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#D4A04A", marginBottom: 4 }}>Risky combination</div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.5 }}>
                    Web browsing + file writes means {agent.name} could download something from the web and save it locally. Only use this combination if {agent.name} specifically needs to.
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Advanced Provider Configuration */}
      <div style={{ ...glass(0.5), borderRadius: 16, overflow: "hidden", padding: 24, marginBottom: 24, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>AI Model</div>
            <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
              Use a different model just for this agent. Leave on the default to share your global key.
            </div>
          </div>
          <div style={{ textAlign: "right", background: "rgba(33,131,128,0.1)", padding: "12px", borderRadius: 8, border: "1px solid rgba(33,131,128,0.2)", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#218380", textTransform: "uppercase" }}>Model Choice</div>
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              style={{ fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(33,131,128,0.3)", outline: "none", background: "var(--surface-card)", color: "var(--text-main)", cursor: "pointer", width: 220 }}
            >
              <option value="">Strategy: {defaultModelInfo.model}</option>
              <optgroup label="Anthropic">
                {(brainModels || []).filter((m: any) => m.provider === "Anthropic").map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                ))}
              </optgroup>
              <optgroup label="OpenAI">
                {(brainModels || []).filter((m: any) => m.provider === "OpenAI").map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                ))}
              </optgroup>
              <optgroup label="Google Gemini">
                {(brainModels || []).filter((m: any) => m.provider === "Google Gemini").map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {["OpenAI", "Anthropic", "Gemini", "Grok"].map(prov => (
            <div key={prov}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-main)" }}>{prov} API Key</div>
                <div
                  style={{ fontSize: 10, color: "#218380", cursor: "pointer", fontWeight: 600, textTransform: "uppercase" }}
                  onClick={async () => {
                    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                    new WebviewWindow('companion_' + Date.now(), {
                      url: `/index.html?companion=${prov === "Grok" ? "xai" : prov.toLowerCase()}`,
                      title: 'Setup Guide',
                      width: 420,
                      height: 760,
                      x: window.screen.availWidth - 440,
                      y: 50,
                      alwaysOnTop: true,
                      decorations: true,
                    });
                  }}
                >
                  Setup Guide ↗
                </div>
              </div>
              <PasswordInput
                placeholder={prov === "Anthropic" ? "sk-ant-..." : "sk-..."}
                value={keys[prov]}
                onChange={(e) => setKeys(prev => ({ ...prev, [prov]: e.target.value }))}
                style={{ padding: "10px 14px", width: "100%", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--glass-light)" }}
              />
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveOverrides} disabled={llmSaveStatus === "loading"} style={{
            padding: "10px 24px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "#3c6663", color: "var(--surface-card)", fontWeight: 600, fontSize: 13, minWidth: 120
          }}>
            {llmSaveStatus === "loading" ? "Saving..." : llmSaveStatus === "success" ? "Saved!" : llmSaveStatus === "error" ? "Error" : "Save Overrides"}
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div style={{
        background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10,
        padding: "10px 14px", fontSize: 12, color: "#0369a1", lineHeight: 1.5,
      }}>
        Gateway-level service connections are managed in the{" "}
        <button onClick={() => setActiveView("integrations")} style={{
          background: "none", border: "none", color: "#0369a1", fontWeight: 700,
          cursor: "pointer", textDecoration: "underline", fontSize: 12, padding: 0, fontFamily: "inherit",
        }}>
          Integrations tab
        </button>
        . Configure here which services are active for <strong>{agent.name}</strong> and which channels/contacts it can access.
      </div>

      {/* High-Risk Modal */}
      {showHighRiskModal && pendingHighRiskAction && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--surface-base)", padding: 32, borderRadius: 16, width: 400, boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 24, marginBottom: 16 }}>⚠️ Security Warning</div>
            <div style={{ fontSize: 14, color: "var(--text-main)", marginBottom: 16, lineHeight: 1.5 }}>
              You are about to enable a high-risk capability (<strong>{pendingHighRiskLabel}</strong>) {agent.isolated ? "for an isolated agent" : ""}.
            </div>
            <div style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 24, lineHeight: 1.5, background: "rgba(212,160,74,0.1)", padding: 12, borderRadius: 8, border: "1px solid rgba(212,160,74,0.3)" }}>
              This could allow the agent to autonomously perform sensitive actions that may result in data loss, financial charges, or security vulnerabilities if the agent is compromised.
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button onClick={() => {
                setShowHighRiskModal(false);
                setPendingHighRiskAction(null);
              }} style={{ padding: "10px 16px", borderRadius: 8, background: "transparent", border: "1px solid var(--border-subtle)", color: "var(--text-main)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
              <button onClick={() => {
                pendingHighRiskAction();
                setShowHighRiskModal(false);
                setPendingHighRiskAction(null);
              }} style={{ padding: "10px 16px", borderRadius: 8, background: "#D4A04A", color: "#FFF", border: "none", cursor: "pointer", fontWeight: 600 }}>Yes, I understand the risks</button>
            </div>
          </div>
        </div>
      )}



      {/* Slack */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#2EB67D"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#2EB67D"/><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/></svg>}
        name="Slack"
        subtitle="Control which Slack channels route messages to this agent"
        connected={slackConnected}
        enabled={slackEnabled}
        initialOpen={allowlistsLoaded && agent.integrations.includes("slack") && allowedSlack.length === 0 && !isSlackPaired}
        onToggle={async (enabled: boolean) => {
          setSlackEnabled(enabled);
          await toggleIntegration("slack", enabled);
        }}
        onSetup={async () => {
          try {
            const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
            const windowLabel = 'companion_slack_' + Date.now();
            const companionWindow = new WebviewWindow(windowLabel, {
              url: `/index.html?companion=slack&agentId=${encodeURIComponent(agent.id)}&agentName=${encodeURIComponent(agent.name)}`,
              title: 'Setup Guide',
              width: 420,
              height: 760,
              x: window.screen.availWidth - 440,
              y: 50,
              alwaysOnTop: true,
              decorations: true,
            });
          } catch (e) {
            console.error("Setup Slack failed:", e);
          }
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Channel allowlist</span>
        </div>
        <MultiPicker
          items={slackChannels}
          selected={allowedSlack}
          onToggle={id => {
            const next = allowedSlack.includes(id)
              ? allowedSlack.filter(x => x !== id)
              : [...allowedSlack, id];
            setAllowedSlack(next);
            saveSlackAllowlist(next);
          }}
          searchValue={slackSearch}
          onSearch={setSlackSearch}
          idKey="id"
          labelKey="name"
          sublabelKey="member_count"
        />

        <div id="slack-pairing-section" style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>Pair your agent</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8, lineHeight: 1.5 }}>
            Now go to Slack and send your bot a direct message with any text (like <code style={{ background: "var(--border-subtle)", padding: "1px 5px", borderRadius: 3 }}>hello</code>), then return and enter the code it replies with here.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={slackPairingCode}
              onChange={e => setSlackPairingCode(e.target.value.toUpperCase())}
              placeholder="XXXXXX"
              maxLength={12}
              style={{
                width: 120, padding: "7px 11px", 
                border: (agent.integrations.includes("slack") && allowedSlack.length === 0 && slackPairingStatus !== "success" && !isSlackPaired) ? "2px solid #ECB22E" : "1px solid var(--border-subtle)",
                boxShadow: (agent.integrations.includes("slack") && allowedSlack.length === 0 && slackPairingStatus !== "success" && !isSlackPaired) ? "0 0 12px rgba(236, 178, 46, 0.6)" : "none",
                borderRadius: 7, fontSize: 14, fontFamily: "monospace", letterSpacing: "0.15em",
                background: "var(--surface-card)", color: "var(--text-main)", textTransform: "uppercase",
                transition: "all 0.3s ease"
              }}
            />
            <button
              onClick={async () => {
                const trimmed = slackPairingCode.trim().toUpperCase();
                if (!trimmed || trimmed.length < 4) return;
                setSlackPairingStatus("loading");
                setSlackPairingError("");
                try {
                  const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                  await invoke("approve_slack_pairing", { code: trimmed });
                  await invoke("store_secret_cmd", { key: `agent_${agent.id}_slack_paired`, value: "true" });
                  setSlackPairingStatus("success");
                  setSlackPairingCode("");
                } catch (e: any) {
                  setSlackPairingStatus("error");
                  setSlackPairingError(e?.toString() || "Pairing failed");
                }
              }}
              disabled={slackPairingStatus === "loading" || !slackPairingCode.trim()}
              style={{
                padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
                borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {slackPairingStatus === "loading" ? "Pairing…" : "Approve"}
            </button>
            <button
              onClick={async () => {
                const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                await invoke("store_secret_cmd", { key: `agent_${agent.id}_slack_paired`, value: "true" });
                setSlackPairingStatus("success");
              }}
              style={{
                padding: "7px 16px", background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border-subtle)",
                borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Skip / Already Paired
            </button>
            {slackPairingStatus === "success" && <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>✓ Paired</span>}
          </div>
          {slackPairingStatus === "error" && <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>{slackPairingError}</div>}
        </div>

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 12 }}>Agent-Specific Tokens</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 4 }}>Bot Token (xoxb-...)</div>
              <PasswordInput
                value={slackBotToken}
                onChange={e => setSlackBotToken(e.target.value)}
                placeholder="xoxb-..."
                style={{ width: "100%", padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 4 }}>App Token (xapp-...)</div>
              <PasswordInput
                value={slackAppToken}
                onChange={e => setSlackAppToken(e.target.value)}
                placeholder="xapp-1-..."
                style={{ width: "100%", padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)", boxSizing: "border-box" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
              <button
                onClick={async () => {
                  setSlackTokensSaving(true);
                  try {
                     const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                     await invoke("store_batch_secrets_cmd", {
                       secrets: {
                          [`agent_${agent.id}_slack_app_token`]: slackAppToken,
                          [`agent_${agent.id}_slack_bot_token`]: slackBotToken
                       }
                     });
                     // Restart gateway to drop old Socket mode connections and apply new tokens
                     await invoke("sync_gateway_channels");
                  } catch (e) {
                     console.error(e);
                  }
                  setTimeout(() => setSlackTokensSaving(false), 1000);
                }}
                disabled={slackTokensSaving}
                style={{
                  padding: "6px 14px", background: "var(--surface-card)", color: "var(--text-main)", border: "1px solid var(--border-subtle)",
                  borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer"
                }}
              >
                {slackTokensSaving ? "Saving..." : "Save Tokens"}
              </button>
              {/* Show Disconnect only when this agent has tokens saved. The modal warns
                  about tokens-and-bindings before invoking `disconnect_slack_for_agent`. */}
              {(slackAppToken || slackBotToken) && (
                <button
                  onClick={() => setAgentDisconnectTarget("slack-agent")}
                  style={{
                    padding: "6px 14px", background: "transparent", color: "#ef4444",
                    border: "1px solid #fca5a5", borderRadius: 6, fontSize: 12,
                    fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Disconnect Slack
                </button>
              )}
            </div>
          </div>
        </div>
      </ServiceRow>

      {/* Gmail */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2z" fill="#fff" stroke="#E8EAED" strokeWidth="1.5"/><path d="M2 6l10 7 10-7" stroke="#EA4335" strokeWidth="2" strokeLinecap="round"/></svg>}
        name="Gmail"
        subtitle="Read and send emails using your Google account"
        connected={gmailConnected}
        enabled={emailMode !== "none"}
        onToggle={async (v) => {
          setEmailMode(v ? "read" : "none");
          await toggleIntegration("email_read", v, ["email_write"]);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => (
            <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`email-mode-${agent.id}`} checked={emailMode === m} onChange={async () => {
                setEmailMode(m);
                await toggleIntegration(`email_${m}`, true, ["email_read", "email_write"].filter(x => x !== `email_${m}`));
              }} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: emailMode === m ? 600 : 400 }}>
                {m === "read" ? "Read-only — monitor inbox, search, summarise" : "Read + Send — can draft and send replies"}
              </span>
            </label>
          ))}
          <div style={{ marginTop: 8, padding: 12, background: "rgba(66, 133, 244, 0.1)", border: "1px solid rgba(66, 133, 244, 0.2)", borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#4285F4", marginBottom: 4 }}>💡 Tip: Dedicated Agent Email</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.4 }}>
              Want to set up an agent with their own dedicated email? Create a new Gmail account and select it during the Google Sign-in flow instead of your personal account.
            </div>
          </div>
          {!gmailConnected && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
              <button
                onClick={async () => {
                  try {
                    const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                    const res: any = await invoke('start_google_oauth', { agentId: agent.id, scopes: ['email'], readOnly: emailMode === "read" });
                    if (res && res.access_token) {
                      checkDynamicStatuses();
                      await invoke("sync_gateway_channels");
                    }
                  } catch (e) { console.error(e); }
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
                  padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                  color: "var(--text-main)", fontWeight: 500
                }}
              >
                Connect Account
              </button>
            </div>
          )}
        </div>
      </ServiceRow>




      {/* Google Calendar */}
      <ServiceRow
        icon={<Calendar size={18} color="#4285F4" />}
        name="Google Calendar"
        subtitle="Allow agent to view and schedule events on your Google Calendar"
        connected={calConnected}
        enabled={calendarMode !== "none"}
        onToggle={async (v) => {
          setCalendarMode(v ? "read" : "none");
          await toggleIntegration("calendar_read", v, ["calendar_write", "calendar"]);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => (
            <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`cal-mode-${agent.id}`} checked={calendarMode === m} onChange={async () => {
                setCalendarMode(m);
                await toggleIntegration(`calendar_${m}`, true, ["calendar_read", "calendar_write", "calendar"].filter(x => x !== `calendar_${m}`));
              }} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: calendarMode === m ? 600 : 400 }}>
                {m === "read" ? "Read-only — monitor schedule and conflicts" : "Read + Write — can create and modify events"}
              </span>
            </label>
          ))}
          {!calConnected && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
              <button
                onClick={async () => {
                  try {
                    const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                    const res: any = await invoke('start_google_oauth', { agentId: agent.id, scopes: ['calendar'], readOnly: calendarMode === "read" });
                    if (res && res.access_token) {
                      checkDynamicStatuses();
                      await invoke("sync_gateway_channels");
                    }
                  } catch (e) { console.error(e); }
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
                  padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                  color: "var(--text-main)", fontWeight: 500
                }}
              >
                Connect Account
              </button>
            </div>
          )}
        </div>
      </ServiceRow>

      {/* Google Drive */}
      <ServiceRow
        icon={<HardDrive size={18} color="#4285F4" />}
        name="Google Drive"
        subtitle="Allow agent to read, write, and organize files in your Google Drive"
        connected={gDriveConnected}
        enabled={driveMode !== "none"}
        onToggle={async (v) => {
          setDriveMode(v ? "read" : "none");
          await toggleIntegration("drive_read", v, ["drive_write", "drive"]);
          if (!v) {
            await toggleIntegration("drive_granular", false);
          } else if (driveAccessScope === "granular") {
            await toggleIntegration("drive_granular", true);
          }
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => (
            <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`drive-mode-${agent.id}`} checked={driveMode === m} onChange={async () => {
                setDriveMode(m);
                await toggleIntegration(`drive_${m}`, true, ["drive_read", "drive_write", "drive"].filter(x => x !== `drive_${m}`));
              }} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: driveMode === m ? 600 : 400 }}>
                {m === "read" ? "Read-only — can view file contents and metadata" : "Read + Write — can create, modify, and delete files"}
              </span>
            </label>
          ))}
          
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginTop: 8 }}>Access Scope</div>
          {(["all", "granular"] as const).map(s => (
            <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`drive-scope-${agent.id}`} checked={driveAccessScope === s} onChange={async () => {
                setDriveAccessScope(s);
                await toggleIntegration("drive_granular", s === "granular");
              }} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: driveAccessScope === s ? 600 : 400 }}>
                {s === "all" ? "All Files — agent can access entire drive" : "Specific Files — agent only accesses files you pick"}
              </span>
            </label>
          ))}

          <div style={{ marginTop: 8, padding: "8px 12px", background: "var(--bg-subtle)", border: "1px solid var(--border-subtle)", borderRadius: 6, color: "var(--text-main)", display: "flex", alignItems: "flex-start", gap: 6 }}>
            <HardDrive size={14} style={{ flexShrink: 0, marginTop: 1, color: "var(--brand-main)" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
              <span style={{ fontSize: 11, lineHeight: "1.4" }}>
                <strong>Note on Access:</strong> {driveAccessScope === "all" ? "Connecting Google Drive grants this agent full read/write access to your entire drive based on the toggle above. You can instruct the agent in its system prompt to restrict its operations to specific folders." : "Connecting Google Drive with Granular Access strictly limits the agent to only the specific files or folders you authorize using the Google Picker API."}
              </span>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  onClick={async () => {
                    if (driveAccessScope === "granular") {
                      if (!import.meta.env.VITE_GOOGLE_API_KEY) {
                         alert("Google Picker requires a Developer API Key in your environment variables (VITE_GOOGLE_API_KEY). Please add it to .env to use granular access.");
                         return;
                      }
                      // Placeholder for loading Google Picker JS API
                      alert("Google Picker API UI is not fully implemented yet. Please switch to 'All Files' or configure the API Key.");
                      return;
                    }

                    try {
                      const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                      const res: any = await invoke('start_google_oauth', { agentId: agent.id, scopes: ['drive'], readOnly: driveMode === "read", granular_drive: driveAccessScope === "granular" });
                      if (res && res.access_token) {
                        checkDynamicStatuses();
                        await invoke("sync_gateway_channels");
                      }
                    } catch (e) { console.error(e); }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
                    padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                    color: "var(--text-main)", fontWeight: 500
                  }}
                >
                  <HardDrive size={12} />
                  {gDriveConnected ? (driveAccessScope === "granular" ? "Select Files via Picker" : "Update Connection Scope") : "Connect Account"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </ServiceRow>

      {/* iMessage */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.02 2 11c0 2.64 1.15 5.02 3 6.71V22l4.29-2.13C10.12 20.28 11.04 20.5 12 20.5c5.52 0 10-3.58 10-8s-4.48-8-10-8z" fill="#34C759"/></svg>}
        name="iMessage"
        subtitle="Choose which contacts and group threads this agent can read and reply to"
        connected={iMsgConnected}
        enabled={iMsgEnabled}
        onToggle={async (enabled: boolean) => {
          setIMsgEnabled(enabled);
          await toggleIntegration("imessage", enabled);
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>
          Contact / thread allowlist
        </div>
        <MultiPicker
          items={iMsgThreads}
          selected={allowedThreads}
          onToggle={id => {
            const next = allowedThreads.includes(id)
              ? allowedThreads.filter(x => x !== id)
              : [...allowedThreads, id];
            setAllowedThreads(next);
            saveIMsgAllowlist(next);
          }}
          searchValue={iMsgSearch}
          onSearch={setIMsgSearch}
          idKey="chat_identifier"
          labelKey="display_name"
        />
      </ServiceRow>

      {/* Web Accounts removed to avoid duplication */}

      {/* File System */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>}
        name="Workspace (File System)"
        subtitle="Allow agent to read and mutate local files in their designated workspace directory."
        connected={true}
        enabled={agent.permissions.some(p => ["file_read", "file_write"].includes(p.id) && p.enabled)}
        statusBadge={
          agent.permissions.some(p => ["file_read", "file_write"].includes(p.id) && p.enabled)
            ? <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
            : <span style={{ fontSize: 10, background: "var(--border-subtle)", color: "#94a3b8", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Disabled</span>
        }
        onToggle={async (enabled: boolean) => {
           const { invoke } = await import('@tauri-apps/api/core');
           const toggle = useWorldStore.getState().togglePermission;
           
           // Apply toggle locally
           if (enabled) {
              if (!agent.permissions.find(p => p.id === "file_read")?.enabled) toggle(agent.id, "file_read");
           } else {
              if (agent.permissions.find(p => p.id === "file_read")?.enabled) toggle(agent.id, "file_read");
              if (agent.permissions.find(p => p.id === "file_write")?.enabled) toggle(agent.id, "file_write");
           }

           // Push to backend
           setTimeout(async () => {
             const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
             if (!currentAgent) return;
             const capabilitiesObj: any = {};
             currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
             try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
           }, 100);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => {
            const hasWrite = agent.permissions.find(p => p.id === "file_write")?.enabled;
            const isChecked = m === "write" ? hasWrite : !hasWrite;
            const recommendedTier = getRecommendedTierForAgent(agent.role);
            const isRecommended = (m === "read" && recommendedTier?.enabled["file_read"] && !recommendedTier?.enabled["file_write"]) ||
                                  (m === "write" && recommendedTier?.enabled["file_write"]);
            return (
              <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
                <input type="radio" name={`fs-mode-${agent.id}`} checked={isChecked} onChange={async () => {
                   const { invoke } = await import('@tauri-apps/api/core');
                   const toggle = useWorldStore.getState().togglePermission;
                   
                   if (m === "write" && !hasWrite) {
                     const action = async () => {
                       const { invoke } = await import('@tauri-apps/api/core');
                       const toggle = useWorldStore.getState().togglePermission;
                       toggle(agent.id, "file_write");
                       setTimeout(async () => {
                         const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
                         if (!currentAgent) return;
                         const capabilitiesObj: any = {};
                         currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
                         try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
                       }, 100);
                     };
                     executeOrConfirmHighRisk(true, "File System Write", action);
                   }
                   else if (m === "read" && hasWrite) {
                     toggle(agent.id, "file_write");
                     setTimeout(async () => {
                       const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
                       if (!currentAgent) return;
                       const capabilitiesObj: any = {};
                       currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
                       try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
                     }, 100);
                   }
                }} style={{ accentColor: "#3c6663" }} />
                <span style={{ color: "var(--text-main)", fontWeight: isChecked ? 600 : 400, display: "flex", alignItems: "center", gap: 8 }}>
                  {m === "read" ? "Read-only — can view logs, read documents, search workspace" : "Read & Write — can create, modify, and delete files"}
                  {isRecommended && (
                    <span style={{ fontSize: 9, color: "var(--brand-main)", fontWeight: 700, display: "flex", alignItems: "center", gap: 3 }} title={`Included in the ${recommendedTier?.label || 'Recommended'} preset`}>
                      ★ RECOMMENDED
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        {/* Allowed Folders section */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
          <div 
            onClick={() => setFoldersExpanded(!foldersExpanded)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {foldersExpanded ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronRight size={14} color="var(--text-muted)" />}
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Allowed Folders ({allowedDirs.length})</div>
            </div>
          </div>
          
          {foldersExpanded && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button 
                  disabled={!agent.isolated}
                onClick={async () => {
                  if (!agent.isolated) return;
                  try {
                    const selected = await open({
                      directory: true,
                      multiple: true,
                      title: "Select Allowed Folders"
                    });
                    if (selected) {
                      const newDirs = Array.isArray(selected) ? selected : [selected];
                      const uniqueDirs = Array.from(new Set([...allowedDirs, ...newDirs]));
                      setAllowedDirs(uniqueDirs);
                      await invoke("update_agent_allowed_directories", { agentId: agent.id, directories: uniqueDirs });
                      // Force a restart of the gateway to pick up the new volumes
                      await invoke("start_gateway");
                    }
                  } catch (e) {
                    console.error("Failed to select directories:", e);
                  }
                }}
                style={{ 
                  display: "flex", alignItems: "center", gap: 4, 
                  background: agent.isolated ? "transparent" : "var(--bg-subtle)", 
                  border: "1px solid var(--border-subtle)", 
                  padding: "4px 8px", borderRadius: 6, fontSize: 11, 
                  cursor: agent.isolated ? "pointer" : "not-allowed",
                  color: agent.isolated ? "var(--text-main)" : "var(--text-muted)",
                  opacity: agent.isolated ? 1 : 0.6
                }}
                title={!agent.isolated ? "Agent must be isolated to add custom folders" : ""}
              >
                <Plus size={12} />
                Add Folder
              </button>
            </div>
            
            {allowedDirs.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                No specific folders allowed. The agent will only have access to its default workspace.
                {!agent.isolated && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "var(--bg-subtle)", border: "1px solid var(--border-subtle)", borderRadius: 6, color: "var(--text-main)", display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1, color: "var(--brand-main)" }} />
                    <span style={{ fontSize: 11, lineHeight: "1.4" }}>
                      <strong>Strict Isolation Required:</strong> Custom folder access must be explicitly scoped per-agent. To enforce this security boundary, you must switch this agent to <strong>Isolated Mode</strong> before selecting custom folders. Alternatively, for agents in the Shared Gateway, consider connecting Google Drive where folder access can be scoped explicitly per-agent via OAuth.
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {allowedDirs.map(dir => (
                  <div key={dir} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-elevated)", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                      <HardDrive size={14} color="var(--text-muted)" />
                      <span style={{ fontSize: 12, color: "var(--text-main)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={dir}>
                        {dir}
                      </span>
                    </div>
                    <button 
                      onClick={async () => {
                        const newDirs = allowedDirs.filter(d => d !== dir);
                        setAllowedDirs(newDirs);
                        await invoke("update_agent_allowed_directories", { agentId: agent.id, directories: newDirs });
                        await invoke("start_gateway");
                      }}
                      style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", color: "var(--text-muted)" }}
                      title="Remove folder"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {!agent.isolated && allowedDirs.length > 0 && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "#fefce8", border: "1px solid #fef08a", borderRadius: 6, color: "#854d0e", display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <Shield size={14} style={{ flexShrink: 0, marginTop: 1, color: "#ca8a04" }} />
                    <span style={{ fontSize: 11, lineHeight: "1.4" }}>
                      <strong>Warning:</strong> These folders were added during a previous session. Because this agent is currently in the Shared Gateway, these folders are mounted into the shared container and could theoretically be accessed by other non-isolated agents. <strong>Please switch to Isolated Mode for strict security scoping, or consider using Google Drive for secure file access in the Shared Gateway.</strong>
                    </span>
                  </div>
                )}
              </div>
            )}
            </div>
          )}
        </div>
      </ServiceRow>

      {/* ── Suggested Services ── */}
      <div style={{ marginTop: 24, marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>Suggested Services</div>
      </div>
      
      {/* Web Credentials */}
      {webCredentials && webCredentials.length > 0 && (
        <ServiceRow
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>}
          name="Web Credentials"
          subtitle="Allow this agent to seamlessly log into these websites."
          connected={true}
          enabled={webCredentials.some(c => agent.integrations.includes(`web_${c.domain}_${c.username}`))}
          statusBadge={null}
          onToggle={async (enabled: boolean) => {
             // If toggled globally, toggle all
             const toRemove = webCredentials.map(c => `web_${c.domain}_${c.username}`);
             if (enabled) {
                let newIntegrations = [...agent.integrations];
                toRemove.forEach(rm => {
                  if (!newIntegrations.includes(rm)) newIntegrations.push(rm);
                });
                const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
                useWorldStore.getState().setAgents(
                  useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
                );
             } else {
                let newIntegrations = agent.integrations.filter(i => !toRemove.includes(i));
                const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
                useWorldStore.getState().setAgents(
                  useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
                );
             }
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 8, borderBottom: "1px solid var(--border-subtle)" }}>
              <input 
                type="text" 
                placeholder="Search domain or username..." 
                value={webCredSearch}
                onChange={(e) => setWebCredSearch(e.target.value)}
                style={{ width: "200px", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 12, background: "var(--surface-base)", color: "var(--text-main)", outline: "none" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button 
                  onClick={async () => {
                     const toRemove = webCredentials.map(c => `web_${c.domain}_${c.username}`);
                     let newIntegrations = [...agent.integrations];
                     toRemove.forEach(rm => {
                       if (!newIntegrations.includes(rm)) newIntegrations.push(rm);
                     });
                     const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                     await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
                     useWorldStore.getState().setAgents(
                       useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
                     );
                  }}
                  style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 4, border: "1px solid var(--border-subtle)", background: "var(--surface-raised)", cursor: "pointer", color: "var(--text-main)" }}
                >
                  Enable All
                </button>
                <button 
                  onClick={async () => {
                     const toRemove = webCredentials.map(c => `web_${c.domain}_${c.username}`);
                     let newIntegrations = agent.integrations.filter(i => !toRemove.includes(i));
                     const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                     await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
                     useWorldStore.getState().setAgents(
                       useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
                     );
                  }}
                  style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 4, border: "1px solid var(--border-subtle)", background: "transparent", cursor: "pointer", color: "var(--text-main)" }}
                >
                  Disable All
                </button>
              </div>
            </div>
            {webCredentials
              .filter(cred => cred.domain.toLowerCase().includes(webCredSearch.toLowerCase()) || cred.username.toLowerCase().includes(webCredSearch.toLowerCase()))
              .map(cred => {
              const integrationKey = `web_${cred.domain}_${cred.username}`;
              const hasAccess = agent.integrations.includes(integrationKey);
              return (
                <div key={integrationKey} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(0,0,0,0.04)", paddingBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{cred.domain}</div>
                    <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 2 }}>{cred.username}</div>
                  </div>
                  <Toggle enabled={hasAccess} onChange={() => toggleIntegration(integrationKey, !hasAccess)} />
                </div>
              );
            })}
          </div>
        </ServiceRow>
      )}

      {/* Capabilities — moved to the bottom of the tab as a "Fine-tune" disclosure.
          The top-level Access Level tier preset handles the common case; this section
          is for power users who want per-permission control. Covers ALL permissions
          on the agent, not just the 9 from the old "Capabilities" group. */}
      {(() => {
        // Use the shared risk-band map so we stay in sync with accessTiers.ts.
        const CAP_RISK_BAND = PERMISSION_RISK_BAND;

        // "Payments & Spending" ServiceRow below, so we hide them here to avoid
        // duplicate toggles. We also hide 'imessage' because it is managed as a primary integration.
        // The rest are hidden because they are currently UI stubs not yet wired into the OpenClaw backend.
        const HIDDEN_FROM_FINE_TUNE = new Set([
          "payments", "spend_auto", "imessage", 
          "ext_network", "int_network", 
          "memory_write", "photos"
        ]);
        const finetunePerms = agent.permissions.filter(p => !HIDDEN_FROM_FINE_TUNE.has(p.id));

        return (
          <ServiceRow
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6B6BAE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>}
            name="Fine-tune capabilities"
            subtitle="Toggle each capability individually. Most people don't need this — the Access Level preset above covers the common cases."
            connected={true}
            statusBadge={<span style={{ fontSize: 10, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Advanced</span>}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {finetunePerms.map((p, i, arr) => {
                const band = CAP_RISK_BAND[p.id] || "medium";
                const bandColor = band === "high" ? "#C62828" : band === "medium" ? "#D4A04A" : "#218380";
                const bandLabel = band === "high" ? "High risk" : band === "medium" ? "Medium risk" : "Low risk";
                const recommendedTier = getRecommendedTierForAgent(agent.role);
                const isRecommended = recommendedTier?.enabled[p.id] === true;
                return (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none", paddingBottom: i < arr.length - 1 ? 12 : 0 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{p.label}</div>
                        <span title={`${bandLabel} — ${band === "high" ? "can take real-world actions on your behalf" : band === "medium" ? "can reach beyond the agent's sandbox" : "stays inside the agent's sandbox"}`} style={{
                          fontSize: 9,
                          background: `${bandColor}15`,
                          color: bandColor,
                          padding: "1px 5px",
                          borderRadius: 4,
                          fontWeight: 700,
                          letterSpacing: "0.02em",
                          cursor: "help",
                        }}>{bandLabel.toUpperCase()}</span>
                        {isRecommended && (
                          <span style={{ fontSize: 9, color: "var(--brand-main)", fontWeight: 700, display: "flex", alignItems: "center", gap: 3 }} title={`Included in the ${recommendedTier?.label || 'Recommended'} preset`}>
                            ★ RECOMMENDED
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>{p.description}</div>
                    </div>
                    <Toggle enabled={p.enabled} onChange={async () => {
                      const action = async () => {
                        const { invoke } = await import('@tauri-apps/api/core');
                        useWorldStore.getState().togglePermission(agent.id, p.id);
                        setTimeout(async () => {
                          const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
                          if (!currentAgent) return;
                          const capabilitiesObj: any = {};
                          currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
                          try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
                        }, 100);
                      };
                      // Only confirm when turning ON a high-risk capability.
                      executeOrConfirmHighRisk(!p.enabled && band === "high", p.label, action);
                    }} />
                  </div>
                );
              })}
            </div>
          </ServiceRow>
        );
      })()}

      {/* Payments & Financials */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2EB67D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>}
        name="Payments & Spending"
        subtitle="Manage agent spending limits, virtual cards, and payment execution."
        connected={true}
        enabled={agent.permissions.some(p => ["payments", "spend_auto"].includes(p.id) && p.enabled) || budget?.payments_enabled}
        statusBadge={
          (agent.permissions.some(p => ["payments", "spend_auto"].includes(p.id) && p.enabled) || budget?.payments_enabled)
            ? <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
            : <span style={{ fontSize: 10, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Disabled</span>
        }
        onToggle={async (enabled: boolean) => {
           const action = async () => {
             const { invoke } = await import('@tauri-apps/api/core');
             const toggle = useWorldStore.getState().togglePermission;
             
             ["payments", "spend_auto"].forEach(pid => {
                const p = agent.permissions.find(x => x.id === pid);
                if (p && p.enabled !== enabled) toggle(agent.id, pid);
             });
             
             if (budget) {
               const newBudget = { ...budget, payments_enabled: enabled };
               setBudget(newBudget);
               try { await invoke('update_agent_budget', { budget: newBudget }); } catch (e) { console.error(e); }
             }

             setTimeout(async () => {
               const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
               if (!currentAgent) return;
               const capabilitiesObj: any = {};
               currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
               try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
             }, 100);
           };
           executeOrConfirmHighRisk(enabled, "Payments & Spending", action);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Permissions Toggles */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {agent.permissions.filter(p => ["payments", "spend_auto"].includes(p.id)).map((p, i, arr) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(0,0,0,0.04)", paddingBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>{p.description}</div>
                </div>
                <Toggle enabled={p.enabled} onChange={async () => {
                  const action = async () => {
                    const { invoke } = await import('@tauri-apps/api/core');
                    useWorldStore.getState().togglePermission(agent.id, p.id);
                    setTimeout(async () => {
                      const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
                      if (!currentAgent) return;
                      const capabilitiesObj: any = {};
                      currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
                      try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
                    }, 100);
                  };
                  executeOrConfirmHighRisk(!p.enabled, p.label, action);
                }} />
              </div>
            ))}
          </div>
          
          {/* Budget UI */}
          {budgetLoading ? (
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Loading budget data...</div>
          ) : !budget ? (
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Failed to load budget data.</div>
          ) : (
            <>
              <div style={{ padding: 16, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Virtual Card Access</div>
                  <Toggle enabled={budget.payments_enabled} onChange={() => updateBudgetProp("payments_enabled", !budget.payments_enabled)} />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 20 }}>When disabled, the agent cannot issue any real-world merchant charges. It will simulate approvals.</div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Require Approval for New Merchants</div>
                  <Toggle enabled={budget.require_approval_new_merchant} onChange={() => updateBudgetProp("require_approval_new_merchant", !budget.require_approval_new_merchant)} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Require Approval for Subscriptions</div>
                  <Toggle enabled={budget.require_approval_recurring} onChange={() => updateBudgetProp("require_approval_recurring", !budget.require_approval_recurring)} />
                </div>
              </div>

              <div style={{ padding: 16, borderRadius: 12, background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 20 }}>Limits & Thresholds</div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Per-Transaction Limit ($)</div>
                  <input type="number" value={budget.per_transaction_limit_cents / 100} onChange={e => updateBudgetProp("per_transaction_limit_cents", Math.max(0, parseInt(e.target.value) || 0) * 100)} style={{ width: 90, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", textAlign: "right", fontSize: 12 }} />
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Auto-Approve Threshold ($)</div>
                  <input type="number" value={budget.auto_approve_threshold_cents / 100} onChange={e => updateBudgetProp("auto_approve_threshold_cents", Math.max(0, parseInt(e.target.value) || 0) * 100)} style={{ width: 90, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", textAlign: "right", fontSize: 12 }} />
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Daily Budget Total ($)</div>
                  <input type="number" value={budget.daily_limit_cents / 100} onChange={e => updateBudgetProp("daily_limit_cents", Math.max(0, parseInt(e.target.value) || 0) * 100)} style={{ width: 90, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", textAlign: "right", fontSize: 12 }} />
                </div>
                
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button onClick={handleSaveBudget} disabled={budgetSaving} style={{
                    padding: "8px 16px", borderRadius: 8, background: budgetSaving ? "#4A9E96" : "#3c6663", color: "var(--surface-card)", fontSize: 12, fontWeight: 600, border: "none", cursor: budgetSaving ? "default" : "pointer", transition: "0.2s"
                  }}>
                    {budgetSaving ? "Saved ✓" : "Commit Limits"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </ServiceRow>
      {/* Dynamic Connectors from Admin */}
      {connectors.filter(c => c.isVisible && c.isSuggested && !['slack', 'gmail', 'imessage', 'filesystem', 'calendar', 'drive'].includes(c.id)).map(c => {
        let IconComponent: any = Link;
        if (c.icon === 'calendar') IconComponent = Calendar;
        if (c.icon === 'hard-drive') IconComponent = HardDrive;
        if (c.icon === 'github') IconComponent = Github;
        if (c.icon === 'send' || c.icon === 'message-circle') IconComponent = MessageCircle;
        if (c.icon === 'cloud') IconComponent = Cloud;
        if (c.icon === 'database') IconComponent = Database;
        if (c.icon === 'activity') IconComponent = Activity;
        if (c.icon === 'map-pin') IconComponent = MapPin;
        if (c.icon === 'zap') IconComponent = Zap;
        if (c.icon === 'camera') IconComponent = Camera;
        if (c.icon === 'bell') IconComponent = Bell;
        if (c.icon === 'home') IconComponent = Home;
        if (c.icon === 'bluetooth') IconComponent = Bluetooth;
        if (c.icon === 'slack') IconComponent = ({size, color}: any) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#2EB67D"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#2EB67D"/><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/></svg>;

        return (
          <ServiceRow
            key={c.id}
            icon={<IconComponent size={18} color="#3c6663" />}
            name={c.name}
            subtitle={c.subtitle}
            connected={dynamicStatuses[c.id] || false}
            enabled={dynamicEnabled[c.id]}
            onToggle={(enabled) => {
              setDynamicEnabled(prev => ({ ...prev, [c.id]: enabled }));
              toggleIntegration(c.id, enabled);
            }}
            onSetup={async () => {
              if (c.needsCompanion) {
                 const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                 new WebviewWindow('companion_' + c.id + '_' + Date.now(), {
                   url: `/index.html?companion=${c.id}&agentId=${encodeURIComponent(agent.id)}&agentName=${encodeURIComponent(agent.name)}`,
                   title: `Setup ${c.name}`,
                   width: 420,
                   height: 760,
                   x: window.screen.availWidth - 440,
                   y: 50,
                   alwaysOnTop: true,
                   decorations: true,
                 });
              } else {
                 if (c.isGlobal) {
                   if (c.id === 'calendar' || c.id === 'drive') {
                      try {
                         const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                         const res: any = await invoke('start_google_oauth', { agentId: agent.id, scopes: [c.id === 'calendar' ? 'calendar' : 'drive'], readOnly: false });
                         if (res && res.access_token) {
                            checkDynamicStatuses();
                            await invoke("sync_gateway_channels");
                         }
                      } catch (e) {
                         console.error(e);
                      }
                   } else if (c.id === 'github') {
                      setDynamicSetupState(prev => ({ ...prev, [c.id]: !prev[c.id] }));
                   } else {
                      setActiveView("integrations");
                   }
                 } else {
                   setDynamicSetupState(prev => ({ ...prev, [c.id]: !prev[c.id] }));
                 }
              }
            }}
          >
            {(dynamicSetupState[c.id] || (c.id === 'github' ? !!githubToken : dynamicStatuses[c.id])) && c.id !== 'twilio' && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{(c.id === 'github' ? !!githubToken : dynamicStatuses[c.id]) ? `Update ${c.name} Personal Access Token` : `Enter ${c.name} Personal Access Token`}</span>
                  {c.id === 'github' && (
                    <a 
                      href="#" 
                      onClick={async (e) => {
                        e.preventDefault();
                        window.open("https://github.com/settings/tokens/new?description=Canopy%20Agent", "_blank");
                        try {
                          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                          new WebviewWindow('companion_' + c.id + '_' + Date.now(), {
                            url: `/index.html?companion=${c.id}&agentId=${encodeURIComponent(agent.id)}&agentName=${encodeURIComponent(agent.name)}`,
                            title: `Setup ${c.name}`,
                            width: 420,
                            height: 760,
                            x: window.screen.availWidth - 440,
                            y: 50,
                            alwaysOnTop: true,
                            decorations: true,
                          });
                        } catch(err) { console.error(err); }
                      }}
                      style={{ fontSize: 11, color: "#3c6663", textDecoration: "none" }}
                    >
                      Get Token →
                    </a>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <PasswordInput
                    value={c.id === 'github' ? githubToken : (dynamicSetupValue[c.id] || "")}
                    onChange={e => {
                      if (c.id === 'github') setGithubToken(e.target.value);
                      else setDynamicSetupValue(prev => ({ ...prev, [c.id]: e.target.value }));
                    }}
                    placeholder={c.id === 'github' ? "ghp_..." : ""}
                    style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 12, background: "var(--surface-base)", color: "var(--text-main)" }}
                  />
                  <button
                    onClick={async () => {
                      const val = c.id === 'github' ? githubToken : dynamicSetupValue[c.id];
                      if (val) {
                        setDynamicSetupLoading(prev => ({ ...prev, [c.id]: true }));
                        try {
                          const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                          if (c.id === 'github') {
                            await invoke("configure_github", { agentId: agent.id, personalAccessToken: val });
                            // Auto-enable GitHub integration after successful configuration
                            await toggleIntegration("github", true);
                          } else if (c.id === 'telegram') {
                            // Per-agent: scope the Telegram bot token to THIS agent.
                            // See channels.rs configure_telegram comment.
                            await invoke("configure_telegram", { agentId: agent.id, botToken: val });
                            await toggleIntegration("telegram", true);
                          } else if (c.id === 'discord') {
                            await invoke("configure_discord", { agentId: agent.id, botToken: val });
                            await toggleIntegration("discord", true);
                          } else {
                            await invoke("store_secret_cmd", { key: `${c.id.toUpperCase()}_TOKEN`, value: val });
                            // Auto-enable integration after successful configuration
                            await toggleIntegration(c.id, true);
                            await invoke("sync_gateway_channels");
                          }
                          // Provide visual feedback instead of instantly wiping the UI
                          setTimeout(() => {
                            if (c.id !== 'github') {
                              setDynamicSetupState(prev => ({ ...prev, [c.id]: false }));
                              setDynamicSetupValue(prev => ({ ...prev, [c.id]: "" }));
                            }
                          }, 1500);
                          checkDynamicStatuses();
                        } catch (e) {
                          alert('Failed to save token');
                        }
                        setDynamicSetupLoading(prev => ({ ...prev, [c.id]: false }));
                      }
                    }}
                    disabled={dynamicSetupLoading[c.id] || !dynamicSetupValue[c.id]}
                    style={{ padding: "6px 12px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: dynamicSetupLoading[c.id] || !dynamicSetupValue[c.id] ? 0.5 : 1 }}
                  >
                    {dynamicSetupLoading[c.id] ? "Saving..." : "Save"}
                  </button>
                  <button onClick={() => setDynamicSetupState(prev => ({ ...prev, [c.id]: false }))} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border-subtle)", borderRadius: 6, color: "var(--text-sub)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                  {/* Per-agent GitHub disconnect — only when this agent has a saved PAT.
                      Routes through `disconnect_github` which wipes both keychain entries
                      and the gh wrapper script inside the gateway workspace. */}
                  {c.id === 'github' && githubToken && (
                    <button
                      onClick={() => setAgentDisconnectTarget("github-agent")}
                      style={{
                        padding: "6px 12px", background: "transparent", color: "#ef4444",
                        border: "1px solid #fca5a5", borderRadius: 6, fontSize: 12,
                        fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            )}
            {(dynamicSetupState[c.id] || dynamicStatuses[c.id]) && c.id === 'twilio' && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>
                  Configure Twilio Credentials
                </div>
                <input
                  type="text"
                  id={`twilio-sid-${c.id}`}
                  placeholder="Account SID (e.g. AC123...)"
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 12, background: "var(--surface-base)", color: "var(--text-main)" }}
                />
                <PasswordInput
                  id={`twilio-token-${c.id}`}
                  placeholder="Auth Token"
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 12, background: "var(--surface-base)", color: "var(--text-main)" }}
                />
                <input
                  type="text"
                  id={`twilio-phone-${c.id}`}
                  placeholder="Twilio Phone Number (e.g. +15551234567)"
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 12, background: "var(--surface-base)", color: "var(--text-main)" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button 
                    onClick={async () => {
                      const sid = (document.getElementById(`twilio-sid-${c.id}`) as HTMLInputElement)?.value;
                      const token = (document.getElementById(`twilio-token-${c.id}`) as HTMLInputElement)?.value;
                      const phone = (document.getElementById(`twilio-phone-${c.id}`) as HTMLInputElement)?.value;
                      if (sid && token && phone) {
                        setDynamicSetupLoading(prev => ({ ...prev, [c.id]: true }));
                        try {
                          const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                          // Per-agent: each agent has its own Twilio sub-account credentials.
                          await invoke("configure_twilio", { agentId: agent.id, accountSid: sid, authToken: token, phoneNumber: phone });
                          setDynamicSetupState(prev => ({ ...prev, [c.id]: false }));
                          checkDynamicStatuses();
                        } catch (e: any) {
                          alert(`Failed to save Twilio credentials: ${e}`);
                        }
                        setDynamicSetupLoading(prev => ({ ...prev, [c.id]: false }));
                      } else {
                        alert("Please fill out all Twilio fields.");
                      }
                    }}
                    disabled={dynamicSetupLoading[c.id]}
                    style={{ padding: "6px 12px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: dynamicSetupLoading[c.id] ? 0.5 : 1 }}
                  >
                    {dynamicSetupLoading[c.id] ? "Saving..." : "Save"}
                  </button>
                  <button onClick={() => setDynamicSetupState(prev => ({ ...prev, [c.id]: false }))} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border-subtle)", borderRadius: 6, color: "var(--text-sub)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            )}
          </ServiceRow>
        );
      })}

      {/* ── Plugin Directory ── */}
      <div style={{ marginTop: 32, marginBottom: 16, paddingTop: 32, borderTop: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Shield style={{ width: 18, height: 18, color: "var(--brand-teal)" }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", display: "flex", alignItems: "center", gap: 8 }}>
              Communication Channels
              {agent.isolated && (
                <span style={{ fontSize: 10, background: "rgba(212,160,74,0.15)", color: "#A87212", padding: "2px 6px", borderRadius: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <ShieldCheck style={{ width: 10, height: 10 }} /> Isolated Sandbox
                </span>
              )}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>Community plugins</div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 4 }}>
              Third-party plugins built by other users. <strong style={{ color: "#E57373" }}>Anything you install here runs code we haven't verified — install only what you trust.</strong>
            </div>
          </div>
          <input 
            type="text" 
            placeholder="Search plugins..." 
            value={pluginSearch}
            onChange={e => setPluginSearch(e.target.value)}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", color: "var(--text-main)", fontSize: 13, width: 220 }}
          />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        {connectors
          .filter(c => c.isPlugin)
          .filter(c => !pluginSearch || c.name.toLowerCase().includes(pluginSearch.toLowerCase()) || c.subtitle.toLowerCase().includes(pluginSearch.toLowerCase()))
          .map(c => (
            <ServiceRow
              key={c.id}
              icon={<span style={{ fontSize: 18 }}>{c.emoji || "🔌"}</span>}
              name={c.name}
              subtitle={c.subtitle}
              connected={dynamicStatuses[c.id] || false}
              enabled={dynamicEnabled[c.id]}
              onToggle={(enabled) => {
                setDynamicEnabled(prev => ({ ...prev, [c.id]: enabled }));
                toggleIntegration(c.id, enabled);
              }}
              onSetup={() => {
                setPluginSetupTarget(c.name);
              }}
            />
          ))}
      </div>

      {/* Plugin Warning Modal */}
      {pluginSetupTarget && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--surface-base)", padding: 24, borderRadius: 12, width: 400, border: "1px solid var(--border-subtle)", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, color: "#E57373" }}>
              <ShieldCheck size={24} />
              <div style={{ fontSize: 16, fontWeight: 700 }}>Security Warning</div>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 16 }}>
              You are about to configure <strong>{pluginSetupTarget}</strong>. Native OpenClaw plugins are created by other users of unverified trust. Installing or configuring them executes third-party code and could lead to security vulnerabilities.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 24 }}>
              Proceed at your own risk.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
              <button 
                onClick={() => setPluginSetupTarget(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-main)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  if (onOpenTerminal) {
                    onOpenTerminal(`openclaw skills config ${pluginSetupTarget}`);
                  } else {
                    alert(`To configure ${pluginSetupTarget}, follow the instructions in the OpenClaw documentation or run \`openclaw skills config ${pluginSetupTarget}\` in the terminal.`);
                  }
                  setPluginSetupTarget(null);
                }}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#E57373", color: "#FFF", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                I Understand, Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-agent disconnect-confirmation modal. Used by both the per-agent Slack
          disconnect button (above) and the GitHub Disconnect button (in the dynamic
          connector setup block). Other agents' connections are NOT affected. */}
      <ConfirmDisconnectModal
        open={agentDisconnectTarget !== null}
        integrationName={agentDisconnectTarget ? AGENT_DISCONNECT_CONFIG[agentDisconnectTarget].displayName : ""}
        tokens={agentDisconnectTarget ? AGENT_DISCONNECT_CONFIG[agentDisconnectTarget].tokens : []}
        boundAgents={agentDisconnectTarget ? [agent.name] : []}
        extraNote={agentDisconnectTarget ? AGENT_DISCONNECT_CONFIG[agentDisconnectTarget].extraNote : undefined}
        busy={agentDisconnectBusy}
        onCancel={() => { if (!agentDisconnectBusy) setAgentDisconnectTarget(null); }}
        onConfirm={handleAgentDisconnect}
      />

    </div>
  );
}