import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
const invoke = async <T,>(cmd: string, args?: any): Promise<T> => {
  try {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      return await tauriInvoke(cmd, args);
    }
    return Promise.reject(new Error("Tauri API not available in browser"));
  } catch (e) {
    throw e;
  }
};
import { WorldScene } from "../components/World/WorldScene";
import { LoadingScreen } from "../components/LoadingScreen";
import { useWorldStore, DEFAULT_PERMISSIONS, getPermissionsForRole, getDefaultPersonality, injectPrincipalContext, AgentData, Agent, AGENT_TYPE_INFO, DiscoveredAgent, Permission } from "../store/worldStore";
import { GenerativeResult } from "../components/GenerativeStudio";
import { Toggle, LobsterIcon } from "../App";
import { GenerativeStudio } from "../components/GenerativeStudio";
import { PasswordInput } from "../components/shared/PasswordInput";
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from "rehype-sanitize";

const safeStartGateway = async () => {
    try { return await invoke("start_gateway"); } catch(e){}
};

export function OnboardingWizard() {

  // --- Draft Persistence ---
  const loadDraft = () => {
    try {
      const d = localStorage.getItem('canopy_onboarding_draft');
      const parsed = d ? JSON.parse(d) : null;
      // Safety hatch: If they somehow got stuck on the last step of the draft, wipe it out
      if (parsed && parsed.step >= 6) {
        localStorage.removeItem('canopy_onboarding_draft');
        return null;
      }
      return parsed;
    } catch { return null; }
  };
  const draft = loadDraft();

  const { agents } = useWorldStore();
  const initialStepTarget = agents.length > 0 ? 1 : 0;
  const [step, setStep] = useState(draft?.step !== undefined ? draft.step : -1);
  const [engineStatus, setEngineStatus] = useState<"checking" | "missing" | "starting" | "ready">("checking");
  const [engineError, setEngineError] = useState("");

  const [userName, setUserName] = useState("");


  const [selectedRole, setSelectedRole] = useState<string | null>(draft?.selectedRole || null);
  const [agentName, setAgentName] = useState(draft?.agentName || "");
  const [apiKey, setApiKey] = useState("");
  const [personalityPrompt, setPersonalityPrompt] = useState("");
  const [recentlyRead, setRecentlyRead] = useState<string[]>([]);
  const [customBookInput, setCustomBookInput] = useState("");
  const [llmProvider, setLlmProvider] = useState<"OpenAI" | "Google Gemini" | "Anthropic" | "xAI Grok" | "">("");
  const [apiKeyMode, setApiKeyMode] = useState<"hidden" | "scan" | "manual">("hidden");
  const [customIdentity, setCustomIdentity] = useState<{ baseModelUrl: string | null; accessories: string[]; dynamicColors?: any } | null>(draft?.customIdentity || null);

  const [plugins, setPlugins] = useState<Record<string, boolean>>(draft?.plugins || { slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false });
  const [isolated, setIsolated] = useState(draft?.isolated || false);
  const [agentPermissions, setAgentPermissions] = useState<Permission[]>(() => {
    if (draft?.selectedRole && draft?.isolated !== undefined) {
      return getPermissionsForRole(draft.selectedRole, draft.isolated);
    }
    return DEFAULT_PERMISSIONS.map(p => ({ ...p }));
  });
  const [pendingHighRiskToggle, setPendingHighRiskToggle] = useState<{ id: string, enabled: boolean } | null>(null);
  const [showHighRiskModal, setShowHighRiskModal] = useState(false);

  const isHighRisk = (id: string) => ["payments", "spend_auto", "file_write", "autonomous", "ext_network", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize"].includes(id);

  const [folderAccessType, setFolderAccessType] = useState<"specific" | "all">("specific");
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [testPluginIndex, setTestPluginIndex] = useState(-1);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");

  // Workspace-level service connection status (shared across all agents)
  const [wsSlackConnected, setWsSlackConnected] = useState(false);
  const [wsGmailConnected, setWsGmailConnected] = useState(false);
  const [wsCalConnected, setWsCalConnected] = useState(false);

  // Only agent-local plugins go through Step 5 integration testing
  const AGENT_LOCAL_PLUGINS = ["folders", "imessage", "photos"];
  const enabledPlugins = Object.entries(plugins)
    .filter(([k, v]) => v && AGENT_LOCAL_PLUGINS.includes(k))
    .map(([k]) => k);

  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackWorkspaceMsg, setSlackWorkspaceMsg] = useState("");

  const [fullDiskAccessGranted, setFullDiskAccessGranted] = useState<boolean | null>(null);
  const [imessageThreads, setIMessageThreads] = useState<any[]>([]);
  const [selectedIMessageThreads, setSelectedIMessageThreads] = useState<string[]>([]);
  const [imessageAccessLevel, setImessageAccessLevel] = useState<"read-only" | "read-send">("read-only");

  const [googleTokens, setGoogleTokens] = useState<any>(null);

  const [deployedAgentId, setDeployedAgentId] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [pairingError, setPairingError] = useState("");

  useEffect(() => {
    if (step >= 0) {
      localStorage.setItem('canopy_onboarding_draft', JSON.stringify({
        step, agentName, selectedRole, plugins, customIdentity, isolated
      }));
    }
  }, [step, agentName, selectedRole, plugins, customIdentity, isolated]);

  const checkConnections = async () => {
      try {
        const s = await invoke<{ connected: boolean }>("check_slack_connection");
        setWsSlackConnected(s?.connected ?? false);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: "GMAIL_ACCESS_TOKEN" });
        setWsGmailConnected(!!tok && tok.length > 10);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: "GCAL_ACCESS_TOKEN" });
        setWsCalConnected(!!tok && tok.length > 10);
      } catch {}
      try {
        const profile = await invoke<any>("get_user_profile");
        if (profile) setUserName(profile.name || "");
      } catch {}
  };

  useEffect(() => {
    checkConnections();
    const handleUpdate = () => checkConnections();
    window.addEventListener("slack-updated", handleUpdate);
    window.addEventListener("refresh_integrations", handleUpdate);
    return () => {
      window.removeEventListener("slack-updated", handleUpdate);
      window.removeEventListener("refresh_integrations", handleUpdate);
    };
  }, []);

  const handleSetupIntegration = async (key: string) => {
    if (key === 'slack' || key === 'discord' || key === 'telegram' || key === 'github') {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const nameMap: any = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', github: 'GitHub' };
        new WebviewWindow('companion_' + key + '_' + Date.now(), {
          url: `/index.html?companion=${key}&agentName=${encodeURIComponent(agentName || 'Agent')}`,
          title: `Setup ${nameMap[key]}`,
          width: 420,
          height: 760,
          x: window.screen.availWidth - 440,
          y: 50,
          alwaysOnTop: true,
          decorations: true,
        });
    } else if (key === 'email' || key === 'calendar') {
        try {
          const result = await invoke<{ access_token?: string }>("start_google_oauth", {
            scopes: [key === 'email' ? 'email' : 'calendar'],
            readOnly: false,
          });
          if (result.access_token) {
            await invoke("store_secret_cmd", { key: key === 'email' ? "GMAIL_ACCESS_TOKEN" : "GCAL_ACCESS_TOKEN", value: result.access_token });
            checkConnections();
            setPlugins(prev => ({ ...prev, [key]: true }));
          }
        } catch (e) { console.error("OAuth failed:", e); }
    } else if (key === 'imessage') {
        try {
          await invoke("start_imessage_watcher", { appHandle: null }).catch(() => {});
          const granted = await invoke<boolean>("check_full_disk_access");
          if (!granted) {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
          }
          checkConnections();
        } catch (e) {}
    }
  };


  useEffect(() => {
    const setupListener = async () => {
      try {
        const { listen: tauriListen } = await import('@tauri-apps/api/event');
        const listen = (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) ? tauriListen : async () => () => {};
        const unlisten1 = await listen('companion-finished', async (e: any) => {
          const { type, key } = e.payload || {};
          if (type === "slack") {
            setWsSlackConnected(true);
            setPlugins(prev => ({ ...prev, slack: true }));
          } else if (key) {
            setApiKey(key);
            if (type === "gemini") setLlmProvider("Google Gemini");
            else if (type === "openai") setLlmProvider("OpenAI");
            else if (type === "anthropic") setLlmProvider("Anthropic");
            else if (type === "xai") setLlmProvider("xAI Grok");
            setApiKeyMode("manual");
          }
          try {
            // Use Tauri V2 getAllWebviewWindows to grab all labeled instances regardless of their dynamic Date.now() tail
            if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
              const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
              const windows = await getAllWebviewWindows();
              for (const w of windows) {
                if (w.label.toLowerCase().includes('companion')) {
                  await w.close().catch(console.warn);
                }
              }
            }
          } catch (err) {
            console.error("Failed to close companions automatically:", err);
          }
        });

        const unlisten2 = await listen('close-companion', async () => {
          try {
            if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
              const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
              const windows = await getAllWebviewWindows();
              for (const w of windows) {
                if (w.label.toLowerCase().includes('companion')) {
                  await w.close().catch(console.warn);
                }
              }
            }
          } catch (err) { }
        });

        return () => { unlisten1(); unlisten2(); };
      } catch (e) { return () => { }; }
    };
    let unlistenFn: any;
    setupListener().then(f => unlistenFn = f);
    return () => { if (unlistenFn) unlistenFn(); };
  }, []);
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>([]);
  const [isDeployingImport, setIsDeployingImport] = useState(false);
  const [createAgentError, setCreateAgentError] = useState("");
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);

  useEffect(() => {
    if (step === -1) {
      const checkEngine = async () => {
        try {
          if (typeof invoke === 'function') {
            const isInstalled = await invoke("check_orbstack_installed");
            if (isInstalled) {
              setEngineStatus("starting");
              await safeStartGateway();
              setEngineStatus("ready");
              setStep(initialStepTarget);
            } else {
              setEngineStatus("missing");
            }
          } else {
            setStep(initialStepTarget);
          }
        } catch (e) {
          setEngineError(e as string);
          setEngineStatus("missing");
        }
      };
      checkEngine();
    }
  }, [step]);

  useEffect(() => {
    let unlisten: any;
    (async () => {
      try {
        const { listen: tauriListen } = await import('@tauri-apps/api/event');
        const listen = (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) ? tauriListen : async () => () => {};
        unlisten = await listen('slack-connected', (event: any) => {
          setSlackWorkspaceMsg(`Connected to ${event.payload.workspace}`);
          setTestStatus("success");
        });
      } catch (e) {
        console.log("No tauri event API natively available", e);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // ── Model catalogue — sourced from Rust, never from localhost:3001 ───────────
  // localhost:3001/api/models was a dev-only proxy that served stale/phantom model
  // names (e.g. "gemini-3.1-flash" which does not exist). We now get the list directly
  // from model_constants.rs via a Tauri command, so the frontend and backend always agree.
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  useEffect(() => {
    invoke<any[]>("get_available_models")
      .then(models => setAvailableModels(models))
      .catch(err => console.warn("Failed to fetch available models from Rust:", err));
  }, []);

  // Heavy roles get powerful models; light roles get fast models.
  const HEAVY_ROLES = ["Strategist", "Analyst", "Researcher", "Engineer"];

  const getDynamicRecommendedModel = (role: string) => {
    const isHeavy = HEAVY_ROLES.includes(role);
    const strategy = isHeavy ? "heavy" : "light";
    const match = availableModels.find((m: any) => m.strategy === strategy);
    if (match) return { provider: match.provider, model: `${match.name} — ${match.description}`, id: match.id };
    return { provider: "Google Gemini", model: "Gemini 3.1 Flash Lite — Fastest Gemini 3 model (Preview)", id: "google/gemini-3.1-flash-lite-preview" };
  };

  const getProviderRecommendedModel = (role: string, targetProvider: string) => {
    const isHeavy = HEAVY_ROLES.includes(role);
    const strategy = isHeavy ? "heavy" : "light";
    const options = availableModels.filter((m: any) => m.provider === targetProvider && m.strategy === strategy);
    if (options.length > 0) return { model: `${options[0].name} — ${options[0].description}`, id: options[0].id };
    const fallbacks = availableModels.filter((m: any) => m.provider === targetProvider);
    if (fallbacks.length > 0) return { model: `${fallbacks[0].name} — ${fallbacks[0].description}`, id: fallbacks[0].id };
    return { model: "Standard Model", id: "" };
  };

  const startImportFlow = async () => {
    setStep(1.8);
    try {
      if (typeof invoke === 'function') {
        const agents = await invoke("scan_local_agents") as DiscoveredAgent[];
        setDiscoveredAgents(agents);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleImportAgent = async (a: DiscoveredAgent) => {
    setIsDeployingImport(true);
    try {
      if (typeof invoke === 'function') {
        const newAgentData = await invoke("import_discovered_agent", {
          agentId: a.id,
          path: a.path
        }) as Agent;

        const roleInfo = agentTypeInfo["Custom"] || agentTypeInfo[Object.keys(agentTypeInfo)[0]];
        const enrichedAgent: AgentData = {
          ...newAgentData,
          title: `The Imported Agent`,
          description: "An agent ported from " + a.source,
          image: roleInfo?.image,
          robeColor: roleInfo?.robeColor || "#888",
          accentColor: roleInfo?.accentColor || "#ccc",
          position: [Math.random() * 2 - 1, 0, Math.random() * 2 - 1],
          targetPosition: [Math.random() * 2 - 1, 0, Math.random() * 2 - 1],
          currentAction: "idle",
          socialMotive: 0.5 + Math.random() * 0.3,
          energy: 0.6 + Math.random() * 0.3,
          uptime: "0 hrs",
          tokensUsed: "0k",
          weeklyCompute: "0.000",
          monthlySpend: 0,
          spendLimit: 200,
          permissions: DEFAULT_PERMISSIONS.map(p => ({ ...p })),
          recentSpend: [],
          chatLog: [],
          memories: [],
          personalityPrompt: "Imported via Auto-Discovery",
          avatarPrompt: `Isometric 3D-rendered agent character in Monument Valley art style. Rounded bell-shaped body with ${roleInfo?.robeColor || "#888"} shell, smooth round head, two swept-back antennae with bulbous ${roleInfo?.accentColor || "#ccc"} tips, small expressive claws at sides. Flat-shaded low-poly faces, soft directional lighting from upper-left. Warm muted pastel palette. No outlines. Ref: agent-style-grid.png`,
          visual_identity: {
            baseModelUrl: null,
            accessories: [],
          }
        };

        addAgent(enrichedAgent);
        setActiveView("canopy");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to import: " + e);
    }
    setIsDeployingImport(false);
  };

  const { setActiveView, addAgent } = useWorldStore();

  const [agentTypeInfo, setAgentTypeInfo] = useState(AGENT_TYPE_INFO);
  const [globalLibrary, setGlobalLibrary] = useState<any[]>([]);

  // Sync static import changes during Vite HMR
  useEffect(() => {
    setAgentTypeInfo(AGENT_TYPE_INFO);
  }, [AGENT_TYPE_INFO]);

  useEffect(() => {
    fetch('http://localhost:3001/api/agents')
      .then(res => res.json())
      .then(data => setAgentTypeInfo(data))
      .catch(err => console.warn("Local API server not running, using static JSON import.", err));
      
    fetch('http://localhost:3001/api/library')
      .then(res => res.json())
      .then(data => setGlobalLibrary(data))
      .catch(err => console.warn("Local API server not running for library.", err));
  }, []);
  const roleTypes = Object.entries(agentTypeInfo)
    .filter(([key, val]) => key !== "Custom" && val.suggest_in_onboarding)
    .map(([key, val]) => ({ key, ...val }))
    .sort((a: any, b: any) => {
      const aOrder = a.manual_order;
      const bOrder = b.manual_order;
      if (aOrder != null && bOrder != null) return aOrder - bOrder;
      if (aOrder != null) return -1;
      if (bOrder != null) return 1;
      return (b.popularity || 0) - (a.popularity || 0);
    });
  const handleRoleSelect = (roleKey: string) => {
    setSelectedRole(roleKey);
    setLlmProvider(getDynamicRecommendedModel(roleKey).provider as any);
    setApiKeyMode("hidden");
    setApiKey("");
    setRecentlyRead([]);
    setPersonalityPrompt(getDefaultPersonality(roleKey, agentName, agentTypeInfo));
    const shouldIsolate = agentTypeInfo[roleKey]?.recommended_isolated || false;
    setIsolated(shouldIsolate);
    setAgentPermissions(getPermissionsForRole(roleKey, shouldIsolate));
  };

  const handleCreateAgent = async () => {
    if (!selectedRole || !agentName.trim()) return;

    setIsCreatingAgent(true);
    setCreateAgentError("");
    const roleInfo = agentTypeInfo[selectedRole];
    let finalPrompt = personalityPrompt;
    if (recentlyRead.length > 0) {
      finalPrompt += `\n\nRecently Read Books: You have recently read the following books and found them very interesting: ${recentlyRead.join(', ')}.`;
    }

    const tempId = `temp-${Date.now()}`;

    // Inject optimistic agent immediately to dismiss wizard
    const optimisticAgent = {
      id: tempId,
      name: agentName,
      status: "deploying", // Signals UI to show loader rings instead of GLB
      role: selectedRole,
      emoji: "agent",
      title: `The ${selectedRole}`,
      description: roleInfo?.description || "A custom agent",
      image: roleInfo?.image,
      color: customIdentity?.dynamicColors?.color || roleInfo?.color || "#888",
      robeColor: customIdentity?.dynamicColors?.robeColor || roleInfo?.robeColor || "#888",
      accentColor: customIdentity?.dynamicColors?.accentColor || roleInfo?.accentColor || "#ccc",
      position: agents.length > 0 ? [Math.max(...agents.map(a => a.position[0])) + 3.5 + Math.random(), 0, Math.random() * 2 - 1] : [Math.random() * 2 - 1, 0, Math.random() * 2 - 1],
      targetPosition: agents.length > 0 ? [Math.max(...agents.map(a => a.position[0])) + 3.5 + Math.random(), 0, Math.random() * 2 - 1] : [Math.random() * 2 - 1, 0, Math.random() * 2 - 1],
      currentAction: "Initializing Agent Container...",
      socialMotive: 0.5 + Math.random() * 0.3,
      energy: 0.6 + Math.random() * 0.3,
      uptime: "0 hrs",
      tokensUsed: "0k",
      weeklyCompute: "0.000",
      monthlySpend: 0,
      spendLimit: 200,
      permissions: agentPermissions.map(p => ({ ...p })),
      recentSpend: [],
      chatLog: [],
      memories: [],
      personalityPrompt: finalPrompt || `${agentName} is a ${selectedRole.toLowerCase()} agent — reliable, sharp, and always working.`,
      avatarPrompt: `Isometric 3D-rendered agent character in Monument Valley art style. Rounded bell-shaped body with ${roleInfo?.robeColor || "#888"} shell, smooth round head, two swept-back antennae with bulbous ${roleInfo?.accentColor || "#ccc"} tips, small expressive claws at sides. Flat-shaded low-poly faces, soft directional lighting from upper-left. Warm muted pastel palette. No outlines. Ref: agent-style-grid.png`,
      visual_identity: customIdentity || { baseModelUrl: null, accessories: [] }
    } as unknown as AgentData;

    const deployAgentCore = async (optimisticId: string) => {
      try {
        if (typeof invoke === 'function') {
          const profile: any = await invoke("get_user_profile");
          finalPrompt = injectPrincipalContext(finalPrompt, profile);
        }
      } catch (e) {
        console.error("Failed to inject principal context:", e);
      }

      let newAgentData: Agent;
      if (typeof invoke === 'function') {
        newAgentData = await invoke("create_agent", {
          name: agentName,
          role: selectedRole,
          emoji: "agent",
          personality: {
            name: agentName,
            communication_style: roleInfo.description,
            expertise: [],
            guardrails: [],
            custom_instructions: "",
            active_model: llmProvider === "Anthropic" ? "anthropic/claude-3-7-sonnet-20250219" : llmProvider === "OpenAI" ? "openai/gpt-4o" : llmProvider === "Google Gemini" ? "google/gemini-2.5-pro" : llmProvider === "xAI Grok" ? "xai/grok-2-latest" : "anthropic/claude-3-7-sonnet-20250219",
            soul_template: roleInfo.soul_template,
            identity_template: finalPrompt,
          },
          isolated: isolated,
          capabilities: agentPermissions.reduce((acc, p) => ({ ...acc, [p.id]: p.enabled }), {}),
        }) as Agent;

        let defaultAccessories: string[] = [];
        try {
          const accRes = await fetch('http://localhost:3001/api/accessories');
          if (accRes.ok) {
            const catalog = await accRes.json();
            defaultAccessories = catalog.defaults?.[selectedRole as string] || [];
          }
        } catch (e) {
          console.warn("Could not fetch accessory defaults", e);
        }

        if (defaultAccessories.length > 0) {
          try {
            await invoke("update_agent_visuals", {
              agentId: newAgentData.id,
              visuals: JSON.stringify({ accessories: defaultAccessories })
            });
            newAgentData.visual_identity = { accessories: defaultAccessories };
          } catch (e) {
            console.error("Failed to seed default visual identity", e);
          }
        }

        if (apiKey.trim()) {
          const providerKeyName: Record<string, string> = {
            "Google Gemini": `agent_${newAgentData.id}_gemini_key`,
            "Anthropic":     `agent_${newAgentData.id}_anthropic_key`,
            "OpenAI":        `agent_${newAgentData.id}_openai_key`,
            "xAI Grok":      `agent_${newAgentData.id}_grok_key`,
          };
          const keyName = providerKeyName[llmProvider] || `agent_${newAgentData.id}_gemini_key`;
          await invoke("store_secret_cmd", { key: keyName, value: apiKey.trim() });
        }

        {
          const globalAnthropic = String(await invoke("get_secret_cmd", { key: "ANTHROPIC_API_KEY" }).catch(() => "") || "");
          const globalOpenAI    = String(await invoke("get_secret_cmd", { key: "OPENAI_API_KEY" }).catch(() => "") || "");
          const globalGemini    = String(await invoke("get_secret_cmd", { key: "GEMINI_API_KEY" }).catch(() => "") || "");
          const globalGrok      = String(await invoke("get_secret_cmd", { key: "XAI_API_KEY" }).catch(() => "")
                                      || await invoke("get_secret_cmd", { key: "GROK_API_KEY" }).catch(() => "") || "");

          const agAnthropic = String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_anthropic_key` }).catch(() => "") || "") || globalAnthropic;
          const agOpenAI    = String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_openai_key` }).catch(() => "") || "")    || globalOpenAI;
          const agGemini    = String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_gemini_key` }).catch(() => "") || "")    || globalGemini;
          const agGrok      = String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_grok_key` }).catch(() => "") || "")      || globalGrok;

          await invoke("sync_credentials", { agentId: newAgentData.id, keys: {
            "ANTHROPIC_API_KEY": agAnthropic,
            "OPENAI_API_KEY":    agOpenAI,
            "GEMINI_API_KEY":    agGemini,
            "XAI_API_KEY":       agGrok,
          }}).catch(console.warn);
        }

        if (plugins.imessage && selectedIMessageThreads.length > 0) {
          await invoke("update_allowed_imessage_threads", {
            agentId: newAgentData.id,
            chatIdentifiers: selectedIMessageThreads
          });
        }

        if (plugins.folders && selectedFolderPath) {
          const bridgeConfig = {
            scope: { allowed_paths: [selectedFolderPath] },
            expires_at: null,
            push_enabled: false
          };
          await invoke("update_bridge_config", {
            bridgeId: `${newAgentData.id}-files`,
            config: bridgeConfig
          });
        }

        if (googleTokens) {
          if (googleTokens.refresh_token) {
            await invoke("store_secret_cmd", { key: `google_refresh_${newAgentData.id}`, value: googleTokens.refresh_token });
          }
          if (googleTokens.access_token) {
            await invoke("store_secret_cmd", { key: `google_access_${newAgentData.id}`, value: googleTokens.access_token });
          }
        }

        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === optimisticId
            ? { ...a, ...newAgentData, id: newAgentData.id, status: "active", currentAction: "idle" } as AgentData
            : a)
        }));

        if (plugins.slack) {
          const slackBotTok = String(await invoke("get_secret_cmd", { key: "slack-bot-token" }).catch(() => "") || "");
          const slackAppTok = String(await invoke("get_secret_cmd", { key: "slack-app-token" }).catch(() => "") || "");
          if (slackBotTok) {
            await invoke("store_secret_cmd", { key: `agent_${newAgentData.id}_slack_bot_token`, value: slackBotTok }).catch(() => {});
          }
          if (slackAppTok) {
            await invoke("store_secret_cmd", { key: `agent_${newAgentData.id}_slack_app_token`, value: slackAppTok }).catch(() => {});
          }
          await invoke("boot_sync_agents").catch(() => {});
          await invoke("start_slack_listener").catch(() => {});
        }
        
        return newAgentData;
      } else {
        throw new Error("Tauri invoke not found");
      }
    };

    addAgent(optimisticAgent);

    if (plugins.slack) {
      try {
        const newAgent = await deployAgentCore(tempId);
        setDeployedAgentId(newAgent.id);
        setStep(7);
      } catch (err) {
        console.error("Background Agent Deployment Failed:", err);
        setCreateAgentError(String(err));
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === tempId
            ? { ...a, status: "error", currentAction: "Deployment Failed: Docker Container Execution Failure" }
            : a)
        }));
      } finally {
        setIsCreatingAgent(false);
      }
    } else {
      setActiveView("canopy");
      setIsCreatingAgent(false);
      setTimeout(async () => {
        try {
          await deployAgentCore(tempId);
        } catch (err) {
          console.error("Background Agent Deployment Failed:", err);
          useWorldStore.setState(state => ({
            agents: state.agents.map(a => a.id === tempId
              ? { ...a, status: "error", currentAction: "Deployment Failed: Docker Container Execution Failure" }
              : a)
          }));
        }
      }, 100);
    }
  };



  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "#faf9f6",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      overflow: "hidden",
      position: "relative",
    }}>
      {agents.length > 0 && step >= 0 && step < 6 && (
        <button
          onClick={() => {
            // Wipe draft so they don't get stuck if they exit mid-way
            localStorage.removeItem('canopy_onboarding_draft');
            useWorldStore.getState().setActiveView("canopy");
          }}
          style={{
            position: "absolute", top: 24, right: 24,
            width: 40, height: 40, borderRadius: "50%",
            border: "1px solid var(--border-subtle)", background: "var(--surface-card)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "var(--text-sub)",
            zIndex: 100, boxShadow: "0 2px 8px rgba(0,0,0,0.05)"
          }}
          title="Exit Wizard"
        >
          <X size={20} />
        </button>
      )}
      {/* Step -1: Engine Boot */}
      {/* Step -1: Engine Boot */}
      {step === -1 && (
        <>
          {(engineStatus === "checking" || engineStatus === "starting" || engineStatus === "ready") && !engineError ? (
            <LoadingScreen />
          ) : (
            <div style={{ textAlign: "center", maxWidth: 480, display: "flex", flexDirection: "column", alignItems: "center", padding: "40px" }}>

              <div style={{
                width: 80, height: 80, borderRadius: "50%", background: "#F5E6D8",
                display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24,
                boxShadow: "0 8px 32px rgba(245, 230, 216, 0.4)"
              }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3c6663" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>

              <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", marginBottom: 16, fontFamily: "'Noto Serif', Georgia, serif" }}>
                Missing Local Engine
              </h1>

              <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32, lineHeight: 1.6 }}>
                Canopy needs OrbStack installed locally to orchestrate your private agents. Without it, your agents won't actually be able to retain memory.
              </p>

              <button
                onClick={async () => {
                  setEngineStatus("checking");
                  try {
                    await invoke("install_orbstack");
                    const installed = await invoke("check_orbstack_installed");
                    if (installed) {
                      setEngineStatus("starting");
                      await invoke("start_gateway");
                      setStep(0);
                    } else {
                      setEngineStatus("missing");
                    }
                  } catch (e) {
                    setEngineError(e as string);
                    setEngineStatus("missing");
                  }
                }}
                style={{
                  padding: "16px 32px", borderRadius: 12, border: "none",
                  background: "#3c6663", color: "var(--surface-card)", fontSize: 16, fontWeight: 600,
                  cursor: "pointer", boxShadow: "0 4px 12px rgba(60,102,99,0.2)",
                  transition: "all 0.2s ease"
                }}
              >
                {engineError?.includes("start gateway") || engineError?.includes("allocated") ? "Retry Connection" : "Install Embedded Engine"}
              </button>

              {engineError && (
                <div style={{ marginTop: 24, padding: "16px", background: "#FEF2F2", color: "#B91C1C", borderRadius: 8, fontSize: 14 }}>
                  {engineError}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Step 1: Welcome */}
      {step === 0 && (
        <>
          {/* Fullscreen Interactive 3D Background */}
          <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            <Canvas
              orthographic
              style={{ position: "absolute", inset: 0, pointerEvents: "auto", cursor: "grab" }}
              gl={{ antialias: true, alpha: true }}
              camera={{ position: [20, 20, 20], zoom: 150 }}
            >
              <ambientLight intensity={0.7} color="#F5E6D8" />
              <directionalLight position={[10, 20, 5]} intensity={0.8} />
              <OrbitControls enableZoom={true} enablePan={true} autoRotate autoRotateSpeed={0.8} />
              <WorldScene agents={[
                {
                  id: "demo-sloane",
                  role: "Assistant",
                  name: "Sloane",
                  visual_identity: null
                },
                {
                  id: "demo-boots",
                  role: "Accountant",
                  name: "Boots",
                  visual_identity: {
                    habitatId: 7,
                    habitatTransform: { rotationY: 0, x: -0.25, y: 1.75, z: -1.75 }
                  }
                },
                {
                  id: "demo-dev",
                  role: "Coder",
                  name: "Dev",
                  visual_identity: {
                    habitatId: 5,
                    habitatTransform: { rotationY: -0.39269908169872414, x: 1.5, y: 0.5, z: -1.25 }
                  }
                }
              ]} />
            </Canvas>
          </div>

          <div style={{ textAlign: "center", maxWidth: 640, zIndex: 1, position: "relative", pointerEvents: "none", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{
              background: "var(--surface-card)", padding: "8px 16px", borderRadius: 20,
              fontSize: 12, fontWeight: 700, color: "#3c6663", backdropFilter: "blur(8px)",
              display: "flex", alignItems: "center", gap: 8, marginBottom: 40,
              boxShadow: "0 4px 12px rgba(0,0,0,0.05)"
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3c6663", display: "inline-block", animation: "pulse 2s infinite" }} />
              Interactive Habitat (Drag to rotate)
            </div>

            <div style={{
              background: "radial-gradient(ellipse at center, rgba(237,228,219,0.9) 0%, rgba(237,228,219,0) 70%)",
              padding: "40px", borderRadius: "50%"
            }}>
              <h1 style={{ fontSize: 56, fontWeight: 700, color: "var(--text-main)", marginBottom: 16, letterSpacing: "-0.02em", fontFamily: "'Noto Serif', Georgia, serif", textShadow: "0 4px 32px rgba(48,51,48,0.06)" }}>
                Welcome to The Canopy
              </h1>
              <p style={{ fontSize: 20, color: "#4A5568", marginBottom: 40, lineHeight: 1.6, maxWidth: 400, margin: "0 auto 40px", textShadow: "0 2px 8px rgba(255,255,255,0.8)" }}>
                Your agents live here. Let's set up your first one!
              </p>
              <button
                onClick={() => setStep(0.5)}
                style={{
                  pointerEvents: "auto",
                  padding: "18px 48px", borderRadius: 16, border: "none",
                  background: "linear-gradient(135deg, #3c6663, #609995)",
                  color: "var(--surface-card)", fontSize: 18, fontWeight: 700, cursor: "pointer",
                  boxShadow: "0 8px 40px rgba(48,51,48,0.08)",
                  transition: "all 0.3s ease",
                  animation: "pulse 2s ease-in-out infinite",
                }}
              >
                Let's Go!
              </button>
            </div>
          </div>
        </>
      )}

      {/* Step 0.5: User Info */}
      {step === 0.5 && (
        <div style={{ maxWidth: 640, width: "90%", background: "var(--surface-card)", padding: 40, borderRadius: 24, boxShadow: "0 12px 48px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column" }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
            First, who are you?
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>
            Tell the agents what to call you and a little bit about what you do, so they can better assist you. You can change this later.
          </p>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>What should we call you?</label>
            <input
              type="text"
              placeholder="e.g. Scottie"
              value={userName}
              onChange={e => setUserName(e.target.value)}
              style={{ width: "100%", padding: "16px", borderRadius: 12, border: "1px solid #E2E8F0", fontSize: 16, outline: "none", background: "#F8FAFC" }}
            />
          </div>


          <button
            disabled={!userName.trim()}
            onClick={async () => {
              try {
                await invoke("save_user_profile", {
                  profile: {
                    name: userName,
                    email: "",
                    phone: "",
                    timezone: "UTC",
                    working_hours: "",
                    communication_tone: "Professional",
                    global_directives: "Always cite your sources and optimize for safety."
                  }
                });
              } catch (e) {
                console.warn("Failed to save user profile", e);
              }
              setStep(1);
            }}
            style={{
              padding: "16px 32px", borderRadius: 12, border: "none",
              background: userName.trim() ? "var(--text-main)" : "#CBD5E1",
              color: "white", fontSize: 16, fontWeight: 600, cursor: userName.trim() ? "pointer" : "not-allowed",
              alignSelf: "flex-end"
            }}
          >
            Continue
          </button>
        </div>
      )}

      {/* Step 2: Choose Role */}
      {step === 1 && (
        <div style={{ maxWidth: 900, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, textAlign: "center", fontFamily: "'Noto Serif', Georgia, serif" }}>
              {agents.length > 0 ? "Add another agent" : "Create your first agent"}
            </h1>
            <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32, textAlign: "center" }}>
              {agents.length > 0 ? "How should we grow the team?" : "You can create additional agents later"}
            </p>

            <div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 32 }}>
              <button onClick={() => handleRoleSelect("Custom")} style={{
                padding: "12px 24px", borderRadius: 12, background: "var(--glass-heavy)", border: selectedRole === "Custom" ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.1)", color: "var(--text-main)", fontSize: 14, fontWeight: 600, cursor: "pointer"
              }}>+ Create Custom Agent</button>
              <button onClick={startImportFlow} style={{
                padding: "12px 24px", borderRadius: 12, background: "transparent", border: "1px dashed rgba(0,0,0,0.2)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600, cursor: "pointer"
              }}>↓ Import Agent</button>
            </div>

            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16,
              padding: "16px 8px", marginBottom: 24,
            }}>
              {roleTypes.map(role => (
                <div key={role.key} style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", textAlign: "center", marginBottom: 8 }}>
                    {role.key}
                  </div>
                  <div
                    onClick={() => handleRoleSelect(role.key)}
                    style={{
                      borderRadius: 10,
                      cursor: "pointer",
                      overflow: "hidden",
                      border: selectedRole === role.key
                        ? `2px solid ${role.color}`
                        : "1px solid rgba(177,178,175,0.10)",
                      transition: "all 0.25s ease",
                      transform: selectedRole === role.key
                        ? "scale(1.05) translateY(-4px)"
                        : "scale(1)",
                      boxShadow: selectedRole === role.key
                        ? `5px 5px 0 ${role.color}45, 0 14px 32px rgba(0,0,0,0.13)`
                        : "0 4px 24px rgba(48,51,48,0.06)",
                    }}
                  >
                    {/* ── Habitat stage (isometric diorama area) ── */}
                    <div style={{
                      background: role.image ? "transparent" : `linear-gradient(160deg, ${role.habitatColor} 0%, ${role.habitatColor}CC 100%)`,
                      padding: role.image ? 0 : "22px 10px 14px",
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
                      minHeight: 120, position: "relative",
                      width: "100%", aspectRatio: role.image ? "auto" : "auto",
                    }}>
                      {role.image ? (
                        <img src={role.image} alt={role.key} style={{ width: "100%", height: "auto", display: "block", objectFit: "cover" }} />
                      ) : (
                        <>
                          {/* Habitat label badge */}
                          <div style={{
                            position: "absolute", top: 8, left: 8,
                            fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
                            color: role.robeColor, textTransform: "uppercase",
                            background: "var(--glass-light)", borderRadius: 4,
                            padding: "2px 6px",
                          }}>{role.habitatLabel}</div>
                          {/* Isometric ground shadow beneath lobster */}
                          <div style={{
                            position: "absolute", bottom: 10, width: 48, height: 12,
                            borderRadius: "50%",
                            background: `radial-gradient(ellipse at center, ${role.robeColor}30 0%, transparent 70%)`,
                          }} />
                          <LobsterIcon size={72} shellColor={role.robeColor} accentColor={role.accentColor} />
                        </>
                      )}
                    </div>
                    {/* ── Label strip ── */}
                    {!role.image && (
                      <div style={{
                        background: selectedRole === role.key
                          ? `${role.color}18`
                          : "var(--glass-heavy)",
                        padding: "9px 12px 10px",
                        borderTop: selectedRole === role.key
                          ? `1px solid ${role.color}40`
                          : "1px solid rgba(177,178,175,0.10)",
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", letterSpacing: "0.01em", marginBottom: 3, textAlign: "center" }}>
                          {role.key}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-sub)", lineHeight: 1.4, textAlign: "center" }}>
                          {role.description}
                        </div>
                      </div>
                    )}
                    {role.image && (
                      <div style={{
                        background: selectedRole === role.key
                          ? `${role.color}18`
                          : "var(--glass-heavy)",
                        padding: "8px 10px",
                        borderTop: selectedRole === role.key
                          ? `1px solid ${role.color}40`
                          : "1px solid rgba(177,178,175,0.10)",
                        borderBottomLeftRadius: 10, borderBottomRightRadius: 10
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", letterSpacing: "0.01em", marginBottom: 3, textAlign: "center" }}>
                          {role.key}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-sub)", lineHeight: 1.3, textAlign: "center" }}>
                          {role.description}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(0)} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => selectedRole === "Custom" ? setStep(1.5) : setStep(2)} disabled={!selectedRole} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: selectedRole ? "#3c6663" : "var(--border-subtle)",
              color: selectedRole ? "var(--surface-card)" : "var(--text-muted)",
              fontSize: 14, fontWeight: 600, cursor: selectedRole ? "pointer" : "default",
              fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 1.5: Custom Agent 3D Generation */}
      {step === 1.5 && (
        <div style={{ width: "90vw", maxWidth: 1200, height: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: 0 }}>Design Custom Agent</h1>
              <p style={{ fontSize: 14, color: "var(--text-sub)", margin: "4px 0 0 0" }}>Describe the appearance and our AI will conform it to The Canopy's visual identity.</p>
            </div>
            <button onClick={() => setStep(1)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", cursor: "pointer", fontWeight: 600, color: "var(--text-sub)" }}>
              Back
            </button>
          </div>

          <div style={{ flex: 1, overflow: "hidden" }}>
            <GenerativeStudio onApply={(res) => {
              setCustomIdentity({ baseModelUrl: null, accessories: res.dynamicParams.accessories, dynamicColors: res.dynamicParams });
              setStep(2);
            }} />
          </div>
        </div>
      )}

      {/* Step 1.8: Import Agent Flow */}
      {step === 1.8 && (
        <div style={{ maxWidth: 700, width: "90%", maxHeight: "90vh", overflow: "auto" }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, textAlign: "center", fontFamily: "'Noto Serif', Georgia, serif" }}>
            Import Existing Agent
          </h1>
          <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32, textAlign: "center" }}>
            Auto-discovered agents from Docker and your local filesystem
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 40 }}>
            {discoveredAgents.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", background: "var(--glass-light)", borderRadius: 16, border: "1px dashed rgba(0,0,0,0.1)" }}>
                <div style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 16 }}>No local agents detected.</div>
                <button style={{ padding: "12px 24px", borderRadius: 12, background: "transparent", border: "1px solid rgba(0,0,0,0.1)", color: "var(--text-main)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Select BlinkClaw .tar.gz Backup
                </button>
              </div>
            ) : discoveredAgents.map(a => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", justifyItems: "center", background: "var(--surface-card)", padding: 20, borderRadius: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Source: {a.source} ({a.path})</div>
                </div>
                <button onClick={() => handleImportAgent(a)} disabled={isDeployingImport} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: isDeployingImport ? "wait" : "pointer" }}>
                  {isDeployingImport ? "Extracting..." : "Import"}
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => setStep(1)} style={{ padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Back</button>
          </div>
        </div>
      )}

      {/* Step 3: Name & Personality */}
      {step === 2 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
              Name Your Agent
            </h1>
            <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32 }}>
              Give them an identity
            </p>

            <div style={{ marginBottom: 32 }}>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>Agent Name</label>
              <input
                value={agentName}
                onChange={e => {
                  const oldName = agentName || "Agent";
                  const newName = e.target.value;
                  setAgentName(newName);
                  if (personalityPrompt.includes(oldName)) {
                    // Use word boundaries to avoid replacing substrings inside other words
                    const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\b${escapedOldName}\\b`, 'g');
                    setPersonalityPrompt(personalityPrompt.replace(regex, newName || "Agent"));
                  }
                }}
                placeholder="e.g., Atlas, Nova, Sage..."
                style={{
                  width: "100%", padding: "14px 18px", borderRadius: 12,
                  fontSize: 15,
                  fontFamily: "inherit", color: "var(--text-main)",
                  outline: "none", background: "var(--surface-card)",
                }}
              />
            </div>

            {selectedRole && agentTypeInfo[selectedRole] && (
              <div style={{
                background: "var(--surface-base)", padding: 20, borderRadius: 16, marginBottom: 32,
                display: "flex", gap: 16, alignItems: "flex-start", backdropFilter: "blur(4px)",
              }}>
                {agentTypeInfo[selectedRole].image ? (
                  <img src={agentTypeInfo[selectedRole].image} alt={selectedRole} style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />
                ) : (
                  <LobsterIcon size={48} shellColor={agentTypeInfo[selectedRole].robeColor} accentColor={agentTypeInfo[selectedRole].accentColor} />
                )}
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>
                    {agentName || "Your Agent"} the {selectedRole}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5 }}>
                    {agentTypeInfo[selectedRole].description}
                  </div>
                </div>
              </div>
            )}

            <div style={{ background: "var(--surface-base)", backdropFilter: "blur(4px)", padding: 24, borderRadius: 16, marginBottom: 32 }}>
              <h3 style={{ fontSize: 16, color: "var(--text-main)", margin: "0 0 4px 0" }}>Agent Personality</h3>
              <p style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 16 }}>Edit their core instructions below. This drives how they think and communicate.</p>

              <div data-color-mode="light" style={{ borderRadius: 12, overflow: "hidden", border: "1px solid rgba(0,0,0,0.1)" }}>
                <MDEditor
                  value={personalityPrompt}
                  onChange={(val) => setPersonalityPrompt(val || "")}
                  previewOptions={{
                    rehypePlugins: [[rehypeSanitize]],
                  }}
                  height={400}
                />
              </div>

              <div style={{ marginTop: 24 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>Recently Read</label>
                <p style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 12 }}>This gives your agent even more personality. Feel free to pick books unrelated to their job for a creative twist!</p>

                {recentlyRead.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                    {recentlyRead.map(book => (
                      <div key={book} style={{ padding: "6px 12px", background: "#3c6663", color: "var(--surface-card)", borderRadius: 16, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                        {book}
                        <span style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => setRecentlyRead(recentlyRead.filter(b => b !== book))}>×</span>
                      </div>
                    ))}
                  </div>
                )}

                {(() => {
                  const suggested = globalLibrary.filter(b => b.recommendedAgents && b.recommendedAgents.includes(selectedRole || "Custom")).map(b => b.title);
                  if (suggested.length === 0) return null;
                  return (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                      {suggested.filter(b => !recentlyRead.includes(b)).map(book => (
                        <div key={book} onClick={() => setRecentlyRead([...recentlyRead, book])} style={{ padding: "4px 10px", background: "var(--border-subtle)", color: "var(--text-main)", borderRadius: 16, fontSize: 11, cursor: "pointer", border: "1px solid rgba(0,0,0,0.1)", transition: "all 0.2s ease" }}>
                          + {book}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                <div style={{ display: "flex", gap: 8 }}>
                  {(() => {
                    const handleAddCustomBook = () => {
                      const title = customBookInput.trim();
                      if (title) {
                        setRecentlyRead([...recentlyRead, title]);
                        setCustomBookInput("");
                        if (selectedRole && selectedRole !== "Custom") {
                          fetch('http://localhost:3001/api/agents/add-suggestion', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ role: selectedRole, bookTitle: title })
                          }).catch(e => console.warn("Failed to suggest book to backend", e));
                        }
                      }
                    };
                    return (
                      <>
                        <input
                          value={customBookInput}
                          onChange={e => setCustomBookInput(e.target.value)}
                          placeholder="Type a custom book title..."
                          style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12, outline: "none", fontFamily: "inherit" }}
                          onKeyDown={e => { if (e.key === "Enter") handleAddCustomBook(); }}
                        />
                        <button onClick={handleAddCustomBook} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--surface-base)", color: "var(--text-main)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>Add</button>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>

          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(1)} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(3)} disabled={!agentName.trim()} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: agentName.trim() ? "#3c6663" : "var(--border-subtle)",
              color: agentName.trim() ? "var(--surface-card)" : "var(--text-muted)",
              fontSize: 14, fontWeight: 600, cursor: agentName.trim() ? "pointer" : "default",
              fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 4: API Key */}
      {step === 3 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
              Power Up Your Agent
            </h1>
            <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32 }}>
              Provide an LLM API key so your agent can think.
            </p>

            {selectedRole && (
              <div style={{ marginBottom: 24, fontSize: 14, color: "var(--text-main)", background: "rgba(33,131,128,0.1)", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(33,131,128,0.2)" }}>
                {llmProvider && llmProvider !== getDynamicRecommendedModel(selectedRole).provider ? (
                  <>Since you selected <strong>{llmProvider}</strong> for the <strong>{selectedRole}</strong> role, we recommend using <strong>{getProviderRecommendedModel(selectedRole, llmProvider).model}</strong>.</>
                ) : (
                  <>Based on the <strong>{selectedRole}</strong> role, we default to the <strong>{getDynamicRecommendedModel(selectedRole).model}</strong> model.</>
                )}
              </div>
            )}

            <div style={{ marginBottom: 24, display: "flex", flexWrap: "wrap", gap: 12 }}>
              {["OpenAI", "Google Gemini", "Anthropic", "xAI Grok"].map(prov => (
                <label key={prov} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface-card)", padding: "12px 16px", borderRadius: 12, border: llmProvider === prov ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.1)", cursor: "pointer", opacity: llmProvider === prov ? 1 : 0.7 }}>
                  <input type="radio" name="provider" checked={llmProvider === prov} onChange={() => { setLlmProvider(prov as any); setApiKeyMode("hidden"); setApiKey(""); }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{prov}</span>
                </label>
              ))}
            </div>

            <div style={{ marginBottom: 32 }}>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 16 }}>
                API Key Setup
              </label>

              <div style={{ display: "flex", gap: 16, flexDirection: "column" }}>
                <button onClick={async () => {
                  if (!llmProvider) return;
                  setApiKeyMode("scan");
                  try {
                    const providerMap: any = { "OpenAI": "OPENAI", "Google Gemini": "GEMINI", "Anthropic": "ANTHROPIC", "xAI Grok": "XAI" };
                    const provId = providerMap[llmProvider] + "_API_KEY";
                    const secret = await invoke<string>("get_secret_cmd", { key: provId });
                    if (secret) setApiKey(secret);
                    else alert("No existing key found in keychain.");
                  } catch (e) {
                    alert("No existing key found in keychain.");
                  }
                }} disabled={!llmProvider} style={{ padding: "12px 20px", borderRadius: 12, border: !llmProvider ? "1px solid rgba(0,0,0,0.1)" : "1px solid #3c6663", background: "rgba(60,102,99,0.05)", color: !llmProvider ? "var(--text-muted)" : "#3c6663", cursor: !llmProvider ? "default" : "pointer", fontWeight: 600 }}>
                  Scan for existing API key
                </button>
                <div style={{ textAlign: "center", fontSize: 12, color: "var(--text-sub)", margin: "-6px 0" }}>— or —</div>
                <button onClick={async () => {
                  if (!llmProvider) return;
                  setApiKeyMode("manual");

                  try {
                    const providerMap: any = { "OpenAI": "openai", "Google Gemini": "gemini", "Anthropic": "anthropic", "xAI Grok": "xai" };
                    const providerId = providerMap[llmProvider];

                    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                    const windowLabel = 'providerCompanion_' + Date.now();
                    const companionWindow = new WebviewWindow(windowLabel, {
                      url: '/index.html?companion=' + providerId,
                      title: 'Setup Guide',
                      width: 420,
                      height: 760,
                      x: window.screen.availWidth - 440,
                      y: 50,
                      alwaysOnTop: true,
                      decorations: true,
                    });

                    const launchBrowser = async () => {
                      const urls: any = {
                        "OpenAI": "https://platform.openai.com/api-keys",
                        "Google Gemini": "https://aistudio.google.com/app/apikey",
                        "Anthropic": "https://console.anthropic.com/settings/keys",
                        "xAI Grok": "https://console.x.ai/"
                      };
                      const { open } = await import('@tauri-apps/plugin-shell');
                      await open(urls[llmProvider]);
                    };

                    companionWindow.once('tauri://created', launchBrowser);
                    companionWindow.once('tauri://error', (e) => {
                      console.error("Window creation error", e);
                      launchBrowser();
                    });
                  } catch (e) {
                    console.error("Failed to spawn companion", e);
                    // Fallback
                    const urls: any = {
                      "OpenAI": "https://platform.openai.com/api-keys",
                      "Google Gemini": "https://aistudio.google.com/app/apikey",
                      "Anthropic": "https://console.anthropic.com/settings/keys",
                      "xAI Grok": "https://console.x.ai/"
                    };
                    const { open } = await import('@tauri-apps/plugin-shell');
                    await open(urls[llmProvider]);
                  }
                }} disabled={!llmProvider} style={{ padding: "12px 20px", borderRadius: 12, border: "none", background: !llmProvider ? "var(--border-subtle)" : "#3c6663", color: !llmProvider ? "var(--text-muted)" : "var(--surface-card)", cursor: !llmProvider ? "default" : "pointer", fontWeight: 600 }}>
                  Set up new API key ✨
                </button>
              </div>

              {apiKeyMode !== "hidden" && (
                <div style={{ marginTop: 24 }}>
                  <PasswordInput
                    placeholder={`Paste your ${llmProvider || ""} API Key here`}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.1)", fontSize: 14, fontFamily: "monospace", outline: "none" }}
                  />
                </div>
              )}
            </div>

          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(2)} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(4)} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: "#3c6663", color: "var(--surface-card)",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 5: Plugins & Permissions */}
      {step === 4 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>Skills & Access</h1>
            <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32, lineHeight: 1.5 }}>
              Choose what {agentName || "your agent"} can access. Workspace tools like Slack and Gmail are shared across all your agents — connect them once in Integrations.
            </p>

            {/* ── Security Posture ── */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                Security Posture
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-card)", padding: "14px 18px", borderRadius: 12, border: isolated ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)", display: "flex", alignItems: "center", gap: 8 }}>
                    Isolated Sandbox
                    {AGENT_TYPE_INFO[selectedRole || ""]?.recommended_isolated && (
                      <span style={{ fontSize: 10, background: "rgba(212,160,74,0.15)", color: "#A87212", padding: "2px 6px", borderRadius: 4 }}>Recommended</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4, lineHeight: 1.4, maxWidth: "90%" }}>
                    Run this agent in a strictly isolated container. It will not share memory or contexts with other agents, and network/file access is restricted by default.
                  </div>
                </div>
                <Toggle enabled={isolated} onChange={() => {
                  const newIsolated = !isolated;
                  setIsolated(newIsolated);
                  if (selectedRole) setAgentPermissions(getPermissionsForRole(selectedRole, newIsolated));
                }} />
              </div>
            </div>

            {/* ── Workspace Tools (shared, gateway-level) ── */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                Workspace Tools
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {([
                  { key: "slack",    label: "Slack",          icon: "💬", connected: wsSlackConnected, desc: "Send and receive Slack messages" },
                  { key: "email",    label: "Gmail",          icon: "📧", connected: wsGmailConnected, desc: "Read and send email on your behalf" },
                  { key: "calendar", label: "Google Calendar",icon: "📅", connected: wsCalConnected,   desc: "View and create calendar events" },
                ] as const).map(({ key, label, icon, connected, desc }) => (
                  <div key={key} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    background: "var(--surface-card)", padding: "14px 18px", borderRadius: 12,
                    border: plugins[key] ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                    opacity: connected ? 1 : 0.75,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <span style={{ fontSize: 22 }}>{icon}</span>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{label}</span>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20,
                            background: connected ? "rgba(33,131,128,0.12)" : "rgba(0,0,0,0.06)",
                            color: connected ? "#3c6663" : "var(--text-muted)",
                            textTransform: "uppercase", letterSpacing: "0.04em",
                          }}>{connected ? "Connected" : "Not set up"}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{desc}</div>
                      </div>
                    </div>
                    {connected ? (
                      <Toggle enabled={plugins[key]} onChange={() => setPlugins(prev => ({ ...prev, [key]: !prev[key] }))} />
                    ) : (
                      <button onClick={() => handleSetupIntegration(key)} style={{
                        padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(60,102,99,0.25)",
                        background: "rgba(60,102,99,0.06)", color: "#3c6663",
                        fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                      }}>Set up →</button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Device Permissions (agent-local) ── */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                Device Permissions
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {([
                  { key: "folders", label: "File System",   icon: "📁", desc: `Let ${agentName || "the agent"} read and write files on your Mac` },
                  { key: "imessage",label: "iMessage",      icon: "💬", desc: `Access your iMessage conversations` },
                  { key: "photos",  label: "Apple Photos",  icon: "🖼️", desc: `Browse and reference your photo library` },
                ] as const).map(({ key, label, icon, desc }) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: "var(--surface-card)", padding: "14px 18px",
                      borderRadius: plugins[key] && key === "folders" ? "12px 12px 0 0" : 12,
                      border: plugins[key] ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                        <span style={{ fontSize: 22 }}>{icon}</span>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{label}</div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{desc}</div>
                        </div>
                      </div>
                      <Toggle enabled={plugins[key]} onChange={() => setPlugins(prev => ({ ...prev, [key]: !prev[key] }))} />
                    </div>
                    {key === "folders" && plugins.folders && (
                      <div style={{ padding: "16px 20px", background: "var(--glass-light)", borderRadius: "0 0 12px 12px", border: "1px solid #3c6663", borderTop: "none" }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 12 }}>Select Folder Scope</div>
                        <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-main)", cursor: "pointer" }}>
                            <input type="radio" checked={folderAccessType === "specific"} onChange={() => setFolderAccessType("specific")} />
                            Specific Folder
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-main)", cursor: "pointer" }}>
                            <input type="radio" checked={folderAccessType === "all"} onChange={() => setFolderAccessType("all")} />
                            All Folders
                          </label>
                        </div>
                        {folderAccessType === "specific" && (
                          <div style={{ display: "flex", gap: 8 }}>
                            <input type="text" readOnly placeholder="No folder selected..." value={selectedFolderPath} style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, background: "var(--surface-card)", outline: "none" }} />
                            <button onClick={async () => {
                              try {
                                const { open } = await import('@tauri-apps/plugin-dialog');
                                const selected = await open({ directory: true, multiple: false });
                                if (selected) setSelectedFolderPath(selected as string);
                              } catch (e) {
                                console.error("No dialog plugin");
                              }
                            }} style={{ padding: "0 16px", borderRadius: 8, border: "1px solid rgba(33,131,128,0.2)", background: "rgba(33,131,128,0.05)", color: "#3c6663", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Browse...</button>
                          </div>
                        )}
                        {folderAccessType === "all" && (
                          <div style={{ display: "flex", gap: 10, background: "rgba(212,160,74,0.15)", padding: "12px 16px", borderRadius: 8, border: "1px solid rgba(212,160,74,0.3)" }}>
                            <span style={{ fontSize: 18 }}>⚠️</span>
                            <div style={{ fontSize: 12, color: "#A87212", lineHeight: 1.4 }}>
                              <strong>Not recommended.</strong> Granting access to all folders poses a security risk. Your agent will be able to read and modify any file on your system.
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              </div>

            {/* ── OpenClaw Capabilities (Agent Sandbox) ── */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                OpenClaw Capabilities
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {agentPermissions.filter(p => p.id !== "imessage" && p.id !== "photos").map(p => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-card)", padding: "14px 18px", borderRadius: 12, border: p.enabled ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{p.label}</div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{p.description}</div>
                    </div>
                    <Toggle enabled={p.enabled} onChange={() => {
                      if (!p.enabled && isHighRisk(p.id)) {
                        setPendingHighRiskToggle({ id: p.id, enabled: true });
                        setShowHighRiskModal(true);
                      } else {
                        setAgentPermissions(prev => prev.map(old => old.id === p.id ? { ...old, enabled: !old.enabled } : old));
                      }
                    }} />
                  </div>
                ))}
              </div>
            </div>

          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(3)} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => {
              // Only agent-local plugins need integration testing (Step 5)
              if (enabledPlugins.length > 0) {
                setTestPluginIndex(0);
                setStep(5);
              } else {
                setStep(6);
              }
            }} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: "#3c6663", color: "var(--surface-card)",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 6: Integration Testing */}
      {step === 5 && testPluginIndex >= 0 && testPluginIndex < enabledPlugins.length && (
        <div style={{ maxWidth: 500, width: "90%", textAlign: "center" }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, textTransform: enabledPlugins[testPluginIndex] === "imessage" ? "none" : "capitalize" }}>Test {enabledPlugins[testPluginIndex] === "imessage" ? "iMessage" : enabledPlugins[testPluginIndex]}</h1>
          <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32 }}>Let's make sure {agentName || "the agent"} can successfully connect.</p>

          <div style={{ background: "var(--surface-card)", padding: 32, borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)", marginBottom: 32, minHeight: 180, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "slack" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "var(--text-main)", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Connect to Slack</div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 24, textAlign: "center" }}>
                  Canopy connects locally via Socket Mode. Setup is now 3 easy steps!
                </div>

                <div style={{ marginBottom: 20, padding: 24, textAlign: "center", background: "rgba(33,131,128,0.05)", borderRadius: 12, border: "1px solid rgba(33,131,128,0.15)" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>Open the Side-by-Side Guide</div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 20, lineHeight: 1.5 }}>
                    We'll open an always-on-top companion window alongside Slack to walk you through pasting your tokens step-by-step.
                  </div>
                  <button onClick={async () => {
                    try {
                      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

                      const windowLabel = 'slackCompanion_' + Date.now();
                      const companionWindow = new WebviewWindow(windowLabel, {
                        url: '/index.html?companion=slack',
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
                          display_information: { name: agentName || "Sloane", description: selectedRole ? `Your ${selectedRole} Canopy Agent` : "Your Canopy Agent", background_color: "#3c6663" },
                          features: {
                            app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
                            bot_user: { display_name: agentName || "Sloane", always_online: true }
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
                      console.error("Failed to spawn companion", e);
                      // Fallback
                      const manifest = {
                        display_information: { name: agentName || "Sloane", description: selectedRole ? `Your ${selectedRole} Canopy Agent` : "Your Canopy Agent", background_color: "#3c6663" },
                        features: {
                          app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
                          bot_user: { display_name: agentName || "Sloane", always_online: true }
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
                    }
                  }} style={{ padding: "12px 24px", borderRadius: 8, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(60,102,99,0.3)" }}>
                    Launch Slack Setup ✨
                  </button>
                </div>

                <div style={{ textAlign: "center", marginTop: 24, fontSize: 12, color: "var(--text-sub)" }}>
                  Listening for credentials from companion window...
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "imessage" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "var(--text-main)", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>iMessage Bridge</div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 24, textAlign: "center" }}>
                  Canopy reads iMessage directly from macOS. Keep your texts local.
                </div>

                {fullDiskAccessGranted !== true && (
                  <div style={{ padding: "20px", background: "var(--surface-base)", borderRadius: 16, border: "1px solid var(--border-subtle)", marginBottom: 20, animation: "slideIn 0.3s ease" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>Permission Required</div>
                    <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 20, lineHeight: 1.5 }}>
                      macOS blocks access to iMessage databases by default. To securely connect this, please toggle Canopy <strong>on</strong> in your System Settings under <strong>Full Disk Access</strong>.
                    </div>

                    <div style={{ background: "var(--surface-card)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid rgba(0,0,0,0.08)", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", marginBottom: 20 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <img src="/app-icon.png" alt="App Icon" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "contain", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }} />
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-main)" }}>Canopy</div>
                      </div>
                      <div style={{ position: "relative" }}>
                        <div style={{ width: 51, height: 31, background: "#34C759", borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 2, boxSizing: "border-box", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)" }}>
                          <div style={{ width: 27, height: 27, background: "var(--surface-card)", borderRadius: "50%", boxShadow: "0 2px 4px rgba(0,0,0,0.2), 0 1px 1px rgba(0,0,0,0.1)" }} />
                        </div>
                        <div style={{ position: "absolute", top: -4, left: -4, right: -4, bottom: -4, border: "2px solid #007AFF", borderRadius: 24, animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" }} />
                      </div>
                    </div>

                    <button onClick={async () => {
                      try {
                        const { open: shellOpen } = await import('@tauri-apps/plugin-shell');
                        await shellOpen("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
                      } catch (e) {
                        // Fallback for older Tauri versions
                        window.location.href = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
                      }
                      // Auto-check when the user switches back — no need to click a button
                      const onFocus = async () => {
                        window.removeEventListener('focus', onFocus);
                        try {
                          const isGranted = await invoke("check_full_disk_access");
                          if (isGranted) {
                            setFullDiskAccessGranted(true);
                            const threads = await invoke("list_imessage_threads");
                            setIMessageThreads(threads as any[]);
                          }
                        } catch (e) { console.error("Permission re-check failed:", e); }
                      };
                      window.addEventListener('focus', onFocus);
                    }} style={{ width: "100%", padding: "14px 16px", background: "#3c6663", color: "var(--surface-card)", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>
                      Open System Settings → Full Disk Access
                    </button>
                    <div style={{ fontSize: 12, color: "#a0aab2", marginTop: 12, textAlign: "center" }}>
                      Toggle Canopy on in Full Disk Access, then switch back here — it will auto-detect.
                    </div>
                  </div>
                )}

                {fullDiskAccessGranted === true && (
                  <>
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>Access Level</div>
                      <div style={{ display: "flex", gap: 16 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                          <input type="radio" checked={imessageAccessLevel === "read-only"} onChange={() => setImessageAccessLevel("read-only")} /> Read-only
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                          <input type="radio" checked={imessageAccessLevel === "read-send"} onChange={() => setImessageAccessLevel("read-send")} /> Read + Send
                        </label>
                      </div>
                    </div>

                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>Allowed Conversations</div>
                      <div style={{ border: "1px solid rgba(0,0,0,0.1)", borderRadius: 8, maxHeight: 160, overflowY: "auto", background: "var(--surface-base)" }}>
                        {imessageThreads.length === 0 ? (
                          <div style={{ padding: 16, fontSize: 13, color: "var(--text-sub)", textAlign: "center" }}>Loading threads...</div>
                        ) : (
                          imessageThreads.map(thread => (
                            <label key={thread.chat_identifier} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid rgba(0,0,0,0.05)", cursor: "pointer" }}>
                              <input type="checkbox"
                                checked={selectedIMessageThreads.includes(thread.chat_identifier)}
                                onChange={(e) => {
                                  if (e.target.checked) setSelectedIMessageThreads([...selectedIMessageThreads, thread.chat_identifier]);
                                  else setSelectedIMessageThreads(selectedIMessageThreads.filter(id => id !== thread.chat_identifier));
                                }}
                              />
                              <div style={{ fontSize: 13, color: "var(--text-main)" }}>
                                {thread.display_name || thread.chat_identifier}
                                <span style={{ color: "var(--text-sub)", fontSize: 11, marginLeft: 6 }}>({thread.message_count} msgs)</span>
                              </div>
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  </>
                )}

                <div style={{ textAlign: "center", marginTop: 24 }}>
                  <button onClick={async () => {
                    setTestStatus("testing");
                    try {
                      if (typeof invoke === 'function') {
                        if (fullDiskAccessGranted !== true) {
                          const isGranted = await invoke("check_full_disk_access");
                          setFullDiskAccessGranted(isGranted as boolean);
                          if (isGranted) {
                            const threads = await invoke("list_imessage_threads");
                            setIMessageThreads(threads as any[]);
                            setTestStatus("idle"); // reset so they can pick threads safely
                            return;
                          } else {
                            setTestStatus("error");
                            return;
                          }
                        } else {
                          // Already granted, user hits Save
                          if (selectedIMessageThreads.length === 0) {
                            alert("Please select at least one thread to grant to your agent.");
                            setTestStatus("idle");
                            return;
                          }
                          setTestStatus("success");
                        }
                      } else {
                        // mock success
                        if (fullDiskAccessGranted !== true) {
                          setTimeout(() => {
                            setFullDiskAccessGranted(true);
                            setIMessageThreads([{ chat_identifier: "123", display_name: "Mom", message_count: 422 }]);
                            setTestStatus("idle");
                          }, 1000);
                        } else {
                          setTimeout(() => { setTestStatus("success"); }, 1000);
                        }
                      }
                    } catch (e) {
                      console.error(e);
                      setTestStatus("error");
                      setFullDiskAccessGranted(false);
                    }
                  }} style={{
                    padding: "12px 32px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                  }}>
                    {fullDiskAccessGranted === true ? "Save Integration" : "Check Access & Load Threads"}
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "folders" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "var(--text-main)", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Folder Permissions</div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 24, textAlign: "center" }}>
                  Select a local folder on your Mac for the agent to have complete read/write access to.
                </div>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>Access Type</div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                      <input type="radio" checked={folderAccessType === "specific"} onChange={() => setFolderAccessType("specific")} /> Specific Folder
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                      <input type="radio" checked={folderAccessType === "all"} onChange={() => {
                        if (window.confirm("WARNING: Are you sure you want to grant this agent access to your entire hard drive?")) {
                          setFolderAccessType("all");
                          setSelectedFolderPath("/");
                        }
                      }} /> Entire Hard Drive
                    </label>
                  </div>
                </div>

                {folderAccessType === "specific" && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Mapped Directory</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input type="text" readOnly value={selectedFolderPath} placeholder="No folder selected..." style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", boxSizing: "border-box", background: "var(--surface-base)" }} />
                      <button onClick={async () => {
                        try {
                          const { open } = await import('@tauri-apps/plugin-dialog');
                          const selected = await open({ directory: true, multiple: false });
                          if (selected) {
                            setSelectedFolderPath(selected as string);
                          }
                        } catch (e) {
                          console.error(e);
                          // Mock fallback for browser
                          setSelectedFolderPath("/Users/mock/Documents");
                        }
                      }} style={{ padding: "0 16px", borderRadius: 8, border: "1px solid rgba(33,131,128,0.2)", background: "rgba(33,131,128,0.05)", color: "#3c6663", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                        Browse Finder...
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ textAlign: "center", marginTop: 24 }}>
                  <button onClick={() => {
                    if (folderAccessType === "specific" && !selectedFolderPath) {
                      alert("Please select a folder map.");
                      return;
                    }
                    setTestStatus("success");
                  }} style={{
                    padding: "12px 32px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: (folderAccessType === "all" || selectedFolderPath) ? "pointer" : "default", transition: "all 0.2s", opacity: (folderAccessType === "all" || selectedFolderPath) ? 1 : 0.5
                  }}>Save Access Map</button>
                </div>
              </div>
            )}

            {testStatus === "idle" && (enabledPlugins[testPluginIndex] === "email" || enabledPlugins[testPluginIndex] === "calendar") && (
              <div style={{ width: "100%", textAlign: "center" }}>
                <div style={{ fontSize: 16, color: "var(--text-main)", fontWeight: 700, marginBottom: 8 }}>Google Workspace APIs</div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 8 }}>
                  Connect your Google account directly on your Mac using a secure local loopback. Canopy never proxies your data through our servers.
                </div>
                <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 24, padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
                  {enabledPlugins[testPluginIndex] === "email"
                    ? "🔒 Secure Mode: requesting read-only email access"
                    : "🔒 Secure Mode: requesting read-only calendar access"
                  }
                </div>
                <button onClick={async () => {
                  setTestStatus("testing");
                  try {
                    if (typeof invoke === 'function') {
                      const readOnly = true; // Always read-only during onboarding; adjust in Connections tab
                      const tokens = await invoke("start_google_oauth", {
                        scopes: [enabledPlugins[testPluginIndex]],
                        readOnly,
                      });
                      if (tokens) {
                        setGoogleTokens((prev: any) => ({ ...prev, ...tokens as any }));
                      }
                      setTestStatus("success");
                    } else {
                      setTimeout(() => setTestStatus("success"), 2000);
                    }
                  } catch (e) {
                    console.error("Google OAuth error:", e);
                    // Surface the actual error so the user knows what failed
                    const msg = String(e);
                    if (msg.includes("GOOGLE_CLIENT_ID") || msg.includes("client_id")) {
                      alert("OAuth setup error: Google client credentials are missing. Please check your .env file or rebuild the app.");
                    } else if (msg.includes("No code in redirect") || msg.includes("redirect")) {
                      alert("OAuth error: The browser redirect wasn't captured. Make sure you completed the Google sign-in and didn't close the browser tab early.");
                    } else if (msg.includes("Token exchange failed")) {
                      alert(`OAuth error: ${msg}`);
                    }
                    setTestStatus("error");
                  }
                }} style={{
                  padding: "12px 24px", borderRadius: 12, background: "var(--surface-card)", color: "#3c6663", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, margin: "0 auto", border: "1px solid rgba(0,0,0,0.1)", boxShadow: "0 4px 12px rgba(0,0,0,0.05)"
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" /><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" /><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
                  Connect {enabledPlugins[testPluginIndex] === "email" ? "Gmail" : "Google Calendar"}
                </button>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "photos" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "var(--text-main)", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Apple Photos Access</div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 24, textAlign: "center", lineHeight: 1.5 }}>
                  Your agent will be able to search and read your local photo library. Photos never leave your Mac.
                </div>

                <div style={{ padding: "20px", background: "var(--surface-base)", borderRadius: 16, border: "1px solid var(--border-subtle)", marginBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>macOS Permission Required</div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 20, lineHeight: 1.6 }}>
                    macOS controls access to your Photos library through System Settings. You need to grant Canopy <strong>Photos</strong> access — this is separate from Full Disk Access.
                    <ol style={{ margin: "12px 0 0 -4px", paddingLeft: 20, lineHeight: 2 }}>
                      <li>Click <strong>Open System Settings</strong> below</li>
                      <li>Find <strong>Canopy</strong> in the list and toggle it <strong>on</strong></li>
                      <li>Switch back here — access will be confirmed automatically</li>
                    </ol>
                  </div>

                  <button onClick={async () => {
                    try {
                      const { open: shellOpen } = await import('@tauri-apps/plugin-shell');
                      await shellOpen("x-apple.systempreferences:com.apple.preference.security?Privacy_Photos");
                    } catch (e) {
                      window.location.href = "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos";
                    }
                    // Auto-confirm when user switches back
                    const onFocus = () => {
                      window.removeEventListener('focus', onFocus);
                      // There's no Tauri command to check Photos TCC status directly —
                      // trust the user confirmed it (the OS will deny at runtime if they didn't)
                      setTestStatus("success");
                    };
                    window.addEventListener('focus', onFocus);
                  }} style={{ width: "100%", padding: "14px 16px", background: "#3c6663", color: "var(--surface-card)", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>
                    Open System Settings → Photos
                  </button>
                  <div style={{ fontSize: 12, color: "#a0aab2", marginTop: 12, textAlign: "center" }}>
                    Toggle Canopy on, then switch back here — it will auto-confirm.
                  </div>
                </div>

                <div style={{ textAlign: "center" }}>
                  <button onClick={() => setTestStatus("success")} style={{ fontSize: 12, color: "var(--text-sub)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                    I've already granted access — skip check
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] !== "slack" && enabledPlugins[testPluginIndex] !== "imessage" && enabledPlugins[testPluginIndex] !== "folders" && enabledPlugins[testPluginIndex] !== "email" && enabledPlugins[testPluginIndex] !== "calendar" && enabledPlugins[testPluginIndex] !== "photos" && (
              <>
                <div style={{ fontSize: 14, color: "var(--text-main)", fontWeight: 600, marginBottom: 16 }}>Test Action: Send a test ping to your {enabledPlugins[testPluginIndex]}.</div>
                <button onClick={() => {
                  setTestStatus("testing");
                  setTimeout(() => setTestStatus("success"), 1500);
                }} style={{
                  padding: "12px 24px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                }}>Run Test</button>
              </>
            )}

            {testStatus === "testing" && (
              <div style={{ color: "#3c6663", fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ display: "inline-block", width: 16, height: 16, border: "3px solid rgba(33,131,128,0.2)", borderTopColor: "#3c6663", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                Testing connection...
              </div>
            )}

            {testStatus === "error" && (
              <div style={{ color: "#E53E3E", fontSize: 16, fontWeight: 600, textAlign: "center" }}>
                <span style={{ fontSize: 32, display: "block", marginBottom: 8 }}>❌</span>
                Connection Failed.
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 8, fontWeight: 400 }}>Make sure both tokens are valid and the app is installed.</div>
                <button onClick={() => setTestStatus("idle")} style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", cursor: "pointer", fontSize: 13 }}>Try Again</button>
              </div>
            )}

            {testStatus === "success" && (
              <div style={{ color: "#4A9E96", fontSize: 18, fontWeight: 600, animation: "pulse 0.5s", textAlign: "center" }}>
                <span style={{ fontSize: 32, display: "block", marginBottom: 8 }}>✅</span>
                Connected successfully!
                {enabledPlugins[testPluginIndex] === "slack" && slackWorkspaceMsg && (
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 8, fontWeight: 400 }}>{slackWorkspaceMsg}</div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => {
              if (testStatus === "success" || testStatus === "error") {
                if (testPluginIndex < enabledPlugins.length - 1) {
                  setTestPluginIndex(testPluginIndex + 1);
                  setTestStatus("idle");
                } else {
                  setStep(6);
                }
              }
            }} disabled={testStatus === "idle" || testStatus === "testing"} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: testStatus === "success" || testStatus === "error" ? "#3c6663" : "var(--border-subtle)",
              color: testStatus === "success" || testStatus === "error" ? "var(--surface-card)" : "var(--text-muted)",
              fontSize: 14, fontWeight: 600, cursor: testStatus === "success" || testStatus === "error" ? "pointer" : "default",
              fontFamily: "inherit",
              width: "100%", maxWidth: 200
            }}>
              {testStatus === "error" ? "Skip For Now" : testPluginIndex < enabledPlugins.length - 1 ? "Next Integration" : "Finish Setup"}
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Celebration */}
      {step === 6 && (
        <div style={{ textAlign: "center", maxWidth: 500 }}>
          <div style={{
            marginBottom: 36, animation: "bounce 1s ease-in-out infinite",
            display: "inline-block",
          }}>
            {(() => {
              const role = selectedRole ? agentTypeInfo[selectedRole] : null;
              const shellColor = role?.robeColor ?? "#3c6663";
              const accentColor = role?.accentColor ?? "#4A9E96";
              const habitatColor = role?.habitatColor ?? "#BDD5D2";
              const habitatLabel = role?.habitatLabel ?? "The Canopy";
              const borderColor = role?.color ?? "#3c6663";
              return (
                <div style={{
                  borderRadius: 14, overflow: "hidden",
                  border: `1.5px solid ${borderColor}40`,
                  boxShadow: `5px 5px 0 ${borderColor}20, 0 20px 48px ${borderColor}25`,
                  display: "inline-block",
                }}>
                  <div style={{
                    background: `linear-gradient(160deg, ${habitatColor} 0%, ${habitatColor}CC 100%)`,
                    padding: "28px 40px 20px", position: "relative",
                    display: "flex", justifyContent: "center", alignItems: "flex-end",
                  }}>
                    <div style={{
                      position: "absolute", top: 10, left: 12,
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
                      color: shellColor, textTransform: "uppercase",
                      background: "var(--glass-light)", borderRadius: 4, padding: "2px 7px",
                    }}>{habitatLabel}</div>
                    <div style={{
                      position: "absolute", bottom: 10, width: 56, height: 14,
                      borderRadius: "50%",
                      background: `radial-gradient(ellipse at center, ${shellColor}30 0%, transparent 70%)`,
                    }} />
                    {role?.image ? (
                      <img src={role.image} alt={selectedRole || 'Agent'} style={{ width: 100, height: 100, objectFit: "cover", zIndex: 1, borderRadius: 12 }} />
                    ) : (
                      <LobsterIcon size={100} shellColor={shellColor} accentColor={accentColor} />
                    )}
                  </div>
                  <div style={{
                    background: "var(--glass-heavy)", padding: "10px 16px 11px",
                    borderTop: `1px solid ${borderColor}20`,
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: shellColor, letterSpacing: "0.03em" }}>
                      READY TO DEPLOY
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
          <h1 style={{ fontSize: 44, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, letterSpacing: "-0.02em", fontFamily: "'Noto Serif', Georgia, serif" }}>
            {agentName} is Alive!
          </h1>
          <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 40, maxWidth: 400, margin: "0 auto 40px" }}>
            Your agent is ready. Drop them into The Canopy and watch them work.
          </p>

          {(!wsSlackConnected || !wsGmailConnected || !wsCalConnected) && (
            <div style={{
              display: "flex", gap: 12, alignItems: "center",
              background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.15)",
              borderRadius: 12, padding: "14px 18px", marginBottom: 24, maxWidth: 420, margin: "0 auto 24px", textAlign: "left",
            }}>
              <span style={{ fontSize: 20 }}>💡</span>
              <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text-main)" }}>Connect your tools</strong> — Slack, Gmail, and Calendar let {agentName || "your agent"} reach you wherever you work.{" "}
                <span style={{ color: "#3c6663", cursor: "pointer", fontWeight: 600 }} onClick={() => useWorldStore.getState().setActiveView("integrations")}>
                  Set up in Integrations →
                </span>
              </div>
            </div>
          )}

          {createAgentError && (
            <div style={{ marginBottom: 24, padding: "16px", background: "#FEF2F2", color: "#B91C1C", borderRadius: 8, fontSize: 14 }}>
              <strong style={{ display: "block", marginBottom: 4 }}>Creation Failed</strong>
              {createAgentError}
            </div>
          )}

          <button onClick={handleCreateAgent} disabled={isCreatingAgent} style={{
            padding: "16px 40px", borderRadius: 16, border: "none",
            background: createAgentError ? "#E53E3E" : "linear-gradient(135deg, #3c6663, #609995)",
            color: "var(--surface-card)", fontSize: 16, fontWeight: 600, cursor: isCreatingAgent ? "not-allowed" : "pointer",
            boxShadow: "0 8px 40px rgba(48,51,48,0.08)",
            transition: "all 0.3s ease",
            opacity: isCreatingAgent ? 0.7 : 1
          }}>
            {isCreatingAgent ? "Deploying Agent..." : (createAgentError ? "Retry Deployment" : (plugins.slack ? "Deploy & Pair Slack" : "Deploy & Go to Dashboard"))}
          </button>
        </div>
      )}

      {/* Step 7: Slack Pairing */}
      {step === 7 && (
        <div style={{ textAlign: "center", maxWidth: 500 }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
            Final Step: Pair Slack
          </h1>
          <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32 }}>
            Your agent is online! Send a direct message to your new bot in Slack. It will reply with a pairing code. Enter it below to establish a secure link.
          </p>

          <div style={{ marginBottom: 24, textAlign: "left" }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>Pairing Code</label>
            <input 
              value={pairingCode}
              onChange={e => setPairingCode(e.target.value)}
              placeholder="e.g. 123456"
              style={{
                width: "100%", padding: "14px 18px", borderRadius: 12,
                fontSize: 16, textAlign: "center", letterSpacing: "2px",
                fontFamily: "monospace", color: "var(--text-main)",
                border: "2px solid rgba(60,102,99,0.3)", outline: "none",
                background: "var(--surface-card)"
              }}
            />
          </div>

          {pairingError && (
            <div style={{ marginBottom: 24, padding: "12px", background: "#FEF2F2", color: "#B91C1C", borderRadius: 8, fontSize: 14 }}>
              {pairingError}
            </div>
          )}

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button 
              onClick={() => {
                setStep(-1);
                setAgentName("");
                setSelectedRole(null);
                setApiKey("");
                setPersonalityPrompt("");
                setRecentlyRead([]);
                setCustomBookInput("");
                setLlmProvider("");
                setCustomIdentity(null);
                setPlugins({ slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false });
                localStorage.removeItem('canopy_onboarding_draft');
                setActiveView("canopy");
              }}
              style={{ padding: "16px 24px", borderRadius: 16, background: "transparent", color: "var(--text-sub)", border: "none", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
            >
              Skip for now
            </button>
            <button 
              disabled={isPairing || !pairingCode.trim()}
              onClick={async () => {
                setIsPairing(true);
                setPairingError("");
                try {
                  await invoke("approve_slack_pairing", { code: pairingCode.trim() });
                  setStep(-1);
                  setAgentName("");
                  setSelectedRole(null);
                  setApiKey("");
                  setPersonalityPrompt("");
                  setRecentlyRead([]);
                  setCustomBookInput("");
                  setLlmProvider("");
                  setCustomIdentity(null);
                  setPlugins({ slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false });
                  localStorage.removeItem('canopy_onboarding_draft');
                  setActiveView("canopy");
                } catch (e) {
                  setPairingError(String(e));
                } finally {
                  setIsPairing(false);
                }
              }}
              style={{
                padding: "16px 40px", borderRadius: 16, border: "none",
                background: "linear-gradient(135deg, #3c6663, #609995)",
                color: "var(--surface-card)", fontSize: 16, fontWeight: 600, cursor: isPairing || !pairingCode.trim() ? "default" : "pointer",
                boxShadow: "0 8px 40px rgba(48,51,48,0.08)",
                opacity: isPairing || !pairingCode.trim() ? 0.6 : 1
              }}
            >
              {isPairing ? "Pairing..." : "Finish & Go to Dashboard"}
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
      `}</style>
      {/* High-Risk Capability Modal */}
      {showHighRiskModal && pendingHighRiskToggle && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--surface-base)", padding: 32, borderRadius: 16, width: 400, boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 24, marginBottom: 16 }}>⚠️ Security Warning</div>
            <div style={{ fontSize: 14, color: "var(--text-main)", marginBottom: 16, lineHeight: 1.5 }}>
              You are about to enable a high-risk capability (<strong>{agentPermissions.find(p => p.id === pendingHighRiskToggle.id)?.label}</strong>) {isolated ? "for an isolated agent" : ""}.
            </div>
            <div style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 24, lineHeight: 1.5, background: "rgba(212,160,74,0.1)", padding: 12, borderRadius: 8, border: "1px solid rgba(212,160,74,0.3)" }}>
              This could allow the agent to autonomously perform sensitive actions that may result in data loss, financial charges, or security vulnerabilities if the agent is compromised.
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button onClick={() => {
                setShowHighRiskModal(false);
                setPendingHighRiskToggle(null);
              }} style={{ padding: "10px 16px", borderRadius: 8, background: "transparent", border: "1px solid var(--border-subtle)", color: "var(--text-main)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
              <button onClick={() => {
                setAgentPermissions(prev => prev.map(p => p.id === pendingHighRiskToggle.id ? { ...p, enabled: pendingHighRiskToggle.enabled } : p));
                setShowHighRiskModal(false);
                setPendingHighRiskToggle(null);
              }} style={{ padding: "10px 16px", borderRadius: 8, background: "#D4A04A", color: "#FFF", border: "none", cursor: "pointer", fontWeight: 600 }}>Yes, I understand the risks</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECT VIEW — Agent Detail
// ═══════════════════════════════════════════════════════════════════════════════
