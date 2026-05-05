import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, Github, MessageCircle, Cloud, Link
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, MultiPicker, glass } from "../../App";
import { PasswordInput } from "../../components/shared/PasswordInput";

export function ConnectionsTab({ agent }: { agent: AgentData }) {
  const { setActiveView } = useWorldStore();

  // Gateway connection statuses (read-only here)
  const [slackConnected, setSlackConnected] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [calConnected, setCalConnected] = useState(false);
  const [gDriveConnected, setGDriveConnected] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [iMsgConnected, setIMsgConnected] = useState(false);

  // Web Credentials
  const [webCredentials, setWebCredentials] = useState<Array<{ domain: string; username: string }>>([]);
  const [webCredSearch, setWebCredSearch] = useState("");
  const [pluginSearch, setPluginSearch] = useState("");

  // Dynamic Connectors
  const [connectors, setConnectors] = useState<any[]>([]);
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

  useEffect(() => {
    if (typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function') {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
      invoke("get_secret_cmd", { key: `agent_${agent.id}_slack_app_token` }).then((t: any) => setSlackAppToken(t as string)).catch(() => {});
      invoke("get_secret_cmd", { key: `agent_${agent.id}_slack_bot_token` }).then((t: any) => setSlackBotToken(t as string)).catch(() => {});
    }
  }, [agent.id]);

  // Per-agent iMessage thread allowlist
  const [iMsgEnabled, setIMsgEnabled] = useState(agent.integrations.includes("imessage"));
  const [iMsgThreads, setIMsgThreads] = useState<Array<{ chat_identifier: string; display_name: string; last_message_date: string }>>([]);
  const [allowedThreads, setAllowedThreads] = useState<string[]>([]);
  const [iMsgPickerOpen, setIMsgPickerOpen] = useState(false);
  const [iMsgSearch, setIMsgSearch] = useState("");

  // Per-agent email mode (uses user's Gmail vs dedicated address)
  const [emailMode, setEmailMode] = useState<"none" | "read" | "write" | "dedicated">(
    agent.integrations.includes("email_write") ? "write"
    : agent.integrations.includes("email_read") ? "read"
    : agent.integrations.includes("email_dedicated") ? "dedicated"
    : "none"
  );
  
  const [calendarMode, setCalendarMode] = useState<"none" | "read" | "write">(
    agent.integrations.includes("calendar_write") ? "write"
    : agent.integrations.includes("calendar_read") ? "read"
    : agent.integrations.includes("calendar") ? "write" // Legacy fallback
    : "none"
  );
  const [dedicatedEmail, setDedicatedEmail] = useState("");
  const [dedicatedPassword, setDedicatedPassword] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);

  // Saving state
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

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
    if (availableProviders.length > 0) {
      const prov = availableProviders[0];
      const strategy = isHeavy ? "heavy" : "light";
      match = brainModels.find((m: any) => m.provider === prov && m.strategy === strategy)
           || brainModels.find((m: any) => m.provider === prov);
    }
    if (!match) {
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

        let mappedKeys: Record<string, string> = {};
        if (keys["OpenAI"]) mappedKeys["OPENAI_API_KEY"] = keys["OpenAI"];
        if (keys["Anthropic"]) mappedKeys["ANTHROPIC_API_KEY"] = keys["Anthropic"];
        if (keys["Gemini"]) mappedKeys["GEMINI_API_KEY"] = keys["Gemini"];
        if (keys["Grok"]) mappedKeys["XAI_API_KEY"] = keys["Grok"];

        await invoke("sync_credentials", { agentId: agent.id, keys: mappedKeys });
        await invoke("update_agent_personality", {
          agentId: agent.id,
          personality: { ...agent.personality, active_model: finalModel }
        });
        await invoke("update_agent_model", { agentId: agent.id, model: finalModel });
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
    let unlisten: any;
    (async () => {
      try {
        const { listen: tauriListen } = await import('@tauri-apps/api/event');
        const listen = (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) ? tauriListen : async () => () => {};
        unlisten = await listen('companion-finished', async (e: any) => {
          const { type } = e.payload || {};
          if (type) {
            checkDynamicStatuses();
            if (type === "slack") {
              setSlackEnabled(true);
              toggleIntegration("slack", true);
              setSlackConnected(true);
            } else {
              setDynamicEnabled(prev => ({ ...prev, [type]: true }));
              toggleIntegration(type, true);
            }
          }
        });
      } catch (e) {}
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [agent.id]);

  const checkDynamicStatuses = async () => {
    if (typeof (window as any).__TAURI_INTERNALS__?.invoke !== 'function') return;
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    const obj: Record<string, boolean> = {};
    for (const c of connectors) {
      if (['slack', 'gmail', 'imessage', 'filesystem'].includes(c.id)) continue;
      let key = c.id.toUpperCase() + "_TOKEN";
      if (c.id === 'calendar') key = 'GCAL_ACCESS_TOKEN';
      if (c.id === 'drive') key = 'GDRIVE_ACCESS_TOKEN';
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
    let unlisten: any;
    const setupListener = async () => {
      const { listen } = (window as any).__TAURI_INTERNALS__ || {};
      if (listen) {
         unlisten = await listen('refresh_integrations', () => {
           checkGatewayStatus();
           checkDynamicStatuses();
         });
      } else {
         const { listen: tauriListen } = await import('@tauri-apps/api/event');
         unlisten = await tauriListen('refresh_integrations', () => {
           checkGatewayStatus();
           checkDynamicStatuses();
         });
      }
    };
    setupListener();
    return () => {
      if (typeof unlisten === 'function') unlisten();
    };
  }, [agent.id, connectors]);

  const checkGatewayStatus = async () => {
    try {
      const appTok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_slack_app_token` }).catch(() => "");
      const botTok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_slack_bot_token` }).catch(() => "");
      const isConnected = !!(appTok && botTok);
      setSlackConnected(isConnected);
      if (isConnected) {
        const chs = await invoke<Array<{ id: string; name: string; member_count: number }>>("list_slack_channels").catch(() => []);
        setSlackChannels(chs);
      }
    } catch { setSlackConnected(false); }

    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "GMAIL_ACCESS_TOKEN" });
      setGmailConnected(!!tok);
    } catch { setGmailConnected(false); }

    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "GCAL_ACCESS_TOKEN" });
      setCalConnected(!!tok);
    } catch { setCalConnected(false); }

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
    // Load dedicated email creds if set
    try {
      const cred = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_email_dedicated` });
      if (cred) {
        const [em, pw] = cred.split(" : ");
        setDedicatedEmail(em || "");
        setDedicatedPassword(pw || "");
      }
    } catch {}
  };

  const saveSlackAllowlist = async (ids: string[]) => {
    try {
      await invoke("update_allowed_slack_channels", { agentId: agent.id, channelIds: ids });
      setAllowedSlack(ids);
    } catch (e) { console.error(e); }
  };

  const saveIMsgAllowlist = async (ids: string[]) => {
    try {
      await invoke("update_allowed_imessage_threads", { agentId: agent.id, threadIds: ids });
      setAllowedThreads(ids);
    } catch (e) { console.error(e); }
  };

  const saveDedicatedEmail = async () => {
    if (!dedicatedEmail.trim() || !dedicatedPassword.trim()) return;
    setEmailSaving(true);
    try {
      // Store agent-scoped credential: "email : app-password"
      await invoke("store_secret_cmd", {
        key: `agent_${agent.id}_email_dedicated`,
        value: `${dedicatedEmail.trim()} : ${dedicatedPassword.trim()}`,
      });
      setEmailMode("dedicated");
      await toggleIntegration("email_dedicated", true, ["email_read", "email_write"]);
    } catch (e) { console.error(e); }
    setEmailSaving(false);
  };

  // ── Row component for each service


  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0", flexShrink: 0 }}>Connections & Permissions</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28, flexShrink: 0 }}>Configure how {agent.name} interacts with the outside world.</p>

      {/* Advanced Provider Configuration */}
      <div style={{ ...glass(0.5), borderRadius: 16, overflow: "hidden", padding: 24, marginBottom: 24, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>Cognitive Engines (LLM)</div>
            <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
              Override the global API vault for explicitly isolating this agent. Keep empty to use standard globals.
            </div>
          </div>
          <div style={{ textAlign: "right", background: "rgba(33,131,128,0.1)", padding: "12px", borderRadius: 8, border: "1px solid rgba(33,131,128,0.2)", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#218380", textTransform: "uppercase" }}>Core Model Override</div>
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              style={{ fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(33,131,128,0.3)", outline: "none", background: "var(--surface-card)", color: "var(--text-main)", cursor: "pointer", width: 220 }}
            >
              <option value="">Strategy: {defaultModelInfo.model}</option>
              <optgroup label="Anthropic">
                {brainModels.filter((m: any) => m.provider === "Anthropic").map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                ))}
              </optgroup>
              <optgroup label="OpenAI">
                {brainModels.filter((m: any) => m.provider === "OpenAI").map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                ))}
              </optgroup>
              <optgroup label="Google Gemini">
                {brainModels.filter((m: any) => m.provider === "Google Gemini").map((m: any) => (
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
                      url: `/index.html?companion=${prov.toLowerCase()}`,
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

      {/* Agent's own email */}
      <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, overflow: "hidden", background: "var(--surface-card)", marginBottom: 24 }}>
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>Dedicated agent email</span>
            <span style={{ fontSize: 10, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Optional</span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5, margin: "0 0 12px" }}>
            Give <strong>{agent.name}</strong> their own email identity. Create a Gmail account for them, then generate an App Password under <em>Google Account → Security → 2-Step Verification → App Passwords</em>.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={dedicatedEmail}
              onChange={e => setDedicatedEmail(e.target.value)}
              placeholder="agent@gmail.com"
              style={{ flex: "1 1 180px", padding: "7px 10px", border: "1px solid var(--border-subtle)", borderRadius: 7, fontSize: 12, fontFamily: "inherit", background: "var(--surface-card)", color: "var(--text-main)" }}
            />
            <PasswordInput
              value={dedicatedPassword}
              onChange={e => setDedicatedPassword(e.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx (App Password)"
              style={{ flex: "1 1 200px", padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "inherit", background: "var(--surface-card)", color: "var(--text-main)" }}
            />
            <button onClick={saveDedicatedEmail} disabled={emailSaving || !dedicatedEmail || !dedicatedPassword} style={{
              padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
              borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              opacity: (!dedicatedEmail || !dedicatedPassword) ? 0.5 : 1,
            }}>
              {emailSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Slack */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#2EB67D"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#2EB67D"/><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/></svg>}
        name="Slack"
        subtitle="Control which Slack channels route messages to this agent"
        connected={slackConnected}
        enabled={slackEnabled}
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

            const launchBrowser = async () => {
              const manifest = {
                display_information: { name: agent.name || "Sloane", description: agent.role ? `Your ${agent.role} Canopy Agent` : "Your Canopy Agent", background_color: "#3c6663" },
                features: {
                  app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
                  bot_user: { display_name: agent.name || "Sloane", always_online: true }
                },
                oauth_config: {
                  scopes: { bot: ["chat:write", "channels:history", "channels:read", "groups:history", "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "users:read", "app_mentions:read", "reactions:read", "commands"] },
                  pkce_enabled: false
                },
                settings: {
                  event_subscriptions: { bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "reaction_added", "reaction_removed"] },
                  interactivity: { is_enabled: true },
                  org_deploy_enabled: false,
                  socket_mode_enabled: true,
                  token_rotation_enabled: false,
                  is_mcp_enabled: false
                }
              };
              const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
              const { open } = await import('@tauri-apps/plugin-shell');
              await open(url);
            };

            companionWindow.once('tauri://created', launchBrowser);
            companionWindow.once('tauri://error', (e) => {
              console.error("Window creation error", e);
              launchBrowser();
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

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>Pair with OpenClaw</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8, lineHeight: 1.5 }}>
            Now go to Slack and send your bot a direct message with the word <code style={{ background: "var(--border-subtle)", padding: "1px 5px", borderRadius: 3 }}>pair</code>, then return and enter the code it replies with here.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={slackPairingCode}
              onChange={e => setSlackPairingCode(e.target.value.toUpperCase())}
              placeholder="XXXXXX"
              maxLength={12}
              style={{
                width: 120, padding: "7px 11px", border: "1px solid var(--border-subtle)",
                borderRadius: 7, fontSize: 14, fontFamily: "monospace", letterSpacing: "0.15em",
                background: "var(--surface-card)", color: "var(--text-main)", textTransform: "uppercase",
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
                   // Optionally re-boot agent to pick up token
                   await invoke("boot_sync_agents");
                } catch (e) {
                   console.error(e);
                }
                setTimeout(() => setSlackTokensSaving(false), 1000);
              }}
              disabled={slackTokensSaving}
              style={{
                alignSelf: "flex-start", padding: "6px 14px", background: "var(--surface-card)", color: "var(--text-main)", border: "1px solid var(--border-subtle)",
                borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", marginTop: 4
              }}
            >
              {slackTokensSaving ? "Saving..." : "Save Tokens"}
            </button>
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
          await toggleIntegration("email_read", v, ["email_write", "email_dedicated"]);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => (
            <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`email-mode-${agent.id}`} checked={emailMode === m} onChange={async () => {
                setEmailMode(m);
                await toggleIntegration(`email_${m}`, true, ["email_read", "email_write", "email_dedicated"].filter(x => x !== `email_${m}`));
              }} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: emailMode === m ? 600 : 400 }}>
                {m === "read" ? "Read-only — monitor inbox, search, summarise" : "Read + Send — can draft and send replies"}
              </span>
            </label>
          ))}
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
        onSetup={async () => {
          try {
            const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
            const res: any = await invoke('start_google_oauth', { scopes: ['calendar'], readOnly: calendarMode === "read" });
            if (res && res.access_token) {
              await invoke('store_secret_cmd', { key: 'GCAL_ACCESS_TOKEN', value: res.access_token });
              checkDynamicStatuses();
            }
          } catch (e) { console.error(e); }
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
                <span style={{ color: "var(--text-main)", fontWeight: isChecked ? 600 : 400 }}>
                  {m === "read" ? "Read-only — can view logs, read documents, search workspace" : "Read & Write — can create, modify, and delete files"}
                </span>
              </label>
            );
          })}
        </div>
      </ServiceRow>

      {/* ── Suggested Services ── */}
      <div style={{ marginTop: 24, marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>Suggested Services</div>
      </div>
      
      {/* Web Credentials */}
      {webCredentials.length > 0 && (
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

      {/* Capabilities & Skills */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6B6BAE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>}
        name="Capabilities & Skills"
        subtitle="Manage agent autonomy, capabilities, and OpenClaw skills."
        connected={true}
        enabled={agent.permissions.some(p => ["ext_network", "autonomous", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize"].includes(p.id) && p.enabled)}
        statusBadge={
          agent.permissions.some(p => ["ext_network", "autonomous", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize"].includes(p.id) && p.enabled)
            ? <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
            : <span style={{ fontSize: 10, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Disabled</span>
        }
        onToggle={async (enabled: boolean) => {
           const action = async () => {
             const { invoke } = await import('@tauri-apps/api/core');
             const toggle = useWorldStore.getState().togglePermission;
             
             ["ext_network", "autonomous", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize"].forEach(pid => {
                const p = agent.permissions.find(x => x.id === pid);
                if (p && p.enabled !== enabled) toggle(agent.id, pid);
             });

             setTimeout(async () => {
               const currentAgent = useWorldStore.getState().agents.find(a => a.id === agent.id);
               if (!currentAgent) return;
               const capabilitiesObj: any = {};
               currentAgent.permissions.forEach(px => capabilitiesObj[px.id] = px.enabled);
               try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: capabilitiesObj }); } catch (e) { console.error(e); }
             }, 100);
           };
           executeOrConfirmHighRisk(enabled, "Capabilities & Skills", action);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {agent.permissions.filter(p => ["ext_network", "autonomous", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize"].includes(p.id)).map((p, i, arr) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none", paddingBottom: i < arr.length - 1 ? 12 : 0 }}>
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
                executeOrConfirmHighRisk(!p.enabled && ["ext_network", "autonomous", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize"].includes(p.id), p.label, action);
              }} />
            </div>
          ))}
        </div>
      </ServiceRow>

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
      {connectors.filter(c => c.isVisible && c.isSuggested && !['slack', 'gmail', 'imessage', 'filesystem', 'calendar'].includes(c.id)).map(c => {
        let IconComponent: any = Link;
        if (c.icon === 'calendar') IconComponent = Calendar;
        if (c.icon === 'hard-drive') IconComponent = HardDrive;
        if (c.icon === 'github') IconComponent = Github;
        if (c.icon === 'send' || c.icon === 'message-circle') IconComponent = MessageCircle;
        if (c.icon === 'cloud') IconComponent = Cloud;
        if (c.icon === 'database') IconComponent = Database;
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
                         const res: any = await invoke('start_google_oauth', { scopes: [c.id], readOnly: false });
                         if (res && res.access_token) {
                            await invoke('store_secret_cmd', { key: c.id === 'calendar' ? 'GCAL_ACCESS_TOKEN' : 'GDRIVE_ACCESS_TOKEN', value: res.access_token });
                            checkDynamicStatuses();
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
                   alert(`Setup for ${c.name} is coming soon!`);
                 }
              }
            }}
          >
            {dynamicSetupState[c.id] && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>
                  Enter {c.name} Personal Access Token
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <PasswordInput
                    value={dynamicSetupValue[c.id] || ""}
                    onChange={e => setDynamicSetupValue(prev => ({ ...prev, [c.id]: e.target.value }))}
                    placeholder="ghp_..."
                    style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 12, background: "var(--surface-base)", color: "var(--text-main)" }}
                  />
                  <button 
                    onClick={async () => {
                      const val = dynamicSetupValue[c.id];
                      if (val) {
                        setDynamicSetupLoading(prev => ({ ...prev, [c.id]: true }));
                        try {
                          const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
                          if (c.id === 'github') {
                            await invoke("configure_github", { agentId: agent.id, personalAccessToken: val });
                          } else if (c.id === 'telegram') {
                            await invoke("configure_telegram", { botToken: val });
                          } else if (c.id === 'discord') {
                            await invoke("configure_discord", { botToken: val });
                          } else {
                            await invoke("store_secret_cmd", { key: `${c.id.toUpperCase()}_TOKEN`, value: val });
                          }
                          setDynamicSetupState(prev => ({ ...prev, [c.id]: false }));
                          setDynamicSetupValue(prev => ({ ...prev, [c.id]: "" }));
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
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>OpenClaw Plugin Directory</div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 4 }}>Enable raw native plugins for this agent.</div>
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
                alert(`To configure ${c.name}, follow the instructions in the OpenClaw documentation or run \`openclaw skills config ${c.name}\` in the terminal.`);
              }}
            />
          ))}
      </div>


    </div>
  );
}