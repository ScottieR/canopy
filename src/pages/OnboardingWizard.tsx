import React, { useEffect, useMemo, useState } from "react";
import { X, Box } from "lucide-react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment } from "@react-three/drei";
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
import { OnboardingCompanion } from "../components/World/OnboardingCompanion";
import { LoadingScreen } from "../components/LoadingScreen";
import { useWorldStore, DEFAULT_PERMISSIONS, getPermissionsForRole, getDefaultPersonality, injectPrincipalContext, AgentData, Agent, AGENT_TYPE_INFO, DiscoveredAgent, Permission, fireActivationEvent } from "../store/worldStore";
import type { GenerativeResult } from "../types/generative";
import { Toggle } from "../App";
import { LobsterIcon } from "../components/World/LobsterIcon";
import { getAssetUrl } from "../utils/assets";
import { buildCompanionUrl } from "../utils/connectorCatalog";
import { MobilePairingModal } from "../components/Companion/MobilePairingModal";
import { TestDriveChat } from "../components/shared/TestDriveChat";
import {
  DISCOVERY_EXAMPLES,
  composeStarterPrompt,
  generateAgentName,
  getDiscoveryConfidenceCopy,
  getRoleDefaultName,
  getRoleVoiceDefault,
  inferRoleFromPrompt,
} from "../utils/onboardingDiscovery";
import { getOnboardingIntegrationIds } from "../utils/onboardingIntegrations";
import { getInitialOnboardingStep } from "../utils/onboardingFlow";
import { useEngineStatus, startEngineProvisioning, describeEngineStage, getDeployGate, isEngineInFlight } from "../utils/engineStatus";
import { speakPreview } from "../utils/voicePreview";
import { DynamicPersonaDraft, composePersonaPersonality, draftPersonaWithEddie, isGenerativeDiscoveryEnabled } from "../utils/generativePersona";
import { getAccessoryName, listAccessoryOptions } from "../utils/accessoryCatalog";
import { buildScopeSection, syncTeamRosterToAgents } from "../utils/rosterScope";
import { getHeartbeatSuggestionsForProfile, serializeHeartbeatFile } from "../utils/heartbeats";
import { getAgentProviderSecretSlot, getManagedProviderId, syncAgentProviderCredentials } from "../security/providerCredentials";
import { PasswordInput } from "../components/shared/PasswordInput";
import rehypeSanitize from "rehype-sanitize";

const safeStartGateway = async () => {
    try { return await invoke("start_gateway"); } catch(e){}
};

// ─── Activation: starter tasks ("Watch [Name] work") ─────────────────────────
// Spec: spec-helper-agent-and-orchestrator.md Part 1C. The aha moment (A2) is
// the user's own agent completing a real first task with a visible artifact —
// not a wizard, not a chat about setup. One click, zero configuration.
const STARTER_TASKS: Record<string, { teaser: string; prompt: string }> = {
  "Researcher":  { teaser: "a one-page briefing on a topic picked for you",
    prompt: "Pick one fascinating topic you think I'd enjoy based on your expertise, and put together a tight one-page briefing on it. Use clear markdown sections: why it matters, three key facts, and one surprising insight." },
  "Assistant":   { teaser: "a ready-to-use daily priorities template",
    prompt: "Build me a clean, reusable daily priorities template I can fill in each morning — top 3 priorities, schedule blocks, and a 'don't forget' section. Make it something I'd actually want to use tomorrow." },
  "Accountant":  { teaser: "a sample monthly budget I can adapt",
    prompt: "Create a sample monthly personal budget template with sensible categories, percentages, and a simple way to track actual vs. planned. Make it clear and adaptable." },
  "Coder":       { teaser: "a small working tool, built live",
    prompt: "Build me a small, genuinely useful interactive tool as a single HTML page — your pick (timer, unit converter, checklist — whatever shows your range). Make it polished." },
  "Chef":        { teaser: "a 3-dinner weeknight plan + shopping list",
    prompt: "Plan three easy weeknight dinners with broad appeal, then give me one combined shopping list organized by store section." },
  "Travel Agent":{ teaser: "a sample weekend getaway itinerary",
    prompt: "Draft a sample 2-day weekend getaway itinerary for a destination you'd recommend — morning/afternoon/evening blocks, one local-secret tip per day, and rough budget." },
  "Strategist":  { teaser: "a one-page strategy template",
    prompt: "Create a one-page strategy template I can reuse for any decision: situation, options, criteria, recommendation, first step. Fill it in with a brief worked example so I can see it in action." },
  "Editor":      { teaser: "a before/after editing demo",
    prompt: "Show me what you do: write one deliberately clunky paragraph, then your edited version side by side, with three notes on what you changed and why." },
  "Trainer":     { teaser: "a simple one-week starter workout plan",
    prompt: "Build a simple one-week starter workout plan for a busy beginner — 30 minutes a day, no equipment, with a rest day. Lay it out as a clean weekly table." },
};
const DEFAULT_STARTER_TASK = { teaser: "a first task picked to show their range",
  prompt: "Introduce yourself briefly, then show me what you can do: pick one small, genuinely useful task in your specialty and complete it right now. Produce something tangible — a document, plan, or template I can actually use." };
const getStarterTask = (role: string | null) => (role && STARTER_TASKS[role]) || DEFAULT_STARTER_TASK;

const DISCOVERY_CONNECTIONS: Record<string, string[]> = {
  Assistant: ["Gmail", "Calendar", "Slack"],
  Researcher: ["Browser", "Files", "Slack"],
  Coder: ["GitHub", "Files", "Slack"],
  Strategist: ["Browser", "Slack", "Files"],
  Accountant: ["Files", "Payments"],
  Editor: ["Files", "Slack"],
  Chef: ["Photos", "Files"],
  "Travel Agent": ["Calendar", "Gmail", "Browser"],
  Trainer: ["Photos", "iMessage"],
};

// ─── Wizard progress — four beats (first-principles consolidation, July 18):
// every visible stage is a moment, not a form. Meet Eddie → Meet your agent →
// Give them power → Watch them work.
const PROGRESS_STAGES = ["Meet Eddie", "Meet your agent", "Give them power", "Watch them work"];
const stageForStep = (s: number): number => {
  if (s < 2) return 0;            // 0/1 discovery (+1.8 import detour)
  if (s < 3) return 1;            // 2 studio (+2.5 dressing room detour)
  if (s < 5) return 2;            // 3 brain + 4 connections
  return 3;                       // 5, 6, 7 (test, deploy+starter, channel)
};

const deriveAgentId = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 57);

  return `agent-${slug || "draft"}`;
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
      if (parsed && parsed.step === 0.5) {
        return { ...parsed, step: 0 };
      }
      return parsed;
    } catch { return null; }
  };
  const draft = loadDraft();

  const { agents } = useWorldStore();
  const hasCompletedInitialSetup = agents.length > 0
    || localStorage.getItem("canopy_initial_setup_complete") === "true";
  const initialStepTarget = hasCompletedInitialSetup ? 1 : 0;
  // The engine gate belongs only to first-run onboarding. Returning users and
  // the Add Agent flow start at agent creation, even if an older draft saved
  // the legacy engine step (-1).
  const [step, setStep] = useState(
    getInitialOnboardingStep(draft?.step, hasCompletedInitialSetup)
  );

  useEffect(() => {
    if (agents.length > 0) {
      localStorage.setItem("canopy_initial_setup_complete", "true");
      if (step === -1) setStep(1);
    }
  }, [agents.length, step]);

  // Maps each wizard step value to a stable name for funnel telemetry, so we
  // can see step-by-step drop-off, not just whether a user reached the end.
  // See spec-global-usage-telemetry.md.
  const ONBOARDING_STEP_NAMES: Record<string, string> = {
    "-1": "engine_check",
    "0": "welcome",
    "0.5": "user_identity",
    "1": "create_agent_intro",
    "1.8": "import_existing_agent",
    "2": "agent_name",
    "2.5": "agent_appearance",
    "3": "power_up",
    "4": "skills_access",
    "5": "plugin_test",
    "6": "deploying",
    "7": "slack_pairing",
  };
  useEffect(() => {
    const name = ONBOARDING_STEP_NAMES[String(step)];
    if (name) {
      // Fire-once per step value, see fireActivationEvent.
      fireActivationEvent(`onboarding_step_reached_${name}`, { step, step_name: name });
    }
  }, [step]);

  const [engineStatus, setEngineStatus] = useState<"checking" | "missing" | "found" | "starting" | "ready">("checking");
  const [foundEngine, setFoundEngine] = useState<"OrbStack" | "Docker" | null>(null);
  const [engineError, setEngineError] = useState("");

  const [userName, setUserName] = useState("");
  const [discoveryInput, setDiscoveryInput] = useState(draft?.discoveryInput || "");


  const [selectedRole, setSelectedRole] = useState<string | null>(draft?.selectedRole || null);
  const [agentName, setAgentName] = useState(draft?.agentName || "");
  const [showAllIntegrations, setShowAllIntegrations] = useState(false);
  const [moreIntegrationsSearch, setMoreIntegrationsSearch] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [personalityPrompt, setPersonalityPrompt] = useState(() => {
    if (draft?.selectedRole) {
      return getDefaultPersonality(draft.selectedRole, draft.agentName || "", AGENT_TYPE_INFO);
    }
    return "";
  });
  const [recentlyRead, setRecentlyRead] = useState<string[]>([]);
  const [customBookInput, setCustomBookInput] = useState("");
  const [llmProvider, setLlmProvider] = useState<"OpenAI" | "Google Gemini" | "Anthropic" | "xAI Grok" | "">(draft?.llmProvider || "");
  const [apiKeyMode, setApiKeyMode] = useState<"hidden" | "scan" | "manual">("hidden");
  const [autoProvisionProvider, setAutoProvisionProvider] = useState<"openai" | "xai" | null>(draft?.autoProvisionProvider || null);
  const [managementConnected, setManagementConnected] = useState(false);
  // Power Up auto-detection: if this machine already has a key or a connected
  // provider management setup, recognize it instead of asking again.
  const [detectedSetup, setDetectedSetup] = useState<null | "key" | "management">(null);
  const [managementCredential, setManagementCredential] = useState("");
  const [managementScopeId, setManagementScopeId] = useState("");
  const [managementBusy, setManagementBusy] = useState(false);
  const [managementError, setManagementError] = useState("");
  const [customIdentity, setCustomIdentity] = useState<{ baseModelUrl: string | null; accessories: string[]; dynamicColors?: any; habitatId?: number; color?: string; decor?: string[]; decorTransforms?: any }>({ baseModelUrl: null, accessories: [], decor: [] });
  const [selectedVoice, setSelectedVoice] = useState(draft?.selectedVoice || "alloy");
  const [selectedVoiceRate, setSelectedVoiceRate] = useState<number>(draft?.selectedVoiceRate || 1);
  const [isPreviewingVoice, setIsPreviewingVoice] = useState(false);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 1440,
    height: typeof window !== "undefined" ? window.innerHeight : 900,
  }));
  const [agentTypeInfo, setAgentTypeInfo] = useState(AGENT_TYPE_INFO);
  const [globalLibrary, setGlobalLibrary] = useState<any[]>([]);
  const [showAllRoles, setShowAllRoles] = useState(false);
  // Two-beat discovery: the full role grid hides behind a quiet link.
  const [showRoleBrowser, setShowRoleBrowser] = useState(false);
  // True once the user has typed a name themselves — generated names then stop
  // overwriting it on role changes.
  const nameEditedRef = React.useRef(false);
  // Eddie's AI-drafted persona for prompts the keyword matcher can't place
  // ("sommelier" must never become "Media Advisor"). Fail-safe: null keeps
  // the keyword draft.
  const [dynamicPersona, setDynamicPersona] = useState<DynamicPersonaDraft | null>(null);
  // Persisted persona identity for the rest of the flow: the blend anchor
  // (e.g. Chef) powers permissions/visuals, but the USER-FACING role stays
  // the persona title ("Mixologist") all the way through deploy.
  const [personaMeta, setPersonaMeta] = useState<{ title: string; tagline: string } | null>(draft?.personaMeta || null);
  const [eddieThinking, setEddieThinking] = useState(false);
  const personaRequestRef = React.useRef(0);
  // Draft-panel setup details collapse behind one "Eddie has it handled" line.
  const [setupExpanded, setSetupExpanded] = useState(false);
  const [habitats, setHabitats] = useState<any[]>([]);

  const getNonOverlappingPosition = (existingAgents: AgentData[]): [number, number, number] => {
    if (existingAgents.length === 0) return [Math.random() * 2 - 1, 0, Math.random() * 2 - 1];
    for (let i = 0; i < 50; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 3 + Math.random() * 5;
      const candidateX = Math.cos(angle) * radius;
      const candidateZ = Math.sin(angle) * radius;
      const tooClose = existingAgents.some(a => {
         const dx = a.targetPosition[0] - candidateX;
         const dz = a.targetPosition[2] - candidateZ;
         return (dx * dx + dz * dz) < 9;
      });
      if (!tooClose) return [candidateX, 0, candidateZ];
    }
    return [existingAgents.length * 3.5, 0, Math.random() * 2 - 1];
  };

  const optimisticId = deriveAgentId(agentName);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const managedProviderId = getManagedProviderId(llmProvider);

  // Round-trip from the API-key companion window (bug fix, July 18): when the
  // companion saves a key it emits `companion-finished`, but nothing synced it
  // back into this field or returned focus. Listen while on Power Up: pull the
  // key from the keychain (never from the event payload), fill the field, and
  // have the MAIN window take focus itself — more reliable than the companion
  // hunting for a window labeled "main".
  useEffect(() => {
    if (step !== 3) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<{ type?: string }>("companion-finished", async event => {
          const providerMap: Record<string, string> = { openai: "OPENAI", gemini: "GEMINI", anthropic: "ANTHROPIC", xai: "XAI" };
          const slot = providerMap[String(event.payload?.type || "").toLowerCase()];
          if (!slot) return;
          try {
            const secret = await invoke<string>("get_secret_cmd", { key: `${slot}_API_KEY` });
            if (!disposed && secret) {
              setApiKey(secret);
              setApiKeyMode("hidden");
              setDetectedSetup("key");
            }
          } catch { /* key not there yet — user can rescan */ }
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await getCurrentWindow().setFocus();
          } catch { /* focus is best-effort */ }
        });
        if (disposed) stop(); else unlisten = stop;
      } catch { /* non-Tauri env */ }
    })();
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, [step]);

  // Power Up auto-detection: recognize existing setup instead of re-asking.
  // Order of preference: connected provider management (mints a fresh
  // per-agent key) → existing global key in the keychain.
  useEffect(() => {
    if (step !== 3 || !llmProvider) return;
    let disposed = false;
    (async () => {
      setDetectedSetup(null);
      try {
        if (managedProviderId) {
          const status = await invoke<{ connected: boolean }>("get_provider_management_status", { provider: managedProviderId }).catch(() => null);
          if (!disposed && status?.connected) {
            setManagementConnected(true);
            setAutoProvisionProvider(managedProviderId);
            setDetectedSetup("management");
            return;
          }
        }
        const providerMap: Record<string, string> = { "OpenAI": "OPENAI", "Google Gemini": "GEMINI", "Anthropic": "ANTHROPIC", "xAI Grok": "XAI" };
        const slot = providerMap[llmProvider];
        if (slot) {
          const secret = await invoke<string>("get_secret_cmd", { key: `${slot}_API_KEY` }).catch(() => "");
          if (!disposed && secret) {
            setApiKey(secret);
            setDetectedSetup("key");
          }
        }
      } catch { /* detection is best-effort; the manual flow remains */ }
    })();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, llmProvider, managedProviderId]);
  useEffect(() => {
    if (!managedProviderId) {
      setManagementConnected(false);
      setAutoProvisionProvider(null);
      return;
    }
    let cancelled = false;
    invoke<any>("get_provider_management_status", { provider: managedProviderId })
      .then(status => { if (!cancelled) setManagementConnected(Boolean(status?.connected)); })
      .catch(() => { if (!cancelled) setManagementConnected(false); });
    return () => { cancelled = true; };
  }, [managedProviderId]);

  const connectManagementForOnboarding = async () => {
    if (!managedProviderId) return;
    setManagementBusy(true);
    setManagementError("");
    try {
      await invoke("connect_provider_management", {
        provider: managedProviderId,
        credential: managementCredential.trim(),
        scopeId: managementScopeId.trim(),
      });
      setManagementConnected(true);
      setAutoProvisionProvider(managedProviderId);
      setApiKey("");
      setApiKeyMode("hidden");
      setManagementCredential("");
    } catch (error) {
      setManagementError(String(error));
    } finally {
      setManagementBusy(false);
    }
  };

  const [plugins, setPlugins] = useState<Record<string, boolean>>(draft?.plugins || { slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false, github: false, telegram: false, discord: false, twilio: false });
  const [isolated, setIsolated] = useState(draft?.isolated || false);
  const [agentPermissions, setAgentPermissions] = useState<Permission[]>(() => {
    if (draft?.selectedRole && draft?.isolated !== undefined) {
      return getPermissionsForRole(draft.selectedRole, draft.isolated);
    }
    return DEFAULT_PERMISSIONS.map(p => ({ ...p }));
  });
  const [pendingHighRiskToggle, setPendingHighRiskToggle] = useState<{ id: string, enabled: boolean } | null>(null);
  const [showHighRiskModal, setShowHighRiskModal] = useState(false);

  const isHighRisk = (id: string) => ["payments", "spend_auto", "file_write", "autonomous", "ext_network", "browser", "proxy", "vision", "canvas", "coding", "gog", "summarize", "computer_control", "host_control", "screen_record"].includes(id);

  const [folderAccessType, setFolderAccessType] = useState<"specific" | "all">("specific");
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [testPluginIndex, setTestPluginIndex] = useState(-1);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testStatusMessage, setTestStatusMessage] = useState("");

  // Workspace-level service connection status (shared across all agents)
  const [wsSlackConnected, setWsSlackConnected] = useState(false);
  const [wsGmailConnected, setWsGmailConnected] = useState(false);
  const [wsCalConnected, setWsCalConnected] = useState(false);

  // Step 5 covers each connection the wizard can actively set up or verify
  // before the real agent record is created.
  const ONBOARDING_SETUP_PLUGINS = ["slack", "github", "telegram", "discord", "twilio", "folders", "imessage", "photos"];
  const enabledPlugins = Object.entries(plugins)
    .filter(([k, v]) => v && ONBOARDING_SETUP_PLUGINS.includes(k))
    .map(([k]) => k);
  const [selectedHeartbeatNames, setSelectedHeartbeatNames] = useState<string[]>(draft?.selectedHeartbeatNames || []);

  const heartbeatSuggestions = useMemo(() => getHeartbeatSuggestionsForProfile({
    role: selectedRole || "Custom",
    integrations: Object.entries(plugins)
      .filter(([, enabled]) => enabled)
      .map(([integration]) => integration),
    permissions: agentPermissions
      .filter(permission => permission.enabled)
      .map(permission => permission.id),
  }), [agentPermissions, plugins, selectedRole]);
  const readyHeartbeatSuggestions = useMemo(
    () => heartbeatSuggestions.filter(suggestion => suggestion.ready),
    [heartbeatSuggestions]
  );
  const lockedHeartbeatSuggestions = useMemo(
    () => heartbeatSuggestions.filter(suggestion => !suggestion.ready),
    [heartbeatSuggestions]
  );
  const selectedHeartbeatTasks = useMemo(
    () => readyHeartbeatSuggestions.filter(task => selectedHeartbeatNames.includes(task.name)),
    [readyHeartbeatSuggestions, selectedHeartbeatNames]
  );
  const formatHeartbeatRequirements = (requirements: { missingIntegrations: string[]; missingPermissions: string[] }) =>
    [...requirements.missingIntegrations, ...requirements.missingPermissions]
      .map(item => item.replace(/_/g, " "))
      .join(" or ");

  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackWorkspaceMsg, setSlackWorkspaceMsg] = useState("");

  const [fullDiskAccessGranted, setFullDiskAccessGranted] = useState<boolean | null>(null);
  const [imessageThreads, setIMessageThreads] = useState<any[]>([]);
  const [selectedIMessageThreads, setSelectedIMessageThreads] = useState<string[]>([]);
  const [selectedSlackChannels, setSelectedSlackChannels] = useState<string[]>([]);
  const [imessageAccessLevel, setImessageAccessLevel] = useState<"read-only" | "read-send">("read-only");
  const [pendingGithubRepos, setPendingGithubRepos] = useState<string[]>([]);
  const [twilioDraft, setTwilioDraft] = useState({ accountSid: "", authToken: "", phoneNumber: "" });

  const [googleTokens, setGoogleTokens] = useState<any>(null);

  const [deployedAgentId, setDeployedAgentId] = useState<string | null>(null);
  // Preflight model health (Part 1D field-test fix): never offer the starter
  // task into a dead key. null = not checked, "checking" = in flight.
  const [modelHealth, setModelHealth] = useState<null | "checking" | { status: string; detail?: string; provider: string; model: string }>(null);
  const [pairingCode, setPairingCode] = useState("");
  // Workstream D: "Where should your agents reach you?" channel chooser state.
  const [channelChoice, setChannelChoice] = useState<null | "mobile" | "telegram" | "slack">(null);
  const [showMobilePairing, setShowMobilePairing] = useState(false);
  // Workstream A: engine provisioning runs in the background from wizard mount.
  // The wizard never blocks on it except at Deploy, and only when it FAILED.
  const engineStatusLive = useEngineStatus();
  const [showEngineGateModal, setShowEngineGateModal] = useState(false);
  const pendingDeployRef = React.useRef<{ starterTask?: string } | null>(null);
  useEffect(() => {
    if (!hasCompletedInitialSetup) {
      startEngineProvisioning();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // When the engine becomes ready while the user is waiting at the gate,
  // continue the held deploy automatically (single-shot via ref clear).
  useEffect(() => {
    if (engineStatusLive.stage === "ready" && showEngineGateModal && pendingDeployRef.current) {
      const opts = pendingDeployRef.current;
      pendingDeployRef.current = null;
      setShowEngineGateModal(false);
      handleCreateAgent(opts.starterTask ? { starterTask: opts.starterTask } : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineStatusLive.stage, showEngineGateModal]);
  const [isPairing, setIsPairing] = useState(false);
  const [pairingError, setPairingError] = useState("");

  const resetWizardState = () => {
    setStep(initialStepTarget);
    setAgentName("");
    nameEditedRef.current = false;
    lastNamedRoleRef.current = null;
    setSelectedRole(null);
    setPersonaMeta(null);
    setDiscoveryInput("");
    setApiKey("");
    setPersonalityPrompt("");
    setRecentlyRead([]);
    setCustomBookInput("");
    setLlmProvider("");
    setApiKeyMode("hidden");
    setAutoProvisionProvider(null);
    setManagementConnected(false);
    setManagementCredential("");
    setManagementScopeId("");
    setManagementBusy(false);
    setManagementError("");
    setCustomIdentity({ baseModelUrl: null, accessories: [], decor: [] });
    setSelectedVoice("alloy");
    setSelectedVoiceRate(1);
    setPlugins({ slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false, github: false, telegram: false, discord: false, twilio: false });
    setSelectedHeartbeatNames([]);
    setSelectedFolderPath("");
    setFolderAccessType("specific");
    setSelectedIMessageThreads([]);
    setSelectedSlackChannels([]);
    setPendingGithubRepos([]);
    setTwilioDraft({ accountSid: "", authToken: "", phoneNumber: "" });
    setGoogleTokens(null);
    setDeployedAgentId(null);
    setPairingCode("");
    setPairingError("");
    setCreateAgentError("");
    setModelHealth(null);
    localStorage.removeItem('canopy_onboarding_draft');
  };

  // Preflight the chosen provider key when the user reaches the celebration
  // step — a 1-token ping that catches invalid keys and quota-exhausted (429)
  // keys before we promise "watch them work."
  useEffect(() => {
    if (step !== 6 || !apiKey.trim() || !llmProvider) { return; }
    let cancelled = false;
    setModelHealth("checking");
    const recommendedModel = selectedRole
      ? (getProviderRecommendedModel(selectedRole, llmProvider).id || undefined)
      : undefined;
    invoke<Array<{ status: string; detail?: string; provider: string; model: string }>>("check_model_health", {
      provider: llmProvider,
      model: recommendedModel,
      keyOverride: apiKey.trim(),
    })
      .then(results => { if (!cancelled && results?.[0]) setModelHealth(results[0]); })
      .catch(() => { if (!cancelled) setModelHealth(null); }); // check failed ≠ key dead; fail open
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (step >= 0) {
      localStorage.setItem('canopy_onboarding_draft', JSON.stringify({
        step, agentName, selectedRole, discoveryInput, selectedVoice, selectedVoiceRate, plugins, customIdentity, isolated, llmProvider, autoProvisionProvider, selectedHeartbeatNames, personaMeta
      }));
    }
  }, [step, agentName, selectedRole, discoveryInput, selectedVoice, selectedVoiceRate, plugins, customIdentity, isolated, llmProvider, autoProvisionProvider, selectedHeartbeatNames, personaMeta]);

  useEffect(() => {
    setSelectedHeartbeatNames(previous => {
      const readyNames = readyHeartbeatSuggestions.map(task => task.name);
      const retained = previous.filter(name => readyNames.includes(name));
      if (retained.length > 0) return retained;
      if (readyNames.length === 0) return [];
      return readyNames.slice(0, Math.min(2, readyNames.length));
    });
  }, [readyHeartbeatSuggestions]);

  const checkConnections = async () => {
      try {
        const s = await invoke<{ connected: boolean }>("check_slack_connection");
        setWsSlackConnected(s?.connected ?? false);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: `agent_${optimisticId}_google_email_access_token` });
        setWsGmailConnected(!!tok && tok.length > 10);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: `agent_${optimisticId}_google_calendar_access_token` });
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
          url: buildCompanionUrl(key, {
            agentId: optimisticId,
            agentName: agentName || "Agent",
            isNew: true,
          }),
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
            agentId: optimisticId,
            scopes: [key === 'email' ? 'email' : 'calendar'],
            readOnly: false,
          });
          if (result.access_token) {
            checkConnections();
            setPlugins(prev => ({ ...prev, [key]: true }));
          }
        } catch (e) { console.error("OAuth failed:", e); }
    } else if (key === 'imessage') {
        try {
          await invoke("start_imessage_watcher", { appHandle: null }).catch(() => {});
          const granted = await invoke<boolean>("check_full_disk_access");
          if (!granted) {
            await invoke("open_full_disk_access_settings");
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
          const { type, key, channels, appToken, botToken, selectedRepos } = e.payload || {};
          if (type === "slack") {
            setWsSlackConnected(true);
            setPlugins(prev => ({ ...prev, slack: true }));
            if (channels) setSelectedSlackChannels(channels);
            if (appToken) setSlackAppToken(appToken);
            if (botToken) setSlackBotToken(botToken);
          } else if (type === "github") {
            setPlugins(prev => ({ ...prev, github: true }));
            setPendingGithubRepos(Array.isArray(selectedRepos) ? selectedRepos : []);
            setTestStatusMessage("GitHub token saved. Run verification here before launch.");
          } else if (key) {
            setApiKey(key);
            setAutoProvisionProvider(null);
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

  const runConnectionPreflight = async (integration: "github" | "telegram" | "discord" | "twilio") => {
    setTestStatus("testing");
    setTestStatusMessage("");
    try {
      const diagnostic = await invoke<{ service: string; is_ok: boolean; message: string }>("preflight_agent_connection", {
        agentId: optimisticId,
        integration,
      });
      setTestStatus(diagnostic.is_ok ? "success" : "error");
      setTestStatusMessage(diagnostic.message);
    } catch (e) {
      console.error(`Failed to preflight ${integration}:`, e);
      setTestStatus("error");
      setTestStatusMessage(`Could not verify ${integration}.`);
    }
  };

  useEffect(() => {
    if (step === -1) {
      const checkEngine = async () => {
        try {
          if (typeof invoke === 'function') {
            const isOrbInstalled = await invoke("check_orbstack_installed").catch(() => false);
            const isDockerInstalled = await invoke("check_docker_installed").catch(() => false);
            if (isOrbInstalled) {
              setFoundEngine("OrbStack");
              setEngineStatus("found");
            } else if (isDockerInstalled) {
              setFoundEngine("Docker");
              setEngineStatus("found");
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
    const fetchModels = () => {
      invoke<any[]>("get_available_models")
        .then(models => setAvailableModels(models))
        .catch(err => console.warn("Failed to fetch available models from Rust:", err));
    };
    fetchModels();
    const interval = setInterval(fetchModels, 3000);
    return () => clearInterval(interval);
  }, []);

  // Heavy roles get powerful models; light roles get fast models.
  const HEAVY_ROLES = ["Strategist", "Analyst", "Researcher", "Engineer"];

  const getDynamicRecommendedModel = (role: string) => {
    const isHeavy = HEAVY_ROLES.includes(role);
    const strategy = isHeavy ? "heavy" : "light";
    const match = availableModels.find((m: any) => m.strategy === strategy);
    if (match) return { provider: match.provider, model: `${match.name} — ${match.description}`, id: match.id };
    return { provider: "Google Gemini", model: "Gemini 3.5 Flash — Stable — speed optimized flagship", id: "google/gemini-3.5-flash" };
  };

  const getProviderRecommendedModel = (role: string, targetProvider: string) => {
    const isHeavy = HEAVY_ROLES.includes(role);
    const strategy = isHeavy ? "heavy" : "light";
    const providerName = targetProvider === "xAI Grok" ? "xAI" : targetProvider;
    const options = availableModels.filter((m: any) => m.provider === providerName && m.strategy === strategy);
    if (options.length > 0) return { model: `${options[0].name} — ${options[0].description}`, id: options[0].id };
    const fallbacks = availableModels.filter((m: any) => m.provider === providerName);
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
  const handleBackFromRoleStep = () => {
    if (agents.length > 0) {
      resetWizardState();
      setActiveView("canopy");
      return;
    }
    setStep(0);
  };
  const discoveryExamples = DISCOVERY_EXAMPLES.filter(example => Boolean((agentTypeInfo as any)[example.role]));
  const continueFromDiscovery = async () => {
    // Eddie-invented personas anchor on their blend's base template for
    // deterministic defaults, then override identity + personality.
    const persona = personaActive ? dynamicPersona : null;
    const nextRole = selectedRole || effectiveDraftRole || discoveryDraft.primaryRole;
    if (!nextRole) return;
    if (!selectedRole) handleRoleSelect(nextRole, discoveryInput);
    if (persona) {
      // handleRoleSelect just cleared persona state + set role defaults; put
      // the tailored identity back on top (same tick — last write wins).
      setAgentName(nameEditedRef.current && agentName.trim() ? agentName : persona.name);
      setPersonalityPrompt(composePersonaPersonality(persona, discoveryInput));
      setPersonaMeta({ title: persona.title, tagline: persona.tagline });
      if (persona.voice) setSelectedVoice(persona.voice);
      if (persona.accessories.length > 0) {
        setCustomIdentity(prev => ({ ...prev, accessories: persona.accessories }));
      }
    }

    if (agents.length === 0) {
      try {
        await invoke("save_user_profile", {
          profile: {
            name: userName || "there",
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
    }
    setStep(2);
  };

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/habitats`)
      .then(r => r.json())
      // Eddy's reef cave (isEddyHabitat) is reserved for The Keeper.
      .then(d => setHabitats(Array.isArray(d) ? d.filter((h: any) => !h.isEddyHabitat) : d))
      .catch(() => { });
  }, []);

  // Sync static import changes during Vite HMR
  useEffect(() => {
    // Robust sync with admin server — bypass cache to ensure real-time updates
    fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/agents`, { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error("Server not reachable");
        return res.json();
      })
      .then(data => {
        console.log("Successfully synced agent configuration from Admin.");
        setAgentTypeInfo(data);
      })
      .catch(err => {
        console.warn("Using local fallback for agent configuration:", err.message);
      });
  }, []);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/library`)
      .then(res => res.json())
      .then(data => setGlobalLibrary(data))
      .catch(err => console.warn("Local API server not running for library.", err));
  }, []);
  const roleTypes = Object.entries(agentTypeInfo)
    .filter(([key, val]) => key !== "Custom" && (showAllRoles || val.suggest_in_onboarding))
    .map(([key, val]) => ({ key, ...val }))
    .sort((a: any, b: any) => {
      // Suggested roles keep their positions; "See more roles" APPENDS the
      // rest below instead of interleaving them by manual_order/popularity
      // (which visually reshuffled the grid the user had already scanned).
      const aSuggested = a.suggest_in_onboarding ? 0 : 1;
      const bSuggested = b.suggest_in_onboarding ? 0 : 1;
      if (aSuggested !== bSuggested) return aSuggested - bSuggested;
      const aOrder = a.manual_order;
      const bOrder = b.manual_order;
      if (aOrder != null && bOrder != null) return aOrder - bOrder;
      if (aOrder != null) return -1;
      if (bOrder != null) return 1;
      return (b.popularity || 0) - (a.popularity || 0);
    });
  const discoveryDraft = useMemo(
    () => inferRoleFromPrompt(discoveryInput, agentTypeInfo as any),
    [agentTypeInfo, discoveryInput],
  );
  // Two-beat discovery (July 18 redesign): the draft panel only exists once the
  // user has given Eddie something — an explicit pick or typed words. An empty
  // input must NEVER produce a phantom draft (that was the "is it already
  // done?" confusion).
  // User-facing role label: the persona title ("Mixologist") survives past
  // discovery even though the blend anchor (e.g. Chef) powers the internals.
  const displayRole = personaMeta?.title || selectedRole;
  const hasDraftSource = !!selectedRole || !!discoveryInput.trim();
  const draftRole = hasDraftSource ? (selectedRole || discoveryDraft.primaryRole) : null;
  // When Eddie invented a persona, its blend anchor drives visuals/defaults
  // (deterministic base-template rule); explicit picks always win.
  const personaActive = !selectedRole && !!dynamicPersona && !dynamicPersona.fitsExisting;
  const effectiveDraftRole = personaActive && (agentTypeInfo as any)[dynamicPersona!.blend[0]]
    ? dynamicPersona!.blend[0]
    : draftRole;
  const draftRoleInfo = effectiveDraftRole ? (agentTypeInfo as any)[effectiveDraftRole] : null;
  const draftConnections = effectiveDraftRole ? (DISCOVERY_CONNECTIONS[effectiveDraftRole] || ["Files", "Slack"]) : [];
  const draftVoice = getRoleVoiceDefault(effectiveDraftRole || "Assistant");
  const isCompactWindow = viewportSize.width < 1320;
  const isNarrowWindow = viewportSize.width < 1120;
  const isVeryNarrowWindow = viewportSize.width < 860;
  const discoveryHeartbeats = useMemo(
    () => draftRole
      ? getHeartbeatSuggestionsForProfile({
          role: draftRole,
          integrations: [],
          permissions: [],
        }).slice(0, 3)
      : [],
    [draftRole],
  );

  // Keep the generated name in step with the inferred role while the user
  // types (explicit picks name themselves in handleRoleSelect). A user-typed
  // name is never overwritten; an Eddie persona name wins over generated ones.
  const lastNamedRoleRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (selectedRole || nameEditedRef.current) return;
    if (personaActive && dynamicPersona?.name) {
      if (agentName !== dynamicPersona.name) setAgentName(dynamicPersona.name);
      return;
    }
    if (!draftRole) return;
    if (lastNamedRoleRef.current === draftRole && agentName.trim()) return;
    lastNamedRoleRef.current = draftRole;
    setAgentName(generateAgentName(draftRole));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRole, selectedRole, personaActive, dynamicPersona]);

  // Eddie's AI drafting: when the keyword matcher is unsure and the user has
  // written a real sentence, ask the hosted brain for a tailored persona
  // (debounced; stale responses discarded; silent failure keeps keyword draft).
  useEffect(() => {
    setDynamicPersona(null);
    if (
      !isGenerativeDiscoveryEnabled() ||
      selectedRole ||
      discoveryInput.trim().length < 12 ||
      discoveryDraft.confidence === "high"
    ) {
      setEddieThinking(false);
      return;
    }
    const requestId = ++personaRequestRef.current;
    setEddieThinking(true);
    const timer = setTimeout(async () => {
      const persona = await draftPersonaWithEddie(
        discoveryInput,
        agentTypeInfo as any,
        listAccessoryOptions(),
      );
      if (personaRequestRef.current !== requestId) return; // stale
      setEddieThinking(false);
      if (persona && !persona.fitsExisting) {
        setDynamicPersona(persona);
        if (persona.voice) setSelectedVoice(persona.voice);
        if (persona.accessories.length > 0) {
          setCustomIdentity(prev => ({ ...prev, accessories: persona.accessories }));
        }
        fireActivationEvent("eddie_persona_drafted", { title: persona.title });
      }
    }, 900);
    return () => {
      clearTimeout(timer);
      if (personaRequestRef.current === requestId) setEddieThinking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveryInput, selectedRole]);

  const previewVoice = () => {
    // Each voice id maps to a distinct system voice + pitch/rate personality —
    // previously every option played the identical system default.
    const started = speakPreview(
      selectedVoice,
      draftRole
        ? getRoleVoiceDefault(draftRole).sample
        : "I help you figure out which agents to create and what they should take off your plate.",
      selectedVoiceRate,
      { onend: () => setIsPreviewingVoice(false), onerror: () => setIsPreviewingVoice(false) },
    );
    if (started) setIsPreviewingVoice(true);
  };

  useEffect(() => {
    if (!selectedRole || draft?.selectedVoice) return;
    const roleDefaults = getRoleVoiceDefault(selectedRole);
    setSelectedVoice(roleDefaults.voice);
    setSelectedVoiceRate(roleDefaults.rate);
  }, [draft?.selectedVoice, selectedRole]);

  const handleRoleSelect = (roleKey: string, seedPrompt?: string) => {
    const roleDefaults = getRoleVoiceDefault(roleKey);
    const roleConfig = (agentTypeInfo as any)[roleKey] || {};
    setSelectedRole(roleKey);
    setLlmProvider(getDynamicRecommendedModel(roleKey).provider as any);
    setApiKeyMode("hidden");
    setApiKey("");
    setRecentlyRead([]);
    setSelectedVoice(roleDefaults.voice);
    setSelectedVoiceRate(roleDefaults.rate);
    // An explicit role pick supersedes any Eddie-invented persona.
    setDynamicPersona(null);
    setPersonaMeta(null);
    setEddieThinking(false);
    personaRequestRef.current++;
    // Names are generated per-persona and randomized ("Custom" is never a
    // name). A name the user typed themselves always survives role changes.
    const nextName = nameEditedRef.current && agentName.trim()
      ? agentName
      : generateAgentName(roleKey);
    setAgentName(nextName);
    const rolePersonality = getDefaultPersonality(roleKey, nextName, agentTypeInfo);
    setPersonalityPrompt(seedPrompt?.trim()
      ? `${rolePersonality}\n\n## Current user need\n\nThe user wants help with: ${seedPrompt.trim()}`
      : rolePersonality);
    const shouldIsolate = agentTypeInfo[roleKey]?.recommended_isolated || false;
    setIsolated(shouldIsolate);
    setAgentPermissions(getPermissionsForRole(roleKey, shouldIsolate));
    setSelectedHeartbeatNames([]);
    if (seedPrompt) setDiscoveryInput(seedPrompt);

    // Also pick a random habitat default when role is selected
    if (habitats.length > 0 || roleConfig?.accessories?.length) {
      const randomHabitat = habitats[Math.floor(Math.random() * habitats.length)];
      setCustomIdentity(prev => ({
        ...prev,
        baseModelUrl: null,
        accessories: roleConfig?.accessories || [],
        decor: [],
        habitatId: roleConfig?.habitatId || roleConfig?.visual_identity?.habitatId || randomHabitat?.id,
        color: roleConfig?.robeColor || prev.color,
      }));
    }
  };

  const renderDiscoveryStep = (isAddAgentFlow: boolean) => (
    <div
      style={{
        width: "100%",
        // Beat one: a single centered ask. Beat two (draft exists): ask + reveal.
        maxWidth: !hasDraftSource ? 640 : (isNarrowWindow ? "100%" : 1180),
        minHeight: isNarrowWindow ? "auto" : "78vh",
        display: "grid",
        gridTemplateColumns: !hasDraftSource ? "1fr" : (isNarrowWindow ? "1fr" : "minmax(0, 1.08fr) minmax(360px, 0.92fr)"),
        gap: isCompactWindow ? 16 : 24,
        alignItems: "stretch",
        padding: isVeryNarrowWindow ? "0 10px 24px" : "0 16px 24px",
        boxSizing: "border-box",
        transition: "max-width 0.4s ease",
      }}
    >
      <div style={{ background: "var(--surface-card)", borderRadius: 28, padding: isCompactWindow ? 22 : 28, boxShadow: "0 20px 48px rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 24, flexWrap: isVeryNarrowWindow ? "wrap" : "nowrap" }}>
          <div style={{ width: 68, height: 68, borderRadius: 22, background: "rgba(242,140,99,0.14)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <LobsterIcon size={54} shellColor="#F28C63" accentColor="#F7C5A8" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#C76A42", marginBottom: 8 }}>
              Eddie · your Canopy lifeguard
            </div>
            {/* Conversational, not a title card. First-run makes his ongoing
                role explicit: he sticks around for help + troubleshooting. */}
            <div style={{ fontSize: 15, color: "var(--text-main)", lineHeight: 1.65, background: "rgba(242,140,99,0.07)", border: "1px solid rgba(242,140,99,0.18)", borderRadius: "4px 16px 16px 16px", padding: "12px 14px" }}>
              {isAddAgentFlow
                ? "Who are we adding to the crew? Tell me what this one should take off your plate, or tap a fit below — I'll draft the rest."
                : <>Hi{userName.trim() ? `, ${userName.trim()}` : ""} — I'm Eddie. I'll help you build your first agent, and I don't disappear afterward: whenever something needs fixing or you're not sure how anything works, just look for me in the corner of the app. <strong>So — what do you want off your plate?</strong></>}
            </div>
          </div>
        </div>

        {!isAddAgentFlow && (
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
              What should Eddie call you?
            </label>
            <input
              type="text"
              placeholder="e.g. Scottie"
              value={userName}
              onChange={e => setUserName(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", borderRadius: 14, border: "1px solid rgba(0,0,0,0.1)", fontSize: 15, outline: "none", background: "#F8FAFC" }}
            />
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
            {isAddAgentFlow ? "What should this new agent take off your plate?" : "What do you want off your plate?"}
          </div>
          <textarea
            value={discoveryInput}
            onChange={e => {
              setDiscoveryInput(e.target.value);
              if (selectedRole && e.target.value.trim()) setSelectedRole(null);
            }}
            placeholder={isAddAgentFlow
              ? "Describe what this new agent should own, automate, or keep watch on."
              : "Describe what you struggle with daily, what you repeat over and over, or what you wish someone would quietly handle for you."}
            rows={5}
            style={{ width: "100%", boxSizing: "border-box", padding: "16px 18px", borderRadius: 18, border: "1px solid rgba(0,0,0,0.1)", fontSize: 15, lineHeight: 1.6, resize: "vertical", outline: "none", background: "var(--surface-base)", color: "var(--text-main)", fontFamily: "inherit" }}
          />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
          {discoveryExamples.map(example => {
            const exampleRoleInfo = (agentTypeInfo as any)[example.role] || {};
            return (
              <button
                key={example.label}
                type="button"
                onClick={() => handleRoleSelect(example.role, example.prompt)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px 7px 7px", borderRadius: 999, border: "1px solid rgba(60,102,99,0.16)", background: "rgba(60,102,99,0.05)", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
              >
                {exampleRoleInfo.image ? (
                  <img src={getAssetUrl(exampleRoleInfo.image)} alt="" style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                ) : (
                  <span style={{ width: 26, height: 26, borderRadius: "50%", background: `${exampleRoleInfo.robeColor || "#3c6663"}20`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <LobsterIcon size={20} shellColor={exampleRoleInfo.robeColor || "#3c6663"} accentColor={exampleRoleInfo.accentColor || "#4A9E96"} />
                  </span>
                )}
                {example.label}
              </button>
            );
          })}
        </div>

        {/* Quiet secondary paths — one text row, not a button cluster. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, fontSize: 12, color: "var(--text-sub)", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => { setShowRoleBrowser(v => !v); setShowAllRoles(true); }}
            style={{ padding: 0, border: "none", background: "transparent", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
          >
            {showRoleBrowser ? "Hide roles" : "Browse all roles"}
          </button>
          <span style={{ opacity: 0.4 }}>·</span>
          <button
            type="button"
            onClick={startImportFlow}
            style={{ padding: 0, border: "none", background: "transparent", color: "var(--text-sub)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
          >
            Import agent
          </button>
          <span style={{ opacity: 0.4 }}>·</span>
          <button
            type="button"
            onClick={() => handleRoleSelect("Custom", discoveryInput)}
            style={{ padding: 0, border: "none", background: "transparent", color: "var(--text-sub)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
          >
            Start from scratch
          </button>
        </div>

        {showRoleBrowser && (
          <div style={{ padding: 16, borderRadius: 18, border: "1px solid rgba(0,0,0,0.06)", background: "rgba(255,255,255,0.55)", marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>All roles</div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 12 }}>Click one and Eddie drafts it instantly.</div>
            <div style={{ display: "grid", gridTemplateColumns: isVeryNarrowWindow ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10, maxHeight: 280, overflowY: "auto" }}>
              {roleTypes.map(role => {
                const active = draftRole === role.key;
                return (
                  <button
                    key={role.key}
                    type="button"
                    onClick={() => handleRoleSelect(role.key, discoveryInput)}
                    style={{ display: "flex", gap: 12, alignItems: "center", textAlign: "left", padding: 12, borderRadius: 14, border: active ? `1px solid ${role.color}` : "1px solid rgba(0,0,0,0.08)", background: active ? `${role.color}10` : "var(--surface-card)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    {/* The portrait is the magic — these are beings, not options. */}
                    {(role as any).image ? (
                      <img src={getAssetUrl((role as any).image)} alt={role.key} style={{ width: 44, height: 44, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 44, height: 44, borderRadius: 12, background: `${(role as any).robeColor || role.color || "#3c6663"}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <LobsterIcon size={34} shellColor={(role as any).robeColor || role.color || "#3c6663"} accentColor={(role as any).accentColor || "#4A9E96"} />
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 3 }}>{role.key}</div>
                      <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.45 }}>{role.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center", marginTop: "auto", flexDirection: isVeryNarrowWindow ? "column-reverse" : "row" }}>
          <button
            type="button"
            onClick={handleBackFromRoleStep}
            style={{ padding: "12px 18px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)", background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: isVeryNarrowWindow ? "100%" : "auto" }}
          >
            {isAddAgentFlow ? "Cancel" : "Back"}
          </button>
          <button
            type="button"
            disabled={(!selectedRole && !discoveryInput.trim()) || (!isAddAgentFlow && !userName.trim())}
            onClick={() => { void continueFromDiscovery(); }}
            style={{ padding: "14px 24px", borderRadius: 14, border: "none", background: (selectedRole || discoveryInput.trim()) && (isAddAgentFlow || userName.trim()) ? "linear-gradient(135deg, #3c6663, #609995)" : "var(--border-subtle)", color: (selectedRole || discoveryInput.trim()) && (isAddAgentFlow || userName.trim()) ? "var(--surface-card)" : "var(--text-muted)", fontSize: 14, fontWeight: 800, cursor: (selectedRole || discoveryInput.trim()) && (isAddAgentFlow || userName.trim()) ? "pointer" : "default", fontFamily: "inherit", minWidth: isVeryNarrowWindow ? 0 : 190, width: isVeryNarrowWindow ? "100%" : "auto" }}
          >
            {hasDraftSource && draftRole
              ? `Meet ${agentName || getRoleDefaultName(draftRole)} →`
              : (isAddAgentFlow ? "Draft this agent" : "Draft my first agent")}
          </button>
        </div>
      </div>

      {/* Beat two: the reveal. Only exists once the user has given Eddie
          something to work with — it materializes, it never pre-exists. */}
      {hasDraftSource && draftRole && draftRoleInfo && (
      <div style={{ background: "linear-gradient(180deg, rgba(244,240,233,0.92) 0%, rgba(255,255,255,0.92) 100%)", borderRadius: 28, padding: isCompactWindow ? 20 : 24, boxShadow: "0 20px 48px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", minWidth: 0, animation: "revealIn 0.45s ease" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
          Eddie&apos;s Draft
        </div>
        {(
          <>
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18, flexWrap: isVeryNarrowWindow ? "wrap" : "nowrap" }}>
              {draftRoleInfo.image ? (
                <img src={getAssetUrl(draftRoleInfo.image)} alt={draftRole} style={{ width: 76, height: 76, borderRadius: 20, objectFit: "cover", flexShrink: 0 }} />
              ) : (
                <div style={{ width: 76, height: 76, borderRadius: 20, background: `${draftRoleInfo.robeColor || "#3c6663"}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <LobsterIcon size={62} shellColor={draftRoleInfo.robeColor || "#3c6663"} accentColor={draftRoleInfo.accentColor || "#4A9E96"} />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  {/* Name is editable right here — it's their being to name. */}
                  <input
                    value={agentName}
                    onChange={e => {
                      nameEditedRef.current = true;
                      setAgentName(e.target.value);
                    }}
                    placeholder={generateAgentName(draftRole)}
                    aria-label="Agent name"
                    style={{ fontSize: 22, fontWeight: 700, color: "var(--text-main)", background: "transparent", border: "none", borderBottom: "1px dashed rgba(0,0,0,0.15)", outline: "none", padding: "0 0 2px", minWidth: 0, width: "100%", maxWidth: 220, fontFamily: "inherit" }}
                  />
                  <button
                    type="button"
                    title="Pick another name"
                    onClick={() => {
                      nameEditedRef.current = false;
                      setAgentName(generateAgentName(draftRole, agentName));
                    }}
                    style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "transparent", color: "var(--text-sub)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, lineHeight: 1 }}
                  >
                    ⟳
                  </button>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  {personaActive ? dynamicPersona!.title : draftRole}
                  {personaActive && (
                    <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(242,140,99,0.14)", color: "#C76A42", fontSize: 10, fontWeight: 800, letterSpacing: "0.04em" }}>
                      TAILORED BY EDDIE
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.55 }}>
                  {/* Why this draft: Eddie's tailored tagline beats everything;
                      personal for explicit picks; honest for weak inferences. */}
                  {personaActive
                    ? dynamicPersona!.tagline || `Invented just for what you described.`
                    : eddieThinking
                      ? "Eddie is thinking about a tailored fit…"
                      : selectedRole
                        ? (discoveryInput.trim()
                            ? `Drafted for: “${discoveryInput.trim().slice(0, 90)}${discoveryInput.trim().length > 90 ? "…" : ""}”`
                            : draftRoleInfo.description)
                        : getDiscoveryConfidenceCopy(discoveryDraft.confidence, draftRole)}
                </div>
              </div>
            </div>

            {/* Tappable alternates — swap the draft live. */}
            {!selectedRole && discoveryDraft.alternatives.filter(alt => (agentTypeInfo as any)[alt]).length > 0 && (
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                <span style={{ fontSize: 11, color: "var(--text-sub)" }}>Or try:</span>
                {discoveryDraft.alternatives.filter(alt => (agentTypeInfo as any)[alt]).slice(0, 3).map(alt => (
                  <button
                    key={alt}
                    type="button"
                    onClick={() => handleRoleSelect(alt, discoveryInput)}
                    style={{ padding: "5px 10px", borderRadius: 999, border: "1px solid rgba(60,102,99,0.2)", background: "rgba(60,102,99,0.05)", color: "#3c6663", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    {alt}
                  </button>
                ))}
              </div>
            )}

            <div style={{ padding: 16, borderRadius: 18, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(0,0,0,0.06)", marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-sub)", marginBottom: 8 }}>Voice & Identity</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexDirection: isVeryNarrowWindow ? "column" : "row" }}>
                <select
                  value={selectedVoice}
                  onChange={e => setSelectedVoice(e.target.value)}
                  style={{ flex: 1, width: isVeryNarrowWindow ? "100%" : undefined, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
                >
                  {["alloy", "echo", "fable", "nova", "onyx", "shimmer"].map(voice => (
                    <option key={voice} value={voice}>{voice}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={previewVoice}
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(60,102,99,0.2)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", minWidth: isVeryNarrowWindow ? 0 : 108, width: isVeryNarrowWindow ? "100%" : "auto" }}
                >
                  {isPreviewingVoice ? "Playing..." : "Preview voice"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 10 }}>
                {draftVoice.sample}
              </div>
              {/* Accessory chips removed: raw ids leaked ("accessories set 1
                  item 17") and the portrait already carries the identity. */}
            </div>

            {/* Setup is Eddie's job — one reassuring line, details on demand.
                (Model/security/tools/routines config-speak stays out of the
                first impression; it re-emerges conversationally in later steps.) */}
            <div style={{ padding: "14px 16px", borderRadius: 18, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <button
                type="button"
                onClick={() => setSetupExpanded(v => !v)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", padding: 0, border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>
                  ✓ Eddie has the setup handled — brain, permissions, tools &amp; routines
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#3c6663", flexShrink: 0 }}>
                  {setupExpanded ? "Hide details" : "Show details"}
                </span>
              </button>
              {setupExpanded && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                    <span style={{ color: "var(--text-sub)" }}>Recommended model</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 700 }}>{getDynamicRecommendedModel(draftRole).provider}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                    <span style={{ color: "var(--text-sub)" }}>Workspace</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 700 }}>{draftRoleInfo.recommended_isolated ? "Isolated sandbox" : "Shared workspace"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12 }}>
                    <span style={{ color: "var(--text-sub)" }}>First useful tools</span>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
                      {draftConnections.map(label => (
                        <span key={label} style={{ padding: "3px 8px", borderRadius: 999, background: "rgba(33,131,128,0.08)", color: "#218380", fontSize: 11, fontWeight: 700 }}>
                          {label}
                        </span>
                      ))}
                    </span>
                  </div>
                  {discoveryHeartbeats.map(task => (
                    <div key={task.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                      <span style={{ color: "var(--text-sub)" }}>{task.title}</span>
                      <span style={{ color: "var(--text-main)", fontWeight: 700 }}>{task.scheduleLabel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );

  const handleCreateAgent = async (opts?: { starterTask?: string }) => {
    if (!selectedRole || !agentName.trim()) return;
    const starterTask = typeof opts?.starterTask === "string" ? opts.starterTask : null;

    setIsCreatingAgent(true);
    setCreateAgentError("");
    const roleInfo = agentTypeInfo[selectedRole];
    let finalPrompt = personalityPrompt;
    if (recentlyRead.length > 0) {
      finalPrompt += `\n\nRecently Read Books: You have recently read the following books and found them very interesting: ${recentlyRead.join(', ')}.`;
    }
    // Lane awareness: slim, stable section pointing at the central TEAM.md
    // (synced below after deploy) — the roster itself never lives in a SOUL,
    // so it can't go stale when agents are added or retired.
    finalPrompt += buildScopeSection(agentName, selectedRole);

    const tempId = `temp-${Date.now()}`;

    const pos = getNonOverlappingPosition(agents);

    // Inject optimistic agent immediately to dismiss wizard
    const optimisticAgent = {
      id: tempId,
      name: agentName,
      status: "deploying", // Signals UI to show loader rings instead of GLB
      role: selectedRole,
      emoji: "agent",
      title: personaMeta?.title || `The ${selectedRole}`,
      description: personaMeta?.tagline || roleInfo?.description || "A custom agent",
      image: roleInfo?.image,
      color: customIdentity?.color || customIdentity?.dynamicColors?.color || roleInfo?.color || "#888",
      robeColor: customIdentity?.color || customIdentity?.dynamicColors?.robeColor || roleInfo?.robeColor || "#888",
      accentColor: customIdentity?.color || customIdentity?.dynamicColors?.accentColor || roleInfo?.accentColor || "#ccc",
      position: pos,
      targetPosition: pos,
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
            active_model: (() => {
              const recommended = getProviderRecommendedModel(selectedRole, llmProvider);
              if (recommended.id) return recommended.id;
              if (llmProvider === "Anthropic") return "anthropic/claude-sonnet-4-6";
              if (llmProvider === "OpenAI") return "openai/gpt-4o";
              if (llmProvider === "Google Gemini") return "google/gemini-3.5-flash";
              if (llmProvider === "xAI Grok") return "xai/grok-beta";
              return "google/gemini-3.5-flash";
            })(),
            soul_template: roleInfo.soul_template,
            identity_template: finalPrompt,
          },
          isolated: isolated,
          capabilities: agentPermissions.reduce((acc, p) => ({ ...acc, [p.id]: p.enabled }), {}),
        }) as Agent;

        const resolvedVisualIdentity = {
          baseModelUrl: customIdentity?.baseModelUrl || null,
          accessories: customIdentity?.accessories?.length
            ? customIdentity.accessories
            : ((roleInfo as any)?.accessories || []),
          decor: customIdentity?.decor || [],
          decorTransforms: customIdentity?.decorTransforms,
          habitatId: customIdentity?.habitatId || (roleInfo as any)?.habitatId || (roleInfo as any)?.visual_identity?.habitatId,
          color: customIdentity?.color || customIdentity?.dynamicColors?.color || roleInfo?.robeColor,
        };

        if (
          resolvedVisualIdentity.accessories.length > 0 ||
          resolvedVisualIdentity.habitatId ||
          resolvedVisualIdentity.color
        ) {
          try {
            await invoke("update_agent_visuals", {
              agentId: newAgentData.id,
              visualIdentity: resolvedVisualIdentity,
            });
            newAgentData.visual_identity = resolvedVisualIdentity as any;
          } catch (e) {
            console.error("Failed to seed draft visual identity", e);
          }
        }

        try {
          await invoke("update_voice_config", {
            agentId: newAgentData.id,
            config: {
              agent_id: newAgentData.id,
              stt_provider: "web_speech",
              tts_provider: "web_speech",
              tts_voice: selectedVoice,
              speaking_rate: selectedVoiceRate,
              auto_play: false,
              enabled: false,
            },
          });
        } catch (e) {
          console.warn("Failed to seed voice config", e);
        }

        if (autoProvisionProvider) {
          await invoke("provision_agent_provider_key", {
            agentId: newAgentData.id,
            provider: autoProvisionProvider,
          });
        } else if (apiKey.trim()) {
          if (!llmProvider) {
            throw new Error("Select a model provider before saving an API key");
          }
          const keyName = getAgentProviderSecretSlot(newAgentData.id, llmProvider);
          await invoke("store_secret_cmd", { key: keyName, value: apiKey.trim() });
        }

        // SECURITY: Rust reads this agent's Keychain slots and writes its runtime
        // auth profile. Provider keys never need to round-trip through React/IPC.
        await syncAgentProviderCredentials(invoke, newAgentData.id);

        if (plugins.imessage && selectedIMessageThreads.length > 0) {
          await invoke("update_allowed_imessage_threads", {
            agentId: newAgentData.id,
            chatIdentifiers: selectedIMessageThreads
          });
        }

        if (plugins.slack && selectedSlackChannels.length > 0) {
          await invoke("update_allowed_slack_channels", {
            agentId: newAgentData.id,
            channelIds: selectedSlackChannels
          }).catch(e => console.warn("Failed to set allowed slack channels", e));
        }

        if (plugins.folders && selectedFolderPath) {
          const bridgeConfig = {
            scope: { allowed_paths: [selectedFolderPath] },
            expires_at: null,
            push_enabled: false
          };
          const bridgePermissions = {
            read: true,
            // Shared agents receive brokered read-only access. Direct writes are
            // available only when onboarding explicitly selected Isolated Mode.
            write: isolated,
            delete: false
          };
          await invoke("enable_bridge", {
            agentId: newAgentData.id,
            bridgeType: "files",
            config: bridgeConfig
          }).catch(async (err) => {
            const message = String(err || "");
            if (!message.toLowerCase().includes("unique")) throw err;
          });
          await invoke("update_bridge_config", {
            bridgeId: `${newAgentData.id}-files`,
            config: bridgeConfig,
            permissions: bridgePermissions
          });
        }

        let githubReady = false;
        let telegramReady = false;
        let discordReady = false;
        let twilioReady = false;

        if (plugins.github) {
          const githubToken = String(
            await invoke("get_secret_cmd", { key: `github-access-token-${newAgentData.id}` }).catch(() => "") || ""
          ).trim();
          if (githubToken) {
            try {
              await invoke("configure_github", { agentId: newAgentData.id, personalAccessToken: githubToken });
              githubReady = true;
            } catch (e) {
              console.warn("Failed to finalize GitHub setup", e);
            }
          }
        }

        telegramReady = !!String(
          await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_telegram_bot_token` }).catch(() => "") || ""
        ).trim();
        discordReady = !!String(
          await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_discord_bot_token` }).catch(() => "") || ""
        ).trim();
        twilioReady =
          !!String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_twilio_account_sid` }).catch(() => "") || "").trim() &&
          !!String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_twilio_auth_token` }).catch(() => "") || "").trim() &&
          !!String(await invoke("get_secret_cmd", { key: `agent_${newAgentData.id}_twilio_phone_number` }).catch(() => "") || "").trim();

        const initialIntegrations = getOnboardingIntegrationIds(
          {
            ...plugins,
            github: githubReady,
            telegram: telegramReady,
            discord: discordReady,
            twilio: twilioReady,
          },
          { githubRepos: pendingGithubRepos }
        );

        if (initialIntegrations.length > 0) {
          try {
            await invoke("update_agent_integrations", { agentId: newAgentData.id, integrations: initialIntegrations });
            newAgentData.integrations = initialIntegrations;
          } catch (e) { console.warn("Failed to set integrations", e); }
        }

        // Central roster: refresh TEAM.md in EVERY agent's workspace so all
        // teammates (old and new) see the updated team immediately.
        try {
          await syncTeamRosterToAgents(
            invoke as any,
            [...agents, newAgentData].map(member => ({
              id: member.id,
              name: member.name,
              role: member.role,
              description: (member as any).description,
            })),
          );
        } catch (e) {
          console.warn("TEAM.md roster sync failed (non-fatal):", e);
        }

        if (selectedHeartbeatTasks.length > 0) {
          try {
            await invoke("write_workspace_file", {
              agentId: newAgentData.id,
              filename: "HEARTBEAT.md",
              content: serializeHeartbeatFile({
                tasks: selectedHeartbeatTasks,
                additionalInstructions: "",
              }),
            });
          } catch (e) {
            console.warn("Failed to seed heartbeat suggestions", e);
          }
        }

        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === optimisticId
            ? { ...a, ...newAgentData, id: newAgentData.id, status: "active", currentAction: "idle" } as AgentData
            : a)
        }));

        if (plugins.slack) {
          await invoke("boot_sync_agents").catch(() => {});
          await invoke("sync_agent_slack_config", { agentId: newAgentData.id }).catch(() => {});
        }

        // A0 activation: agent successfully deployed. Fire-once, see fireActivationEvent.
        fireActivationEvent("activation_a0_deployed");

        return newAgentData;
      } else {
        throw new Error("Tauri invoke not found");
      }
    };

    addAgent(optimisticAgent);

    // Starter task path (activation A2 — "Watch [Name] work"): wait for the
    // real deploy, then land the user directly in the agent's chat where
    // ChatTab picks up the queued first task and sends it automatically.
    if (starterTask && !plugins.slack) {
      try {
        const newAgent = await deployAgentCore(tempId);
        localStorage.setItem("canopy_starter_task", JSON.stringify({ agentId: newAgent.id, prompt: starterTask }));
        localStorage.removeItem('canopy_onboarding_draft');
        const store = useWorldStore.getState();
        store.setSelectedAgent(newAgent.id);
        if (typeof (store as any).setArchitectTab === "function") (store as any).setArchitectTab("overview");
        store.setActiveView("architect");
      } catch (err) {
        console.error("Starter-task deployment failed:", err);
        setCreateAgentError(String(err));
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === tempId
            ? { ...a, status: "error", currentAction: "Deployment Failed: Docker Container Execution Failure" }
            : a)
        }));
      } finally {
        setIsCreatingAgent(false);
      }
      return;
    }

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
      display: "flex", alignItems: step <= 1.8 ? "flex-start" : "center", justifyContent: "center",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      overflowX: "hidden",
      overflowY: "auto",
      padding: step <= 1.8 ? "72px 0 24px" : "24px 0",
      boxSizing: "border-box",
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

      {/* Progress indicator — visible shape across the whole wizard */}
      {step >= 0 && (
        <div style={{
          position: "absolute", top: 28, left: "50%", transform: "translateX(-50%)",
          display: "flex", alignItems: "center", gap: 10, zIndex: 90,
        }}>
          {PROGRESS_STAGES.map((label, i) => {
            const current = stageForStep(step);
            const done = i < current;
            const active = i === current;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div style={{
                    width: active ? 10 : 8, height: active ? 10 : 8, borderRadius: "50%",
                    background: done || active ? "#3c6663" : "var(--border-subtle)",
                    boxShadow: active ? "0 0 0 4px rgba(60,102,99,0.15)" : "none",
                    transition: "all 0.3s ease",
                  }} />
                  <span style={{
                    fontSize: 10, fontWeight: active ? 700 : 500,
                    color: done || active ? "#3c6663" : "var(--text-muted)",
                    letterSpacing: "0.02em",
                  }}>{label}</span>
                </div>
                {i < PROGRESS_STAGES.length - 1 && (
                  <div style={{ width: 28, height: 2, borderRadius: 1, marginBottom: 14, background: done ? "#3c6663" : "var(--border-subtle)", transition: "background 0.3s ease" }} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Companion lobster — warmth on the anxiety-prone form steps.
          (Step 0 already shows the full WorldScene; -1 is the loader.) */}
      {/* One Eddie per screen: the discovery step (1) has Eddie in its header,
          so the ambient walking companion is suppressed there. */}
      {step >= 0.5 && step !== 1 && (
        <div style={{
          position: "absolute", bottom: 8, left: 16, width: 150, height: 150,
          pointerEvents: "none", zIndex: 80,
        }}>
          <React.Suspense fallback={null}>
            <Canvas camera={{ position: [0, 1.2, 3.2], fov: 35 }} gl={{ alpha: true }} style={{ background: "transparent" }}>
              <ambientLight intensity={0.9} />
              <directionalLight position={[3, 5, 2]} intensity={1.1} />
              <OnboardingCompanion
                position={[0, -0.7, 0]}
                scale={0.85}
                animationState="breathe"
                baseColor={(selectedRole && agentTypeInfo[selectedRole]?.robeColor) || "#F28C63"}
              />
            </Canvas>
          </React.Suspense>
        </div>
      )}

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
                <Box size={40} color="#3c6663" strokeWidth={2} />
              </div>

              <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", marginBottom: 16, fontFamily: "'Noto Serif', Georgia, serif" }}>
                {engineStatus === "found" ? "Local engine found" : "One quick setup step"}
              </h1>

              <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32, lineHeight: 1.6 }}>
                {engineStatus === "found"
                  ? `Canopy runs your agents locally so your data never leaves your Mac. We'll connect to your existing ${foundEngine} setup.`
                  : "Canopy runs your agents on your Mac so your data never leaves it. We need to install a local container engine (OrbStack / Docker) to make that work — it takes about a minute."}
              </p>

              <button
                onClick={async () => {
                  setEngineStatus("checking");
                  if (engineStatus === "found") {
                    try {
                      setEngineStatus("starting");
                      await safeStartGateway();
                      setStep(initialStepTarget);
                    } catch (e) {
                      setEngineError(e as string);
                      setEngineStatus("missing");
                    }
                  } else {
                    try {
                      await invoke("install_orbstack");
                      const installed = await invoke("check_orbstack_installed");
                      if (installed) {
                        setEngineStatus("starting");
                        await invoke("start_gateway");
                        setStep(initialStepTarget);
                      } else {
                        setEngineStatus("missing");
                      }
                    } catch (e) {
                      setEngineError(e as string);
                      setEngineStatus("missing");
                    }
                  }
                }}
                style={{
                  padding: "16px 32px", borderRadius: 12, border: "none",
                  background: "#3c6663", color: "var(--surface-card)", fontSize: 16, fontWeight: 600,
                  cursor: "pointer", boxShadow: "0 4px 12px rgba(60,102,99,0.2)",
                  transition: "all 0.2s ease"
                }}
              >
                {engineStatus === "found" 
                  ? `Connect to ${foundEngine}`
                  : engineError?.includes("start gateway") || engineError?.includes("allocated") ? "Retry" : "Install helper"}
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
        renderDiscoveryStep(false)
      )}

      {/* Step 0.5 removed (first-principles consolidation): the user's name is
          collected conversationally inside the discovery card, and the profile
          is saved in continueFromDiscovery. One beat, not two. */}

      {/* Step 2: Choose Role */}
      {step === 1 && (
        renderDiscoveryStep(true)
      )}

      {/* Step 1.5: (Removed Nano Banana step - functionality moved to 2.5) */}


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
        <div style={{ maxWidth: 1180, width: "94%", height: "90vh", display: "flex", flexDirection: "column" }}>
          {/* Meet {Name} studio: identity + personality on the left, living
              preview + test-drive conversation on the right. Tweak ↔ talk. */}
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: viewportSize.width < 1000 ? "1fr" : "minmax(0, 1fr) 400px", gap: 24 }}>
          <div style={{ overflow: "auto", padding: "20px 0", minWidth: 0 }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
              Meet {agentName.trim() || "Your Agent"}
            </h1>
            <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32 }}>
              Shape who {agentName.trim() || "they"} are — and try them out live on the right while you do.
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
                  <img src={getAssetUrl(agentTypeInfo[selectedRole].image)} alt={selectedRole} style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />
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

            <div style={{ background: "var(--surface-base)", backdropFilter: "blur(4px)", padding: 20, borderRadius: 16, marginBottom: 24 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>Voice & visual identity</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 14 }}>
                Eddie already picked a starting voice and accessories so this agent feels distinct right away.
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <select
                  value={selectedVoice}
                  onChange={e => setSelectedVoice(e.target.value)}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
                >
                  {["alloy", "echo", "fable", "nova", "onyx", "shimmer"].map(voice => (
                    <option key={voice} value={voice}>{voice}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={previewVoice}
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(60,102,99,0.18)", background: "rgba(60,102,99,0.06)", color: "#3c6663", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", minWidth: 112 }}
                >
                  {isPreviewingVoice ? "Playing..." : "Preview voice"}
                </button>
              </div>
              {/* The being, live: lobster + accessories + habitat, same preview
                  pipeline as the appearance step — never raw asset ids. */}
              <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
                <div style={{ width: 180, height: 150, borderRadius: 14, overflow: "hidden", background: "rgba(60,102,99,0.06)", border: "1px solid rgba(0,0,0,0.06)", flexShrink: 0 }}>
                  <React.Suspense fallback={null}>
                    <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 110 }} gl={{ alpha: true }}>
                      <ambientLight intensity={0.7} />
                      <directionalLight position={[5, 5, 5]} intensity={1} />
                      <group position={[0, -0.06, 0]}>
                        <WorldScene agents={[{
                          id: "identity-preview-agent",
                          role: selectedRole || "Custom",
                          name: agentName || "Agent",
                          visual_identity: {
                            habitatId: customIdentity?.habitatId || 1,
                            accessories: customIdentity?.accessories || [],
                          } as any,
                        }]} />
                      </group>
                    </Canvas>
                  </React.Suspense>
                </div>
                <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {(customIdentity?.accessories || []).map(accessory => (
                      <span key={accessory} style={{ padding: "5px 10px", borderRadius: 999, background: "rgba(60,102,99,0.08)", color: "#3c6663", fontSize: 11, fontWeight: 700 }}>
                        {getAccessoryName(accessory)}
                      </span>
                    ))}
                    {(customIdentity?.accessories || []).length === 0 && (
                      <span style={{ fontSize: 12, color: "var(--text-sub)" }}>No starter accessories yet. You can add them on the next screen.</span>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: "var(--text-sub)", opacity: 0.7 }}>Full dressing room on the next screen.</span>
                </div>
              </div>
            </div>

            <div style={{ background: "var(--surface-base)", backdropFilter: "blur(4px)", padding: 24, borderRadius: 16, marginBottom: 32 }}>
              <div>
                <h3 style={{ fontSize: 16, color: "var(--text-main)", margin: "0 0 4px 0" }}>Personality</h3>
                <p style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 16 }}>
                  {/* Research-backed (July 18): concise + specific beats long
                      trait essays; the model infers related traits, and memory
                      accretes preferences over time. Eddie writes it; the user
                      nudges it. Plain textarea, not a markdown IDE. */}
                  Eddie wrote this from what you told him. Keep it short and specific — {agentName || "your agent"} fills in the rest, and learns your preferences as you work together. Try a change, then test it on the right.
                </p>
                <textarea
                  value={personalityPrompt}
                  onChange={e => setPersonalityPrompt(e.target.value)}
                  rows={7}
                  placeholder={`e.g. You are ${agentName || "Fern"}, a warm, sharp ${displayRole || draftRole || "specialist"} who gives concrete recommendations, never waffles, and always says when something is outside your expertise.`}
                  style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.1)", fontSize: 14, lineHeight: 1.65, resize: "vertical", outline: "none", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
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
                        // Custom reading context belongs to this local draft.
                        // It is never uploaded to mutate the shared catalog.
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

          {/* Right pane: the living preview + test-drive conversation. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "20px 0", minHeight: 0 }}>
            <div style={{ height: 190, borderRadius: 18, overflow: "hidden", background: "rgba(60,102,99,0.06)", border: "1px solid rgba(0,0,0,0.06)", position: "relative", flexShrink: 0 }}>
              <React.Suspense fallback={null}>
                <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 120 }} gl={{ alpha: true }}>
                  <ambientLight intensity={0.7} />
                  <directionalLight position={[5, 5, 5]} intensity={1} />
                  <group position={[0, -0.06, 0]}>
                    <WorldScene agents={[{
                      id: "studio-preview-agent",
                      role: selectedRole || "Custom",
                      name: agentName || "Agent",
                      visual_identity: {
                        habitatId: customIdentity?.habitatId || 1,
                        accessories: customIdentity?.accessories || [],
                      } as any,
                    }]} />
                  </group>
                </Canvas>
              </React.Suspense>
              <button
                type="button"
                onClick={() => setStep(2.5)}
                style={{ position: "absolute", bottom: 10, right: 10, padding: "7px 12px", borderRadius: 10, border: "1px solid rgba(60,102,99,0.25)", background: "rgba(255,255,255,0.85)", color: "#3c6663", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
              >
                Open dressing room
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: 14, borderRadius: 18, background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.06)" }}>
              <TestDriveChat personality={personalityPrompt} agentName={agentName.trim() || "your agent"} />
            </div>
          </div>
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(agents.length > 0 ? 1 : 0)} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(3)} disabled={!agentName.trim()} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: agentName.trim() ? "#3c6663" : "var(--border-subtle)",
              color: agentName.trim() ? "var(--surface-card)" : "var(--text-muted)",
              fontSize: 14, fontWeight: 600, cursor: agentName.trim() ? "pointer" : "default",
              fontFamily: "inherit",
            }}>{`Give ${agentName.trim() || "them"} power →`}</button>
          </div>
        </div>
      )}

      {/* Step 2.5: Dressing room (optional detour from the studio) */}
      {step === 2.5 && (
        <div style={{ maxWidth: 900, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: 0 }}>Design {agentName || "Agent"}</h1>
              <p style={{ fontSize: 14, color: "var(--text-sub)", margin: "4px 0 0 0" }}>Choose their appearance, accessories, and habitat.</p>
            </div>
          </div>

          <div style={{ padding: "14px 16px", borderRadius: 16, background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.14)", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 6 }}>Starter accessories already included</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(customIdentity?.accessories || []).map(accessory => (
                <span key={accessory} style={{ padding: "5px 8px", borderRadius: 999, background: "rgba(60,102,99,0.08)", color: "#3c6663", fontSize: 11, fontWeight: 700 }}>
                  {accessory.split("/").pop()?.replace(".png", "").replace(/[-_]/g, " ")}
                </span>
              ))}
              {(customIdentity?.accessories || []).length === 0 && (
                <span style={{ fontSize: 12, color: "var(--text-sub)" }}>No accessories have been picked yet.</span>
              )}
            </div>
          </div>
          
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Visualizer */}
            <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", flex: 2, border: "1px solid rgba(0,0,0,0.06)", minHeight: 400 }}>
              <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 150 }}>
                <Environment preset="city" />
                <ambientLight intensity={0.5} />
                <directionalLight position={[5, 5, 5]} intensity={1} castShadow />
                <OrbitControls enablePan={false} />
                <group position={[0, -0.06, 0]}>
                  <WorldScene agents={[{
                    id: "preview-agent",
                    role: selectedRole || "Custom",
                    name: agentName || "Agent",
                    visual_identity: {
                      habitatId: customIdentity?.habitatId || 1,
                      accessories: customIdentity?.accessories || [],
                      color: customIdentity?.color || agentTypeInfo[selectedRole || "Custom"]?.robeColor
                    } as any
                  }]} />
                </group>
              </Canvas>
            </div>
            
            {/* Controls */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, height: 200 }}>
              {/* Habitat Selector */}
              <div style={{ background: "var(--glass-light)", borderRadius: 24, padding: 16, overflowY: "auto", border: "1px solid rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12 }}>HABITAT</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                  {habitats.map(h => (
                    <div key={h.id}
                      onClick={() => setCustomIdentity(prev => ({ ...prev, habitatId: h.id }))}
                      style={{ height: 80, borderRadius: 12, overflow: "hidden", position: "relative", cursor: "pointer", border: customIdentity?.habitatId === h.id ? "2px solid #218380" : "2px solid transparent" }}>
                      {h.imageUrl ? (
                        <img src={getAssetUrl(h.imageUrl)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt={h.name} />
                      ) : (
                        <div style={{ width: "100%", height: "100%", background: "rgba(0,0,0,0.05)" }} />
                      )}
                      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(0,0,0,0.4)", color: "white", fontSize: 10, padding: "2px 4px", textAlign: "center" }}>{h.name}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Color Selector */}
              <div style={{ background: "var(--glass-light)", borderRadius: 24, padding: 16, overflowY: "auto", border: "1px solid rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12 }}>COLOR</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {['#7A9EB5', '#545281', '#BFCB75', '#8E9EAA', '#7AAC7A', '#96A88E', '#F0B466', '#7F8C8D', '#A882D8', '#8EB5A0', '#82A4A8', '#B85C82', '#E0908B', '#D96C3B'].map(color => (
                    <div key={color}
                      onClick={() => setCustomIdentity(prev => ({ ...prev, color }))}
                      style={{
                        backgroundColor: color, width: 36, height: 36, borderRadius: 8, cursor: "pointer",
                        border: customIdentity?.color === color ? '2px solid var(--text-main)' : '2px solid rgba(0,0,0,0.1)'
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(2)} data-role="dressing-back" style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(2)} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: "#3c6663", color: "var(--surface-card)",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{`Done — back to ${agentName.trim() || "the studio"}`}</button>
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
                  <>Based on the <strong>{displayRole}</strong> role, we default to the <strong>{getDynamicRecommendedModel(selectedRole).model}</strong> model.
                  {detectedSetup && (
                    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(74,158,150,0.12)", border: "1px solid rgba(74,158,150,0.3)", color: "#2c5a55", fontSize: 13, fontWeight: 600 }}>
                      ✓ {detectedSetup === "management"
                        ? `You're already connected to ${llmProvider} — a dedicated key will be created for ${agentName || "this agent"} automatically. Just continue.`
                        : `Found your existing ${llmProvider} key — ${agentName || "this agent"} is ready to think. Just continue.`}
                    </div>
                  )}
                  </>
                )}
              </div>
            )}

            <div style={{ marginBottom: 24, display: "flex", flexWrap: "wrap", gap: 12 }}>
              {["OpenAI", "Google Gemini", "Anthropic", "xAI Grok"].map(prov => (
                <label key={prov} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface-card)", padding: "12px 16px", borderRadius: 12, border: llmProvider === prov ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.1)", cursor: "pointer", opacity: llmProvider === prov ? 1 : 0.7 }}>
                  <input type="radio" name="provider" checked={llmProvider === prov} onChange={() => { setLlmProvider(prov as any); setApiKeyMode("hidden"); setApiKey(""); setAutoProvisionProvider(null); }} />
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
                  setAutoProvisionProvider(null);
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
                  Use an existing key for this agent
                </button>
                <div style={{ textAlign: "center", fontSize: 12, color: "var(--text-sub)", margin: "-6px 0" }}>— or —</div>
                <button onClick={async () => {
                  if (!llmProvider) return;
                  if (managedProviderId) {
                    setApiKey("");
                    setApiKeyMode("hidden");
                    setAutoProvisionProvider(managementConnected ? managedProviderId : null);
                    return;
                  }
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
                  {managedProviderId ? `Create a dedicated ${llmProvider} key automatically ✨` : "Set up new API key ✨"}
                </button>
              </div>

              {managedProviderId && !managementConnected && (
                <div style={{ marginTop: 16, padding: 16, borderRadius: 12, border: "1px solid rgba(33,131,128,0.22)", background: "rgba(33,131,128,0.05)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 5 }}>Connect {llmProvider} management once</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 10 }}>
                    Canopy creates a separate key for each agent. The management credential stays in your Mac Keychain and is never sent to Eddy or the Canopy server.
                  </div>
                  <PasswordInput
                    placeholder={managedProviderId === "xai" ? "xAI Management API key" : "OpenAI organization Admin key"}
                    value={managementCredential}
                    onChange={e => setManagementCredential(e.target.value)}
                    style={{ width: "100%", padding: "11px 13px", borderRadius: 9, border: "1px solid rgba(0,0,0,0.12)", marginBottom: 8 }}
                  />
                  <input
                    placeholder={managedProviderId === "xai" ? "xAI team ID" : "OpenAI project ID"}
                    value={managementScopeId}
                    onChange={e => setManagementScopeId(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 9, border: "1px solid rgba(0,0,0,0.12)", marginBottom: 8 }}
                  />
                  <button onClick={connectManagementForOnboarding} disabled={managementBusy || !managementCredential.trim() || !managementScopeId.trim()} style={{ width: "100%", padding: "10px 14px", borderRadius: 9, border: "none", background: "#218380", color: "white", fontWeight: 700, cursor: "pointer" }}>
                    {managementBusy ? "Validating…" : "Connect once & use automatic keys"}
                  </button>
                  {managementError && <div style={{ marginTop: 8, fontSize: 12, color: "#b42318" }}>{managementError}</div>}
                </div>
              )}

              {managedProviderId && managementConnected && autoProvisionProvider === managedProviderId && (
                <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: 10, background: "rgba(33,131,128,0.09)", color: "#218380", fontSize: 12, fontWeight: 700 }}>
                  ✓ A dedicated {llmProvider} key will be created for {agentName || "this agent"} during deployment.
                </div>
              )}

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

              {/* Required-field guidance */}
              {(() => {
                const hasKey = apiKey.trim().length > 0;
                if (autoProvisionProvider) {
                  return <div style={{ marginTop: 14, fontSize: 12, color: "#218380", fontWeight: 600 }}>Dedicated-key provisioning is ready. No inference key needs to be pasted.</div>;
                }
                if (hasKey) {
                  return (
                    <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#218380", fontWeight: 600 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      Key detected. We'll save it securely to your Mac's Keychain.
                    </div>
                  );
                }
                if (!llmProvider) {
                  return (
                    <div style={{ marginTop: 14, fontSize: 12, color: "var(--text-sub)" }}>
                      Pick a provider above to continue.
                    </div>
                  );
                }
                return (
                  <div style={{ marginTop: 14, fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
                    {agentName || "Your agent"} needs an API key to think. Use <strong>Scan</strong> if you've set up {llmProvider} before, or <strong>Set up new</strong> to walk through it now.
                  </div>
                );
              })()}
            </div>

          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(2.5)} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            {/* Key-free creation (spec Part 1B Layer 2): the key is a graduation
                moment at first message, not a gate on creating the agent. */}
            <button
              onClick={() => { setApiKey(""); setApiKeyMode("hidden"); setAutoProvisionProvider(null); setStep(4); }}
              title={`You can finish creating ${agentName || "your agent"} now and connect a key when you send their first message.`}
              style={{
                marginLeft: "auto", padding: "12px 20px", borderRadius: 12,
                background: "transparent", border: "none", color: "var(--text-sub)",
                fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                textDecoration: "underline", textUnderlineOffset: 3,
              }}
            >Skip — connect later</button>
            {(() => {
              const canAdvance = !!llmProvider && (apiKey.trim().length > 0 || autoProvisionProvider !== null);
              return (
                <button
                  onClick={() => { if (canAdvance) setStep(4); }}
                  disabled={!canAdvance}
                  title={canAdvance ? "" : "Add a key here, or use Skip to connect one later."}
                  style={{
                    padding: "12px 28px", borderRadius: 12, border: "none",
                    background: canAdvance ? "#3c6663" : "var(--border-subtle)",
                    color: canAdvance ? "var(--surface-card)" : "var(--text-muted)",
                    fontSize: 14, fontWeight: 600,
                    cursor: canAdvance ? "pointer" : "not-allowed",
                    fontFamily: "inherit",
                    opacity: canAdvance ? 1 : 0.85,
                  }}
                >Next</button>
              );
            })()}
          </div>
        </div>
      )}

      {/* Step 5: Plugins & Permissions */}
      {step === 4 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>Skills & Access</h1>
            <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 32, lineHeight: 1.5 }}>
              What should {agentName || "your agent"} be able to use? Connect the ones that matter — everything else can wait.
            </p>

            {/* ── Extra privacy (advanced) — plain language, technical detail
                   obscured; defaults are safe either way. ── */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-card)", padding: "14px 18px", borderRadius: 12, border: isolated ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)", display: "flex", alignItems: "center", gap: 8 }}>
                    Keep {agentName || "this agent"} extra private
                    {AGENT_TYPE_INFO[selectedRole || ""]?.recommended_isolated && (
                      <span style={{ fontSize: 10, background: "rgba(212,160,74,0.15)", color: "#A87212", padding: "2px 6px", borderRadius: 4 }}>Recommended for this role</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4, lineHeight: 1.4, maxWidth: "90%" }}>
                    {agentName || "This agent"} works alone and can't see what your other agents know. Good for sensitive work like finances or health.
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

            {/* ── Agent-Specific Connections ── */}
            {(() => {
              const TOP_INTEGRATIONS_BY_ROLE: Record<string, string[]> = {
                "Researcher":  ["folders", "slack"],
                "Tutor":       ["folders", "slack"],
                "Assistant":   ["slack", "folders"],
                "Therapist":   ["imessage", "slack"],
                "Chef":        ["photos", "folders"],
                "Accountant":  ["folders", "slack"],
                "Educator":    ["folders", "slack"],
                "Artist":      ["photos", "folders"],
                "Coder":       ["github", "folders"],
                "Architect":   ["github", "folders"],
                "Musician":    ["folders", "imessage"],
                "Trainer":     ["imessage", "photos"],
                "Strategist":  ["slack", "folders"],
                "Negotiator":  ["slack", "imessage"],
                "Engineer":    ["github", "folders"],
                "Editor":      ["folders", "slack"],
                "Coach":       ["imessage", "slack"],
                "Custom":      ["slack", "folders"],
              };

              const ALL_INTEGRATIONS = [
                { key: "slack",    label: "Slack App",         icon: "💬", desc: `Create a dedicated Slack bot for this agent` },
                { key: "github",   label: "GitHub",            icon: "🐙", desc: `Access repos, issues, and pull requests` },
                { key: "folders",  label: "File System",       icon: "📁", desc: `Let ${agentName || "the agent"} read and write files on your Mac` },
                { key: "imessage", label: "iMessage",          icon: "💬", desc: `Access your iMessage conversations` },
                { key: "photos",   label: "Apple Photos",      icon: "🖼️", desc: `Browse and reference your photo library` },
                { key: "telegram", label: "Telegram",          icon: "✈️", desc: `Connect a Telegram bot for channel and DM access` },
                { key: "discord",  label: "Discord",           icon: "🎮", desc: `Connect a Discord bot to respond in channels and DMs` },
                { key: "twilio",   label: "Twilio Voice & SMS",icon: "📞", desc: `Give this agent a phone number for calls and texts` },
              ] as const;

              const topKeys = (selectedRole && TOP_INTEGRATIONS_BY_ROLE[selectedRole]) || ["slack", "folders"];
              const topIntegrations = topKeys
                .map(k => ALL_INTEGRATIONS.find(i => i.key === k))
                .filter(Boolean) as typeof ALL_INTEGRATIONS[number][];
              const moreIntegrations = ALL_INTEGRATIONS.filter(i => !topKeys.includes(i.key));

              const renderIntegrationRow = (item: typeof ALL_INTEGRATIONS[number], isTop: boolean) => (
                <div key={item.key} style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    background: "var(--surface-card)", padding: "14px 18px",
                    borderRadius: plugins[item.key] && item.key === "folders" ? "12px 12px 0 0" : 12,
                    border: plugins[item.key] ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <span style={{ fontSize: 22 }}>{item.icon}</span>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{item.label}</span>
                          {isTop && (
                            <span style={{ fontSize: 10, background: "rgba(60,102,99,0.1)", color: "#3c6663", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
                              Suggested
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{item.desc}</div>
                      </div>
                    </div>
                    <Toggle enabled={plugins[item.key]} onChange={() => setPlugins(prev => ({ ...prev, [item.key]: !prev[item.key] }))} />
                  </div>
                  {item.key === "folders" && plugins.folders && (
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
              );

              return (
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                    Agent-Specific Connections
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {topIntegrations.map(item => renderIntegrationRow(item, true))}
                    {moreIntegrations.length > 0 && (
                      <>
                        <button
                          onClick={() => { setShowAllIntegrations(v => !v); setMoreIntegrationsSearch(""); }}
                          style={{
                            background: "none", border: "none", cursor: "pointer",
                            fontSize: 12, color: "var(--text-sub)", textAlign: "left",
                            padding: "4px 2px", display: "flex", alignItems: "center", gap: 6,
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transition: "transform 0.2s", transform: showAllIntegrations ? "rotate(180deg)" : "rotate(0deg)" }}>
                            <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          {showAllIntegrations ? "Show fewer" : `More integrations (${moreIntegrations.length})`}
                        </button>
                        {showAllIntegrations && (
                          <>
                            <div style={{ position: "relative" }}>
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }}>
                                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
                                <path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                              </svg>
                              <input
                                type="text"
                                placeholder="Filter integrations..."
                                value={moreIntegrationsSearch}
                                onChange={e => setMoreIntegrationsSearch(e.target.value)}
                                style={{
                                  width: "100%", boxSizing: "border-box",
                                  padding: "9px 12px 9px 30px", borderRadius: 8,
                                  border: "1px solid rgba(0,0,0,0.1)", fontSize: 12,
                                  background: "var(--surface-card)", color: "var(--text-main)",
                                  outline: "none",
                                }}
                              />
                            </div>
                            {moreIntegrations
                              .filter(item => {
                                const q = moreIntegrationsSearch.toLowerCase();
                                return !q || item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q);
                              })
                              .map(item => renderIntegrationRow(item, false))}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                Suggested Heartbeats
              </div>
              <div style={{ padding: "16px 18px", borderRadius: 14, background: "rgba(33,131,128,0.04)", border: "1px solid rgba(33,131,128,0.14)", marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 6 }}>
                  Start {agentName || "this agent"} with proactive routines
                </div>
                <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
                  {agentName || "Your agent"} will run these on schedule once deployed. You can change or pause them anytime.
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {readyHeartbeatSuggestions.slice(0, 4).map(task => {
                  const selected = selectedHeartbeatNames.includes(task.name);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        setSelectedHeartbeatNames(previous =>
                          previous.includes(task.name)
                            ? previous.filter(name => name !== task.name)
                            : [...previous, task.name]
                        );
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                        background: "var(--surface-card)",
                        padding: "14px 18px",
                        borderRadius: 12,
                        border: selected ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{task.title}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "rgba(33,131,128,0.12)", color: "#3c6663", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {task.scheduleLabel}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>{task.prompt}</div>
                      </div>
                      <div style={{ alignSelf: "center", minWidth: 88, textAlign: "right", fontSize: 12, fontWeight: 700, color: selected ? "#3c6663" : "var(--text-muted)" }}>
                        {selected ? "Included" : "Optional"}
                      </div>
                    </button>
                  );
                })}
                {lockedHeartbeatSuggestions.slice(0, 2).map(task => (
                  <div
                    key={task.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 16,
                      background: "rgba(212,160,74,0.08)",
                      padding: "14px 18px",
                      borderRadius: 12,
                      border: "1px solid rgba(212,160,74,0.22)",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{task.title}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "rgba(212,160,74,0.14)", color: "#A87212", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          {task.scheduleLabel}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 6 }}>{task.prompt}</div>
                      <div style={{ fontSize: 11, color: "#A87212", lineHeight: 1.4 }}>
                        Unlock by connecting or enabling {formatHeartbeatRequirements(task)}.
                      </div>
                    </div>
                    <div style={{ alignSelf: "center", minWidth: 88, textAlign: "right", fontSize: 12, fontWeight: 700, color: "#A87212" }}>
                      Needs setup
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── OpenClaw Capabilities (Agent Sandbox) ── */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                Agent Core Capabilities
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  {
                    id: "bundle_web",
                    label: "Web Surfing & Research",
                    description: "Allows the agent to search the web, visually navigate websites, and bypass blocks.",
                    linkedPerms: ["browser", "ext_network", "gog", "summarize", "proxy"]
                  },
                  {
                    id: "bundle_vision",
                    label: "Visual & Canvas Processing",
                    description: "Allows the agent to analyze images, read your screen visually, and edit canvas layouts.",
                    linkedPerms: ["vision", "canvas"]
                  },
                  {
                    id: "bundle_autonomous",
                    label: "Autonomous Background Action",
                    description: "Allows the agent to run tasks on a schedule and execute loops without asking for permission each step.",
                    linkedPerms: ["autonomous", "scheduled"]
                  },
                  {
                    id: "bundle_memory",
                    label: "Long-Term Memory",
                    description: "Allows the agent to store notes and remember your preferences across different conversations.",
                    linkedPerms: ["memory_write"]
                  },
                  {
                    id: "bundle_coding",
                    label: "Write & Run Code",
                    description: "Allows the agent to write and execute code to solve complex problems or process data.",
                    linkedPerms: ["coding"]
                  }
                ].map(bundle => {
                  const isEnabled = bundle.linkedPerms.some(id => agentPermissions.find(p => p.id === id)?.enabled);
                  return (
                    <div key={bundle.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-card)", padding: "14px 18px", borderRadius: 12, border: isEnabled ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)" }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>{bundle.label}</div>
                        <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{bundle.description}</div>
                      </div>
                      <Toggle enabled={isEnabled} onChange={() => {
                        const willEnable = !isEnabled;
                        const hasHighRisk = bundle.linkedPerms.some(id => isHighRisk(id));
                        
                        if (willEnable && hasHighRisk) {
                          const riskId = bundle.linkedPerms.find(id => isHighRisk(id));
                          if (riskId) {
                            setPendingHighRiskToggle({ id: riskId, enabled: true });
                            setShowHighRiskModal(true);
                            return;
                          }
                        }
                        
                        setAgentPermissions(prev => prev.map(p => 
                          bundle.linkedPerms.includes(p.id) ? { ...p, enabled: willEnable } : p
                        ));
                      }} />
                    </div>
                  );
                })}
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
                      if (typeof invoke === 'function') {
                        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                        new WebviewWindow('companion_slack_' + Date.now(), {
                          url: buildCompanionUrl("slack", {
                            agentId: optimisticId,
                            agentName: agentName || "Agent",
                            isNew: true,
                          }),
                          title: 'Setup Slack',
                          width: 420,
                          height: 760,
                          x: window.screen.availWidth - 440,
                          y: 50,
                          alwaysOnTop: true,
                          decorations: true,
                        });
                      }
                    } catch (e) {
                      console.error("Failed to spawn companion, falling back to browser tab only", e);
                      const manifest = {
                        display_information: { name: agentName || "Sloane", description: selectedRole ? `Your ${selectedRole} Canopy Agent` : "Your Canopy Agent", background_color: "#3c6663" },
                        features: {
                          app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
                          bot_user: { display_name: agentName || "Sloane", always_online: true }
                        },
                        oauth_config: {
                          scopes: { bot: ["chat:write", "channels:history", "channels:read", "groups:history", "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "users:read", "app_mentions:read", "reactions:read", "reactions:write", "commands"] },
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
                      {import.meta.env.DEV && (
                        <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(255, 165, 0, 0.1)", border: "1px solid rgba(255, 165, 0, 0.3)", borderRadius: 6, fontSize: 12, color: "#b37400" }}>
                          <strong>Dev Mode Note:</strong> Since you are running in development, "Canopy" won't appear in the list. You must grant Full Disk Access to your <strong>Terminal</strong> or <strong>IDE</strong> (e.g., VS Code, Cursor) instead.
                        </div>
                      )}
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

                    <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
                      <button onClick={async () => {
                        try {
                          await invoke("open_full_disk_access_settings");
                        } catch (e) {
                          console.error("Failed to open System Settings:", e);
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
                      }} style={{ padding: "14px 24px", background: "#3c6663", color: "var(--surface-card)", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>
                        Open System Settings → Full Disk Access
                      </button>
                    </div>
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
                        agentId: optimisticId,
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
                    // Must go through Rust: the JS shell plugin rejects
                    // x-apple.systempreferences: URLs and the location.href
                    // fallback is blocked by the webview — both were silent no-ops.
                    try {
                      await invoke("open_photos_privacy_settings");
                    } catch (e) {
                      console.error("Failed to open Photos privacy settings:", e);
                      alert("Couldn't open System Settings automatically. Open System Settings → Privacy & Security → Photos and toggle Canopy on.");
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

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "github" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 14, color: "var(--text-main)", fontWeight: 600, marginBottom: 12 }}>
                  GitHub setup needs a Personal Access Token and repository selection.
                </div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 20 }}>
                  Launch the side-by-side guide, finish token creation, then verify access here before launch.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={() => handleSetupIntegration("github")} style={{ padding: "12px 18px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Launch GitHub Setup
                  </button>
                  <button onClick={() => runConnectionPreflight("github")} style={{ padding: "12px 18px", borderRadius: 12, border: "1px solid rgba(60,102,99,0.25)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Verify GitHub Access
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "telegram" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 14, color: "var(--text-main)", fontWeight: 600, marginBottom: 12 }}>
                  Telegram uses a dedicated bot token from BotFather.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={() => handleSetupIntegration("telegram")} style={{ padding: "12px 18px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Launch Telegram Setup
                  </button>
                  <button onClick={() => runConnectionPreflight("telegram")} style={{ padding: "12px 18px", borderRadius: 12, border: "1px solid rgba(60,102,99,0.25)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Verify Telegram Access
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "discord" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 14, color: "var(--text-main)", fontWeight: 600, marginBottom: 12 }}>
                  Discord needs a dedicated bot token from the Developer Portal.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={() => handleSetupIntegration("discord")} style={{ padding: "12px 18px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Launch Discord Setup
                  </button>
                  <button onClick={() => runConnectionPreflight("discord")} style={{ padding: "12px 18px", borderRadius: 12, border: "1px solid rgba(60,102,99,0.25)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Verify Discord Access
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "twilio" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 14, color: "var(--text-main)", fontWeight: 600, marginBottom: 16 }}>
                  Twilio needs your Account SID, Auth Token, and a phone number to bind to this agent.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                  <PasswordInput
                    value={twilioDraft.accountSid}
                    onChange={e => setTwilioDraft(prev => ({ ...prev, accountSid: e.target.value }))}
                    placeholder="Account SID (AC...)"
                    style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)" }}
                  />
                  <PasswordInput
                    value={twilioDraft.authToken}
                    onChange={e => setTwilioDraft(prev => ({ ...prev, authToken: e.target.value }))}
                    placeholder="Auth Token"
                    style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)" }}
                  />
                  <input
                    value={twilioDraft.phoneNumber}
                    onChange={e => setTwilioDraft(prev => ({ ...prev, phoneNumber: e.target.value }))}
                    placeholder="+1 555 123 4567"
                    style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                  />
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={async () => {
                    setTestStatus("testing");
                    setTestStatusMessage("");
                    try {
                      await invoke("configure_twilio", {
                        agentId: optimisticId,
                        accountSid: twilioDraft.accountSid,
                        authToken: twilioDraft.authToken,
                        phoneNumber: twilioDraft.phoneNumber,
                      });
                      await runConnectionPreflight("twilio");
                    } catch (e) {
                      console.error("Failed to configure Twilio:", e);
                      setTestStatus("error");
                      setTestStatusMessage("Twilio setup failed. Check the SID, token, and phone number.");
                    }
                  }} style={{ padding: "12px 18px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Save and Verify Twilio
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] !== "slack" && enabledPlugins[testPluginIndex] !== "imessage" && enabledPlugins[testPluginIndex] !== "folders" && enabledPlugins[testPluginIndex] !== "email" && enabledPlugins[testPluginIndex] !== "calendar" && enabledPlugins[testPluginIndex] !== "photos" && enabledPlugins[testPluginIndex] !== "github" && enabledPlugins[testPluginIndex] !== "telegram" && enabledPlugins[testPluginIndex] !== "discord" && enabledPlugins[testPluginIndex] !== "twilio" && (
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
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 8, fontWeight: 400 }}>{testStatusMessage || "Make sure the required credentials are valid and setup is complete."}</div>
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
                {!slackWorkspaceMsg && testStatusMessage && (
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 8, fontWeight: 400 }}>{testStatusMessage}</div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => {
              if (testPluginIndex > 0) {
                setTestPluginIndex(testPluginIndex - 1);
                setTestStatus("idle");
                setTestStatusMessage("");
              } else {
                setStep(4);
                setTestStatus("idle");
                setTestStatusMessage("");
              }
            }} style={{
              padding: "12px 24px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.1)",
              background: "transparent", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit"
            }}>
              Back
            </button>
            <button onClick={() => {
              if (testStatus === "success" || testStatus === "error") {
                if (testPluginIndex < enabledPlugins.length - 1) {
                  setTestPluginIndex(testPluginIndex + 1);
                  setTestStatus("idle");
                  setTestStatusMessage("");
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
                      position: "absolute", bottom: 10, width: 56, height: 14,
                      borderRadius: "50%",
                      background: `radial-gradient(ellipse at center, ${shellColor}30 0%, transparent 70%)`,
                    }} />
                    {role?.image ? (
                      <img src={getAssetUrl(role.image)} alt={selectedRole || 'Agent'} style={{ width: 100, height: 100, objectFit: "cover", zIndex: 1, borderRadius: 12 }} />
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

          {(selectedHeartbeatTasks.length > 0 || lockedHeartbeatSuggestions.length > 0) && (
            <div style={{
              background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.15)",
              borderRadius: 12, padding: "16px 18px", marginBottom: 24, maxWidth: 460, margin: "0 auto 24px", textAlign: "left",
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
                Starting routines
              </div>
              {selectedHeartbeatTasks.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {selectedHeartbeatTasks.slice(0, 3).map(task => (
                    <div key={task.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, color: "var(--text-sub)" }}>
                      <span style={{ color: "var(--text-main)", fontWeight: 600 }}>{task.title}</span>
                      <span>{task.scheduleLabel}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5, marginTop: 4 }}>
                    These routines can evolve later as {agentName || "your agent"} learns your workflow.
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
                  {agentName || "Your agent"} will start on-demand only. Connect {formatHeartbeatRequirements(lockedHeartbeatSuggestions[0])} later to unlock the first proactive routine.
                </div>
              )}
            </div>
          )}

          {createAgentError && (
            <div style={{ marginBottom: 24, padding: "16px", background: "#FEF2F2", color: "#B91C1C", borderRadius: 8, fontSize: 14 }}>
              <strong style={{ display: "block", marginBottom: 4 }}>Creation Failed</strong>
              {createAgentError}
            </div>
          )}

          {/* No-key notice — agent was created key-free (spec Part 1B Layer 2) */}
          {!apiKey.trim() && (
            <div style={{
              display: "flex", gap: 12, alignItems: "center",
              background: "rgba(212,160,74,0.08)", border: "1px solid rgba(212,160,74,0.25)",
              borderRadius: 12, padding: "14px 18px", maxWidth: 420, margin: "0 auto 24px", textAlign: "left",
            }}>
              <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text-main)" }}>{agentName || "Your agent"} will be resting</strong> until you connect an AI model. We'll ask for your key when you send their first message.
              </div>
            </div>
          )}

          {(() => {
            // Preflight verdict: fail OPEN on null (the check itself errored —
            // don't block deploy on our own bug), fail CLOSED on a confirmed
            // bad key (rate_limited / invalid_key / model_unavailable).
            const checking = modelHealth === "checking";
            const healthBad = typeof modelHealth === "object" && modelHealth !== null && modelHealth.status !== "ok";
            const starterEligible = !plugins.slack && !!apiKey.trim() && !createAgentError && !healthBad && !checking;
            const provLabel = llmProvider || "your AI provider";
            const badCopy = healthBad ? (
              (modelHealth as any).status === "rate_limited"
                ? `Your ${provLabel} key is out of quota right now, so ${agentName || "your agent"} won't be able to respond until it resets. You can go back and pick a different provider, or deploy anyway and connect later.`
                : (modelHealth as any).status === "invalid_key"
                ? `${provLabel} rejected this key. Double-check it on the previous step before deploying.`
                : (modelHealth as any).status === "model_unavailable"
                ? `Your ${provLabel} key doesn't have access to the recommended model. Go back to pick another provider, or deploy and choose a model later.`
                : `We couldn't verify your ${provLabel} connection (${(modelHealth as any).detail || "unknown error"}).`
            ) : null;

            return (<>
              {/* Connection health verdict */}
              {checking && !isCreatingAgent && (
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 20, display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
                  <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid rgba(60,102,99,0.3)", borderTopColor: "#3c6663", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                  Checking your {provLabel} connection…
                </div>
              )}
              {healthBad && !isCreatingAgent && (
                <div style={{
                  background: "rgba(212,160,74,0.08)", border: "1px solid rgba(212,160,74,0.3)",
                  borderRadius: 14, padding: "16px 20px", maxWidth: 440, margin: "0 auto 24px", textAlign: "left",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#A4761B", marginBottom: 4 }}>
                    Heads up — {agentName || "your agent"} won't be able to think yet
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 10 }}>{badCopy}</div>
                  <button onClick={() => { setModelHealth(null); setStep(3); }} style={{
                    padding: "8px 14px", borderRadius: 10, border: "1px solid rgba(164,118,27,0.4)",
                    background: "transparent", color: "#A4761B", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                  }}>← Change provider or key</button>
                </div>
              )}

              {/* Starter task — the fastest path to seeing real work (activation A2) */}
              {starterEligible && !isCreatingAgent && (
                <div style={{
                  background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.15)",
                  borderRadius: 14, padding: "16px 20px", maxWidth: 440, margin: "0 auto 24px", textAlign: "left",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#3c6663", marginBottom: 4, letterSpacing: "0.02em" }}>
                    {agentName || "Your agent"}'s first task
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5 }}>
                    Deploy and watch {agentName || "them"} get straight to work on {getStarterTask(selectedRole).teaser} — done in about a minute.
                  </div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
                <button
                  onClick={() => {
                    if (checking) return;
                    // Workstream B: weave the user's own discovery words into the
                    // starter task so the first deliverable is domain-specific.
                    const deployOpts = starterEligible
                      ? { starterTask: composeStarterPrompt(getStarterTask(selectedRole).prompt, discoveryInput, draftConnections) }
                      : undefined;
                    // Workstream A: Deploy always has a working exit. If the
                    // background engine job hasn't finished, hold the intent and
                    // show live status instead of letting deploy fail cryptically.
                    if (getDeployGate(engineStatusLive) !== "proceed") {
                      pendingDeployRef.current = deployOpts || {};
                      setShowEngineGateModal(true);
                      fireActivationEvent("deploy_blocked_on_engine", { stage: engineStatusLive.stage });
                      return;
                    }
                    handleCreateAgent(deployOpts);
                  }}
                  disabled={isCreatingAgent || checking}
                  style={{
                    padding: "16px 40px", borderRadius: 16, border: "none",
                    background: createAgentError ? "#E53E3E" : "linear-gradient(135deg, #3c6663, #609995)",
                    color: "var(--surface-card)", fontSize: 16, fontWeight: 600, cursor: (isCreatingAgent || checking) ? "not-allowed" : "pointer",
                    boxShadow: "0 8px 40px rgba(48,51,48,0.08)",
                    transition: "all 0.3s ease",
                    opacity: (isCreatingAgent || checking) ? 0.7 : 1,
                    display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 12
                  }}>
                  {isCreatingAgent && <span style={{ display: "inline-block", width: 16, height: 16, border: "3px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 1s linear infinite" }} />}
                  {isCreatingAgent ? "Deploying Agent..." : (createAgentError ? "Retry Deployment"
                    : checking ? "Checking connection…"
                    : (plugins.slack ? "Deploy & Pair Slack"
                    : (starterEligible ? `Deploy & Watch ${agentName || "Them"} Work` : "Deploy & Go to Dashboard")))}
                </button>
                {starterEligible && !isCreatingAgent && (
                  <button
                    onClick={() => {
                      if (getDeployGate(engineStatusLive) !== "proceed") {
                        pendingDeployRef.current = {};
                        setShowEngineGateModal(true);
                        fireActivationEvent("deploy_blocked_on_engine", { stage: engineStatusLive.stage });
                        return;
                      }
                      handleCreateAgent();
                    }}
                    style={{
                      padding: "8px 16px", borderRadius: 10, border: "none", background: "transparent",
                      color: "var(--text-sub)", fontSize: 13, fontWeight: 600, cursor: "pointer",
                      textDecoration: "underline", textUnderlineOffset: 3, fontFamily: "inherit",
                    }}
                  >Skip the first task — just go to dashboard</button>
                )}
              </div>
            </>);
          })()}
          
          {isCreatingAgent && (
            <div style={{ marginTop: 16, fontSize: 13, color: "var(--text-sub)", textAlign: "center", maxWidth: 300, margin: "16px auto 0" }}>
              Creating secure workspace and applying personality. This may take up to a minute, please don't close this window...
            </div>
          )}
        </div>
      )}

      {/* Step 7: Slack Pairing */}
      {step === 7 && (
        <div style={{ textAlign: "center", maxWidth: 560 }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
            Where should {agentName || "your agent"} reach you?
          </h1>
          <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 28 }}>
            {agentName || "Your agent"} will send your morning brief, finished work, and anything that needs your approval here — so things keep moving even when this app is closed.
          </p>

          {/* Channel cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24, textAlign: "left" }}>
            {([
              { key: "mobile" as const, title: "Canopy mobile app", desc: "Richest experience — approvals, deliverables, and briefs on your phone. Scan a QR to pair.", cta: "Pair my phone" },
              { key: "telegram" as const, title: "Telegram", desc: `Get messages from ${agentName || "your agent"} in a chat you already use. Quick bot setup.`, cta: "Connect Telegram" },
              { key: "slack" as const, title: "Slack", desc: "Best for teams — your agent joins your workspace as a bot.", cta: "Pair Slack" },
            ]).map(channel => (
              <div
                key={channel.key}
                style={{
                  padding: "16px 18px", borderRadius: 16,
                  border: channelChoice === channel.key ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                  background: "var(--surface-card)",
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 3 }}>{channel.title}</div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.5 }}>{channel.desc}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setChannelChoice(channel.key);
                    fireActivationEvent("onboarding_channel_selected", { channel: channel.key });
                    if (channel.key === "mobile") {
                      setShowMobilePairing(true);
                    } else if (channel.key === "telegram") {
                      handleSetupIntegration("telegram");
                    }
                    // slack: reveals the pairing-code input below
                  }}
                  style={{
                    padding: "10px 16px", borderRadius: 12, border: "1px solid rgba(60,102,99,0.25)",
                    background: channelChoice === channel.key ? "linear-gradient(135deg, #3c6663, #609995)" : "rgba(60,102,99,0.06)",
                    color: channelChoice === channel.key ? "var(--surface-card)" : "#3c6663",
                    fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit",
                  }}
                >
                  {channel.cta}
                </button>
              </div>
            ))}
          </div>

          {/* Slack pairing-code flow (unchanged behavior, revealed on selection) */}
          {channelChoice === "slack" && (
            <div style={{ marginBottom: 24, textAlign: "left", padding: 16, borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)", background: "rgba(255,255,255,0.6)" }}>
              <p style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 12, lineHeight: 1.5 }}>
                Send a direct message to your new bot in Slack. It will reply with a pairing code — enter it below to establish a secure link.
              </p>
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
              {pairingError && (
                <div style={{ marginTop: 12, padding: "12px", background: "#FEF2F2", color: "#B91C1C", borderRadius: 8, fontSize: 14 }}>
                  {pairingError}
                </div>
              )}
              <button
                disabled={isPairing || !pairingCode.trim()}
                onClick={async () => {
                  setIsPairing(true);
                  setPairingError("");
                  try {
                    await invoke("approve_slack_pairing", { code: pairingCode.trim(), agentId: deployedAgentId });
                    fireActivationEvent("channel_connected", { type: "slack" });
                    resetWizardState();
                    setActiveView("canopy");
                  } catch (e) {
                    setPairingError(String(e));
                  } finally {
                    setIsPairing(false);
                  }
                }}
                style={{
                  marginTop: 14, width: "100%", padding: "14px 24px", borderRadius: 14, border: "none",
                  background: "linear-gradient(135deg, #3c6663, #609995)",
                  color: "var(--surface-card)", fontSize: 15, fontWeight: 700,
                  cursor: isPairing || !pairingCode.trim() ? "default" : "pointer",
                  opacity: isPairing || !pairingCode.trim() ? 0.6 : 1, fontFamily: "inherit",
                }}
              >
                {isPairing ? "Pairing..." : "Confirm Pairing"}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "center" }}>
            <button
              onClick={() => {
                if (!channelChoice) fireActivationEvent("onboarding_channel_skipped");
                resetWizardState();
                setActiveView("canopy");
              }}
              style={{ padding: "16px 24px", borderRadius: 16, background: channelChoice && channelChoice !== "slack" ? "linear-gradient(135deg, #3c6663, #609995)" : "transparent", color: channelChoice && channelChoice !== "slack" ? "var(--surface-card)" : "var(--text-sub)", border: "none", fontSize: 16, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
            >
              {channelChoice && channelChoice !== "slack" ? "Finish & Go to Dashboard" : "Skip for now"}
            </button>
          </div>
          {!channelChoice && (
            <p style={{ fontSize: 12, color: "var(--text-sub)", opacity: 0.7, marginTop: 10 }}>
              You can connect later — {agentName || "your agent"} will remind you when there's something worth sending.
            </p>
          )}

          <MobilePairingModal
            isOpen={showMobilePairing}
            onClose={() => setShowMobilePairing(false)}
            defaultAgentId={deployedAgentId || undefined}
            initialView="pair-device"
          />
        </div>
      )}

      {/* ── Workstream A: ambient engine chip (steps 0–5, first-run only) ── */}
      {!hasCompletedInitialSetup && step >= 0 && step < 6 && isEngineInFlight(engineStatusLive) && (
        <div style={{
          position: "fixed", bottom: 18, right: 18, zIndex: 9000,
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px", borderRadius: 999,
          background: "rgba(60,102,99,0.92)", color: "#F0FDF4",
          fontSize: 12, fontWeight: 700, boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
        }}>
          <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid rgba(240,253,244,0.35)", borderTopColor: "#F0FDF4", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
          {describeEngineStage(engineStatusLive)}
        </div>
      )}

      {/* ── Workstream A: Deploy gate modal — the four exits, never a dead end ── */}
      {showEngineGateModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)", zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--surface-base)", padding: 32, borderRadius: 20, width: 440, boxShadow: "0 20px 40px rgba(0,0,0,0.2)", textAlign: "center" }}>
            {getDeployGate(engineStatusLive) === "wait" ? (
              <>
                <div style={{ margin: "0 auto 16px", width: 42, height: 42, border: "4px solid rgba(60,102,99,0.2)", borderTopColor: "#3c6663", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
                  Almost ready — preparing the habitat
                </div>
                <div style={{ fontSize: 14, color: "var(--text-sub)", lineHeight: 1.6, marginBottom: 6 }}>
                  {engineStatusLive.detail}{engineStatusLive.progress != null ? ` (${engineStatusLive.progress}%)` : ""}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", opacity: 0.75, marginBottom: 20 }}>
                  {agentName || "Your agent"} will deploy automatically the moment this finishes. Your setup is saved either way.
                </div>
                <button
                  onClick={() => { setShowEngineGateModal(false); }}
                  style={{ padding: "12px 24px", borderRadius: 12, border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-main)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                >
                  I'll wait on the summary screen
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 30, marginBottom: 10 }}>🛟</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
                  Engine setup needs a retry
                </div>
                <div style={{ fontSize: 14, color: "var(--text-sub)", lineHeight: 1.6, marginBottom: 20 }}>
                  {engineStatusLive.detail}
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button
                    onClick={() => {
                      startEngineProvisioning();
                      fireActivationEvent("engine_install_retry_clicked");
                    }}
                    style={{ padding: "12px 24px", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #3c6663, #609995)", color: "var(--surface-card)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Retry setup
                  </button>
                  <button
                    onClick={() => {
                      // Draft persists via canopy_onboarding_draft autosave; the
                      // auto-continue effect deploys when the engine turns ready.
                      setShowEngineGateModal(false);
                    }}
                    style={{ padding: "12px 20px", borderRadius: 12, border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-main)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Save my setup for later
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes revealIn { from { opacity: 0; transform: translateY(14px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
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
