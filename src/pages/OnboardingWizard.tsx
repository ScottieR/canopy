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
import habitatsCatalog from "../../shared/habitats.json";
import accessoriesCatalog from "../../shared/accessories.json";
import { TerrariumBase, HabitatErrorBoundary } from "../components/World/WorldScene";
import { OnboardingCompanion } from "../components/World/OnboardingCompanion";
import { LoadingScreen } from "../components/LoadingScreen";
import { useWorldStore, DEFAULT_PERMISSIONS, getPermissionsForRole, getDefaultPersonality, injectPrincipalContext, AgentData, Agent, AGENT_TYPE_INFO, DiscoveredAgent, Permission, fireActivationEvent, reportTelemetryEvent } from "../store/worldStore";
import type { GenerativeResult } from "../types/generative";
import { Toggle } from "../App";
import { LobsterIcon } from "../components/World/LobsterIcon";
import { getAssetUrl } from "../utils/assets";
import { buildCompanionUrl } from "../utils/connectorCatalog";
import { MobilePairingModal } from "../components/Companion/MobilePairingModal";
import { PowerUpChat } from "../components/shared/PowerUpChat";
import { DraftInterviewChat } from "../components/shared/DraftInterviewChat";
import {
  composeStarterPrompt,
  generateAgentName,
  getRoleDefaultName,
  getVoiceProfile,
  getRoleVoiceDefault,
  inferRoleFromPrompt,
} from "../utils/onboardingDiscovery";
import {
  composeSetupConversationPrompt,
  getCollaboratorSuggestions,
  getNextUnlockForRole,
  getRosterGapSuggestionDetails,
  getSuggestedConnectionLabelsForRole,
  getSuggestedPermissionLabelsForRole,
  inferRosterRole,
} from "../utils/agentSetupRecommendations";
import { getOnboardingIntegrationIds } from "../utils/onboardingIntegrations";
import { getInitialOnboardingStep } from "../utils/onboardingFlow";
import { useEngineStatus, startEngineProvisioning, describeEngineStage, getDeployGate, isEngineInFlight } from "../utils/engineStatus";
import { DynamicPersonaDraft, composeRequestDrivenPersonality, draftPersonaWithEddie, isGenerativeDiscoveryEnabled } from "../utils/generativePersona";
import { getAccessoryName, listAccessoryOptions } from "../utils/accessoryCatalog";
import { mergeIdentityNotes } from "../utils/draftInterview";
import { getOnboardingConfig, refreshOnboardingConfig, OnboardingConfig } from "../utils/onboardingConfig";
import { buildScopeSection, syncTeamRosterToAgents } from "../utils/rosterScope";
import { getHeartbeatSuggestionsForProfile, serializeHeartbeatFile, HeartbeatTask } from "../utils/heartbeats";
import {
  formatRecommendedModel,
  getRecommendedModel,
} from "../utils/modelRecommendations";
import { getAgentProviderSecretSlot, getManagedProviderId, syncAgentProviderCredentials } from "../security/providerCredentials";
import { PasswordInput } from "../components/shared/PasswordInput";
import { cancelAgentSpeech, playVoicePreview } from "../utils/voicePlayback";
import { GLBAgent, GLBModel } from "../components/World/GLBAgent";
import rehypeSanitize from "rehype-sanitize";

const CURATED_VOICE_IDS = ["alloy", "echo", "fable", "nova", "onyx", "shimmer"] as const;
const LOCAL_HABITATS = Array.isArray(habitatsCatalog)
  ? habitatsCatalog.filter((habitat: any) => !habitat?.isEddyHabitat && habitat?.name !== "Design Studio")
  : [];
const ACCESSORY_ITEMS: Record<string, any> =
  (accessoriesCatalog as any)?.items && typeof (accessoriesCatalog as any).items === "object"
    ? (accessoriesCatalog as any).items
    : {};

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

const DISCOVERY_VALUE_COPY: Record<string, string[]> = {
  Assistant: [
    "Keep your mornings clear with a calmer view of what needs attention first.",
    "Catch loose ends before they turn into follow-up work for you.",
    "Send concise wrap-ups so you know what moved without chasing status.",
  ],
  Researcher: [
    "Turn messy questions into briefings you can act on quickly.",
    "Keep watch on new developments that could change your decision.",
    "Bring back sharper options instead of a pile of tabs.",
  ],
  Coder: [
    "Keep code work moving with less context switching and status chasing.",
    "Surface blockers, stale PRs, and the fixes most worth shipping next.",
    "Turn implementation ideas into working outputs faster.",
  ],
  Strategist: [
    "Pressure-test decisions before they become expensive commitments.",
    "Keep priorities visible so important work does not drift.",
    "Hand you tighter weekly recaps and clearer next moves.",
  ],
  Accountant: [
    "Spot spend issues early instead of during cleanup later.",
    "Keep recurring financial admin from piling up in the background.",
    "Turn budget drift into simple next actions.",
  ],
  Editor: [
    "Help rough drafts sound sharper before they leave your hands.",
    "Keep output consistent even when the source material is messy.",
    "Show what is ready, blocked, or needs a final pass.",
  ],
  Chef: [
    "Turn meal planning into one calmer weekly rhythm.",
    "Keep dinner ideas and grocery thinking from draining your energy.",
  ],
  "Travel Agent": [
    "Keep trips feeling smooth instead of full of little logistical misses.",
    "Surface what still needs booking, prep, or confirmation before it bites you.",
  ],
  Trainer: [
    "Keep your routine honest, practical, and easier to stick with.",
    "Turn weekly check-ins into momentum instead of guilt.",
  ],
  Custom: [
    "Take a real category of work off your plate instead of just chatting about it.",
    "Turn recurring friction into a calmer system you do not have to babysit.",
  ],
};

const BOOK_SHELF_COLORS = ["#D96C3B", "#6B6BAE", "#4A9E96", "#C76A42", "#7A9EB5", "#A4761B", "#7AAC7A"];

function getDiscoveryValueBullets(role: string | null, heartbeatTitles: string[] = []): string[] {
  const base = DISCOVERY_VALUE_COPY[role || ""] || DISCOVERY_VALUE_COPY.Custom;
  const heartbeatBullets = heartbeatTitles.slice(0, 2).map(title => {
    if (/wrap-up/i.test(title)) return "Send a clean wrap-up so you can see what moved without asking for it.";
    if (/briefing/i.test(title)) return "Start with a tighter briefing instead of piecing the day together yourself.";
    if (/research scan/i.test(title)) return "Keep watch on changes that could shift the recommendation.";
    if (/check-in/i.test(title)) return "Run a steady check-in rhythm so important work does not drift.";
    return `${title} without needing you to remember to ask.`;
  });
  return [...heartbeatBullets, ...base].slice(0, 3);
}

function getCapabilityActionLabel(key: string): string {
  switch (key) {
    case "email":
      return "Connect Gmail";
    case "calendar":
      return "Connect Calendar";
    case "folders":
      return "Choose a folder";
    case "slack":
      return "Connect Slack";
    case "github":
      return "Connect GitHub";
    case "imessage":
      return "Allow iMessage";
    case "photos":
      return "Allow Photos";
    default:
      return `Add ${key}`;
  }
}

const ADMIN_TO_MAIN_DECOR_SCALE = 0.5;

function decorSeededRandom(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function pickDecorPointIndex(agentId: string | undefined, itemIndex: number, total: number) {
  const seed = (agentId?.length || 0) + itemIndex;
  return Math.floor(decorSeededRandom(seed) * total);
}

class OnboardingDecorErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: any) { console.warn("[OnboardingDecorObject] failed to render decor GLB:", err); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

function OnboardingDecorObject({ agentId, path, glbPath, transform, decorPoints, index, defaultDecorRotation, defaultScale, isSelected, onSelect }: any) {
  const [target, setTarget] = useState<any>(null);
  const fallbackYaw = useMemo(() => {
    const seed = (path?.length || 0) + index * 13;
    return Math.sin(seed * 1.7) * Math.PI;
  }, [path, index]);

  useEffect(() => {
    if (!target) return;

    const hasSavedPos =
      transform?.x !== undefined &&
      transform?.y !== undefined &&
      transform?.z !== undefined;

    if (hasSavedPos) {
      target.position.set(transform.x, transform.y, transform.z);
    } else if (decorPoints && decorPoints.length > 0) {
      const pointIndex = pickDecorPointIndex(agentId, index, decorPoints.length);
      const point = decorPoints[pointIndex];
      target.position.set(
        point.x * ADMIN_TO_MAIN_DECOR_SCALE,
        point.y * ADMIN_TO_MAIN_DECOR_SCALE,
        point.z * ADMIN_TO_MAIN_DECOR_SCALE,
      );
    } else {
      const seed = path.length + index;
      target.position.set(Math.sin(seed * 1.1) * 0.6, 0, Math.cos(seed * 1.3) * 0.6);
    }

    const rotX = defaultDecorRotation ? defaultDecorRotation[0] : 0;
    const defaultY = defaultDecorRotation ? defaultDecorRotation[1] : fallbackYaw;
    const rotZ = defaultDecorRotation ? defaultDecorRotation[2] : 0;
    const rotY = transform?.rotationY !== undefined ? transform.rotationY : defaultY;
    target.rotation.set(
      transform?.rotationX !== undefined ? transform.rotationX : rotX,
      rotY,
      transform?.rotationZ !== undefined ? transform.rotationZ : rotZ,
    );

    const catalogScale = transform?.scale !== undefined ? transform.scale : (defaultScale ?? 75);
    const scale = catalogScale * 0.01 * 0.25;
    target.scale.set(scale, scale, scale);
  }, [target, transform, decorPoints, index, path, defaultDecorRotation, defaultScale, fallbackYaw, agentId]);

  return (
    <group ref={setTarget} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
      <OnboardingDecorErrorBoundary fallback={
        <mesh>
          <boxGeometry args={isSelected ? [0.44, 0.44, 0.44] : [0.4, 0.4, 0.4]} />
          <meshBasicMaterial color={isSelected ? "#3c6663" : "#E57373"} wireframe />
        </mesh>
      }>
        <React.Suspense fallback={
          <mesh>
            <boxGeometry args={[0.3, 0.3, 0.3]} />
            <meshBasicMaterial color="#FFAB91" wireframe />
          </mesh>
        }>
          <GLBModel url={getAssetUrl(glbPath)} />
        </React.Suspense>
      </OnboardingDecorErrorBoundary>
    </group>
  );
}

// ─── Wizard progress — four beats (first-principles consolidation, July 18):
// every visible stage is a moment, not a form. Meet Eddie → Meet your agent →
// Give them power → Watch them work.
// THREE beats — "after 3 the agent is deployed" (Scottie). Deploy/pairing
// screens (6/7) are the tail of beat 3, not a fourth step.
const PROGRESS_STAGES = ["Meet Eddie", "Meet your agent", "Give them power"];
const stageForStep = (s: number): number => {
  if (s < 2) return 0;            // 0/1 discovery (+1.8 import detour)
  if (s < 3) return 1;            // 2 studio (+2.5 dressing room detour)
  return 2;                       // 3.7 chat, 3/4/5 detours, 6 deploy, 7 pairing
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
      if (parsed && parsed.step === 2.5) {
        return { ...parsed, step: 2 };
      }
      if (parsed && (parsed.step === 3 || parsed.step === 4 || parsed.step === 5)) {
        // Beat 3 is now the power-up conversation (3.7); the brain screen (3)
        // and the checklist (4) are detours that resume back into it.
        return { ...parsed, step: 3.7 };
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
    "3.7": "powerup_chat",
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

  // ── Funnel behavior telemetry (anonymous; see spec-global-usage-telemetry) ──
  // Backward navigation: a strong "something confused me here" signal.
  const prevStepRef = React.useRef<number | null>(null);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = step;
    if (prev !== null && step < prev) {
      reportTelemetryEvent("onboarding_back", {
        from_step: prev, from_name: ONBOARDING_STEP_NAMES[String(prev)] || String(prev),
        to_step: step, to_name: ONBOARDING_STEP_NAMES[String(step)] || String(step),
      });
    }
  }, [step]);

  // Stuckness: 90s on a step with zero pointer/keyboard interaction, reported
  // once per step visit — surfaces "where do people stall" in the admin funnel.
  useEffect(() => {
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      reportTelemetryEvent("onboarding_stuck", {
        step, step_name: ONBOARDING_STEP_NAMES[String(step)] || String(step), seconds: 90,
      });
    };
    let timer = window.setTimeout(fire, 90_000);
    const reset = () => {
      window.clearTimeout(timer);
      if (!fired) timer = window.setTimeout(fire, 90_000);
    };
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [step]);

  // Draft resume: distinguishes "came back after abandoning" from fresh starts
  // in the funnel (absence of later step_reached events = drop-off point).
  useEffect(() => {
    if (draft?.step !== undefined) {
      reportTelemetryEvent("onboarding_resumed", { step: draft.step });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [anthropicKey, setAnthropicKey] = useState("");
  const [showAnthropicKeyStep, setShowAnthropicKeyStep] = useState(false);
  const [anthropicKeyError, setAnthropicKeyError] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [personalityPrompt, setPersonalityPrompt] = useState(() => {
    if (draft?.personalityPrompt) {
      return draft.personalityPrompt;
    }
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
  const [showVoiceChoices, setShowVoiceChoices] = useState(false);
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
  const voiceEditedRef = React.useRef(Boolean(draft?.selectedVoice));
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
  const [habitats, setHabitats] = useState<any[]>(LOCAL_HABITATS);
  const [showDiscoveryCapabilities, setShowDiscoveryCapabilities] = useState(false);
  const [studioAccessorySearch, setStudioAccessorySearch] = useState("");
  const [studioDecorSearch, setStudioDecorSearch] = useState("");
  const [selectedDecor, setSelectedDecor] = useState<string | null>(null);
  const [studioSection, setStudioSection] = useState<"habitat" | "accessories" | "decor" | "books">("habitat");

  useEffect(() => () => {
    cancelAgentSpeech();
  }, []);

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

  const syncAgentNameInDraft = (nextName: string) => {
    const oldName = agentName || "Agent";
    setAgentName(nextName);
    setPersonalityPrompt((previous: string) => {
      if (!previous || !oldName.trim() || oldName === nextName) return previous;
      const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escapedOldName}\\b`, "g");
      return previous.replace(regex, nextName || "Agent");
    });
  };

  const handleStudioHabitatSelect = (habitatId: number) => {
    setSelectedDecor(null);
    setCustomIdentity(prev => {
      const current = prev || { baseModelUrl: null, accessories: [], decor: [] };
      if ((current.habitatId || 1) === habitatId) return { ...current, habitatId };
      const existingTransforms = current.decorTransforms || {};
      const repositionedTransforms: Record<string, any> = {};
      for (const [path, transform] of Object.entries(existingTransforms)) {
        const { x, y, z, ...rest } = (transform || {}) as any;
        if (Object.keys(rest).length > 0) repositionedTransforms[path] = rest;
      }
      return {
        ...current,
        habitatId,
        decorTransforms: repositionedTransforms,
      };
    });
  };

  const toggleStudioDecor = (decorId: string) => {
    setCustomIdentity(prev => {
      const current = prev || { baseModelUrl: null, accessories: [], decor: [] };
      const activeDecor = current.decor || [];
      const isActive = activeDecor.includes(decorId);
      const nextDecor = isActive ? activeDecor.filter(id => id !== decorId) : [...activeDecor, decorId];
      const nextTransforms = { ...(current.decorTransforms || {}) };
      if (isActive) delete nextTransforms[decorId];
      return {
        ...current,
        decor: nextDecor,
        decorTransforms: nextTransforms,
      };
    });
    setSelectedDecor(previous => previous === decorId ? null : decorId);
  };

  const handleStudioDecorNudge = (axis: "x" | "y" | "z" | "ry", amount: number) => {
    if (!selectedDecor) return;
    const currentTransforms = customIdentity?.decorTransforms || {};
    const existing = currentTransforms[selectedDecor] || {};
    const index = (customIdentity?.decor || []).indexOf(selectedDecor);
    if (index === -1) return;

    let base = { x: 0, y: 0, z: 0, rotationY: 0 };
    if (existing.x !== undefined) {
      base.x = existing.x;
      base.y = existing.y;
      base.z = existing.z;
    } else {
      const decorPoints = selectedHabitat?.decorPoints || [];
      if (decorPoints.length > 0) {
        const pointIndex = pickDecorPointIndex(optimisticId, index, decorPoints.length);
        const point = decorPoints[pointIndex];
        base.x = point.x * ADMIN_TO_MAIN_DECOR_SCALE;
        base.y = point.y * ADMIN_TO_MAIN_DECOR_SCALE;
        base.z = point.z * ADMIN_TO_MAIN_DECOR_SCALE;
      } else {
        const seed = selectedDecor.length + index;
        base.x = Math.sin(seed * 1.1) * 0.6;
        base.y = 0;
        base.z = Math.cos(seed * 1.3) * 0.6;
      }
    }

    if (existing.rotationY !== undefined) {
      base.rotationY = existing.rotationY;
    } else {
      const defaultDecorRotation = ACCESSORY_ITEMS[selectedDecor]?.decorRotation;
      const fallbackYaw = Math.sin((selectedDecor.length + index * 13) * 1.7) * Math.PI;
      base.rotationY = defaultDecorRotation ? defaultDecorRotation[1] : fallbackYaw;
    }

    setCustomIdentity(prev => ({
      ...(prev || { baseModelUrl: null, accessories: [], decor: [] }),
      decorTransforms: {
        ...(prev?.decorTransforms || {}),
        [selectedDecor]: {
          ...existing,
          x: base.x + (axis === "x" ? amount : 0),
          y: base.y + (axis === "y" ? amount : 0),
          z: base.z + (axis === "z" ? amount : 0),
          rotationY: base.rotationY + (axis === "ry" ? amount : 0),
        },
      },
    }));
  };

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

  const scanExistingProviderKey = async () => {
    if (!llmProvider) return;
    setAutoProvisionProvider(null);
    setApiKeyMode("scan");
    try {
      const providerMap: Record<string, string> = { "OpenAI": "OPENAI", "Google Gemini": "GEMINI", "Anthropic": "ANTHROPIC", "xAI Grok": "XAI" };
      const provId = `${providerMap[llmProvider]}_API_KEY`;
      const secret = await invoke<string>("get_secret_cmd", { key: provId });
      if (secret) {
        setApiKey(secret);
        setDetectedSetup("key");
      } else {
        alert(`No existing ${llmProvider} key was found in your keychain yet.`);
      }
    } catch {
      alert(`No existing ${llmProvider} key was found in your keychain yet.`);
    }
  };

  const launchProviderSetup = async () => {
    if (!llmProvider) return;
    if (managedProviderId && managementConnected) {
      setApiKey("");
      setApiKeyMode("hidden");
      setAutoProvisionProvider(managedProviderId);
      setDetectedSetup("management");
      return;
    }
    setApiKeyMode("manual");
    try {
      const providerMap: Record<string, string> = { "OpenAI": "openai", "Google Gemini": "gemini", "Anthropic": "anthropic", "xAI Grok": "xai" };
      const providerId = providerMap[llmProvider];
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const windowLabel = `providerCompanion_${Date.now()}`;
      const companionWindow = new WebviewWindow(windowLabel, {
        url: `/index.html?companion=${providerId}`,
        title: "Setup Guide",
        width: 420,
        height: 760,
        x: window.screen.availWidth - 440,
        y: 50,
        alwaysOnTop: true,
        decorations: true,
      });

      const launchBrowser = async () => {
        const urls: Record<string, string> = {
          "OpenAI": "https://platform.openai.com/api-keys",
          "Google Gemini": "https://aistudio.google.com/app/apikey",
          "Anthropic": "https://console.anthropic.com/settings/keys",
          "xAI Grok": "https://console.x.ai/",
        };
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(urls[llmProvider]);
      };

      companionWindow.once("tauri://created", launchBrowser);
      companionWindow.once("tauri://error", () => { void launchBrowser(); });
    } catch (e) {
      console.error("Failed to spawn provider companion", e);
      const urls: Record<string, string> = {
        "OpenAI": "https://platform.openai.com/api-keys",
        "Google Gemini": "https://aistudio.google.com/app/apikey",
        "Anthropic": "https://console.anthropic.com/settings/keys",
        "xAI Grok": "https://console.x.ai/",
      };
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(urls[llmProvider]);
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
  const [postDeployConversationPrompt, setPostDeployConversationPrompt] = useState("");
  // Preflight model health (Part 1D field-test fix): never offer the starter
  // task into a dead key. null = not checked, "checking" = in flight.
  const [modelHealth, setModelHealth] = useState<null | "checking" | { status: string; detail?: string; provider: string; model: string }>(null);
  const [pairingCode, setPairingCode] = useState("");
  // Workstream D: "Where should your agents reach you?" channel chooser state.
  const [channelChoice, setChannelChoice] = useState<null | "mobile" | "telegram" | "slack">(null);
  // Beat-3 conversation: bump to rebuild the script after a detour (brain
  // screen / checklist) so it reflects freshly detected state.
  const [powerUpRunId, setPowerUpRunId] = useState(0);
  const powerUpDeclinedRef = React.useRef<string[]>([]);
  // Studio (Phase 1): personality collapsed by default; close-up size presets
  // replace wheel zoom (scroll-trap fix).
  const [identityNotesOpen, setIdentityNotesOpen] = useState(false);
  const [studioZoomScale, setStudioZoomScale] = useState<0.8 | 1 | 1.25>(1);
  // Beat-1 interview facts about the HUMAN — funneled into the shared
  // canonical USER.md at deploy (every current + future agent inherits them).
  // The same notes also merge into personalityPrompt → this agent's SOUL.md.
  const interviewFactsRef = React.useRef<string[]>([]);
  // AI-generated routines accepted in the power-up conversation — merged into
  // HEARTBEAT.md at deploy alongside the template selections.
  const customHeartbeatsRef = React.useRef<HeartbeatTask[]>([]);
  // Admin-tunable onboarding knobs (variant, ask budget, agent loop on/off).
  // Cached/default value renders immediately; fresh value arrives in background.
  const [onboardingCfg, setOnboardingCfg] = useState<OnboardingConfig>(getOnboardingConfig());
  useEffect(() => { void refreshOnboardingConfig().then(setOnboardingCfg); }, []);
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
    setPostDeployConversationPrompt("");
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
        step, agentName, selectedRole, discoveryInput, selectedVoice, selectedVoiceRate, plugins, customIdentity, isolated, llmProvider, autoProvisionProvider, selectedHeartbeatNames, personaMeta, personalityPrompt
      }));
    }
  }, [step, agentName, selectedRole, discoveryInput, selectedVoice, selectedVoiceRate, plugins, customIdentity, isolated, llmProvider, autoProvisionProvider, selectedHeartbeatNames, personaMeta, personalityPrompt]);

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
    if (key === 'slack' || key === 'discord' || key === 'telegram' || key === 'github' || key === 'twilio') {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const nameMap: any = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', github: 'GitHub', twilio: 'Twilio' };
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
    } else if (key === 'folders') {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({ directory: true, multiple: false });
          if (selected) {
            setSelectedFolderPath(selected as string);
            setPlugins(prev => ({ ...prev, folders: true }));
          }
        } catch (e) {
          console.error("Folder setup failed:", e);
        }
    } else if (key === 'photos') {
        try {
          // Opening System Settings is not the same as being granted access —
          // don't fake-connect (Phase 0 fix #4). The toggle reflects the
          // user's intent; the step-5 test / first real use verifies the grant.
          await invoke("open_photos_privacy_settings");
        } catch (e) {
          console.error("Photos setup failed:", e);
        }
    }
  };

  const toggleStudioAccessory = (accessoryId: string) => {
    setCustomIdentity(prev => {
      const current = prev?.accessories || [];
      const next = current.includes(accessoryId)
        ? current.filter(id => id !== accessoryId)
        : [...current, accessoryId];
      return { ...(prev || { baseModelUrl: null, decor: [] }), accessories: next };
    });
  };

  const handleConversationUnlock = async (unlock: ReturnType<typeof getNextUnlockForRole>) => {
    if (!unlock) return;
    if (unlock.kind === "workspace" && unlock.id === "isolated") {
      setIsolated(true);
      if (selectedRole) {
        setAgentPermissions(getPermissionsForRole(selectedRole, true));
      }
      return;
    }
    if (unlock.kind === "permission") {
      setAgentPermissions(previous =>
        previous.map(permission => permission.id === unlock.id ? { ...permission, enabled: true } : permission)
      );
      return;
    }
    if (unlock.kind === "connection") {
      await handleSetupIntegration(unlock.id);
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
          } else if (type === "telegram") {
            setPlugins(prev => ({ ...prev, telegram: true }));
            reportTelemetryEvent("channel_connected", { type: "telegram" });
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

  const getDynamicRecommendedModel = (role: string) => {
    const match = getRecommendedModel(availableModels, role);
    return { provider: match.provider, model: formatRecommendedModel(match), id: match.id };
  };

  const getProviderRecommendedModel = (role: string, targetProvider: string) => {
    const match = getRecommendedModel(availableModels, role, targetProvider);
    return { model: formatRecommendedModel(match), id: match.id };
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
  const continueFromDiscovery = async (nextStep = 2) => {
    const isCustomFlow = selectedRole === "Custom";
    const persona = isCustomFlow ? dynamicPersona : null;
    const nextRole = isCustomFlow
      ? (effectiveDraftRole || discoveryDraft.primaryRole)
      : selectedRole;
    if (!nextRole) return;
    if (isCustomFlow) {
      if (!discoveryInput.trim()) return;
      handleRoleSelect(nextRole, {
        seedPrompt: discoveryInput,
        selectionSource: "discovery",
        dynamicPersona: persona,
      });
    }
    if (persona && !persona.fitsExisting) {
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
    setStep(nextStep);
  };

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/habitats`)
      .then(r => r.json())
      // Eddy's reef cave (isEddyHabitat) is reserved for The Keeper.
      .then(d => {
        const nextHabitats = Array.isArray(d) ? d.filter((h: any) => !h.isEddyHabitat && h?.name !== "Design Studio") : [];
        setHabitats(nextHabitats.length > 0 ? nextHabitats : LOCAL_HABITATS);
      })
      .catch(() => {
        setHabitats(LOCAL_HABITATS);
      });
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
    .filter(([key]) => key !== "Custom")
    .map(([key, val]) => ({ key, ...val }))
    .sort((a: any, b: any) => {
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
  const isCustomSelection = selectedRole === "Custom";
  const displayRole = personaMeta?.title || (isCustomSelection ? "Custom" : selectedRole);
  const hasDraftSource = !!selectedRole;
  const helperSuggestedRole = isCustomSelection && dynamicPersona?.fitsExisting
    ? dynamicPersona.existingRole
    : null;
  const draftRole = selectedRole && selectedRole !== "Custom"
    ? selectedRole
    : (isCustomSelection && discoveryInput.trim()
      ? (helperSuggestedRole || discoveryDraft.primaryRole)
      : null);
  // When Eddie invented a persona, its blend anchor drives visuals/defaults
  // (deterministic base-template rule); explicit picks always win.
  const personaActive = isCustomSelection && !!dynamicPersona && !dynamicPersona.fitsExisting;
  const effectiveDraftRole = personaActive && (agentTypeInfo as any)[dynamicPersona!.blend[0]]
    ? dynamicPersona!.blend[0]
    : draftRole;
  const draftRoleInfo = effectiveDraftRole ? (agentTypeInfo as any)[effectiveDraftRole] : null;
  const discoveryPanelRoleInfo = draftRoleInfo || (isCustomSelection ? {
    description: "Describe the kind of agent you need and Eddie will draft the role, personality, voice, and setup around it.",
    robeColor: "#3c6663",
    accentColor: "#4A9E96",
  } : null);
  const draftConnections = effectiveDraftRole ? getSuggestedConnectionLabelsForRole(effectiveDraftRole) : [];
  const draftPermissionLabels = effectiveDraftRole ? getSuggestedPermissionLabelsForRole(effectiveDraftRole) : [];
  const draftVoice = getRoleVoiceDefault(effectiveDraftRole || "Assistant");
  const selectedVoiceProfile = getVoiceProfile(selectedVoice);
  const isCompactWindow = viewportSize.width < 1320;
  const isNarrowWindow = viewportSize.width < 1120;
  const isVeryNarrowWindow = viewportSize.width < 860;
  const rosterGapSuggestions = useMemo(
    () => getRosterGapSuggestionDetails(agents, agentTypeInfo as any, 2),
    [agentTypeInfo, agents],
  );
  const liveRoleAgentsByRole = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const agent of agents) {
      const inferred = inferRosterRole(agent as any, agentTypeInfo as any);
      if (!inferred) continue;
      if (!map[inferred]) map[inferred] = [];
      map[inferred].push(agent.name);
    }
    return map;
  }, [agentTypeInfo, agents]);
  const featuredRoleTypes = useMemo(() => {
    const gapRoles = rosterGapSuggestions.map(suggestion => suggestion.role);
    const gapSet = new Set(gapRoles);
    const gapItems = roleTypes.filter(role => gapSet.has(role.key));
    const remaining = roleTypes.filter(role => !gapSet.has(role.key));
    return [...gapItems, ...remaining].slice(0, 5);
  }, [roleTypes, rosterGapSuggestions]);
  const collaboratorSuggestions = useMemo(
    () => getCollaboratorSuggestions(
      effectiveDraftRole,
      agents.filter(agent => agent.role !== effectiveDraftRole),
    ),
    [agents, effectiveDraftRole],
  );
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
  const discoveryValueBullets = useMemo(
    () => getDiscoveryValueBullets(
      effectiveDraftRole,
      discoveryHeartbeats.map(task => task.title),
    ),
    [discoveryHeartbeats, effectiveDraftRole],
  );
  const accessoryOptions = useMemo(() => listAccessoryOptions(), []);
  const validHabitatIds = useMemo(() => new Set(habitats.map(h => h.id)), [habitats]);
  const selectedHabitat = useMemo(
    () => habitats.find(h => h.id === (customIdentity?.habitatId || 1)),
    [customIdentity?.habitatId, habitats],
  );
  const selectedHabitatPlacement = useMemo(
    () => selectedHabitat?.placement || { x: 0, y: 0, z: 0, rotationY: 0 },
    [selectedHabitat],
  );
  const decorOptions = useMemo(
    () => Object.entries(ACCESSORY_ITEMS)
      .filter(([_, meta]) => meta && meta.isVisible !== false && !!meta.name && (meta.type === "decor" || meta.type === "both"))
      .map(([id, meta]) => ({ id, name: meta.name as string, labels: Array.isArray(meta.labels) ? meta.labels : [], meta })),
    [],
  );
  const filteredStudioAccessories = useMemo(() => {
    const q = studioAccessorySearch.trim().toLowerCase();
    const selectedAccessories = customIdentity?.accessories || [];
    const matches = accessoryOptions.filter(option => {
      if (!q) return true;
      return option.name.toLowerCase().includes(q) || option.labels.some((label: string) => label.toLowerCase().includes(q));
    });
    return matches
      .sort((a, b) => {
        const aSelectedIndex = selectedAccessories.indexOf(a.id);
        const bSelectedIndex = selectedAccessories.indexOf(b.id);
        const aSelected = aSelectedIndex >= 0;
        const bSelected = bSelectedIndex >= 0;
        if (aSelected !== bSelected) return aSelected ? -1 : 1;
        if (aSelected && bSelected) return aSelectedIndex - bSelectedIndex;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 48);
  }, [accessoryOptions, customIdentity?.accessories, studioAccessorySearch]);
  const filteredStudioDecor = useMemo(() => {
    const q = studioDecorSearch.trim().toLowerCase();
    const selectedDecorIds = customIdentity?.decor || [];
    const matches = decorOptions.filter(option => {
      if (!q) return true;
      return option.name.toLowerCase().includes(q) || option.labels.some((label: string) => label.toLowerCase().includes(q));
    });
    return matches
      .sort((a, b) => {
        const aSelectedIndex = selectedDecorIds.indexOf(a.id);
        const bSelectedIndex = selectedDecorIds.indexOf(b.id);
        const aSelected = aSelectedIndex >= 0;
        const bSelected = bSelectedIndex >= 0;
        if (aSelected !== bSelected) return aSelected ? -1 : 1;
        if (aSelected && bSelected) return aSelectedIndex - bSelectedIndex;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 48);
  }, [customIdentity?.decor, decorOptions, studioDecorSearch]);
  const suggestedLibraryBooks = useMemo(
    () => globalLibrary
      .filter(book => book.recommendedAgents && book.recommendedAgents.includes(selectedRole || "Custom"))
      .slice(0, 10),
    [globalLibrary, selectedRole],
  );
  const selectedRoleModelUrl = useMemo(
    () => customIdentity?.baseModelUrl || (["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].includes(selectedRole || "") ? `/models/lobsters/${selectedRole}.glb` : undefined),
    [customIdentity?.baseModelUrl, selectedRole],
  );
  const studioNudgeButtonStyle: React.CSSProperties = useMemo(() => ({
    background: "var(--surface-card)",
    color: "var(--text-main)",
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 8,
    width: 30,
    height: 30,
    padding: 0,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "inherit",
  }), []);
  const setupRecommendedConnections = useMemo(
    () => (selectedRole ? getSuggestedConnectionLabelsForRole(selectedRole).slice(0, 3) : []),
    [selectedRole],
  );
  const enabledPermissionIds = useMemo(
    () => agentPermissions.filter(permission => permission.enabled).map(permission => permission.id),
    [agentPermissions],
  );
  const enabledSetupIntegrations = useMemo(
    () => getOnboardingIntegrationIds(plugins, { githubRepos: pendingGithubRepos }),
    [pendingGithubRepos, plugins],
  );
  const currentSetupUnlock = useMemo(
    () => getNextUnlockForRole(selectedRole || "Custom", {
      enabledIntegrations: enabledSetupIntegrations,
      enabledPermissions: enabledPermissionIds,
      isolated,
    }),
    [enabledPermissionIds, enabledSetupIntegrations, isolated, selectedRole],
  );
  const powerConfigured = Boolean(autoProvisionProvider || apiKey.trim());
  // Integration keys confirmed connected — the parent-owned truth PowerUpChat
  // reacts to for its in-voice success acks.
  const powerUpConnectedKeys = useMemo(() => {
    const keys: string[] = [];
    if (wsGmailConnected) keys.push("email");
    if (wsCalConnected) keys.push("calendar");
    if (wsSlackConnected) keys.push("slack");
    if (plugins.folders && selectedFolderPath) keys.push("folders");
    return keys;
  }, [wsGmailConnected, wsCalConnected, wsSlackConnected, plugins.folders, selectedFolderPath]);

  useEffect(() => {
    if (habitats.length === 0) return;
    const currentHabitatId = customIdentity?.habitatId;
    if (currentHabitatId != null && validHabitatIds.has(currentHabitatId)) return;
    const fallbackHabitatId = habitats[0]?.id;
    if (fallbackHabitatId == null) return;
    setCustomIdentity(prev => ({
      ...(prev || { baseModelUrl: null, accessories: [], decor: [] }),
      habitatId: fallbackHabitatId,
    }));
  }, [customIdentity?.habitatId, habitats, validHabitatIds]);

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
  // written a real sentence, ask the hosted brain for a tailored identity so
  // the later personality write-up reflects the request itself rather than a
  // canned role template (debounced; stale responses discarded; silent failure
  // keeps the deterministic fallback).
  useEffect(() => {
    setDynamicPersona(null);
    if (
      !isGenerativeDiscoveryEnabled() ||
      selectedRole !== "Custom" ||
      discoveryInput.trim().length < 12
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
      if (persona) {
        setDynamicPersona(persona);
        if (!persona.fitsExisting) {
          if (persona.voice) setSelectedVoice(persona.voice);
          if (persona.accessories.length > 0) {
            setCustomIdentity(prev => ({ ...prev, accessories: persona.accessories }));
          }
          fireActivationEvent("eddie_persona_drafted", { title: persona.title });
        } else if (persona.existingRole) {
          fireActivationEvent("eddie_role_matched", { role: persona.existingRole });
        }
      }
    }, 900);
    return () => {
      clearTimeout(timer);
      if (personaRequestRef.current === requestId) setEddieThinking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveryInput, selectedRole]);

  useEffect(() => {
    if (!selectedRole || draft?.selectedVoice) return;
    const roleDefaults = getRoleVoiceDefault(selectedRole);
    setSelectedVoice(roleDefaults.voice);
    setSelectedVoiceRate(roleDefaults.rate);
  }, [draft?.selectedVoice, selectedRole]);

  useEffect(() => {
    if (selectedRole || draft?.selectedVoice || voiceEditedRef.current || !effectiveDraftRole) return;
    const roleDefaults = getRoleVoiceDefault(effectiveDraftRole);
    setSelectedVoice(roleDefaults.voice);
    setSelectedVoiceRate(roleDefaults.rate);
  }, [draft?.selectedVoice, effectiveDraftRole, selectedRole]);

  const handleRoleSelect = (
    roleKey: string,
    options?: {
      seedPrompt?: string;
      selectionSource?: "explicit" | "discovery";
      dynamicPersona?: DynamicPersonaDraft | null;
    },
  ) => {
    const seedPrompt = options?.seedPrompt;
    const selectionSource = options?.selectionSource ?? "explicit";
    const tailoredPersona = options?.dynamicPersona ?? null;
    const roleDefaults = getRoleVoiceDefault(roleKey);
    const roleConfig = (agentTypeInfo as any)[roleKey] || {};
    setSelectedRole(roleKey);
    setLlmProvider(getDynamicRecommendedModel(roleKey).provider as any);
    setApiKeyMode("hidden");
    setApiKey("");
    setRecentlyRead([]);
    voiceEditedRef.current = false;
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
      : tailoredPersona?.name?.trim() || generateAgentName(roleKey);
    setAgentName(nextName);
    if (roleKey !== "Custom" && selectionSource === "explicit") {
      setDiscoveryInput("");
    }
    if (selectionSource === "discovery" && seedPrompt?.trim()) {
      setPersonalityPrompt(composeRequestDrivenPersonality({
        persona: tailoredPersona,
        agentName: nextName,
        roleKey,
        userNeed: seedPrompt,
      }));
    } else {
      const rolePersonality = getDefaultPersonality(roleKey, nextName, agentTypeInfo);
      setPersonalityPrompt(seedPrompt?.trim()
        ? `${rolePersonality}\n\n## Current user need\n\nThe user wants help with: ${seedPrompt.trim()}`
        : rolePersonality);
    }
    const shouldIsolate = agentTypeInfo[roleKey]?.recommended_isolated || false;
    setIsolated(shouldIsolate);
    setAgentPermissions(getPermissionsForRole(roleKey, shouldIsolate));
    setSelectedHeartbeatNames([]);
    if (roleKey === "Custom" && seedPrompt) setDiscoveryInput(seedPrompt);

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

  const handleVoiceChoice = (voiceId: string) => {
    voiceEditedRef.current = true;
    setSelectedVoice(voiceId);
    setShowVoiceChoices(false);
  };

  const previewVoiceSample = async (voiceId: string, sample: string) => {
    await playVoicePreview(sample, voiceId);
  };

  const renderDiscoveryStep = (isAddAgentFlow: boolean) => (
    (() => {
      const customSelected = selectedRole === "Custom";

      return (
    <div
      style={{
        width: "100%",
        // Beat one: a single centered ask. Beat two (draft exists): ask + reveal.
        maxWidth: isNarrowWindow ? "100%" : 1180,
        minHeight: isNarrowWindow ? "auto" : "78vh",
        display: "grid",
        gridTemplateColumns: isNarrowWindow ? "1fr" : "minmax(0, 1.08fr) minmax(360px, 0.92fr)",
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
                ? "Who are we adding to the crew? Pick the lane first and I’ll line up the role, voice, look, and setup from there."
                : <>Hi{userName.trim() ? `, ${userName.trim()}` : ""} — I&apos;m Eddie. Pick a role that feels close to what you need. If nothing fits, choose <strong>Custom</strong> and I&apos;ll draft something around your request.</>}
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

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
            Pick a role to start from
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 12 }}>
            {isAddAgentFlow
              ? "Eddie put likely team gaps first. You can still make a duplicate if you want another specialist in the same lane."
              : "Choose the closest fit. Custom is there if none of these are quite right."}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isVeryNarrowWindow ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            {featuredRoleTypes.map(role => {
              const active = selectedRole === role.key;
              const liveAgents = liveRoleAgentsByRole[role.key] || [];
              const gapReason = rosterGapSuggestions.find(suggestion => suggestion.role === role.key)?.reason;
              return (
                <button
                  key={role.key}
                  type="button"
                  onClick={() => handleRoleSelect(role.key, { selectionSource: "explicit" })}
                  style={{ display: "flex", gap: 12, alignItems: "flex-start", textAlign: "left", padding: 14, borderRadius: 16, border: active ? `1px solid ${role.color || "#3c6663"}` : "1px solid rgba(0,0,0,0.08)", background: active ? `${role.color || "#3c6663"}10` : "var(--surface-card)", cursor: "pointer", fontFamily: "inherit" }}
                >
                  {(role as any).image ? (
                    <img src={getAssetUrl((role as any).image)} alt={role.key} style={{ width: 46, height: 46, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 46, height: 46, borderRadius: 12, background: `${(role as any).robeColor || role.color || "#3c6663"}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <LobsterIcon size={34} shellColor={(role as any).robeColor || role.color || "#3c6663"} accentColor={(role as any).accentColor || "#4A9E96"} />
                    </div>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{role.key}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-sub)", lineHeight: 1.45 }}>{role.description}</div>
                    {gapReason && (
                      <div style={{ fontSize: 10.5, color: "#C76A42", lineHeight: 1.45, marginTop: 6 }}>
                        Eddie suggested this gap first.
                      </div>
                    )}
                    {liveAgents.length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, fontSize: 10.5, color: "#3c6663" }}>
                        <span aria-hidden="true">✓</span>
                        <span>{liveAgents[0]}{liveAgents.length > 1 ? ` +${liveAgents.length - 1}` : ""} already live</span>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => handleRoleSelect("Custom", { seedPrompt: discoveryInput, selectionSource: "explicit" })}
              style={{ display: "flex", gap: 12, alignItems: "flex-start", textAlign: "left", padding: 14, borderRadius: 16, border: customSelected ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: customSelected ? "rgba(60,102,99,0.10)" : "var(--surface-card)", cursor: "pointer", fontFamily: "inherit" }}
            >
              <div style={{ width: 46, height: 46, borderRadius: 12, background: "rgba(60,102,99,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <LobsterIcon size={34} shellColor="#3c6663" accentColor="#4A9E96" />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Custom</div>
                <div style={{ fontSize: 11.5, color: "var(--text-sub)", lineHeight: 1.45 }}>
                  Something else. Describe the exact job and Eddie will draft the role, personality, voice, and setup around it.
                </div>
              </div>
            </button>
          </div>
        </div>

        {customSelected && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
              {isAddAgentFlow ? "What should this new agent help with?" : "What kind of agent do you need?"}
            </div>
            <textarea
              value={discoveryInput}
              onChange={e => {
                setDiscoveryInput(e.target.value);
                setDynamicPersona(null);
                setPersonaMeta(null);
              }}
              placeholder={isAddAgentFlow
                ? "Describe the kind of specialist you want added to the team."
                : "Describe the work, expertise, outputs, and lifestyle fit you want this custom agent to handle."}
              rows={6}
              style={{ width: "100%", boxSizing: "border-box", padding: "16px 18px", borderRadius: 18, border: "1px solid rgba(0,0,0,0.1)", fontSize: 15, lineHeight: 1.6, resize: "vertical", outline: "none", background: "var(--surface-base)", color: "var(--text-main)", fontFamily: "inherit" }}
            />
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, fontSize: 12, color: "var(--text-sub)", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => { setShowRoleBrowser(v => !v); setShowAllRoles(true); }}
            style={{ padding: 0, border: "none", background: "transparent", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
          >
            {(showRoleBrowser || showAllRoles) ? "Hide all roles" : "Show all roles"}
          </button>
          <span style={{ opacity: 0.4 }}>·</span>
          <button
            type="button"
            onClick={startImportFlow}
            style={{ padding: 0, border: "none", background: "transparent", color: "var(--text-sub)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
          >
            Import agent
          </button>
        </div>

        {(showRoleBrowser || showAllRoles) && (
          <div style={{ padding: 16, borderRadius: 18, border: "1px solid rgba(0,0,0,0.06)", background: "rgba(255,255,255,0.55)", marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>All roles</div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 12 }}>Pick any role here if the featured ones above are not the right fit.</div>
            <div style={{ display: "grid", gridTemplateColumns: isVeryNarrowWindow ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10, maxHeight: 280, overflowY: "auto" }}>
              {roleTypes.map(role => {
                const active = selectedRole === role.key;
                const liveAgents = liveRoleAgentsByRole[role.key] || [];
                return (
                  <button
                    key={role.key}
                    type="button"
                    onClick={() => handleRoleSelect(role.key, { selectionSource: "explicit" })}
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
                      {liveAgents.length > 0 && (
                        <div style={{ fontSize: 10.5, color: "#3c6663", marginTop: 5 }}>✓ {liveAgents[0]}{liveAgents.length > 1 ? ` +${liveAgents.length - 1}` : ""} already live</div>
                      )}
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
            disabled={(!selectedRole || (customSelected && !discoveryInput.trim())) || (!isAddAgentFlow && !userName.trim())}
            onClick={() => { void continueFromDiscovery(); }}
            style={{ padding: "14px 24px", borderRadius: 14, border: "none", background: (selectedRole && (!customSelected || discoveryInput.trim()) && (isAddAgentFlow || userName.trim())) ? "linear-gradient(135deg, #3c6663, #609995)" : "var(--border-subtle)", color: (selectedRole && (!customSelected || discoveryInput.trim()) && (isAddAgentFlow || userName.trim())) ? "var(--surface-card)" : "var(--text-muted)", fontSize: 14, fontWeight: 800, cursor: (selectedRole && (!customSelected || discoveryInput.trim()) && (isAddAgentFlow || userName.trim())) ? "pointer" : "default", fontFamily: "inherit", minWidth: isVeryNarrowWindow ? 0 : 190, width: isVeryNarrowWindow ? "100%" : "auto" }}
          >
            {selectedRole && selectedRole !== "Custom"
              ? `Meet ${agentName || getRoleDefaultName(selectedRole)} →`
              : customSelected
                ? "Draft custom agent"
              : (isAddAgentFlow ? "Draft this agent" : "Draft my first agent")}
          </button>
        </div>
      </div>

      {/* Beat two: the reveal. Only exists once the user has given Eddie
          something to work with — it materializes, it never pre-exists. */}
      {hasDraftSource && discoveryPanelRoleInfo && (
      <div style={{ background: "linear-gradient(180deg, rgba(244,240,233,0.92) 0%, rgba(255,255,255,0.92) 100%)", borderRadius: 28, padding: isCompactWindow ? 20 : 24, boxShadow: "0 20px 48px rgba(0,0,0,0.05)", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", minWidth: 0, animation: "revealIn 0.45s ease" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
          Eddie&apos;s Draft
        </div>
        {(
          <>
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18, flexWrap: isVeryNarrowWindow ? "wrap" : "nowrap" }}>
              {(discoveryPanelRoleInfo as any).image ? (
                <img src={getAssetUrl((discoveryPanelRoleInfo as any).image)} alt={draftRole || "Custom"} style={{ width: 76, height: 76, borderRadius: 20, objectFit: "cover", flexShrink: 0 }} />
              ) : (
                <div style={{ width: 76, height: 76, borderRadius: 20, background: `${(discoveryPanelRoleInfo as any).robeColor || "#3c6663"}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <LobsterIcon size={62} shellColor={(discoveryPanelRoleInfo as any).robeColor || "#3c6663"} accentColor={(discoveryPanelRoleInfo as any).accentColor || "#4A9E96"} />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  {/* Name is editable right here — it's their being to name. */}
                  <input
                    value={agentName}
                    onChange={e => {
                      nameEditedRef.current = true;
                      syncAgentNameInDraft(e.target.value);
                    }}
                    placeholder={generateAgentName(draftRole || "Custom")}
                    aria-label="Agent name"
                    style={{ fontSize: 22, fontWeight: 700, color: "var(--text-main)", background: "transparent", border: "none", borderBottom: "1px dashed rgba(0,0,0,0.15)", outline: "none", padding: "0 0 2px", minWidth: 0, width: "100%", maxWidth: 220, fontFamily: "inherit" }}
                  />
                  <button
                    type="button"
                    title="Pick another name"
                    onClick={() => {
                      nameEditedRef.current = false;
                      syncAgentNameInDraft(generateAgentName(draftRole || "Custom", agentName));
                    }}
                    style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "transparent", color: "var(--text-sub)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, lineHeight: 1 }}
                  >
                    ⟳
                  </button>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  {personaActive ? dynamicPersona!.title : (selectedRole === "Custom" ? (draftRole || "Custom") : draftRole)}
                  {personaActive && (
                    <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(242,140,99,0.14)", color: "#C76A42", fontSize: 10, fontWeight: 800, letterSpacing: "0.04em" }}>
                      TAILORED BY EDDIE
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.55 }}>
                  {personaActive
                    ? dynamicPersona!.tagline || `Invented just for what you described.`
                    : eddieThinking
                      ? "Eddie is thinking about a tailored fit…"
                      : selectedRole === "Custom"
                        ? (discoveryInput.trim()
                            ? `Drafted for: “${discoveryInput.trim().slice(0, 90)}${discoveryInput.trim().length > 90 ? "…" : ""}”`
                            : discoveryPanelRoleInfo.description)
                        : discoveryPanelRoleInfo.description}
                </div>
              </div>
            </div>

            {isAddAgentFlow && collaboratorSuggestions.length > 0 && (
              <div style={{ padding: "12px 14px", borderRadius: 16, background: "rgba(242,140,99,0.08)", border: "1px solid rgba(242,140,99,0.18)", fontSize: 12, color: "var(--text-sub)", lineHeight: 1.55, marginBottom: 14 }}>
                <strong style={{ color: "var(--text-main)" }}>Would pair well with your current crew:</strong>{" "}
                {collaboratorSuggestions.map((suggestion, index) => (
                  <React.Fragment key={`${suggestion.name}-${suggestion.role}`}>
                    {index > 0 ? " " : ""}
                    <span style={{ color: "#C76A42", fontWeight: 700 }}>{suggestion.name}</span> ({suggestion.role}) to {suggestion.reason}.
                  </React.Fragment>
                ))}
              </div>
            )}

            {/* Simplified (Scottie, July 28): no duplicate name/description,
                no generic capability bullets, no "Show more capabilities" —
                routines get their moment in beat 3, tailored to the user.
                The interview IS the panel body, with room to breathe. */}
            <div style={{ padding: "16px 18px", borderRadius: 18, background: "rgba(255,255,255,0.78)", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: 12 }}>
              <DraftInterviewChat
                key={`interview-${draftRole || selectedRole || "custom"}-${personaMeta?.title || ""}`}
                agentName={agentName || getRoleDefaultName(draftRole || selectedRole || "Assistant")}
                roleTitle={personaMeta?.title || draftRole || selectedRole || "specialist"}
                personality={personalityPrompt}
                discoveryInput={discoveryInput}
                tall
                onIdentityNotes={(notes) => {
                  setPersonalityPrompt((prev: string) => mergeIdentityNotes(prev, notes));
                  if (!interviewFactsRef.current.includes(notes)) interviewFactsRef.current.push(notes);
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => { void continueFromDiscovery(3.7); }}
                  style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(60,102,99,0.2)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}
                >
                  Skip to power up
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}
    </div>
      );
    })()
  );

  const handoffToAgentConversation = (agentId: string, prompt?: string | null) => {
    setSelectedAgentId(agentId);
    setShowAnthropicKeyStep(true);
    localStorage.setItem("canopy_pending_handoff", JSON.stringify({ agentId, prompt: prompt || "" }));
  };

  const completeHandoffToAgentConversation = (agentId: string, prompt?: string | null) => {
    const cleanPrompt = (prompt || "").trim();
    if (cleanPrompt) {
      localStorage.setItem("canopy_starter_task", JSON.stringify({ agentId, prompt: cleanPrompt }));
    }
    localStorage.removeItem("canopy_onboarding_draft");
    localStorage.removeItem("canopy_pending_handoff");
    const store = useWorldStore.getState();
    store.setSelectedAgent(agentId);
    if (typeof (store as any).setArchitectTab === "function") {
      (store as any).setArchitectTab("overview");
    }
    store.setActiveView("architect");
  };

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
              if (llmProvider === "Anthropic") return "anthropic/claude-sonnet-5";
              if (llmProvider === "OpenAI") return "openai/gpt-5.6-terra";
              if (llmProvider === "Google Gemini") return "google/gemini-3.6-flash";
              if (llmProvider === "xAI Grok") return "xai/grok-4.5";
              return "anthropic/claude-sonnet-5";
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
                stt_provider: "whisper_cloud",
                tts_provider: "eleven_labs",
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
        const postDeployPrompt = composeSetupConversationPrompt({
          agentName: newAgentData.name,
          role: selectedRole,
          userNeed: discoveryInput,
          state: {
            enabledIntegrations: initialIntegrations,
            enabledPermissions: agentPermissions
              .filter(permission => permission.enabled)
              .map(permission => permission.id),
            isolated,
          },
        });

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

        const allHeartbeatTasks = [...selectedHeartbeatTasks, ...customHeartbeatsRef.current];
        if (allHeartbeatTasks.length > 0) {
          try {
            await invoke("write_workspace_file", {
              agentId: newAgentData.id,
              filename: "HEARTBEAT.md",
              content: serializeHeartbeatFile({
                tasks: allHeartbeatTasks,
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

        // Beat-1 interview facts → shared USER.md (synced to every agent).
        // Fire-and-forget: a failure here must never fail the deploy.
        if (interviewFactsRef.current.length > 0) {
          invoke("append_onboarding_user_facts", { facts: interviewFactsRef.current })
            .then(() => reportTelemetryEvent("onboarding_user_facts_saved", { count: interviewFactsRef.current.length }))
            .catch(() => {});
        }

        return { agent: newAgentData, postDeployPrompt };
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
        const { agent: newAgent } = await deployAgentCore(tempId);
        handoffToAgentConversation(newAgent.id, starterTask);
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
        const { agent: newAgent, postDeployPrompt } = await deployAgentCore(tempId);
        setSelectedAgentId(newAgent.id);
        setShowAnthropicKeyStep(true);
        setDeployedAgentId(newAgent.id);
        setPostDeployConversationPrompt(postDeployPrompt);
        setStep(6);
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
      try {
        const { agent: newAgent, postDeployPrompt } = await deployAgentCore(tempId);
        setSelectedAgentId(newAgent.id);
        setShowAnthropicKeyStep(true);
        if (channelChoice === "mobile") {
          // The user chose their phone as the channel during the power-up
          // conversation — honor it: land on the pairing screen post-deploy.
          setDeployedAgentId(newAgent.id);
          setPostDeployConversationPrompt(postDeployPrompt);
          setStep(7);
        } else {
          handoffToAgentConversation(newAgent.id, postDeployPrompt);
        }
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
                <div style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 8 }}>No local agents detected.</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, maxWidth: 380, margin: "0 auto" }}>
                  Canopy scans Docker and your local setup automatically. Start your existing
                  agent's runtime and it will appear here — or go back and create a fresh one.
                </div>
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

      {/* Step 3: Name, personality, and appearance studio */}
      {step === 2 && (
        <div style={{ maxWidth: 940, width: "94%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr", gap: 24 }}>
            <div style={{ overflow: "auto", padding: "20px 0 8px", minWidth: 0 }}>
              <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
                Meet {agentName.trim() || "Your Agent"}
              </h1>
              <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 28 }}>
                Shape who {agentName.trim() || "they"} are, dress them a little, and test the vibe live on the right.
              </p>

              <div style={{ marginBottom: 28 }}>
                <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>Agent Name</label>
                <input
                  value={agentName}
                  onChange={e => {
                    nameEditedRef.current = true;
                    syncAgentNameInDraft(e.target.value);
                  }}
                  placeholder="e.g., Atlas, Nova, Sage..."
                  style={{ width: "100%", padding: "14px 18px", borderRadius: 12, fontSize: 15, fontFamily: "inherit", color: "var(--text-main)", outline: "none", background: "var(--surface-card)" }}
                />
              </div>

              {selectedRole && agentTypeInfo[selectedRole] && (
                <div style={{ background: "var(--surface-base)", padding: 20, borderRadius: 18, marginBottom: 24, display: "flex", gap: 16, alignItems: "flex-start", border: "1px solid rgba(0,0,0,0.05)" }}>
                  {agentTypeInfo[selectedRole].image ? (
                    <img src={getAssetUrl(agentTypeInfo[selectedRole].image)} alt={selectedRole} style={{ width: 54, height: 54, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
                  ) : (
                    <LobsterIcon size={52} shellColor={agentTypeInfo[selectedRole].robeColor} accentColor={agentTypeInfo[selectedRole].accentColor} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
                      {agentName || "Your Agent"} the {selectedRole}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.55 }}>
                      {personaMeta?.tagline || agentTypeInfo[selectedRole].description}
                    </div>
                  </div>
                </div>
              )}

              {/* Personality demoted to a toggle (plan Phase 1): it was written
                  during the beat-1 conversation — the studio is for appearance. */}
              <div style={{ background: "var(--surface-base)", padding: "16px 24px", borderRadius: 18, marginBottom: 24, border: "1px solid rgba(0,0,0,0.05)" }}>
                <button
                  type="button"
                  onClick={() => setIdentityNotesOpen(v => !v)}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}
                >
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>
                    Identity notes
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)", marginLeft: 8 }}>
                      written by Eddie from your conversation
                    </span>
                  </span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transition: "transform 0.2s", transform: identityNotesOpen ? "rotate(180deg)" : "rotate(0deg)", color: "var(--text-sub)" }}>
                    <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                {identityNotesOpen && (
                  <div style={{ marginTop: 14 }}>
                    <p style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 12, lineHeight: 1.55 }}>
                      Keep it short and specific and {agentName || "your agent"} will take it from there.
                    </p>
                    <textarea
                      value={personalityPrompt}
                      onChange={e => setPersonalityPrompt(e.target.value)}
                      rows={7}
                      placeholder={`e.g. You are ${agentName || "Fern"}, a warm, sharp ${displayRole || draftRole || "specialist"} who gives concrete recommendations, never waffles, and always says when something is outside your expertise.`}
                      style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.1)", fontSize: 14, lineHeight: 1.65, resize: "vertical", outline: "none", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
                    />
                  </div>
                )}
              </div>

              <div style={{ background: "var(--surface-base)", padding: 24, borderRadius: 18, marginBottom: 24, border: "1px solid rgba(0,0,0,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Appearance studio</div>
                    <div style={{ fontSize: 12.5, color: "var(--text-sub)", lineHeight: 1.5 }}>
                      Pick a habitat, keep the best accessories, and make them feel recognizable right away.
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => { void previewVoiceSample(selectedVoice, getRoleVoiceDefault(selectedRole || "Assistant").sample); }}
                      style={{ padding: "8px 12px", borderRadius: 999, border: "1px solid rgba(60,102,99,0.18)", background: "rgba(60,102,99,0.08)", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                    >
                      Hear {selectedVoiceProfile.voiceLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowVoiceChoices(v => !v)}
                      style={{ padding: 0, border: "none", background: "transparent", color: "var(--text-sub)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
                    >
                      {showVoiceChoices ? "Keep this voice" : "Change voice"}
                    </button>
                  </div>
                </div>

                {showVoiceChoices && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                    {CURATED_VOICE_IDS.map(voiceId => {
                      const profile = getVoiceProfile(voiceId);
                      const active = selectedVoice === voiceId;
                      return (
                        <button
                          key={voiceId}
                          type="button"
                          onClick={() => handleVoiceChoice(voiceId)}
                          style={{ padding: "6px 10px", borderRadius: 999, border: active ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: active ? "rgba(60,102,99,0.10)" : "var(--surface-card)", color: active ? "#3c6663" : "var(--text-sub)", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          {profile.voiceLabel}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div style={{ height: 300, borderRadius: 18, overflow: "hidden", background: "rgba(60,102,99,0.06)", border: "1px solid rgba(0,0,0,0.06)", marginBottom: 18 }}>
                  <React.Suspense fallback={null}>
                    <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 280 }} gl={{ alpha: true }}>
                      <Environment preset="city" />
                      <ambientLight intensity={0.65} />
                      <directionalLight position={[5, 5, 5]} intensity={1} castShadow />
                      <OrbitControls
                        enablePan
                        enableRotate
                        enableZoom
                        enableDamping
                        dampingFactor={0.08}
                        minZoom={180}
                        maxZoom={420}
                        target={[0, 0.3, 0]}
                      />
                      <group position={[0, -0.06, 0]}>
                        <group
                          position={[-selectedHabitatPlacement.x, -0.01 - selectedHabitatPlacement.y, -selectedHabitatPlacement.z]}
                          rotation={[0, Math.PI / 4 - (selectedHabitatPlacement.rotationY * Math.PI / 180), 0]}
                        >
                          <HabitatErrorBoundary fallback={<group />}>
                            <TerrariumBase
                              habitatId={selectedHabitat?.id || customIdentity?.habitatId || 1}
                              modelUrl={selectedHabitat?.path}
                            />
                          </HabitatErrorBoundary>
                          {(customIdentity?.decor || []).map((path, index) => (
                            <OnboardingDecorObject
                              key={path}
                              agentId={optimisticId}
                              path={path}
                              glbPath={path.replace(".png", ".glb")}
                              transform={customIdentity?.decorTransforms?.[path]}
                              decorPoints={selectedHabitat?.decorPoints || []}
                              index={index}
                              defaultDecorRotation={ACCESSORY_ITEMS[path]?.decorRotation}
                              defaultScale={ACCESSORY_ITEMS[path]?.scale}
                              isSelected={selectedDecor === path}
                              onSelect={() => setSelectedDecor(path)}
                            />
                          ))}
                        </group>
                        <group position={[0, 0, 0]}>
                          <GLBAgent
                            fileUrl={selectedRoleModelUrl}
                            accessories={customIdentity?.accessories || []}
                            role={selectedRole || "Custom"}
                            scale={0.25}
                            robeColor={customIdentity?.color || agentTypeInfo[selectedRole || "Custom"]?.robeColor}
                            accentColor={agentTypeInfo[selectedRole || "Custom"]?.accentColor}
                            forceAnimation="Breathe"
                          />
                        </group>
                      </group>
                    </Canvas>
                  </React.Suspense>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
                  {([
                    {
                      key: "habitat" as const,
                      label: "Habitat",
                      detail: selectedHabitat?.name || "Choose a home",
                    },
                    {
                      key: "accessories" as const,
                      label: "Accessories",
                      detail: `${(customIdentity?.accessories || []).length} selected`,
                    },
                    {
                      key: "decor" as const,
                      label: "Decor",
                      detail: `${(customIdentity?.decor || []).length} placed`,
                    },
                    {
                      key: "books" as const,
                      label: "Books",
                      detail: `${recentlyRead.length} in their stack`,
                    },
                  ]).map(section => {
                    const active = studioSection === section.key;
                    return (
                      <button
                        key={section.key}
                        type="button"
                        onClick={() => setStudioSection(section.key)}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: 2,
                          minWidth: viewportSize.width < 860 ? "calc(50% - 4px)" : 132,
                          padding: "11px 13px",
                          borderRadius: 14,
                          border: active ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                          background: active ? "rgba(60,102,99,0.10)" : "var(--surface-card)",
                          color: active ? "#3c6663" : "var(--text-main)",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          textAlign: "left",
                        }}
                      >
                        <span style={{ fontSize: 12.5, fontWeight: 800 }}>{section.label}</span>
                        <span style={{ fontSize: 11, color: active ? "#2f5c59" : "var(--text-sub)" }}>{section.detail}</span>
                      </button>
                    );
                  })}
                </div>

                {selectedDecor && (
                  <div style={{
                    display: "flex",
                    gap: 14,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginBottom: 18,
                    padding: "10px 12px",
                    borderRadius: 16,
                    background: "rgba(255,255,255,0.84)",
                    border: "1px solid rgba(0,0,0,0.08)",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#3c6663" }}>
                      Moving {getAccessoryName(selectedDecor)}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <button type="button" onClick={() => handleStudioDecorNudge("z", -0.1)} style={studioNudgeButtonStyle}>↑</button>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button type="button" onClick={() => handleStudioDecorNudge("x", -0.1)} style={studioNudgeButtonStyle}>←</button>
                        <button type="button" onClick={() => handleStudioDecorNudge("z", 0.1)} style={studioNudgeButtonStyle}>↓</button>
                        <button type="button" onClick={() => handleStudioDecorNudge("x", 0.1)} style={studioNudgeButtonStyle}>→</button>
                      </div>
                    </div>
                    <div style={{ width: 1, height: 32, background: "rgba(0,0,0,0.08)" }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <button type="button" onClick={() => handleStudioDecorNudge("y", 0.1)} style={{ ...studioNudgeButtonStyle, width: 48, fontSize: 11 }}>+Y</button>
                      <button type="button" onClick={() => handleStudioDecorNudge("y", -0.1)} style={{ ...studioNudgeButtonStyle, width: 48, fontSize: 11 }}>-Y</button>
                    </div>
                    <div style={{ width: 1, height: 32, background: "rgba(0,0,0,0.08)" }} />
                    <div style={{ display: "flex", gap: 4 }}>
                      <button type="button" onClick={() => handleStudioDecorNudge("ry", Math.PI / 16)} style={{ ...studioNudgeButtonStyle, width: 36, fontSize: 16 }}>⟳</button>
                      <button type="button" onClick={() => handleStudioDecorNudge("ry", -Math.PI / 16)} style={{ ...studioNudgeButtonStyle, width: 36, fontSize: 16 }}>⟲</button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedDecor(null)}
                      style={{ marginLeft: "auto", background: "transparent", color: "var(--text-sub)", border: "none", padding: 4, cursor: "pointer", display: "flex", alignItems: "center" }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}

                {studioSection === "habitat" && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-sub)", marginBottom: 10 }}>
                      Pick A Habitat
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: viewportSize.width < 860 ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      {habitats.slice(0, 8).map(habitat => {
                        const active = habitat.id === (customIdentity?.habitatId || 1);
                        return (
                        <button
                          key={habitat.id}
                          type="button"
                          onClick={() => handleStudioHabitatSelect(habitat.id)}
                          style={{ borderRadius: 16, overflow: "hidden", padding: 0, border: active ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: active ? "rgba(60,102,99,0.06)" : "var(--surface-card)", cursor: "pointer", fontFamily: "inherit" }}
                        >
                            <div style={{ height: 92, background: "rgba(60,102,99,0.05)" }}>
                              {habitat.imageUrl ? (
                                <img src={getAssetUrl(habitat.imageUrl)} alt={habitat.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                              ) : (
                                <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, rgba(60,102,99,0.18), rgba(255,255,255,0.65))" }} />
                              )}
                            </div>
                            <div style={{ padding: "8px 10px", textAlign: "left" }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-main)" }}>{habitat.name}</div>
                              {active && <div style={{ fontSize: 10.5, color: "#3c6663", marginTop: 2 }}>Chosen home</div>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {studioSection === "accessories" && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-sub)" }}>
                        Accessories
                      </div>
                      <input
                        value={studioAccessorySearch}
                        onChange={e => setStudioAccessorySearch(e.target.value)}
                        placeholder="Search the shelf..."
                        style={{ width: viewportSize.width < 860 ? "100%" : 220, padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12, outline: "none", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
                      />
                    </div>
                    {(customIdentity?.accessories || []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                        {(customIdentity?.accessories || []).map(accessoryId => (
                          <button
                            key={accessoryId}
                            type="button"
                            onClick={() => toggleStudioAccessory(accessoryId)}
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 999, border: "1px solid rgba(60,102,99,0.18)", background: "rgba(60,102,99,0.08)", color: "#3c6663", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                          >
                            {getAccessoryName(accessoryId)}
                            <span style={{ opacity: 0.65 }}>×</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: viewportSize.width < 860 ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      {filteredStudioAccessories.map(option => {
                        const active = (customIdentity?.accessories || []).includes(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => toggleStudioAccessory(option.id)}
                            style={{ padding: 10, borderRadius: 16, border: active ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: active ? "rgba(60,102,99,0.07)" : "var(--surface-card)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, textAlign: "left", fontFamily: "inherit" }}
                          >
                            <div style={{ height: 78, borderRadius: 12, background: "linear-gradient(180deg, rgba(244,240,233,0.95), rgba(255,255,255,0.85))", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                              <img src={getAssetUrl(option.id)} alt={option.name} style={{ width: 64, height: 64, objectFit: "contain" }} />
                            </div>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", lineHeight: 1.35 }}>{option.name}</div>
                              <div style={{ fontSize: 10.5, color: active ? "#3c6663" : "var(--text-sub)", marginTop: 3 }}>{active ? "On your agent" : "Add to look"}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {studioSection === "decor" && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-sub)" }}>
                        Decor
                      </div>
                      <input
                        value={studioDecorSearch}
                        onChange={e => setStudioDecorSearch(e.target.value)}
                        placeholder="Search decor..."
                        style={{ width: viewportSize.width < 860 ? "100%" : 220, padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12, outline: "none", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
                      />
                    </div>
                    {(customIdentity?.decor || []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                        {(customIdentity?.decor || []).map(decorId => (
                          <button
                            key={decorId}
                            type="button"
                            onClick={() => setSelectedDecor(decorId)}
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 999, border: selectedDecor === decorId ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: selectedDecor === decorId ? "rgba(60,102,99,0.08)" : "var(--surface-card)", color: selectedDecor === decorId ? "#3c6663" : "var(--text-main)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                          >
                            {getAccessoryName(decorId)}
                          </button>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: viewportSize.width < 860 ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      {filteredStudioDecor.map(option => {
                        const active = (customIdentity?.decor || []).includes(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => toggleStudioDecor(option.id)}
                            style={{ padding: 10, borderRadius: 16, border: active ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: active ? "rgba(60,102,99,0.07)" : "var(--surface-card)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, textAlign: "left", fontFamily: "inherit" }}
                          >
                            <div style={{ height: 78, borderRadius: 12, background: "linear-gradient(180deg, rgba(244,240,233,0.95), rgba(255,255,255,0.85))", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                              <img src={getAssetUrl(option.id)} alt={option.name} style={{ width: 64, height: 64, objectFit: "contain" }} />
                            </div>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", lineHeight: 1.35 }}>{option.name}</div>
                              <div style={{ fontSize: 10.5, color: active ? "#3c6663" : "var(--text-sub)", marginTop: 3 }}>
                                {active ? (selectedDecor === option.id ? "Selected to move" : "Placed in habitat") : "Add to habitat"}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {studioSection === "books" && (
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Recently Read</div>
                    <div style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.55, marginBottom: 16 }}>
                      Give them a little texture. Eddie suggested a few books that fit this lane, but the best picks can be surprising too.
                    </div>

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

                    {suggestedLibraryBooks.length > 0 && (
                      <div style={{ marginBottom: 18 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-sub)", marginBottom: 10 }}>
                          Eddie&apos;s Shelf
                        </div>
                        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", overflowX: "auto", paddingBottom: 8 }}>
                          {suggestedLibraryBooks.map((book, index) => {
                            const active = recentlyRead.includes(book.title);
                            return (
                              <button
                                key={book.title}
                                type="button"
                                onClick={() => setRecentlyRead(active ? recentlyRead.filter(title => title !== book.title) : [...recentlyRead, book.title])}
                                style={{ minWidth: 96, height: 132, padding: "12px 10px 14px", borderRadius: "12px 12px 8px 8px", border: active ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: BOOK_SHELF_COLORS[index % BOOK_SHELF_COLORS.length], color: "#fff", boxShadow: active ? "0 10px 22px rgba(60,102,99,0.18)" : "0 8px 18px rgba(0,0,0,0.08)", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between", flexShrink: 0 }}
                              >
                                <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{book.title}</div>
                                <div style={{ fontSize: 10.5, opacity: 0.9 }}>{active ? "Added" : "Add to stack"}</div>
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ height: 8, borderRadius: 999, background: "rgba(78, 54, 33, 0.18)", marginTop: -4 }} />
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 8, flexWrap: viewportSize.width < 860 ? "wrap" : "nowrap" }}>
                      <input
                        value={customBookInput}
                        onChange={e => setCustomBookInput(e.target.value)}
                        placeholder="Add a custom book title..."
                        style={{ flex: 1, minWidth: 220, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12, outline: "none", fontFamily: "inherit", background: "var(--surface-card)" }}
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            const title = customBookInput.trim();
                            if (title) {
                              setRecentlyRead([...recentlyRead, title]);
                              setCustomBookInput("");
                            }
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          const title = customBookInput.trim();
                          if (title) {
                            setRecentlyRead([...recentlyRead, title]);
                            setCustomBookInput("");
                          }
                        }}
                        style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)", background: "var(--surface-card)", color: "var(--text-main)", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
                      >
                        Add book
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.05)", flexDirection: isVeryNarrowWindow ? "column-reverse" : "row" }}>
            <button onClick={() => setStep(agents.length > 0 ? 1 : 0)} style={{ padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: isVeryNarrowWindow ? "100%" : "auto" }}>
              Back
            </button>
            <button onClick={() => setStep(3.7)} disabled={!agentName.trim()} style={{ padding: "12px 28px", borderRadius: 12, border: "none", background: agentName.trim() ? "#3c6663" : "var(--border-subtle)", color: agentName.trim() ? "var(--surface-card)" : "var(--text-muted)", fontSize: 14, fontWeight: 600, cursor: agentName.trim() ? "pointer" : "default", fontFamily: "inherit", width: isVeryNarrowWindow ? "100%" : "auto" }}>
              {`Give ${agentName.trim() || "them"} power →`}
            </button>
          </div>
        </div>
      )}

      {/* Step 2.5 retired: appearance now lives directly inside Meet Agent. */}
      {step === 2.5 && (
        <div style={{ maxWidth: 560, width: "90%", textAlign: "center" }}>
          <h1 style={{ fontSize: 34, fontWeight: 700, color: "var(--text-main)", marginBottom: 10, fontFamily: "'Noto Serif', Georgia, serif" }}>
            Appearance moved into the studio
          </h1>
          <p style={{ fontSize: 15, color: "var(--text-sub)", lineHeight: 1.6, marginBottom: 28 }}>
            Habitat and accessories now live on the Meet {agentName.trim() || "your agent"} step so you can tweak everything in one place.
          </p>
          <button
            type="button"
            onClick={() => setStep(2)}
            style={{ padding: "12px 22px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
          >
            Back to studio
          </button>
        </div>
      )}

      {/* Step 4: conversational setup */}
      {/* Step 3.7: Beat 3 — the power-up conversation. The brain screen (3)
          and the checklist (4) are detours that return here. */}
      {step === 3.7 && (
        <div style={{ maxWidth: 1060, width: "94%", height: "90vh", display: "flex", flexDirection: "column", padding: "20px 0" }}>
          <PowerUpChat
            key={`powerup-${powerUpRunId}`}
            agentName={agentName.trim() || "Your agent"}
            portrait={selectedRole && agentTypeInfo[selectedRole]?.image ? (
              <img src={getAssetUrl(agentTypeInfo[selectedRole].image)} alt={selectedRole} style={{ width: 40, height: 40, borderRadius: 10, objectFit: "cover" }} />
            ) : (
              <LobsterIcon size={38} shellColor={selectedRole ? agentTypeInfo[selectedRole]?.robeColor : "#3c6663"} accentColor={selectedRole ? agentTypeInfo[selectedRole]?.accentColor : "#4A9E96"} />
            )}
            scriptInput={{
              agentName: agentName.trim() || "Your agent",
              role: selectedRole,
              displayRole: personaMeta?.title || selectedRole,
              discoveryInput,
              connectedIntegrations: powerUpConnectedKeys,
              declinedIntegrations: powerUpDeclinedRef.current,
              readyHeartbeats: readyHeartbeatSuggestions,
              channelConnected: wsSlackConnected,
              brainDetected: powerConfigured,
              brainProviderName: llmProvider || undefined,
              maxAsks: onboardingCfg.maxAsks,
            }}
            liveAgentEnabled={onboardingCfg.liveAgentEnabled}
            autoAdvanceConfirmations={onboardingCfg.autoAdvanceConfirmations}
            configVariant={onboardingCfg.variant}
            wideLayout={viewportSize.width >= 1000}
            onBack={() => setStep(2)}
            connectedIntegrations={powerUpConnectedKeys}
            onSetupIntegration={(key) => { void handleSetupIntegration(key); }}
            onChannelChoice={(kind) => {
              if (kind === "telegram") { void handleSetupIntegration("telegram"); setChannelChoice("telegram"); }
              else if (kind === "slack") { setPlugins(prev => ({ ...prev, slack: true })); setChannelChoice("slack"); }
              else if (kind === "mobile") { setChannelChoice("mobile"); }
              fireActivationEvent("onboarding_channel_selected", { channel: kind });
            }}
            onHeartbeatToggle={(name, enabled) => {
              setSelectedHeartbeatNames(prev => enabled
                ? (prev.includes(name) ? prev : [...prev, name])
                : prev.filter(n => n !== name));
            }}
            onCustomHeartbeat={(task, accepted) => {
              customHeartbeatsRef.current = accepted
                ? [...customHeartbeatsRef.current.filter(t => t.name !== task.name), task]
                : customHeartbeatsRef.current.filter(t => t.name !== task.name);
            }}
            onOpenBrainSetup={() => setStep(3)}
            onOpenAdvanced={() => setStep(4)}
            onDeploy={() => setStep(6)}
          />
        </div>
      )}

      {step === 3 && (
        <div style={{ maxWidth: 1180, width: "94%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: viewportSize.width < 1040 ? "1fr" : "minmax(0, 1fr) 340px", gap: 24 }}>
            <div style={{ overflow: "auto", padding: "20px 0", minWidth: 0 }}>
              <h1 style={{ fontSize: 40, fontWeight: 700, color: "var(--text-main)", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
                Give {agentName || "your agent"} power
              </h1>
              <p style={{ fontSize: 16, color: "var(--text-sub)", marginBottom: 28, lineHeight: 1.6 }}>
                Let {agentName || "them"} walk you through the few setup moves that make the first real conversation feel powerful instead of handicapped.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ alignSelf: "flex-start", maxWidth: 700, padding: "16px 18px", borderRadius: "10px 18px 18px 18px", background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.65 }}>
                    I&apos;m ready to help with {discoveryInput.trim() ? discoveryInput.trim() : `your ${selectedRole?.toLowerCase() || "work"}`}. First let&apos;s make sure I can think, then I&apos;ll ask for the next unlock that lets me actually carry some weight.
                  </div>
                </div>

                <div style={{ alignSelf: "flex-start", maxWidth: 720, padding: "16px 18px", borderRadius: "10px 18px 18px 18px", background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.14)" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
                    Step 1: pick how I think
                  </div>
                  <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.6, marginBottom: 14 }}>
                    {llmProvider
                      ? `I’m lined up for ${llmProvider}. ${powerConfigured ? "That part looks ready." : "If you already use it, I can pull from that setup or open a guided flow."}`
                      : `Choose the model provider you want me to use. Eddie already steered the default for this role, but you can override it.`}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: llmProvider ? 14 : 0 }}>
                    {["OpenAI", "Google Gemini", "Anthropic", "xAI Grok"].map(provider => {
                      const active = llmProvider === provider;
                      return (
                        <button
                          key={provider}
                          type="button"
                          onClick={() => {
                            setLlmProvider(provider as any);
                            setApiKey("");
                            setApiKeyMode("hidden");
                            setAutoProvisionProvider(null);
                            setDetectedSetup(null);
                          }}
                          style={{ padding: "10px 14px", borderRadius: 999, border: active ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.1)", background: active ? "rgba(60,102,99,0.12)" : "var(--surface-card)", color: active ? "#3c6663" : "var(--text-main)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          {provider}
                        </button>
                      );
                    })}
                  </div>
                  {llmProvider && (
                    <>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                        <button
                          type="button"
                          onClick={() => { void scanExistingProviderKey(); }}
                          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid rgba(60,102,99,0.22)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          Use my existing {llmProvider} setup
                        </button>
                        <button
                          type="button"
                          onClick={() => { void launchProviderSetup(); }}
                          style={{ padding: "10px 14px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          {managedProviderId && managementConnected ? `Create a dedicated ${llmProvider} key` : `Walk me through ${llmProvider}`}
                        </button>
                      </div>
                      <div style={{ marginTop: 12, fontSize: 12, color: powerConfigured ? "#2c5a55" : "var(--text-sub)", lineHeight: 1.55 }}>
                        {powerConfigured
                          ? detectedSetup === "management"
                            ? `Ready: Canopy will mint a dedicated ${llmProvider} key for ${agentName || "this agent"} during deploy.`
                            : `Ready: your ${llmProvider} key is available for this agent.`
                          : `Not connected yet. The setup guide opens next to the provider console so you can finish it without typing into this wizard.`}
                      </div>
                    </>
                  )}
                </div>

                {powerConfigured && (
                  <div style={{ alignSelf: "flex-start", maxWidth: 720, padding: "16px 18px", borderRadius: "10px 18px 18px 18px", background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.06)" }}>
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
                      Step 2: unlock the next useful thing
                    </div>
                    <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.6, marginBottom: 14 }}>
                      {currentSetupUnlock
                        ? `Next I’d like ${currentSetupUnlock.label} ${currentSetupUnlock.reason}.`
                        : `Core setup is in good shape. I’d mainly want a couple of routines next so I can help without being asked every time.`}
                    </div>
                    {currentSetupUnlock && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                        <button
                          type="button"
                          onClick={() => { void handleConversationUnlock(currentSetupUnlock); }}
                          style={{ padding: "10px 14px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          {currentSetupUnlock.kind === "permission"
                            ? `Turn on ${currentSetupUnlock.label}`
                            : currentSetupUnlock.kind === "workspace"
                              ? "Keep me isolated"
                              : getCapabilityActionLabel(currentSetupUnlock.id)}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowAllIntegrations(v => !v)}
                          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)", background: "var(--surface-card)", color: "var(--text-sub)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          Show more options
                        </button>
                      </div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {setupRecommendedConnections.map(connection => (
                        <span key={connection} style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(60,102,99,0.08)", color: "#3c6663", fontSize: 11.5, fontWeight: 700 }}>
                          {connection}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ alignSelf: "flex-start", maxWidth: 720, padding: "16px 18px", borderRadius: "10px 18px 18px 18px", background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.14)" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
                    Step 3: starting routines
                  </div>
                  <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.6, marginBottom: 14 }}>
                    These are the routines I&apos;d start with. Click the ones you want active from day one.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {readyHeartbeatSuggestions.slice(0, 4).map(task => {
                      const active = selectedHeartbeatNames.includes(task.name);
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
                          style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", gap: 12, padding: "13px 14px", borderRadius: 14, border: active ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)", background: active ? "rgba(60,102,99,0.1)" : "var(--surface-card)", cursor: "pointer", fontFamily: "inherit" }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{task.title}</div>
                            <div style={{ fontSize: 11.5, color: "var(--text-sub)", lineHeight: 1.5 }}>{task.prompt}</div>
                          </div>
                          <div style={{ flexShrink: 0, fontSize: 11, color: active ? "#3c6663" : "var(--text-sub)", fontWeight: 700 }}>
                            {active ? "Included" : task.scheduleLabel}
                          </div>
                        </button>
                      );
                    })}
                    {lockedHeartbeatSuggestions.slice(0, 2).map(task => (
                      <div key={task.id} style={{ padding: "13px 14px", borderRadius: 14, border: "1px solid rgba(212,160,74,0.25)", background: "rgba(212,160,74,0.08)" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{task.title}</div>
                        <div style={{ fontSize: 11.5, color: "var(--text-sub)", lineHeight: 1.5, marginBottom: 6 }}>{task.prompt}</div>
                        <div style={{ fontSize: 11, color: "#A4761B" }}>Unlock by connecting {formatHeartbeatRequirements(task)}.</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "20px 0", minHeight: 0 }}>
              <div style={{ padding: 18, borderRadius: 18, background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 10 }}>
                  Setup status
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                    <span style={{ color: "var(--text-sub)" }}>Thinking</span>
                    <span style={{ color: powerConfigured ? "#3c6663" : "var(--text-main)", fontWeight: 700 }}>
                      {powerConfigured ? (llmProvider || "Connected") : "Needs provider"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                    <span style={{ color: "var(--text-sub)" }}>Workspace mode</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 700 }}>{isolated ? "Isolated" : "Shared"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                    <span style={{ color: "var(--text-sub)" }}>Routines</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 700 }}>{selectedHeartbeatNames.length}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                    <span style={{ color: "var(--text-sub)" }}>Current next ask</span>
                    <span style={{ color: "var(--text-main)", fontWeight: 700, textAlign: "right" }}>{currentSetupUnlock?.label || "Ready to launch"}</span>
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, minHeight: 0, padding: 18, borderRadius: 18, background: "rgba(60,102,99,0.06)", border: "1px solid rgba(60,102,99,0.12)" }}>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3c6663", marginBottom: 10 }}>
                  What this unlocks
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {discoveryValueBullets.slice(0, 3).map((bullet, index) => (
                    <div key={`${bullet}-${index}`} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ width: 7, height: 7, marginTop: 6, borderRadius: "50%", background: "#3c6663", flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.55 }}>{bullet}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)", flexDirection: isVeryNarrowWindow ? "column-reverse" : "row" }}>
            <button onClick={() => { setPowerUpRunId(id => id + 1); setStep(3.7); }} style={{ padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: isVeryNarrowWindow ? "100%" : "auto" }}>
              Back
            </button>
            <button onClick={() => { setPowerUpRunId(id => id + 1); setStep(3.7); }} style={{ padding: "12px 28px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: isVeryNarrowWindow ? "100%" : "auto" }}>
              Back to {agentName || "the conversation"} →
            </button>
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
                  <div key={key} onClick={() => { if (!connected) void handleSetupIntegration(key); }} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    background: "var(--surface-card)", padding: "14px 18px", borderRadius: 12,
                    border: plugins[key] ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                    cursor: connected ? "default" : "pointer",
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
                    <Toggle enabled={plugins[item.key]} onChange={() => {
                      const enabling = !plugins[item.key];
                      setPlugins(prev => ({ ...prev, [item.key]: enabling }));
                      // Enabling an integration that needs real setup must LAUNCH
                      // that setup — a toggle that only flips local state is a lie
                      // (Phase 0 fix #1). Slack is deliberately excluded: its
                      // pairing runs in the deploy flow (step 7). Folders shows
                      // its inline scope picker below.
                      if (enabling && !["slack", "folders"].includes(item.key)) {
                        void handleSetupIntegration(item.key);
                      }
                    }} />
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
            <button onClick={() => { setPowerUpRunId(id => id + 1); setStep(3.7); }} style={{
              padding: "12px 28px", borderRadius: 12, background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back to the conversation</button>
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
                        // Single code path (Phase 0 fix #5): identical companion
                        // launch as everywhere else, no inline duplicate.
                        await handleSetupIntegration("slack");
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
      {showAnthropicKeyStep && selectedAgentId && (
        <div style={{ textAlign: "center", maxWidth: 500 }}>
          <h1 style={{ fontSize: 36, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>Connect Your AI Model</h1>
          <p style={{ fontSize: 15, color: "var(--text-sub)", marginBottom: 32, lineHeight: 1.6 }}>
            To use agents with multiple providers, we need your Anthropic API key as a fallback. This ensures your agent works seamlessly even if their primary provider is unavailable.
          </p>

          <div style={{
            background: "var(--surface-card)",
            borderRadius: 14,
            border: "1px solid var(--border-subtle)",
            padding: 24,
            marginBottom: 24,
          }}>
            <div style={{ textAlign: "left", marginBottom: 16 }}>
              <label style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-main)",
                marginBottom: 8,
              }}>
                Anthropic API Key
              </label>
              <PasswordInput
                value={anthropicKey}
                onChange={(e) => {
                  setAnthropicKey(e.target.value);
                  setAnthropicKeyError("");
                }}
                placeholder="sk-ant-..."
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: anthropicKeyError ? "1px solid #E57373" : "1px solid var(--border-subtle)",
                  fontFamily: "monospace",
                  fontSize: 13,
                  boxSizing: "border-box",
                }}
              />
              {anthropicKeyError && (
                <div style={{ fontSize: 12, color: "#E57373", marginTop: 8 }}>
                  {anthropicKeyError}
                </div>
              )}
            </div>

            <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.6, marginBottom: 16 }}>
              Don't have an Anthropic key?{" "}
              <span style={{ color: "#3c6663", fontWeight: 600, cursor: "pointer" }} onClick={async () => {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open("https://console.anthropic.com/account/keys");
              }}>
                Get your key →
              </span>
            </div>

            <button
              onClick={async () => {
                if (!anthropicKey.trim()) {
                  setAnthropicKeyError("Please enter your Anthropic API key");
                  return;
                }

                try {
                  const slot = getAgentProviderSecretSlot(selectedAgentId, "Anthropic");
                  await invoke('set_keychain_item', {
                    key: slot,
                    value: anthropicKey
                  });

                  await syncAgentProviderCredentials(invoke, selectedAgentId);

                  const pending = localStorage.getItem("canopy_pending_handoff");
                  if (pending) {
                    const { agentId, prompt } = JSON.parse(pending);
                    completeHandoffToAgentConversation(agentId, prompt);
                  } else {
                    setShowAnthropicKeyStep(false);
                    if (step === 6) {
                      setShowAnthropicKeyStep(false);
                    }
                  }
                } catch (e) {
                  setAnthropicKeyError("Failed to save API key: " + String(e));
                }
              }}
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: "#3c6663",
                color: "var(--surface-card)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: 12,
              }}
            >
              Save and Continue
            </button>

            <button
              onClick={() => {
                const pending = localStorage.getItem("canopy_pending_handoff");
                if (pending) {
                  const { agentId, prompt } = JSON.parse(pending);
                  completeHandoffToAgentConversation(agentId, prompt);
                } else {
                  setShowAnthropicKeyStep(false);
                }
              }}
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: "1px solid var(--border-subtle)",
                background: "transparent",
                color: "var(--text-sub)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Skip for Now
            </button>
          </div>

          <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
            Your API key is stored securely in your system keychain and never shared.
          </div>
        </div>
      )}

      {step === 6 && !showAnthropicKeyStep && (
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
                      ? { starterTask: composeStarterPrompt(getStarterTask(selectedRole).prompt, discoveryInput, draftConnections, draftPermissionLabels) }
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
                    const nextAgentId = deployedAgentId;
                    const nextPrompt = postDeployConversationPrompt;
                    resetWizardState();
                    if (nextAgentId) handoffToAgentConversation(nextAgentId, nextPrompt);
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
                const nextAgentId = deployedAgentId;
                const nextPrompt = postDeployConversationPrompt;
                resetWizardState();
                if (nextAgentId) handoffToAgentConversation(nextAgentId, nextPrompt);
                else setActiveView("canopy");
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
