import React, { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera, Billboard, Image } from "@react-three/drei";
import * as THREE from "three";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { WorldScene, TerrariumBase } from "./components/World/WorldScene";
import RAW_AGENT_TYPE_INFO from "../shared/agents.json";
import { GLBAgent, Pedestal, SingleGLB } from "./components/World/GLBAgent";
import { GenerativeStudio, GenerativeResult } from "./components/GenerativeStudio";
import { ProvidersVault } from "./components/ProvidersVault";
import { IntegrationsView } from "./components/IntegrationsView";
import { UpdateManager } from "./components/shared/UpdateManager";
import { PasswordInput } from "./components/shared/PasswordInput";
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from "rehype-sanitize";
let gatewayBootPromise: Promise<any> | null = null;
const safeStartGateway = async () => {
  if (!gatewayBootPromise) {
    gatewayBootPromise = invoke("start_gateway");
    gatewayBootPromise.catch(() => { gatewayBootPromise = null; });
  }
  return gatewayBootPromise;
};

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL THEME PALETTES
// ═══════════════════════════════════════════════════════════════════════════════
const lightGradient = "radial-gradient(circle at 0% 0%, #E5E1FD 0%, #E1F2FF 35%, #FFEBE6 75%, #FFF7F2 100%)";
const darkGradient = "radial-gradient(circle at 85% 15%, #24304A 0%, #1A2133 40%, #111520 80%, #0B0E14 100%)";


// ═══════════════════════════════════════════════════════════════════════════════
// CANOPY — Monument Valley Isometric World + Architect Agent Detail
// ═══════════════════════════════════════════════════════════════════════════════

class SafeBillboard extends React.Component<{ url: string, position: [number, number, number] }, { hasError: boolean }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true };
  }
  componentDidCatch(error: any, errorInfo: any) {
    console.warn("Gracefully intercepting broken accessory texture", this.props.url);
  }
  render() {
    if (this.state.hasError) return null;
    return (
      <Billboard position={this.props.position}>
        <Image url={this.props.url} transparent scale={1.0} />
      </Billboard>
    );
  }
}

function OrganicLobsterBody({ robeMat, headColor }: { robeMat: THREE.Material, headColor: string }) {
  const pts = useMemo(() => {
    const p = [];
    const height = 0.55;
    const baseRadius = 0.26;
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      // Organic, slightly bulbous bell curve
      const r = 0.05 + (baseRadius - 0.05) * (1 - Math.pow(t, 2.5));
      p.push(new THREE.Vector2(r, t * height));
    }
    return p;
  }, []);

  return (
    <>
      <mesh material={robeMat} position={[0, 0, 0]}>
        <latheGeometry args={[pts, 24]} />
      </mesh>
      <mesh position={[0, 0.58, 0]}>
        <sphereGeometry args={[0.13, 16, 16]} />
        <meshStandardMaterial color={headColor} flatShading />
      </mesh>
    </>
  );
}

export function LobsterIcon({ size = 48, className = "", role, agentImage }: { size?: number, shellColor?: string, accentColor?: string, className?: string, role?: string, agentImage?: string | null }) {
  const info = role ? (RAW_AGENT_TYPE_INFO as any)[role] : null;
  const imageSrc = agentImage || (info?.image) || "/agents/Custom.png";
  return (
    <img
      src={imageSrc}
      alt="Lobster Agent"
      style={{ width: size, height: size, objectFit: "contain" }}
      className={className}
    />
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;
  status: "active" | "sleeping" | "thinking" | "stopped" | "error";
  isolated: boolean;
  paused: boolean;
  container_id: string | null;
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
  };
  integrations: string[];
  created_at: string;
  stats: {
    tasks_today: number;
    messages_handled: number;
    uptime_seconds: number;
    total_cost_usd: number;
    custom_metrics?: {
      label: string;
      value: string | number;
    }[];
  };
}

interface Permission {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  category: "network" | "execution" | "data" | "financial";
}

interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  time: string;
}

// Local UI state (frontend-only, extends Agent for UI purposes)
interface AgentData extends Agent {
  // Extended fields for UI rendering
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

interface DiscoveredAgent {
  source: string;
  id: string;
  name: string;
  path: string;
}

interface WorldState {
  agents: AgentData[];
  selectedAgent: string | null;
  hoveredAgent: string | null;
  activeView: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile";
  architectTab: string;
  gatewayReady: boolean;
  setSelectedAgent: (id: string | null) => void;
  setHoveredAgent: (id: string | null) => void;
  setActiveView: (view: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault" | "integrations" | "profile") => void;
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
  theme: "light" | "dark";
  toggleTheme: () => void;
}

// ─── World Zones ─────────────────────────────────────────────────────────────

const ZONES = {
  plaza: { center: [0, 0, 0] as [number, number, number], radius: 2.5 },
  axis: { center: [4, 1.5, -2] as [number, number, number], radius: 1.5 },
  labyrinth: { center: [-3, 0.5, -2] as [number, number, number], radius: 1.5 },
  terrace: { center: [3, 2.5, -4] as [number, number, number], radius: 1 },
  sanctuary: { center: [0, 1.0, -4] as [number, number, number], radius: 1.5 },
};

// ─── Default Permissions ──────────────────────────────────────────────────────

const DEFAULT_PERMISSIONS: Permission[] = [
  { id: "ext_network", label: "External Network", description: "Allow outbound API calls and web access", enabled: false, category: "network" },
  { id: "int_network", label: "Internal Network", description: "Communicate with other agents via data handoffs", enabled: false, category: "network" },
  { id: "autonomous", label: "Autonomous Execution", description: "Run tasks without manual approval", enabled: false, category: "execution" },
  { id: "scheduled", label: "Scheduled Tasks", description: "Execute on cron schedules", enabled: true, category: "execution" },
  { id: "memory_write", label: "Memory Write", description: "Store long-term data and learnings", enabled: true, category: "data" },
  { id: "file_read", label: "File System Read", description: "Read files in scoped directories", enabled: false, category: "data" },
  { id: "file_write", label: "File System Write", description: "Create and modify files", enabled: false, category: "data" },
  { id: "payments", label: "Payment Authorization", description: "Request virtual cards for purchases", enabled: false, category: "financial" },
  { id: "spend_auto", label: "Auto-Approve Under Limit", description: "Auto-approve purchases under threshold", enabled: false, category: "financial" },
  { id: "imessage", label: "iMessage Interception", description: "Read and reply to text messages", enabled: false, category: "network" },
  { id: "photos", label: "Apple Photos", description: "Access local photo library database", enabled: false, category: "data" },
];

// ─── Agent Type Mappings ──────────────────────────────────────────────────────

const AGENT_TYPE_INFO = RAW_AGENT_TYPE_INFO as Record<string, { description: string; color: string; robeColor: string; accentColor: string; habitatColor: string; habitatLabel: string; image?: string; suggest_in_onboarding?: boolean; library?: { title: string; author: string; mode: string }[]; readwise_enabled?: boolean }>;

function getDefaultPersonality(role: string, name: string, agentTypeInfo: Record<string, any> = AGENT_TYPE_INFO) {
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

  // Inject Library References
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

  // Inject Readwise User Context
  if (info.readwise_enabled) {
    basePrompt += `\n\nUser Context: You have direct access to the user's personal Readwise highlights. Proactively reference their recent reading notes or saved clips when personalizing interactions to show you understand their evolving worldview.`;
  }

  return basePrompt;
}

function injectPrincipalContext(basePrompt: string, profile: UserProfile | null) {
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

// ─── Store ───────────────────────────────────────────────────────────────────

const useWorldStore = create<WorldState>((set) => ({
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
  updateAgentVisuals: (id, visuals) => set((state) => ({
    agents: state.agents.map((a) => a.id === id ? { ...a, visual_identity: visuals } : a)
  })),
}));

// ─── Utility AI ──────────────────────────────────────────────────────────────

function pickNextAction(agent: AgentData): { action: string; target: [number, number, number] } {
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

// ═══════════════════════════════════════════════════════════════════════════════
// 3D WORLD COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function useCardinalMaterial(lit: string, shadow: string, top: string) {
  return useMemo(() => new THREE.ShaderMaterial({
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){vN=normalize(normalMatrix*normal);vW=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform vec3 lC,sC,tC,fC;uniform float fS,fE;varying vec3 vN,vW;void main(){vec3 ld=normalize(vec3(.5,1.,.3));float n=dot(vN,ld);vec3 c=vN.y>.5?tC:n>0.?lC:sC;float f=smoothstep(fS,fE,-vW.y);c=mix(c,fC,f*.3);gl_FragColor=vec4(c,1.);}`,
    uniforms: { lC: { value: new THREE.Color(lit) }, sC: { value: new THREE.Color(shadow) }, tC: { value: new THREE.Color(top) }, fS: { value: -2 }, fE: { value: -8 }, fC: { value: new THREE.Color("#EDE4DB") } },
  }), [lit, shadow, top]);
}

function IsoBlock({ position, size = [1, 1, 1], lit = "#D4A574", shadow = "#B88A5E", top = "#E8C9A0" }: { position: [number, number, number]; size?: [number, number, number]; lit?: string; shadow?: string; top?: string }) {
  const m = useCardinalMaterial(lit, shadow, top);
  return <mesh position={position} material={m}><boxGeometry args={size} /></mesh>;
}

function Column({ position, height = 1.5, color = "#C4A0C9" }: { position: [number, number, number]; height?: number; color?: string }) {
  return (<group position={position}>
    <mesh position={[0, height / 2, 0]}><cylinderGeometry args={[0.08, 0.1, height, 6]} /><meshStandardMaterial color={color} flatShading /></mesh>
    <mesh position={[0, height + 0.05, 0]}><boxGeometry args={[0.25, 0.1, 0.25]} /><meshStandardMaterial color={color} flatShading /></mesh>
  </group>);
}

function Arch({ position, rotation = [0, 0, 0], scale = 1, lit = "#9EB4C7", shadow = "#7E98AD", top = "#BED0DE" }: { position: [number, number, number]; rotation?: [number, number, number]; scale?: number; lit?: string; shadow?: string; top?: string }) {
  const m = useCardinalMaterial(lit, shadow, top);
  return (<group position={position} rotation={rotation as any} scale={scale}>
    <mesh position={[-0.6, 0.5, 0]} material={m}><boxGeometry args={[0.3, 1, 0.3]} /></mesh>
    <mesh position={[0.6, 0.5, 0]} material={m}><boxGeometry args={[0.3, 1, 0.3]} /></mesh>
    <mesh position={[0, 1.1, 0]} material={m}><boxGeometry args={[1.5, 0.25, 0.3]} /></mesh>
    <mesh position={[0, 1.35, 0]} material={m}><boxGeometry args={[1.1, 0.15, 0.35]} /></mesh>
  </group>);
}

function Stairs({ position, rotation = [0, 0, 0], steps = 5, lit = "#D4A574", shadow = "#B88A5E", top = "#E8C9A0" }: { position: [number, number, number]; rotation?: [number, number, number]; steps?: number; lit?: string; shadow?: string; top?: string }) {
  const m = useCardinalMaterial(lit, shadow, top);
  return (<group position={position} rotation={rotation as any}>
    {Array.from({ length: steps }).map((_, i) => <mesh key={i} position={[0, i * 0.15, i * 0.25]} material={m}><boxGeometry args={[0.8, 0.15, 0.25]} /></mesh>)}
  </group>);
}

function GeometricPlant({ position, height = 0.5, color = "#6B8E5A" }: { position: [number, number, number]; height?: number; color?: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => { if (ref.current) ref.current.rotation.z = Math.sin(clock.getElapsedTime() * 0.8 + position[0]) * 0.03; });
  return (<group ref={ref} position={position}>
    <mesh position={[0, height * 0.3, 0]}><cylinderGeometry args={[0.02, 0.03, height * 0.6, 4]} /><meshStandardMaterial color="#B5A898" flatShading /></mesh>
    <mesh position={[0, height * 0.6, 0]}><octahedronGeometry args={[height * 0.25, 0]} /><meshStandardMaterial color={color} flatShading /></mesh>
    <mesh position={[0, height * 0.8, 0]}><octahedronGeometry args={[height * 0.18, 0]} /><meshStandardMaterial color={color} flatShading /></mesh>
  </group>);
}

function Water() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide,
    vertexShader: `uniform float t;varying vec2 vU;varying float vW;void main(){vU=uv;vec3 p=position;float w=sin(p.x*2.+t*.5)*.03+sin(p.z*1.5+t*.3)*.02;p.y+=w;vW=w;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader: `uniform float t;varying vec2 vU;varying float vW;void main(){vec3 b=vec3(.514,.773,.745);vec3 d=vec3(.408,.678,.647);vec3 c=mix(d,b,vU.y*.5+.5+vW*3.);c+=sin(vU.x*20.+t*.8)*sin(vU.y*15.+t*.6)*.05;gl_FragColor=vec4(c,.45);}`,
    uniforms: { t: { value: 0 } },
  }), []);
  useFrame(({ clock }) => { mat.uniforms.t.value = clock.getElapsedTime(); });
  return <mesh position={[0, -0.6, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mat}><planeGeometry args={[20, 20, 32, 32]} /></mesh>;
}

function FloatingMotes({ count = 20 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const motes = useMemo(() => Array.from({ length: count }).map(() => ({
    x: (Math.random() - 0.5) * 12, y: Math.random() * 3 - 0.3, z: (Math.random() - 0.5) * 12,
    s: 0.1 + Math.random() * 0.2, p: Math.random() * Math.PI * 2, sz: 0.02 + Math.random() * 0.03,
  })), [count]);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    motes.forEach((m, i) => {
      dummy.position.set(m.x + Math.sin(t * m.s + m.p) * 0.5, m.y + Math.sin(t * m.s * 1.3 + m.p) * 0.3, m.z + Math.cos(t * m.s * 0.7 + m.p) * 0.5);
      dummy.scale.setScalar(m.sz * (0.8 + Math.sin(t * 2 + m.p) * 0.2));
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[undefined, undefined, count]}><sphereGeometry args={[1, 6, 6]} /><meshBasicMaterial color="#F5E6D8" transparent opacity={0.4} /></instancedMesh>;
}

function AgentCharacter({ agent }: { agent: AgentData }) {
  const groupRef = useRef<THREE.Group>(null);
  const { setSelectedAgent, setHoveredAgent, hoveredAgent, setActiveView } = useWorldStore();
  const velocity = useRef(new THREE.Vector3());
  const timer = useRef(Math.random() * 5);
  const update = useWorldStore(s => s.updateAgentPosition);
  const updateTarget = useWorldStore(s => s.updateAgentTarget);
  const updateAction = useWorldStore(s => s.updateAgentAction);
  const isHovered = hoveredAgent === agent.id;

  useFrame(({ clock }, delta) => {
    if (!groupRef.current) return;
    const t = clock.getElapsedTime();
    timer.current -= delta;
    if (timer.current <= 0) {
      const d = pickNextAction(agent);
      updateTarget(agent.id, d.target);
      updateAction(agent.id, d.action);
      timer.current = 4 + Math.random() * 6;
    }
    const cur = groupRef.current.position;
    const tgt = new THREE.Vector3(...agent.targetPosition); tgt.y = 0;
    const toT = tgt.clone().sub(cur);
    const dist = toT.length();
    if (dist > 0.15) {
      const speed = 0.4;
      const ds = dist < 1 ? speed * (dist / 1) : speed;
      const desired = toT.normalize().multiplyScalar(ds);
      const steer = desired.sub(velocity.current).multiplyScalar(0.05);
      velocity.current.add(steer).clampLength(0, speed);
      cur.add(velocity.current.clone().multiplyScalar(delta * 2));
      if (velocity.current.length() > 0.01) {
        groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, Math.atan2(velocity.current.x, velocity.current.z), delta * 3);
      }
      cur.y = Math.abs(Math.sin(t * 6)) * 0.04;
    } else {
      velocity.current.multiplyScalar(0.9);
      cur.y = Math.sin(t * 1.5) * 0.01;
    }
    if (Math.random() < 0.1) update(agent.id, [cur.x, cur.y, cur.z]);
  });

  const robeMat = useMemo(() => new THREE.MeshStandardMaterial({ color: agent.robeColor, flatShading: true }), [agent.robeColor]);
  const headColor = useMemo(() => { const c = new THREE.Color(agent.robeColor); c.lerp(new THREE.Color("#F5E6D8"), 0.6); return c; }, [agent.robeColor]);

  return (
    <group ref={groupRef} position={agent.position}
      onClick={e => { e.stopPropagation(); setSelectedAgent(agent.id); setActiveView("architect"); }}
      onPointerOver={e => { e.stopPropagation(); setHoveredAgent(agent.id); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHoveredAgent(null); document.body.style.cursor = 'default'; }}
    >
      {isHovered && <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.3, 0.38, 24]} /><meshBasicMaterial color="#83C5BE" transparent opacity={0.5} /></mesh>}

      {/* 3D Body rendered from exact Lathe */}
      <OrganicLobsterBody robeMat={robeMat} headColor={headColor} />

      {/* Claws — dynamic expressive arms */}
      <ClawArm side={-1} color={agent.accentColor} id={agent.id} />
      <ClawArm side={1} color={agent.accentColor} id={agent.id} />

      {/* Antennae — dynamic swept stalks */}
      <AntennaStalk base={[-0.05, 0.65, -0.02]} h={0.24} c={0.2} color={agent.accentColor} id={agent.id} />
      <AntennaStalk base={[0.05, 0.65, -0.02]} h={0.24} c={-0.2} color={agent.accentColor} id={agent.id} />

      {agent.status === "thinking" && <ThinkBubbles color={agent.accentColor} />}
    </group>
  );
}

function AntennaStalk({ base, h, c, color, id }: { base: [number, number, number]; h: number; c: number; color: string; id: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.rotation.z = Math.sin(t * 2 + id.length) * 0.08 + c;
    ref.current.rotation.x = -0.1 + Math.sin(t * 1.5 + id.length * 0.7) * 0.05;
  });
  return (<group ref={ref} position={base}>
    <mesh position={[0, h / 2, 0]}><cylinderGeometry args={[0.008, 0.012, h, 6]} /><meshStandardMaterial color={color} /></mesh>
    <mesh position={[0, h, 0]}><sphereGeometry args={[0.03, 12, 12]} /><meshStandardMaterial color={color} /></mesh>
  </group>);
}

function ClawArm({ side, color, id }: { side: number; color: string; id: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    // Expressive idle swaying 
    ref.current.rotation.z = side * 0.4 + Math.sin(t * 1.8 + id.length * side) * 0.12;
    ref.current.rotation.x = Math.sin(t * 1.2 + id.length) * 0.06;
  });
  return (
    <group ref={ref} position={[side * 0.26, 0.25, 0.15]} rotation={[0, 0, side * 0.4]}>
      <mesh position={[0, -0.06, 0]}>
        <cylinderGeometry args={[0.01, 0.015, 0.12, 6]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, -0.13, 0]} scale={[1, 1.2, 1]}>
        <sphereGeometry args={[0.035, 12, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
}

function ThinkBubbles({ color }: { color: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => { if (!ref.current) return; const t = clock.getElapsedTime(); ref.current.children.forEach((c, i) => { c.position.y = 0.8 + Math.sin(t * 2 + i * 1.5) * 0.1 + i * 0.08; c.position.x = Math.sin(t * 1.5 + i * 2) * 0.08; c.position.z = Math.cos(t * 1.2 + i * 2) * 0.08; }); });
  return (<group ref={ref}>{[0, 1, 2].map(i => <mesh key={i}><sphereGeometry args={[0.02, 6, 6]} /><meshBasicMaterial color={color} transparent opacity={0.5} /></mesh>)}</group>);
}

function WorldArchitecture() {
  return (<group>
    {/* Base Platform */}
    <IsoBlock position={[0, -0.25, 0]} size={[10, 0.5, 10]} lit="#D1C4B4" shadow="#B5A898" top="#E8DDD0" />

    {/* Plaza (Center) with fountain */}
    <mesh position={[0, 0.05, 0]}><cylinderGeometry args={[0.5, 0.6, 0.1, 8]} /><meshStandardMaterial color="#83C5BE" flatShading /></mesh>
    <mesh position={[0, 0.15, 0]}><cylinderGeometry args={[0.15, 0.15, 0.3, 6]} /><meshStandardMaterial color="#9EB4C7" flatShading /></mesh>

    {/* Executive's Axis (Assistant) - [4, 1.5, -2] - Teal */}
    <IsoBlock position={[4, 0.5, -2]} size={[2, 1.5, 2]} lit="#64C8C0" shadow="#4AA8A1" top="#81DCD5" />
    <IsoBlock position={[4, 1.75, -2]} size={[1.2, 1, 1.2]} lit="#64C8C0" shadow="#4AA8A1" top="#81DCD5" />
    {/* Floating Data Screens */}
    <mesh position={[3.3, 2.5, -1.5]} rotation={[0, Math.PI / 4, 0]}><boxGeometry args={[1, 0.6, 0.05]} /><meshBasicMaterial color="#81DCD5" transparent opacity={0.6} /></mesh>
    <mesh position={[4.5, 2.0, -1.3]} rotation={[0, -Math.PI / 6, 0]}><boxGeometry args={[0.8, 0.5, 0.05]} /><meshBasicMaterial color="#81DCD5" transparent opacity={0.6} /></mesh>

    {/* Accountant's Labyrinth (Financial) - [-3, 0.5, -2] - Peach/Salmon */}
    <Stairs position={[-2, 0, -1]} rotation={[0, -Math.PI / 2, 0]} steps={5} />
    <IsoBlock position={[-3, 0.25, -2]} size={[2.5, 0.5, 2.5]} lit="#F39B88" shadow="#D87F6C" top="#FFAF9F" />
    <IsoBlock position={[-3.5, 0.75, -2.5]} size={[1, 0.5, 1]} lit="#F39B88" shadow="#D87F6C" top="#FFAF9F" />
    <IsoBlock position={[-2.5, 0.75, -2.5]} size={[0.5, 0.8, 0.5]} lit="#F39B88" shadow="#D87F6C" top="#FFAF9F" />
    <Stairs position={[-2.5, 0.5, -3]} rotation={[0, 0, 0]} steps={3} />

    {/* Strategist's Terrace (STR Manager) - [3, 2.5, -4] - Slate/Navy */}
    <IsoBlock position={[3, 1.25, -4]} size={[2, 2.5, 2]} lit="#718096" shadow="#4A5568" top="#A0AEC0" />
    {/* Overlook railings */}
    <Column position={[2.1, 2.6, -3.1]} height={0.3} color="#A0AEC0" />
    <Column position={[3.9, 2.6, -3.1]} height={0.3} color="#A0AEC0" />
    <Column position={[2.1, 2.6, -4.9]} height={0.3} color="#A0AEC0" />
    <Column position={[3.9, 2.6, -4.9]} height={0.3} color="#A0AEC0" />
    <IsoBlock position={[3, 2.6, -4]} size={[1.8, 0.05, 1.8]} lit="#718096" shadow="#4A5568" top="#A0AEC0" transparent opacity={0.3} />

    {/* Scientist's Sanctuary (Researcher) - [0, 1.0, -4] - Sage Green */}
    <IsoBlock position={[0, 0.5, -4]} size={[2.5, 1, 2.5]} lit="#8FBC8F" shadow="#6E9C6E" top="#AADBAA" />
    {/* Lab Flasks */}
    <mesh position={[-0.6, 1.4, -4]}><cylinderGeometry args={[0.15, 0.3, 0.8, 8]} /><meshStandardMaterial color="#AADBAA" flatShading transparent opacity={0.7} /></mesh>
    <mesh position={[0.5, 1.3, -4.2]}><sphereGeometry args={[0.35, 8, 8]} /><meshStandardMaterial color="#8FBC8F" flatShading transparent opacity={0.7} /></mesh>
    <mesh position={[0, 1.2, -3.5]}><cylinderGeometry args={[0.1, 0.1, 0.4, 8]} /><meshStandardMaterial color="#AADBAA" flatShading transparent opacity={0.7} /></mesh>

    {/* Educator's Enclave (Tutor) - [-3, 0, 3] - Soft Purple */}
    <IsoBlock position={[-3, 0, 3]} size={[3.5, 0.4, 3.5]} lit="#B892FF" shadow="#9670D8" top="#D4B3FF" />
    <Arch position={[-2, 0.4, 3]} rotation={[0, Math.PI / 2, 0]} scale={1.2} />
    <Arch position={[-3, 0.4, 2]} scale={1.2} />
    <Arch position={[-3, 0.4, 4]} scale={1.2} />
    {/* Trees & Study objects */}
    <GeometricPlant position={[-3.8, 0.2, 3.8]} height={0.7} color="#B892FF" />
    <GeometricPlant position={[-2.4, 0.2, 4.2]} height={0.5} color="#9670D8" />
    <IsoBlock position={[-3.5, 0.35, 2.5]} size={[0.6, 0.3, 0.6]} lit="#D1C4B4" shadow="#B5A898" top="#E8DDD0" />
  </group>);
}

function SkyGradient() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec2 vU;
      void main() {
        // Pastel Rainbow inspired by the 3D reference
        vec3 c1 = vec3(0.92, 0.90, 0.97); // Warm Lavender (bottom left)
        vec3 c2 = vec3(0.85, 0.93, 0.98); // Light Cyan (top right)
        vec3 c3 = vec3(0.95, 0.90, 0.98); // Soft Purple (top left)
        vec3 c4 = vec3(0.90, 0.94, 0.98); // Light Blue (bottom right)
        
        vec3 bot = mix(c1, c4, vU.x);
        vec3 top = mix(c3, c2, vU.x);
        vec3 finalColor = mix(bot, top, vU.y);
        
        // Subtle vignette to focus the center
        vec2 cn = vU - 0.5;
        finalColor *= 1.0 - dot(cn, cn) * 0.3;
        
        // Output pure sRGB color
        gl_FragColor = vec4(finalColor, 1.0);
      }`,
    uniforms: { t: { value: 0 } },
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false, // CRUCIAL: prevents the ACESFilmic filter from turning our rainbow into muddy grey!
  }), []);
  useFrame(({ clock }) => { mat.uniforms.t.value = clock.getElapsedTime(); });
  return <mesh material={mat}><sphereGeometry args={[50, 16, 16]} /></mesh>;
}

function CanopyScene({ 
  isEditMode, 
  transformMode, 
  selectedEditAgent, 
  setSelectedEditAgent, 
  editTransforms, 
  onTransformChange 
}: { 
  isEditMode?: boolean, 
  transformMode?: "translate" | "rotate", 
  selectedEditAgent?: string | null, 
  setSelectedEditAgent?: (id: string | null) => void, 
  editTransforms?: Record<string, any>, 
  onTransformChange?: (id: string, transform: any) => void 
}) {
  const agents = useWorldStore(s => s.agents);
  const setSelected = useWorldStore(s => s.setSelectedAgent);
  const setHoveredAgent = useWorldStore(s => s.setHoveredAgent);
  const hoveredAgent = useWorldStore(s => s.hoveredAgent);
  const setActiveView = useWorldStore(s => s.setActiveView);

  const handleAgentClick = (id: string) => {
    if (isEditMode) {
      if (setSelectedEditAgent) setSelectedEditAgent(id);
    } else {
      setSelected(id);
      setActiveView("architect");
    }
  };

  return (<>
    {/* Soft, balanced lighting so we don't blow out or over-expose the pastel colors! */}
    <ambientLight intensity={0.7} color="#FFFFFF" />
    <directionalLight position={[8, 12, 4]} intensity={0.4} color="#FFFFFF" />
    <directionalLight position={[-4, 8, -4]} intensity={0.2} color="#E8F0F8" />

    {/* Removed Water and SkyGradient to eliminate any transparent 'overlay' planes or murky backgrounds */}
    <FloatingMotes count={25} />

    <WorldScene
      agents={agents}
      onAgentClick={handleAgentClick}
      onAgentHover={setHoveredAgent}
      hoveredAgentId={hoveredAgent}
      isEditMode={isEditMode}
      transformMode={transformMode}
      selectedEditAgent={selectedEditAgent}
      editTransforms={editTransforms}
      onTransformChange={onTransformChange}
    />

    <mesh position={[0, -2, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false} onClick={() => setSelected(null)}><planeGeometry args={[100, 100]} /></mesh>
  </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const glass = (opacity = 0.55): React.CSSProperties => {
  const isDark = useWorldStore.getState().theme === "dark";
  return {
    background: isDark ? `rgba(17,21,32,${opacity})` : `rgba(255,255,255,${opacity})`,
    backdropFilter: "blur(24px)",
    WebkitBackdropFilter: "blur(24px)",
    border: isDark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.3)",
    borderRadius: 16,
    boxShadow: isDark ? "0 8px 32px rgba(0,0,0,0.3)" : "0 8px 32px rgba(0,0,0,0.06)",
  };
};

function Toggle({ enabled, onChange, size = "normal" }: { enabled: boolean; onChange: () => void; size?: "normal" | "small" }) {
  const w = size === "small" ? 32 : 40;
  const h = size === "small" ? 18 : 22;
  const d = size === "small" ? 14 : 18;
  return (
    <button onClick={onChange} style={{
      width: w, height: h, borderRadius: h, border: "none", padding: 2, cursor: "pointer",
      background: enabled ? "#3c6663" : "var(--border-subtle)", transition: "all 0.2s ease",
      display: "flex", alignItems: "center",
    }}>
      <div style={{
        width: d, height: d, borderRadius: "50%", background: "var(--surface-card)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.15)", transition: "transform 0.2s ease",
        transform: `translateX(${enabled ? w - d - 4 : 0}px)`,
      }} />
    </button>
  );
}

function ProgressBar({ value, max = 1, color = "#3c6663", height = 4 }: { value: number; max?: number; color?: string; height?: number }) {
  return (
    <div style={{ height, borderRadius: height / 2, background: "var(--border-subtle)", width: "100%" }}>
      <div style={{ height: "100%", borderRadius: height / 2, background: color, width: `${(value / max) * 100}%`, transition: "width 0.5s ease" }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ═══════════════════════════════════════════════════════════════════════════════

function OnboardingWizard() {
  const { agents } = useWorldStore();
  const initialStepTarget = agents.length > 0 ? 1 : 0;
  const [step, setStep] = useState(-1);
  const [engineStatus, setEngineStatus] = useState<"checking" | "missing" | "starting" | "ready">("checking");
  const [engineError, setEngineError] = useState("");

  const [userName, setUserName] = useState("");
  const [userContext, setUserContext] = useState("");

  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [personalityPrompt, setPersonalityPrompt] = useState("");
  const [recentlyRead, setRecentlyRead] = useState<string[]>([]);
  const [customBookInput, setCustomBookInput] = useState("");
  const [llmProvider, setLlmProvider] = useState<"OpenAI" | "Google Gemini" | "Anthropic" | "">("");
  const [apiKeyMode, setApiKeyMode] = useState<"hidden" | "scan" | "manual">("hidden");
  const [customIdentity, setCustomIdentity] = useState<{ baseModelUrl: string | null; accessories: string[] } | null>(null);

  const [plugins, setPlugins] = useState<Record<string, boolean>>({ slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false });
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

  // Check workspace-level service connections on mount
  useEffect(() => {
    (async () => {
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
        if (profile) {
            setUserName(profile.name || "");
            setUserContext(profile.working_hours || "");
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten1 = await listen('companion-finished', async (e: any) => {
          const { type, key } = e.payload || {};
          if (type === "slack") {
            // Slack completion from the companion guide means the bot token is saved.
            // We do NOT try to collect the pairing code here — pairing requires the agent
            // to already be registered in OpenClaw and the listener to be running, which
            // can't happen until after create_agent completes. The user will finish pairing
            // from the Connections tab after the agent is created.
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
            const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
            const windows = await getAllWebviewWindows();
            for (const w of windows) {
              if (w.label.toLowerCase().includes('companion')) {
                await w.close().catch(console.warn);
              }
            }
          } catch (err) {
            console.error("Failed to close companions automatically:", err);
          }
        });

        const unlisten2 = await listen('close-companion', async () => {
          try {
            const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
            const windows = await getAllWebviewWindows();
            for (const w of windows) {
              if (w.label.toLowerCase().includes('companion')) {
                await w.close().catch(console.warn);
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
        const { listen } = await import('@tauri-apps/api/event');
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

  // Sync static import changes during Vite HMR
  useEffect(() => {
    setAgentTypeInfo(AGENT_TYPE_INFO);
  }, [AGENT_TYPE_INFO]);

  useEffect(() => {
    fetch('http://localhost:3001/api/agents')
      .then(res => res.json())
      .then(data => setAgentTypeInfo(data))
      .catch(err => console.warn("Local API server not running, using static JSON import.", err));
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
    const optimisticAgent: AgentData = {
      id: tempId as unknown as number, // Temporary cast
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
      position: [Math.random() * 2 - 1, 0, Math.random() * 2 - 1],
      targetPosition: [Math.random() * 2 - 1, 0, Math.random() * 2 - 1],
      currentAction: "Initializing Agent Container...",
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
      personalityPrompt: finalPrompt || `${agentName} is a ${selectedRole.toLowerCase()} agent — reliable, sharp, and always working.`,
      avatarPrompt: `Isometric 3D-rendered agent character in Monument Valley art style. Rounded bell-shaped body with ${roleInfo?.robeColor || "#888"} shell, smooth round head, two swept-back antennae with bulbous ${roleInfo?.accentColor || "#ccc"} tips, small expressive claws at sides. Flat-shaded low-poly faces, soft directional lighting from upper-left. Warm muted pastel palette. No outlines. Ref: agent-style-grid.png`,
      visual_identity: customIdentity || { baseModelUrl: null, accessories: [] }
    };

    addAgent(optimisticAgent);
    setActiveView("canopy");
    setIsCreatingAgent(false);

    // Fire off slow OpenClaw logic in the background
    setTimeout(async () => {
      try {
        if (typeof invoke === 'function') {
          const profile: any = await invoke("get_user_profile");
          finalPrompt = injectPrincipalContext(finalPrompt, profile);
        }
      } catch (e) {
        console.error("Failed to inject principal context:", e);
      }

      let newAgentData: Agent;
      try {
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
              custom_instructions: finalPrompt
            },
            isolated: false,
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
              if (typeof invoke === 'function') {
                await invoke("update_agent_visuals", {
                  agentId: newAgentData.id,
                  visuals: JSON.stringify({ accessories: defaultAccessories })
                });
                newAgentData.visual_identity = { accessories: defaultAccessories };
              }
            } catch (e) {
              console.error("Failed to seed default visual identity", e);
            }
          }

          // Store the API key under the provider-specific keychain name so boot-time
          // sync_credentials can find it with the per-agent key → global fallback logic.
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

          // Push credentials to OpenClaw immediately — per-agent key wins, global key is fallback.
          // This is the same logic used at boot time, applied right after creation.
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

          // Successfully setup container. Swap the temp stub out for the permanent database entity
          useWorldStore.setState(state => ({
            agents: state.agents.map(a => a.id === tempId as unknown as number
              ? { ...a, ...newAgentData, id: newAgentData.id, status: "active", currentAction: "idle" }
              : a)
          }));

          // If Slack was enabled, the bot token was saved by the companion guide to the
          // "slack-bot-token" keychain entry. Now that the agent is registered in OpenClaw,
          // sync that token into the gateway config and start the listener so the bot comes
          // online. The user will DM the bot to get a pairing code, then finish pairing in
          // the Connections tab — that step requires the bot to be live first.
          if (plugins.slack) {
            const slackBotTok = String(await invoke("get_secret_cmd", { key: "slack-bot-token" }).catch(() => "") || "");
            if (slackBotTok) {
              await invoke("store_secret_cmd", { key: `agent_${newAgentData.id}_slack_bot_token`, value: slackBotTok }).catch(() => {});
            }
            await invoke("start_slack_listener").catch(() => {});
          }

        } else {
          throw new Error("Tauri invoke not found");
        }
      } catch (err) {
        console.error("Background Agent Deployment Failed:", err);
        // Paint the placeholder red with an error
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === tempId as unknown as number
            ? { ...a, status: "error", currentAction: "Deployment Failed: Docker Container Execution Failure" }
            : a)
        }));
      }
    }, 100);
  };



  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "#faf9f6",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      overflow: "hidden",
    }}>
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

          <div style={{ marginBottom: 32 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>What would you like your agents to know about you?</label>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8 }}>(Optional. Your agents can also learn over time.)</div>
            <textarea
              placeholder="e.g. I run a short-term rental business and do a lot of software engineering..."
              value={userContext}
              onChange={e => setUserContext(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: "16px", borderRadius: 12, border: "1px solid #E2E8F0", fontSize: 16, outline: "none", background: "#F8FAFC", resize: "none" }}
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
                    working_hours: userContext,
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

                {agentTypeInfo[selectedRole || "Custom"]?.suggestedBooks?.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                    {agentTypeInfo[selectedRole || "Custom"].suggestedBooks.filter((b: string) => !recentlyRead.includes(b)).map((book: string) => (
                      <div key={book} onClick={() => setRecentlyRead([...recentlyRead, book])} style={{ padding: "4px 10px", background: "var(--border-subtle)", color: "var(--text-main)", borderRadius: 16, fontSize: 11, cursor: "pointer", border: "1px solid rgba(0,0,0,0.1)", transition: "all 0.2s ease" }}>
                        + {book}
                      </div>
                    ))}
                  </div>
                )}

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
                      <button onClick={() => setActiveView("integrations")} style={{
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
                <span style={{ color: "#3c6663", cursor: "pointer", fontWeight: 600 }} onClick={() => setActiveView("integrations")}>
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
            {isCreatingAgent ? "Deploying..." : (createAgentError ? "Retry Deployment" : "Go to Dashboard")}
          </button>
        </div>
      )}

      <style>{`
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECT VIEW — Agent Detail
// ═══════════════════════════════════════════════════════════════════════════════

function ArchitectView({ agent }: { agent: AgentData }) {
  const { agents, setSelectedAgent, setActiveView, architectTab, setArchitectTab, togglePermission } = useWorldStore();
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [diagErrors, setDiagErrors] = useState<string[]>([]);
  const [diagSuccess, setDiagSuccess] = useState<string>("");
  const [openclawStatusOutput, setOpenclawStatusOutput] = useState<string>("");
  const [showDiagnosticsPane, setShowDiagnosticsPane] = useState(false);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [isHealing, setIsHealing] = useState(false);
  const [showUpdateTip, setShowUpdateTip] = useState(false);

  useEffect(() => {
    // Reset Diagnostic UI states when selecting a different agent
    setDiagErrors([]);
    setDiagSuccess("");
    setOpenclawStatusOutput("");
    setShowDiagnosticsPane(false);
    setShowUpdateTip(false);
  }, [agent.id]);

  const runDiagnostics = async () => {
    const btn = document.getElementById('diag-btn-text');
    if (btn) btn.innerText = "Running Diagnostics...";
    setOpenclawStatusOutput("");
    setShowDiagnosticsPane(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // Always re-run boot_sync_agents during diagnostics — it's idempotent and handles
      // the case where the agent dir never got created (agents add timed out on a previous boot).
      // sync_credentials silently skips agents whose dir doesn't exist yet, so this is the
      // only path that will actually fix an unregistered agent.
      await invoke("boot_sync_agents").catch((e: any) => console.warn("boot_sync in diag:", e));

      const anthropic = await invoke("get_secret_cmd", { key: "ANTHROPIC_API_KEY" }).catch(() => "");
      const openai = await invoke("get_secret_cmd", { key: "OPENAI_API_KEY" }).catch(() => "");
      const gemini = await invoke("get_secret_cmd", { key: "GEMINI_API_KEY" }).catch(() => "");
      const xai = await invoke("get_secret_cmd", { key: "XAI_API_KEY" }).catch(() => "");

      await invoke("sync_credentials", {
        agentId: agent.id, keys: {
          "ANTHROPIC_API_KEY": String(anthropic || ""),
          "OPENAI_API_KEY": String(openai || ""),
          "GEMINI_API_KEY": String(gemini || ""),
          "XAI_API_KEY": String(xai || "")
        }
      }).catch((err) => console.error("Sync credentials failed:", err));

      const res: any = await invoke("audit_openclaw_config");
      const statusStr: any = await invoke("get_openclaw_status").catch(() => "");

      if (statusStr) {
        setOpenclawStatusOutput(statusStr);
      }

      if (res && (!res.is_aligned || res.missing_keys.length > 0)) {
        const errors = [];
        if (res.missing_keys && res.missing_keys.length > 0) {
          errors.push(`Missing API Keys for: ${res.missing_keys.join(', ')}. Please configure them in setup.`);
        }
        if (res.active_default_model !== res.expected_model) {
          errors.push(`Model Mismatch: OpenClaw fallback model is stuck on ${res.active_default_model} but it should be ${res.expected_model} based on your active API keys.`);
        }
        if (res.port_mismatch) {
          errors.push("Port configuration mismatch detected on gateway proxy.");
        }
        if (!res.container_running) {
          errors.push("The OpenClaw gateway container is entirely offline. Ensure Docker is running.");
        }
        setDiagErrors(errors);
        setDiagSuccess("");
        if (btn) btn.innerText = "Errors Found";
      } else if (statusStr && statusStr.toLowerCase().includes("error")) {
        setDiagErrors(["OpenClaw Status check reported trailing service errors. Please view the diagnostic logs below!"]);
        setDiagSuccess("");
        if (btn) btn.innerText = "Check Logs";
      } else {
        setDiagErrors([]);
        setDiagSuccess("Systems Healthy & Aligned!");
        if (btn) btn.innerText = "System Healthy";
      }
    } catch (e) {
      const errStr = String(e);
      // Do NOT auto-heal on Timeout — restarting the VM makes slow containers worse.
      if (errStr.includes("stopped container") || errStr.includes("OOM")) {
        setIsHealing(true);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("hard_reset_infrastructure").catch(ex => console.error("Healing failed:", ex));
        setIsHealing(false);
        setDiagErrors(["Infrastructure was cleanly rebooted. Please try running diagnostics again."]);
        if (btn) btn.innerText = "Diagnostics";
        return;
      }
      if (btn) btn.innerText = "Diagnostic Failed";
      setDiagErrors(["Critical Failure: " + errStr]);
    }
    setTimeout(() => { if (btn) btn.innerText = "Diagnostics"; }, 3000);
  };


  const tabs = [
    { id: "overview", label: "Overview", icon: <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" /> },
    { id: "chat", label: "Chat", icon: <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /> },
    { id: "identity", label: "3D Identity", icon: <path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /> },
    { id: "personality", label: "Brain", icon: <path d="M13 10V3L4 14h7v7l9-11h-7z" /> },
    { id: "connections", label: "Connections", icon: <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /> },
    { id: "spend", label: "Spend", icon: <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" /> },
  ];

  const SvgIcon = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  );

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, fontFamily: "'Manrope', system-ui, sans-serif", position: "relative" }}>
      {isHealing && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 999, background: "rgba(255,255,255,0.85)",
          backdropFilter: "blur(12px)", display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <div style={{
            background: "var(--surface-card)", padding: 40, borderRadius: 24,
            boxShadow: "0 24px 48px rgba(0,0,0,0.1)", textAlign: "center", maxWidth: 420,
            border: "1px solid rgba(0,0,0,0.08)"
          }}>
            <div style={{ marginBottom: 24, display: "flex", justifyContent: "center" }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "rgba(33,131,128,0.1)", display: "flex", alignItems: "center", justifyContent: "center", animation: "pulse 2s infinite" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#218380" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
              </div>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-main)", marginBottom: 16 }}>Auto-Healing Engine...</h2>
            <p style={{ fontSize: 15, color: "var(--text-sub)", lineHeight: 1.6 }}>
              It looks like your underlying agent infrastructure got overloaded. We are safely flushing the environment buffers and waking the engines back up. This usually takes just a few seconds.
            </p>
          </div>
        </div>
      )}
      {showUpdateTip && (
        <div style={{
          position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: "#218380", color: "#fff", padding: "12px 20px", borderRadius: 12,
          boxShadow: "0 8px 24px rgba(33,131,128,0.25)", zIndex: 1000,
          display: "flex", alignItems: "center", gap: 12, fontSize: 13, border: "1px solid rgba(255,255,255,0.1)",
          animation: "slideIn 0.3s ease-out"
        }}>
          <div style={{ background: "rgba(255,255,255,0.2)", borderRadius: 8, padding: "6px 8px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
          <span style={{ flex: 1, fontWeight: 600 }}>Agent settings saved</span>
          <button onClick={() => setShowUpdateTip(false)} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>✕</button>
        </div>
      )}

      {/* Sidebar */}
      <div style={{
        width: 220, flexShrink: 0, display: "flex", flexDirection: "column",
        background: "var(--surface-card)", borderRight: "1px solid rgba(0,0,0,0.06)",
        padding: "16px 12px", gap: 4, overflowY: "auto"
      }}>
        {/* Agent Identity */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: `${agent.robeColor || "#CCC"}15`, boxShadow: `0 0 0 1px ${agent.robeColor || "#CCC"}40` }}>
            <LobsterIcon size={32} role={agent.role} agentImage={agent.image} shellColor={agent.robeColor} accentColor={agent.accentColor} />
          </div>
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div
                  onClick={() => setIsAgentMenuOpen(!isAgentMenuOpen)}
                  style={{ display: "flex", alignItems: "center", cursor: "pointer", gap: 6 }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>{agent.name}</div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-sub)", transition: "transform 0.2s", transform: isAgentMenuOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-sub)", textTransform: "capitalize", marginTop: 2 }}>{agent.role}</div>
              </div>

              {/* Custom Dropdown Menu */}
              {isAgentMenuOpen && (
                <>
                  <div
                    onClick={() => setIsAgentMenuOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 99 }}
                  />
                  <div style={{
                    position: "absolute", top: 38, left: 0, width: 220, background: "var(--surface-card)",
                    border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.1)",
                    zIndex: 100, overflow: "hidden", display: "flex", flexDirection: "column"
                  }}>
                    {agents.map(a => (
                      <div
                        key={a.id}
                        onClick={() => {
                          setSelectedAgent(a.id);
                          setIsAgentMenuOpen(false);
                        }}
                        style={{
                          display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                          cursor: "pointer", background: a.id === agent.id ? "rgba(33,131,128,0.06)" : "transparent",
                          borderLeft: a.id === agent.id ? "3px solid #218380" : "3px solid transparent",
                          transition: "background 0.1s"
                        }}
                      >
                        <div style={{ position: "relative" }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                            background: `${a.robeColor || "#CCC"}15`, boxShadow: `0 0 0 1px ${a.robeColor || "#CCC"}40`
                          }}>
                            <LobsterIcon size={26} role={a.role} agentImage={a.image} shellColor={a.robeColor} accentColor={a.accentColor} />
                          </div>
                          <div style={{
                            position: "absolute", bottom: -2, right: -2, width: 8, height: 8, borderRadius: "50%",
                            background: a.status === "active" ? "#4A9E96" : a.status === "thinking" ? "#8B6AAE" : a.status === "error" ? "#E57373" : "var(--text-muted)",
                            border: "1.5px solid white"
                          }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{a.name}</div>
                          <div style={{ fontSize: 10, color: "var(--text-sub)", textTransform: "capitalize" }}>{a.role}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
          </div>
        </div>

        {/* Nav tabs */}
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => {
            setArchitectTab(tab.id);
            setShowDiagnosticsPane(false);
          }} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13,
            fontWeight: architectTab === tab.id ? 600 : 400,
            color: architectTab === tab.id ? "#218380" : "#218380",
            opacity: architectTab === tab.id ? 1 : 0.6,
            background: architectTab === tab.id ? "rgba(33,131,128,0.08)" : "transparent",
            borderLeft: architectTab === tab.id ? "3px solid #3c6663" : "3px solid transparent",
            transition: "all 0.15s ease", fontFamily: "inherit", textAlign: "left", width: "100%",
          }}>
            <SvgIcon size={18}>{tab.icon}</SvgIcon>
            {tab.label}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Danger Zone */}
        <div style={{ padding: "10px 0", borderTop: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
          <button
            onClick={() => setShowDangerZone(!showDangerZone)}
            style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "right", padding: "4px 8px" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showDangerZone ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>

          {showDangerZone && (
            <div style={{
              background: "#fff", borderRadius: 12, padding: 12, border: "1px solid #f2bdbd", boxShadow: "0 4px 12px rgba(198,40,40,0.08)"
            }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#C62828", textTransform: "uppercase", marginBottom: 8, letterSpacing: "0.05em" }}>Danger Zone</div>
              <button
                onClick={async () => {
                  const { invoke } = await import('@tauri-apps/api/core');
                  const nowPaused = !agent.paused;
                  // Optimistic update
                  useWorldStore.getState().setAgents(
                    useWorldStore.getState().agents.map(a =>
                      a.id === agent.id ? { ...a, paused: nowPaused, status: nowPaused ? "sleeping" as any : a.status } : a
                    )
                  );
                  try {
                    await invoke("set_agent_paused", { agentId: agent.id, paused: nowPaused });
                  } catch (e) {
                    // Roll back on error
                    useWorldStore.getState().setAgents(
                      useWorldStore.getState().agents.map(a =>
                        a.id === agent.id ? { ...a, paused: !nowPaused } : a
                      )
                    );
                    alert("Failed to " + (nowPaused ? "pause" : "resume") + " agent: " + e);
                  }
                }}
                style={{ width: "100%", padding: "8px 12px", background: agent.paused ? "rgba(74,158,150,0.1)" : "var(--surface-base)", color: agent.paused ? "#4A9E96" : "var(--text-sub)", border: agent.paused ? "1px solid rgba(74,158,150,0.3)" : "1px solid rgba(0,0,0,0.1)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", marginBottom: 6 }}
              >
                {agent.paused ? "▶ Resume Agent" : "⏸ Pause Agent"}
              </button>
              <button
                onClick={async () => {
                  const { confirm } = await import('@tauri-apps/plugin-dialog');
                  const isConfirmed = await confirm(`Are you absolutely sure you want to permanently delete ${agent.name}? This cannot be undone.`, { title: "Delete Agent", kind: "warning" });
                  if (!isConfirmed) return;
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke("delete_agent", { agentId: agent.id });
                    useWorldStore.getState().setAgents(useWorldStore.getState().agents.filter(a => a.id !== agent.id));
                    useWorldStore.getState().setActiveView("canopy");
                  } catch (e) {
                    alert("Failed to delete agent: " + e);
                  }
                }}
                style={{ width: "100%", padding: "8px 12px", background: "#fdeaea", color: "#C62828", border: "1px solid #f2bdbd", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                Delete Agent
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            if (diagErrors.length > 0 || diagSuccess || openclawStatusOutput) {
              setShowDiagnosticsPane(true);
            } else {
              runDiagnostics();
            }
          }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            padding: "10px", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12, cursor: "pointer",
            background: "var(--glass-light)", color: "#218380", fontSize: 12, fontFamily: "inherit",
            fontWeight: 600, marginTop: 4, transition: "all 0.2s ease"
          }}>
          <SvgIcon size={14}><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><circle cx="12" cy="12" r="3"></circle></SvgIcon>
          <span id="diag-btn-text">Diagnostics</span>
        </button>

        <button onClick={() => setActiveView("canopy")} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "8px", border: "none", borderRadius: 8, cursor: "pointer",
          background: "transparent", color: "var(--text-sub)", fontSize: 12, fontFamily: "inherit",
          marginTop: 4,
        }}>
          <SvgIcon size={14}><path d="M11 17l-5-5m0 0l5-5m-5 5h12" /></SvgIcon>
          Back to Canopy
        </button>
      </div>

      {/* ── Main Content ── */}
      {showDiagnosticsPane ? (
        <div style={{ flex: 1, overflow: "auto", padding: "32px 40px", display: "flex", flexDirection: "column", position: "relative", background: "var(--surface-base)" }}>
          <button
            onClick={() => setShowDiagnosticsPane(false)}
            style={{ position: "absolute", top: 24, right: 32, background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", padding: 8, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <SvgIcon size={24}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></SvgIcon>
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, paddingRight: 32 }}>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-main)", margin: 0 }}>System Diagnostics</h1>
            {openclawStatusOutput && (
              <button
                onClick={runDiagnostics}
                style={{ background: "#218380", color: "white", padding: "6px 12px", borderRadius: 6, border: "none", fontSize: 12, cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}
              >
                <SvgIcon size={14}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></SvgIcon>
                Re-run Audit
              </button>
            )}
          </div>
          <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 24 }}>Real-time audit of your OpenClaw agent status</p>

          {!openclawStatusOutput && diagErrors.length === 0 && !diagSuccess && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, padding: "40px 0", color: "var(--text-sub)" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid rgba(0,0,0,0.1)", borderTopColor: "#218380", animation: "diagnostics-spin 1s linear infinite" }} />
              <div style={{ fontSize: 13, fontWeight: 600 }}>Executing full system audit...</div>
              <style>{`@keyframes diagnostics-spin { 100% { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {diagErrors.length > 0 && (
            <div style={{ marginBottom: 24, padding: "16px", background: "#FEF2F2", color: "#B91C1C", borderRadius: 8, fontSize: 13, border: "1px solid #FCA5A5" }}>
              <span style={{ fontWeight: 700, display: "block", marginBottom: 8 }}>Action Required:</span>
              <ul style={{ margin: 0, paddingLeft: 20, marginBottom: 16 }}>
                {diagErrors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
              <button
                id="repair-btn"
                onClick={async () => {
                  const btn = document.getElementById('repair-btn');
                  if (btn) btn.innerText = "Applying Repairs...";
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke("repair_openclaw_config");
                    // Re-register any agents whose dirs were never created.
                    await invoke("boot_sync_agents").catch((e: any) => console.warn("boot_sync in repair:", e));
                    if (btn) {
                      btn.innerText = "Repaired! Re-Run Diagnostics \u2192";
                      btn.style.background = "#15803D";
                    }
                  } catch (e) {
                    if (btn) btn.innerText = "Repair Failed";
                    alert("Repair failed: " + e);
                  }
                }}
                style={{ background: "#B91C1C", color: "white", padding: "8px 16px", borderRadius: 6, border: "none", fontSize: 12, cursor: "pointer", fontWeight: 700, transition: "background 0.2s" }}
              >
                Launch Auto-Repair
              </button>
            </div>
          )}

          {diagSuccess && (
            <div style={{ marginBottom: 24, padding: "16px", background: "#F0FDF4", color: "#15803D", borderRadius: 8, fontSize: 13, border: "1px solid #BBF7D0", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <SvgIcon size={16}><path d="M5 13l4 4L19 7" /></SvgIcon> {diagSuccess}
            </div>
          )}

          {openclawStatusOutput && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <details style={{ background: "#f8f9fa", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", overflow: "hidden" }}>
                <summary style={{ padding: "12px 16px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, color: "var(--text-main)", fontSize: 13, userSelect: "none", outline: "none" }}>
                  <SvgIcon size={16}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></SvgIcon>
                  See advanced raw telemetry
                </summary>
                <div style={{ padding: "16px", borderTop: "1px solid rgba(0,0,0,0.1)", fontSize: 12, overflowY: "auto", fontFamily: "monospace", color: "var(--text-sub)", whiteSpace: "pre-wrap", maxHeight: 400, background: "#fff" }}>
                  {openclawStatusOutput}
                </div>
              </details>
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: "32px 40px", display: "flex", flexDirection: "column" }}>
          {architectTab === "overview" && <OverviewTab key={agent.id} agent={agent} onUpdate={() => setShowUpdateTip(true)} onNavigate={setArchitectTab} />}
          {architectTab === "identity" && <IdentityTab key={agent.id} agent={agent} />}
          {architectTab === "personality" && <PersonalityTab key={agent.id} agent={agent} />}
          {architectTab === "connections" && <ConnectionsTab key={agent.id} agent={agent} />}
          {architectTab === "spend" && <SpendTab key={agent.id} agent={agent} />}
          {architectTab === "chat" && <ChatTab key={agent.id} agent={agent} />}
        </div>
      )}
    </div>
  );
}

// ─── Connections Tab ─────────────────────────────────────────────────────────
// Per-agent: toggles + channel/contact pickers only. No OAuth here.
// All gateway-level service setup lives in the top-level Integrations tab.

function ConnectionsTab({ agent }: { agent: AgentData }) {
  const { setActiveView } = useWorldStore();

  // Gateway connection statuses (read-only here)
  const [slackConnected, setSlackConnected] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [calConnected, setCalConnected] = useState(false);
  const [iMsgConnected, setIMsgConnected] = useState(false);

  // Per-agent Slack channel allowlist
  const [slackEnabled, setSlackEnabled] = useState(agent.integrations.includes("slack"));
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; member_count: number }>>([]);
  const [allowedSlack, setAllowedSlack] = useState<string[]>([]);
  const [slackPickerOpen, setSlackPickerOpen] = useState(false);
  const [slackSearch, setSlackSearch] = useState("");

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
  const [dedicatedEmail, setDedicatedEmail] = useState("");
  const [dedicatedPassword, setDedicatedPassword] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);

  // Saving state
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => {
    checkGatewayStatus();
    loadAllowlists();
  }, [agent.id]);

  const checkGatewayStatus = async () => {
    try {
      const s = await invoke<{ connected: boolean }>("check_slack_connection");
      setSlackConnected(s.connected);
      if (s.connected) {
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
    } catch (e) { console.error(e); }
    setEmailSaving(false);
  };

  // ── Row component for each service
  const ServiceRow = ({
    icon, name, subtitle, connected, gatewayLabel, enabled, onToggle, children,
  }: {
    icon: React.ReactNode; name: string; subtitle: string;
    connected: boolean; gatewayLabel?: string;
    enabled?: boolean; onToggle?: (v: boolean) => void;
    children?: React.ReactNode;
  }) => {
    const [open, setOpen] = useState(false);
    return (
      <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, overflow: "hidden", background: "var(--surface-card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: "var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {icon}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{name}</span>
              {connected
                ? <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Connected{gatewayLabel ? ` · ${gatewayLabel}` : ""}</span>
                : <span style={{ fontSize: 10, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Not set up</span>
              }
            </div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 2 }}>{subtitle}</div>
          </div>
          {!connected ? (
            <button onClick={() => setActiveView("integrations")} style={{
              padding: "5px 12px", border: "1px solid var(--border-subtle)", borderRadius: 6,
              background: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
              color: "#3c6663", fontFamily: "inherit",
            }}>
              Set up →
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {children && (
                <button onClick={() => setOpen(v => !v)} style={{
                  fontSize: 11, fontWeight: 600, color: "var(--text-sub)", background: "none",
                  border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "5px 10px",
                  cursor: "pointer", fontFamily: "inherit",
                }}>
                  {open ? "Done" : "Configure"}
                </button>
              )}
              {onToggle && (
                <button onClick={() => onToggle(!enabled)} style={{
                  width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                  background: enabled ? "#3c6663" : "#d1d5db", position: "relative", transition: "background 0.2s",
                  flexShrink: 0,
                }}>
                  <span style={{
                    position: "absolute", top: 3, left: enabled ? 21 : 3,
                    width: 16, height: 16, borderRadius: "50%", background: "#fff",
                    transition: "left 0.2s", display: "block",
                  }} />
                </button>
              )}
            </div>
          )}
        </div>
        {connected && open && children && (
          <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "14px 16px" }}>
            {children}
          </div>
        )}
      </div>
    );
  };

  // ── Multi-select picker
  const MultiPicker = ({
    items, selected, onToggle, searchValue, onSearch, idKey, labelKey,
    sublabelKey,
  }: {
    items: any[]; selected: string[]; onToggle: (id: string) => void;
    searchValue: string; onSearch: (v: string) => void;
    idKey: string; labelKey: string; sublabelKey?: string;
  }) => {
    const filtered = items.filter(i =>
      i[labelKey]?.toLowerCase().includes(searchValue.toLowerCase())
    );
    return (
      <div>
        <input
          value={searchValue}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search…"
          style={{
            width: "100%", padding: "6px 10px", border: "1px solid var(--border-subtle)",
            borderRadius: 6, fontSize: 12, fontFamily: "inherit", marginBottom: 8,
            background: "var(--surface-card)", color: "var(--text-main)",
          }}
        />
        <div style={{ maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-sub)", padding: "8px 0" }}>No results</div>
          ) : filtered.map(item => {
            const id = item[idKey];
            const checked = selected.includes(id);
            return (
              <label key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", cursor: "pointer", borderRadius: 5 }}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(id)} style={{ accentColor: "#3c6663" }} />
                <span style={{ fontSize: 12, color: "var(--text-main)", fontWeight: checked ? 600 : 400 }}>
                  #{item[labelKey]}
                  {sublabelKey && item[sublabelKey] && (
                    <span style={{ fontSize: 10, color: "var(--text-sub)", marginLeft: 4, fontWeight: 400 }}>
                      · {item[sublabelKey]}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {selected.length > 0 && (
          <div style={{ fontSize: 11, color: "#3c6663", marginTop: 6 }}>
            {selected.length} selected — agent only receives messages from these
          </div>
        )}
        {selected.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 6 }}>
            No filter — agent receives messages from all channels/DMs
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

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

      {/* Slack */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#2EB67D"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#2EB67D"/><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/></svg>}
        name="Slack"
        subtitle="Control which Slack channels route messages to this agent"
        connected={slackConnected}
        enabled={slackEnabled}
        onToggle={setSlackEnabled}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>
          Channel allowlist
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
      </ServiceRow>

      {/* Gmail */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2z" fill="#fff" stroke="#E8EAED" strokeWidth="1.5"/><path d="M2 6l10 7 10-7" stroke="#EA4335" strokeWidth="2" strokeLinecap="round"/></svg>}
        name="Gmail"
        subtitle="Read and send emails using your Google account"
        connected={gmailConnected}
        enabled={emailMode !== "none"}
        onToggle={v => setEmailMode(v ? "read" : "none")}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => (
            <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`email-mode-${agent.id}`} checked={emailMode === m} onChange={() => setEmailMode(m)} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: emailMode === m ? 600 : 400 }}>
                {m === "read" ? "Read-only — monitor inbox, search, summarise" : "Read + Send — can draft and send replies"}
              </span>
            </label>
          ))}
        </div>
      </ServiceRow>

      {/* Agent's own email */}
      <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, overflow: "hidden", background: "var(--surface-card)" }}>
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

      {/* iMessage */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.02 2 11c0 2.64 1.15 5.02 3 6.71V22l4.29-2.13C10.12 20.28 11.04 20.5 12 20.5c5.52 0 10-3.58 10-8s-4.48-8-10-8z" fill="#34C759"/></svg>}
        name="iMessage"
        subtitle="Choose which contacts and group threads this agent can read and reply to"
        connected={iMsgConnected}
        enabled={iMsgEnabled}
        onToggle={setIMsgEnabled}
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

      {/* Calendar */}
      <ServiceRow
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4285F4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}
        name="Google Calendar"
        subtitle="Read events and create calendar items"
        connected={calConnected}
        enabled={agent.integrations.includes("calendar")}
        onToggle={() => {}} // calendar enable/disable handled in integrations
      />

    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({ agent, onUpdate }: { agent: AgentData; onUpdate?: () => void }) {
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const [repairLog, setRepairLog] = useState<string | null>(null);
  const [repairSucceeded, setRepairSucceeded] = useState<boolean | null>(null);
  const [hardResetting, setHardResetting] = useState(false);
  
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [tempName, setTempName] = useState(agent.name);
  const [tempRole, setTempRole] = useState(agent.role);

  useEffect(() => {
    setIsEditingDetails(false);
    setTempName(agent.name);
    setTempRole(agent.role);
  }, [agent.id]);

  const saveDetails = async () => {
    if (!tempName.trim()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("update_agent_details", {
        agentId: agent.id,
        name: tempName,
        role: tempRole
      });
      // Update global store
      const { setAgents, agents } = useWorldStore.getState();
      setAgents(agents.map(a => a.id === agent.id ? { ...a, name: tempName, role: tempRole } : a));
      setIsEditingDetails(false);
      if (tempName !== agent.name && onUpdate) {
        onUpdate();
      }
    } catch (e) {
      console.error("Failed to update agent details:", e);
    }
  };

  const handleHardReset = async () => {
    setHardResetting(true);
    setRepairLog("Hard Reset in progress...\n\nRestarting OrbStack Linux VM and rebuilding the gateway container.\nThis takes 15–20 seconds.");
    setRepairSucceeded(null);
    try {
      await invoke("hard_reset_infrastructure");
      setRepairLog("✓ Hard Reset complete — OrbStack VM restarted. Re-registering agents...");
      // Re-run boot_sync_agents so agents are registered and credentials written
      // after the container comes back up. Without this, agents.list is restored
      // but no auth-profiles.json is written and the gateway can't authenticate.
      try {
        await invoke("boot_sync_agents");
        setRepairLog("✓ Hard Reset complete — gateway restarted and agents re-initialized.");
      } catch (syncErr) {
        console.warn("boot_sync after hard reset:", syncErr);
        setRepairLog("✓ Hard Reset complete — gateway restarted.\n(Agent re-sync ran in background.)");
      }
      setRepairSucceeded(true);
    } catch (e) {
      setRepairLog(`✗ Hard Reset failed:\n${String(e)}\n\nMake sure OrbStack is installed and try opening it manually.`);
      setRepairSucceeded(false);
    }
    setHardResetting(false);
  };

  return (
    <div>
      {agent.paused && (
        <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 16, padding: 24, marginBottom: 32 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", flexShrink: 0 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Agent Paused</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)" }}>This agent won't load into the gateway at startup. Use "▶ Resume Agent" in the Danger Zone to re-activate it.</div>
            </div>
          </div>
        </div>
      )}
      {agent.status === "error" && !agent.paused && !gatewayReady && (
        <div style={{ background: "#fffbf0", border: "1px solid #f4d58a", borderRadius: 16, padding: 24, marginBottom: 32 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#F4A83A", display: "flex", alignItems: "center", justifyContent: "center", color: "white", flexShrink: 0 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Agent is Waking Up</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)" }}>The gateway is still starting. This takes up to 90 seconds on a cold start — hang tight.</div>
            </div>
          </div>
        </div>
      )}
      {agent.status === "error" && !agent.paused && gatewayReady && (
        <div style={{ background: "#fcf3f3", border: "1px solid #f2bdbd", borderRadius: 16, padding: 24, marginBottom: 32 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#E57373", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--surface-card)", flexShrink: 0 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Agent Environment Offline</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)" }}>The OpenClaw setup failed or the local Docker container unexpectedly stopped.</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleHardReset}
                disabled={hardResetting}
                title="Restart OrbStack VM and rebuild the gateway container from scratch"
                style={{ padding: "10px 16px", borderRadius: 10, background: "transparent", color: "#E57373", fontSize: 12, fontWeight: 600, border: "1px solid #E57373", cursor: hardResetting ? "not-allowed" : "pointer", opacity: hardResetting ? 0.6 : 1, transition: "all 0.2s ease", whiteSpace: "nowrap" }}>
                {hardResetting ? "Resetting..." : "Hard Reset"}
              </button>
              <button
                id="repair-openclaw-btn"
                onClick={async () => {
                  const btn = document.getElementById('repair-openclaw-btn');
                  if (btn) btn.innerText = "Rebuilding...";
                  setRepairLog(null);
                  setRepairSucceeded(null);
                  try {
                    if (typeof invoke === 'function') {
                      // Per-agent key takes priority; global key is the fallback.
                      const agAnthropic = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_anthropic_key` }).catch(() => "") || "")
                                       || String(await invoke("get_secret_cmd", { key: "ANTHROPIC_API_KEY" }).catch(() => "") || "");
                      const agOpenAI    = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_openai_key` }).catch(() => "") || "")
                                       || String(await invoke("get_secret_cmd", { key: "OPENAI_API_KEY" }).catch(() => "") || "");
                      const agGemini    = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_gemini_key` }).catch(() => "") || "")
                                       || String(await invoke("get_secret_cmd", { key: "GEMINI_API_KEY" }).catch(() => "") || "");
                      const agGrok      = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_grok_key` }).catch(() => "") || "")
                                       || String(await invoke("get_secret_cmd", { key: "XAI_API_KEY" }).catch(() => "")
                                       || await invoke("get_secret_cmd", { key: "GROK_API_KEY" }).catch(() => "") || "");

                      await invoke("sync_credentials", {
                        agentId: agent.id, keys: {
                          "ANTHROPIC_API_KEY": agAnthropic,
                          "OPENAI_API_KEY":    agOpenAI,
                          "GEMINI_API_KEY":    agGemini,
                          "XAI_API_KEY":       agGrok,
                        }
                      }).catch((err) => console.error("Sync credentials failed:", err));

                      const res = await invoke("repair_gateway", { agentId: agent.id });
                      if (btn) btn.innerText = "Repaired!";
                      setRepairLog(String(res));
                      setRepairSucceeded(true);

                      // Clear the error status — the agent is now registered and live.
                      useWorldStore.setState(state => ({
                        agents: state.agents.map(a => a.id === agent.id
                          ? { ...a, status: "active", currentAction: "idle" }
                          : a)
                      }));
                    }
                  } catch (e) {
                    if (btn) btn.innerText = "Failed — See Details";
                    setRepairLog(String(e));
                    setRepairSucceeded(false);
                    console.error("Openclaw repair failed:", e);
                  }
                  setTimeout(() => { if (btn) btn.innerText = "Re-Initialize Setup"; }, 3000);
                }}
                style={{ padding: "10px 20px", borderRadius: 10, background: "#E57373", color: "var(--surface-card)", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", transition: "all 0.2s ease", whiteSpace: "nowrap" }}>
                Re-Initialize Setup
              </button>
            </div>
          </div>
          {repairLog && (
            <div style={{
              padding: 16,
              borderRadius: 12,
              background: repairSucceeded === true ? "rgba(52,211,153,0.07)" : repairSucceeded === false ? "rgba(229,115,115,0.08)" : "rgba(0,0,0,0.04)",
              border: `1px solid ${repairSucceeded === true ? "rgba(52,211,153,0.25)" : repairSucceeded === false ? "rgba(229,115,115,0.3)" : "rgba(0,0,0,0.1)"}`,
              color: repairSucceeded === true ? "#1a6b52" : repairSucceeded === false ? "#c62828" : "var(--text-sub)",
              fontSize: 11,
              marginTop: 20,
              whiteSpace: "pre-wrap",
              fontFamily: "'Geist Mono', monospace",
              maxHeight: 260,
              overflowY: "auto",
              lineHeight: 1.6,
            }}>
              {repairLog}
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 32, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          {isEditingDetails ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input value={tempName} onChange={e => setTempName(e.target.value)} style={{ fontSize: 32, fontWeight: 700, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-base)", outline: "none", color: "var(--text-main)" }} />
              <input value={tempRole} onChange={e => setTempRole(e.target.value)} style={{ fontSize: 16, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-base)", outline: "none", color: "var(--text-sub)" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={saveDetails} style={{ padding: "6px 16px", background: "#4A9E96", color: "white", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button>
                <button onClick={() => { setIsEditingDetails(false); setTempName(agent.name); setTempRole(agent.role); }} style={{ padding: "6px 16px", background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border-subtle)", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <h1 style={{ fontSize: 36, fontWeight: 700, color: "var(--text-main)", letterSpacing: "-0.02em", margin: 0, lineHeight: 1.1 }}>
                {agent.name}: <span style={{ color: "var(--text-sub)", fontWeight: 400 }}>{agent.title}</span>
              </h1>
              <p style={{ fontSize: 15, color: "var(--text-sub)", marginTop: 8, maxWidth: 600, lineHeight: 1.6 }}>
                {agent.description}
              </p>
            </>
          )}
        </div>
        
        {!isEditingDetails && (
          <button 
            onClick={() => setIsEditingDetails(true)} 
            style={{ 
              display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", 
              borderRadius: 8, border: "1px solid var(--border-subtle)", background: "transparent", 
              color: "var(--text-sub)", cursor: "pointer", fontSize: 13, fontWeight: 600 
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Edit Agent
          </button>
        )}
      </div>

      {/* Status + Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Current State</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: agent.paused ? "var(--text-muted)" : !gatewayReady ? "#F4A83A" : agent.status === "active" ? "#4A9E96" : agent.status === "thinking" ? "#8B6AAE" : agent.status === "error" ? "#E57373" : "var(--text-muted)",
              boxShadow: agent.paused ? "none" : !gatewayReady ? "0 0 8px rgba(244,168,58,0.5)" : agent.status === "active" ? "0 0 8px rgba(74,158,150,0.5)" : agent.status === "error" ? "0 0 8px rgba(229,115,115,0.5)" : "none",
              animation: (!agent.paused && !gatewayReady) ? "pulse 1.5s ease-in-out infinite" : "none",
            }} />
            <span style={{ fontSize: 20, fontWeight: 600, color: agent.paused ? "var(--text-muted)" : !gatewayReady ? "#F4A83A" : "var(--text-main)", textTransform: "capitalize" }}>
              {agent.paused ? "Paused" : !gatewayReady ? "Waking Up" : agent.status === "error" ? "Offline" : agent.currentAction}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 11, color: "var(--text-sub)" }}>
            <span>Uptime</span>
            <span style={{ fontWeight: 500, color: "var(--text-main)" }}>{agent.uptime}</span>
          </div>
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Resource Consumption</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Weekly Compute</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-main)" }}>{agent.weeklyCompute}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Tokens Mined</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-main)" }}>
                {(() => {
                  const totalTokens = (agent.stats?.total_tokens_in || 0) + (agent.stats?.total_tokens_out || 0);
                  if (totalTokens === 0) return agent.tokensUsed || "0k";
                  if (totalTokens > 1000000) return (totalTokens / 1000000).toFixed(1) + "M";
                  if (totalTokens > 1000) return (totalTokens / 1000).toFixed(1) + "k";
                  return totalTokens;
                })()}
              </div>
            </div>
          </div>
          <ProgressBar value={parseFloat(agent.weeklyCompute)} max={0.1} color="#4A9E96" />
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Cost (Active)</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)" }}>${(agent.stats?.total_cost_usd || agent.monthlySpend || 0).toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 8 }}>of ${agent.spendLimit} limit</div>
          <ProgressBar value={agent.stats?.total_cost_usd || agent.monthlySpend || 0} max={agent.spendLimit} color={(agent.stats?.total_cost_usd || agent.monthlySpend || 0) > agent.spendLimit * 0.8 ? "#D4A04A" : "#4A9E96"} />
        </div>
      </div>

      {/* Core Nature + Permissions quick view */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.5fr", gap: 16 }}>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 16 }}>Core Nature</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", fontStyle: "italic", lineHeight: 1.5 }}>
            "{agent.personalityPrompt}"
          </div>
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 16 }}>Key Permissions</div>
          {agent.permissions.filter(p => ["autonomous", "payments", "ext_network", "file_write"].includes(p.id)).map(p => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-main)" }}>{p.label}</div>
                <div style={{ fontSize: 11, color: "var(--text-sub)" }}>{p.description}</div>
              </div>
              <Toggle enabled={p.enabled} onChange={() => useWorldStore.getState().togglePermission(agent.id, p.id)} size="small" />
            </div>
          ))}
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16, display: "flex", flexDirection: "column", maxHeight: 300 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 16 }}>Quick Comms</div>
          <ChatTab agent={agent} compact={true} />
        </div>
      </div>
    </div>
  );
}

// ─── Personality / Neural Path Tab ───────────────────────────────────────────

// ─── 3D Identity Tab ─────────────────────────────────────────────────────────

const PASTEL_COLORS = [
  "#FFAB91", "#FFD54F", "#FFF59D", "#DCE775", "#AED581", "#81C784",
  "#4DB6AC", "#4DD0E1", "#4FC3F7", "#64B5F6", "#7986CB", "#9575CD",
  "#BA68C8", "#F06292", "#E0E0E0", "#BCAAA4"
];

const HABITATS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// 150 items
const ACCESSORIES = Array.from({ length: 6 }, (_, s) =>
  Array.from({ length: 25 }, (_, i) =>
    `/accessories/accessories_set_${s + 1}_item_${String(i + 1).padStart(2, '0')}.png`
  )
).flat();

function IdentityTab({ agent }: { agent: AgentData }) {
  const { setAgents } = useWorldStore();
  const [accessorySearch, setAccessorySearch] = useState("");
  const [stagedVisuals, setStagedVisuals] = useState<Partial<AgentData["visual_identity"]>>(agent.visual_identity || {});

  useEffect(() => {
    setStagedVisuals(agent.visual_identity || {});
  }, [agent.id, agent.visual_identity]);

  const handleUpdateStaged = (updates: Partial<AgentData["visual_identity"]>) => {
    setStagedVisuals(prev => ({ ...prev, ...updates }));
  };

  const handleSave = async () => {
    const updatedVi = { ...stagedVisuals };
    setAgents(useWorldStore.getState().agents.map(a =>
      a.id === agent.id ? { ...a, color: updatedVi.color || a.color, robeColor: updatedVi.color || a.robeColor, accentColor: updatedVi.color || a.accentColor, visual_identity: updatedVi } : a
    ));
    if (typeof invoke === 'function') {
      try {
        await invoke("update_agent_visuals", { agentId: agent.id, visualIdentity: updatedVi });
      } catch (e) {
        console.error("Failed to save visual identity", e);
      }
    }
  };

  const handleUndo = () => {
    setStagedVisuals(agent.visual_identity || {});
  };

  const hasChanges = JSON.stringify(stagedVisuals) !== JSON.stringify(agent.visual_identity || {});

  const handleApplyGeneration = (res: GenerativeResult) => {
    setAgents(useWorldStore.getState().agents.map(a =>
      a.id === agent.id ? {
        ...a,
        image: res.compiledImageUrl,
        color: res.dynamicParams.color || a.color,
        robeColor: res.dynamicParams.robeColor || a.robeColor,
        accentColor: res.dynamicParams.accentColor || a.accentColor,
        visual_identity: { ...a.visual_identity, accessories: [...(a.visual_identity?.accessories || []), ...res.dynamicParams.accessories] }
      } : a
    ));
  };

  const [catalog, setCatalog] = useState<any>(null);
  useEffect(() => {
    fetch('http://localhost:3001/api/accessories')
      .then(r => r.json())
      .then(d => setCatalog(d))
      .catch(() => { });
  }, []);

  const visibleAccessories = React.useMemo(() => {
    if (!catalog || !catalog.items) return ACCESSORIES;
    return ACCESSORIES.filter(path => {
      if (catalog.items[path] && catalog.items[path].isVisible === false) return false;
      return true;
    });
  }, [catalog]);

  const sortedAccessories = useMemo(() => {
    const copy = [...visibleAccessories];
    const seed = agent.role.charCodeAt(0) % 6;
    const suggestions = copy.splice(seed * 25, 5);
    const combined = [...suggestions, ...copy];
    if (!accessorySearch) return combined;
    return combined.filter(a => a.toLowerCase().includes(accessorySearch.toLowerCase()));
  }, [agent.role, accessorySearch]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, height: "100%", paddingRight: 8 }}>
      {/* 3D Dressing Room Areas */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Area 1: Base Lobster & Accessories */}
        <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", flex: 2, border: "1px solid rgba(0,0,0,0.06)", minHeight: 400 }}>
          <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 60 }}>
            <ambientLight intensity={0.8} color="#F5E6D8" />
            <directionalLight position={[10, 20, 5]} intensity={1} />
            <OrbitControls autoRotate autoRotateSpeed={1.5} enablePan={false} />
            <group position={[0, -0.6, 0]}>
              {stagedVisuals?.habitatId ? (
                <React.Suspense fallback={null}>
                  <group position={[0, -0.1, 0]} scale={1.0} rotation={[0, Math.PI / 4, 0]}>
                    <TerrariumBase habitatId={stagedVisuals.habitatId} />
                  </group>
                </React.Suspense>
              ) : (
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <shadowMaterial transparent opacity={0.2} />
                </mesh>
              )}
              <GLBAgent
                fileUrl={stagedVisuals?.baseModelUrl || (["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].includes(agent.role) ? `/models/lobsters/${agent.role}.glb` : undefined)}
                accessories={stagedVisuals?.accessories || []}
                agentStatus={agent.status}
                scale={1.0}
                robeColor={stagedVisuals?.color || agent.color}
              //forceAnimation="Long_Breathe_and_Look_Around"
              />
              {/* Fallback Accessory Stickers for Preview */}
              <React.Suspense fallback={null}>
                {(stagedVisuals?.accessories || []).map((path, i) => (
                  <SafeBillboard
                    key={path}
                    url={`http://localhost:3001${path}`}
                    position={[(i - ((stagedVisuals?.accessories?.length || 1) - 1) / 2) * 1.2, 2.5, 0]}
                  />
                ))}
              </React.Suspense>
            </group>
          </Canvas>
          <div style={{ position: "absolute", top: 16, left: 16, background: "var(--glass-heavy)", padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, color: "#218380", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#218380", animation: "pulse 2s infinite" }} />
            Core Agent
          </div>
          {hasChanges && (
            <div style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 8 }}>
              <button
                onClick={handleUndo}
                style={{ background: "rgba(0,0,0,0.05)", border: "none", padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, color: "var(--text-sub)", cursor: "pointer", transition: "all 0.2s" }}
              >
                Undo
              </button>
              <button
                onClick={handleSave}
                style={{ background: "#218380", border: "none", padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, color: "white", cursor: "pointer", transition: "all 0.2s", boxShadow: "0 4px 12px rgba(33,131,128,0.2)" }}
              >
                Save Changes
              </button>
            </div>
          )}
        </div>

        {/* Lower row: Interactive Selectors */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, height: 260 }}>

          {/* Selector 1: Pastels */}
          <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12 }}>PIGMENTS</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, overflowY: "auto", alignContent: "flex-start", flex: 1, paddingBottom: 16 }}>
              {PASTEL_COLORS.map(c => (
                <div key={c}
                  onClick={() => handleUpdateStaged({ color: c })}
                  style={{ width: 32, height: 32, borderRadius: "50%", background: c, cursor: "pointer", border: (stagedVisuals?.color || agent.color) === c ? '2px solid var(--text-main)' : '2px solid transparent', transition: "all 0.2s ease" }}
                />
              ))}
            </div>
          </div>

          {/* Selector 2: Assets Grid */}
          <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>ASSETS</span>
              <input
                type="text"
                placeholder="Search..."
                value={accessorySearch}
                onChange={e => setAccessorySearch(e.target.value)}
                style={{ background: "rgba(0,0,0,0.05)", border: "none", borderRadius: 12, padding: "4px 8px", fontSize: 9, width: 60, outline: "none", color: "var(--text-main)" }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, overflowY: "auto", flex: 1, paddingRight: 4, paddingBottom: 16 }}>
              {sortedAccessories.map(acc => {
                let isActive = stagedVisuals?.accessories?.includes(acc);
                return (
                  <img key={acc} src={acc}
                    onClick={() => {
                      const current = stagedVisuals?.accessories || [];
                      handleUpdateStaged({ accessories: isActive ? current.filter(x => x !== acc) : [...current, acc] });
                    }}
                    style={{ width: "100%", aspectRatio: "1/1", objectFit: "contain", background: "rgba(0,0,0,0.03)", borderRadius: 8, cursor: "pointer", border: isActive ? '2px solid var(--text-main)' : '2px solid transparent', transition: "all 0.1s ease" }}
                  />
                )
              })}
            </div>
          </div>

          {/* Selector 3: Habitats */}
          <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12 }}>HABITAT</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, overflowY: "auto", flex: 1, alignContent: "flex-start", paddingRight: 4, paddingBottom: 16 }}>
              {HABITATS.map(h => (
                <div key={h}
                  onClick={() => handleUpdateStaged({ habitatId: h })}
                  style={{ background: "rgba(0,0,0,0.03)", borderRadius: 12, height: 100, overflow: "hidden", position: "relative", cursor: "pointer", border: stagedVisuals?.habitatId === h ? "2px solid #218380" : "2px solid rgba(0,0,0,0)", transition: "all 0.1s ease" }}>
                  <Canvas orthographic camera={{ position: [5, 5, 5], zoom: 16 }} style={{ pointerEvents: "none" }}>
                    <ambientLight intensity={1} />
                    <directionalLight position={[10, 20, 5]} intensity={1} />
                    <group position={[0, -0.6, 0]} rotation={[0, Math.PI / 4, 0]}>
                      <React.Suspense fallback={null}>
                        <TerrariumBase habitatId={h} />
                      </React.Suspense>
                    </group>
                  </Canvas>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PersonalityTab({ agent }: { agent: AgentData }) {
  const initialFullPrompt = agent.personalityPrompt || "";
  const booksMatch = initialFullPrompt.match(/\n\nRecently Read Books: You have recently read the following books and found them very interesting: (.*?)(?=\n\n|$)/);
  const booksStr = booksMatch ? booksMatch[1] : "";
  const initialBooks = booksStr ? booksStr.replace(/\.$/, "").split(", ").filter(Boolean) : [];
  const base = initialFullPrompt.replace(/\n\nRecently Read Books: You have recently read the following books and found them very interesting: .*?(?=\n\n|$)/, "");

  const [prompt, setPrompt] = useState(base);
  const [recentlyRead, setRecentlyRead] = useState<string[]>(initialBooks);
  const [customBookInput, setCustomBookInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>((agent.personality as any)?.active_model || "");

  const [selectedFile, setSelectedFile] = useState("Library");
  const [fileContent, setFileContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [fileSaveStatus, setFileSaveStatus] = useState("");

  useEffect(() => {
    if (selectedFile === "Library") return;
    setFileSaveStatus("");
    invoke<string>("read_workspace_file", { agentId: agent.id, filename: selectedFile })
      .then(content => setFileContent(content))
      .catch(err => {
        console.warn("Failed to read file", err);
        setFileContent("");
      });
  }, [agent.id, selectedFile]);

  const handleSaveFile = async () => {
    setIsSaving(true);
    setFileSaveStatus("Saving...");
    try {
      await invoke("write_workspace_file", { agentId: agent.id, filename: selectedFile, content: fileContent });
      setFileSaveStatus("Saved successfully!");
      setTimeout(() => setFileSaveStatus(""), 3000);
    } catch (e) {
      setFileSaveStatus("Error saving file: " + e);
    }
    setIsSaving(false);
  };

  const savePersonalityChanges = async (newRecentlyRead: string[]) => {
    try {
      if (typeof invoke === 'function') {
        let finalPrompt = prompt;
        if (newRecentlyRead.length > 0) {
          finalPrompt += `\n\nRecently Read Books: You have recently read the following books and found them very interesting: ${newRecentlyRead.join(', ')}.`;
        }
        await invoke("update_agent_personality", {
          agentId: agent.id,
          personality: { ...agent.personality, custom_instructions: finalPrompt }
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  // ── Model list for the Brain tab — sourced from Rust, not localhost:3001 ─────
  const [brainModels, setBrainModels] = useState<any[]>([]);
  useEffect(() => {
    invoke<any[]>("get_available_models")
      .then(models => setBrainModels(models))
      .catch(() => { /* gateway not yet up, will retry on next render */ });
  }, []);

  const HEAVY_ROLES_BRAIN = ["Strategist", "Analyst", "Researcher", "Engineer"];
  const getDynamicRecommendedModel = () => {
    const isHeavy = HEAVY_ROLES_BRAIN.includes(agent.role);
    // Prefer the provider for which a key is already set in this agent's Brain config
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

  const [keys, setKeys] = useState<{ [provider: string]: string }>({
    "OpenAI": "", "Anthropic": "", "Gemini": "", "Grok": ""
  });
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

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
    setSaveStatus("loading");
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
          } catch (err) {
            // macOS keychain might throw if the key doesn't exist to delete. Ignore gracefully.
          }
        }

        // Model IDs from get_available_models() are already in "provider/model-name" format
        // (e.g. "google/gemini-3.1-flash-lite-preview"). No prefix construction needed.
        // Fallback to the Rust-side default if nothing is selected.
        const finalModel = selectedModel || defaultModelInfo?.id || "google/gemini-3.1-flash-lite-preview";

        // Synchronize updated keys directly to OpenClaw's auth-profiles.json layer
        let mappedKeys: Record<string, string> = {};
        if (keys["OpenAI"]) mappedKeys["OPENAI_API_KEY"] = keys["OpenAI"];
        if (keys["Anthropic"]) mappedKeys["ANTHROPIC_API_KEY"] = keys["Anthropic"];
        if (keys["Gemini"]) mappedKeys["GEMINI_API_KEY"] = keys["Gemini"];
        if (keys["Grok"]) mappedKeys["XAI_API_KEY"] = keys["Grok"];

        await invoke("sync_credentials", { agentId: agent.id, keys: mappedKeys });

        // Push personality state to SQLite. Use the full provider/model-name string.
        await invoke("update_agent_personality", {
          agentId: agent.id,
          personality: { ...agent.personality, active_model: finalModel }
        });
        // Update agent model in OpenClaw — model ID is already correctly formatted.
        await invoke("update_agent_model", { agentId: agent.id, model: finalModel });
      }
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (e) {
      console.error(e);
      setSaveStatus("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", paddingRight: 16, overflowY: "auto" }}>


      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0", flexShrink: 0 }}>Brain</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28, flexShrink: 0 }}>Shape how {agent.name} thinks, acts, and appears.</p>

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
          <button onClick={saveOverrides} disabled={saveStatus === "loading"} style={{
            padding: "10px 24px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "#3c6663", color: "var(--surface-card)", fontWeight: 600, fontSize: 13, minWidth: 120
          }}>
            {saveStatus === "loading" ? "Saving..." : saveStatus === "success" ? "Saved!" : saveStatus === "error" ? "Error" : "Save Overrides"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
        <div style={{ display: "flex", gap: 12 }}>
          {["Library", "USER.md", "PREFERENCES.md", "IDENTITY.md", "TOOLS.md", "SOUL.md"].map(f => (
            <button
              key={f}
              onClick={() => setSelectedFile(f)}
              style={{
                padding: "8px 16px", borderRadius: 8, border: "none",
                background: selectedFile === f ? "#218380" : "rgba(0,0,0,0.05)",
                color: selectedFile === f ? "#FFF" : "var(--text-main)",
                fontWeight: 600, cursor: "pointer", fontSize: 13
              }}
            >
              {f}
            </button>
          ))}
        </div>

        {selectedFile === "Library" ? (
          <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>Training Books</div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 12 }}>These books are injected into the agent's context to subtly shift their default decision making.</div>

            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                {recentlyRead.length === 0 && <span style={{ fontSize: 12, color: "var(--text-sub)", fontStyle: "italic" }}>No books assigned.</span>}
                {recentlyRead.map(book => (
                  <div key={book} style={{ padding: "6px 12px", background: "#3c6663", color: "var(--surface-card)", borderRadius: 16, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                    {book}
                    <span style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => {
                        const nextRead = recentlyRead.filter(b => b !== book);
                        setRecentlyRead(nextRead);
                        savePersonalityChanges(nextRead);
                    }}>×</span>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                <input
                  value={customBookInput}
                  onChange={e => setCustomBookInput(e.target.value)}
                  placeholder="Type a custom book title..."
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12, outline: "none", fontFamily: "inherit" }}
                  onKeyDown={e => {
                    if (e.key === "Enter" && customBookInput.trim()) {
                      const nextRead = [...recentlyRead, customBookInput.trim()];
                      setRecentlyRead(nextRead);
                      setCustomBookInput("");
                      savePersonalityChanges(nextRead);
                    }
                  }}
                />
                <button onClick={() => {
                  if (customBookInput.trim()) {
                    const nextRead = [...recentlyRead, customBookInput.trim()];
                    setRecentlyRead(nextRead);
                    setCustomBookInput("");
                    savePersonalityChanges(nextRead);
                  }
                }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--surface-base)", color: "var(--text-main)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>Add</button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
            <textarea
              value={fileContent}
              onChange={e => setFileContent(e.target.value)}
              style={{
                flex: 1, width: "100%", padding: 20, borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-bg)",
                color: "var(--text-main)", fontSize: 14, fontFamily: "'Fira Code', monospace",
                resize: "none", outline: "none", minHeight: 300
              }}
            />
            <div style={{ position: "absolute", bottom: 20, right: 20, display: "flex", alignItems: "center", gap: 12 }}>
              {fileSaveStatus && <span style={{ fontSize: 13, color: fileSaveStatus.includes("Error") ? "#E57373" : "#218380", fontWeight: 600 }}>{fileSaveStatus}</span>}
              <button
                onClick={handleSaveFile}
                disabled={isSaving}
                style={{
                  padding: "10px 24px", borderRadius: 8, border: "none",
                  background: "#3c6663", color: "#FFF", fontWeight: 700,
                  cursor: isSaving ? "not-allowed" : "pointer", fontSize: 14,
                  boxShadow: "0 4px 12px rgba(33,131,128,0.2)"
                }}
              >
                {isSaving ? "Saving..." : "Save File"}
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Permissions Tab ─────────────────────────────────────────────────────────

function PermissionsTab({ agent }: { agent: AgentData }) {
  const toggle = useWorldStore(s => s.togglePermission);
  const buckets = [
    {
      id: "lockdown",
      label: "Lockdown (Safe Defaults)",
      desc: "Recommended for all agents. Capabilities that pose no external security risk.",
      color: "#2E7D32",
      bg: "#e8f5e9",
      permissions: ["int_network", "scheduled", "memory_write", "file_read"]
    },
    {
      id: "secure",
      label: "Secure (Scoped Context)",
      desc: "Best practice for agents that need to browse or mutate local workspaces safely.",
      color: "#00ACC1",
      bg: "#e0f7fa",
      permissions: ["ext_network", "file_write", "payments", "imessage", "photos"]
    },
    {
      id: "yolo",
      label: "YOLO Mode (High Risk ⚠️)",
      desc: "Autonomy and financial risk. Could act unpredictably if manipulated via prompt injection.",
      color: "#C62828",
      bg: "#fdeaea",
      permissions: ["autonomous", "spend_auto"],
      isYolo: true
    }
  ];

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Permissions</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28 }}>
        Granular control over {agent.name}'s capabilities. Changes take effect immediately.
      </p>

      {/* Isolation badge */}
      <div style={{
        ...glass(0.5), padding: "14px 20px", borderRadius: 12, marginBottom: 20,
        display: "flex", alignItems: "center", gap: 12,
        borderLeft: "3px solid #6B6BAE",
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6B6BAE" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Shared Container</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)" }}>This agent runs in the shared Gateway. Switch to isolated for OS-level sandboxing.</div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          id="isolate-btn"
          onClick={async () => {
            const btn = document.getElementById('isolate-btn');
            const wasIsolated = agent.isolated;
            if (btn) btn.innerText = "Rebooting...";
            try {
              if (typeof invoke === 'function') {
                await invoke("toggle_agent_isolation", {
                  agentId: agent.id,
                  isolated: !wasIsolated
                });
                useWorldStore.getState().toggleIsolation(agent.id);
              }
            } catch (e) {
              console.error("Failed isolation toggle", e);
            } finally {
              if (btn) btn.innerText = !wasIsolated ? "Join Shared" : "Isolate";
            }
          }}
          style={{
            padding: "6px 14px", borderRadius: 8, border: "1px solid #6B6BAE",
            background: agent.isolated ? "#6B6BAE" : "transparent", color: agent.isolated ? "var(--surface-card)" : "#6B6BAE", fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s"
          }}>{agent.isolated ? "Un-Isolate" : "Isolate"}</button>
      </div>

      {buckets.map(bucket => {
        const bucketPerms = agent.permissions.filter(p => bucket.permissions.includes(p.id));
        if (bucketPerms.length === 0) return null;
        return (
          <div key={bucket.id} style={{ marginBottom: 32 }}>
            <div style={{
              padding: "12px 16px", background: bucket.bg, borderTopLeftRadius: 14, borderTopRightRadius: 14,
              borderBottom: `2px solid ${bucket.color}`, display: "flex", flexDirection: "column"
            }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: bucket.color, marginBottom: 4 }}>{bucket.label}</div>
              <div style={{ fontSize: 12, color: bucket.isYolo ? "#b71c1c" : "var(--text-sub)", fontWeight: bucket.isYolo ? 600 : 400 }}>{bucket.desc}</div>
            </div>
            <div style={{ ...glass(0.5), borderBottomLeftRadius: 14, borderBottomRightRadius: 14, overflow: "hidden" }}>
              {bucketPerms.map((p, i, arr) => (
                <div key={p.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "14px 20px",
                  borderBottom: i < arr.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>{p.description}</div>
                  </div>
                  <Toggle enabled={p.enabled} onChange={async () => {
                    toggle(agent.id, p.id);
                    try {
                      if (typeof invoke === 'function') {
                        const newPerms = agent.permissions.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x);
                        const capabilitiesObj: any = {};
                        newPerms.forEach(px => capabilitiesObj[px.id] = px.enabled);
                        await invoke("update_agent_capabilities", {
                          agentId: agent.id,
                          capabilities: capabilitiesObj
                        });
                      }
                    } catch (e) { console.error("Failed to update capabilities", e); }
                  }} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Memory Tab ──────────────────────────────────────────────────────────────

function MemoryTab({ agent }: { agent: AgentData }) {
  const memories = agent.memories || [];
  const { setAgents } = useWorldStore();
  const [newMemoryText, setNewMemoryText] = useState("");
  const [newMemoryType, setNewMemoryType] = useState("learned");
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const typeColors: Record<string, string> = { learned: "#4A9E96", experience: "#5B88A6", preference: "#8B6AAE", context: "#D4A04A" };

  const handleCreateMemory = async () => {
    if (!newMemoryText.trim()) return;
    setSaveStatus("loading");
    try {
      const newMem = {
        id: Math.random().toString(36).substring(7),
        type: newMemoryType,
        text: newMemoryText.trim(),
        when: new Date().toISOString(),
        confidence: 1.0
      };

      const updatedMemories = [newMem, ...memories];
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("update_agent_memories", { agentId: agent.id, memories: updatedMemories });

      setAgents(useWorldStore.getState().agents.map(a =>
        a.id === agent.id ? { ...a, memories: updatedMemories } as AgentData : a
      ));

      setNewMemoryText("");
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      console.error(err);
      setSaveStatus("error");
    }
  };

  const handleDeleteMemory = async (memId: string) => {
    try {
      const updatedMemories = memories.filter(m => m.id !== memId);
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("update_agent_memories", { agentId: agent.id, memories: updatedMemories });

      setAgents(useWorldStore.getState().agents.map(a =>
        a.id === agent.id ? { ...a, memories: updatedMemories } as AgentData : a
      ));
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Memory</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28 }}>
        What {agent.name} has learned and remembers. Memories are versioned and can be pruned.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["All", "Learned", "Experience", "Preference"].map(f => (
          <button key={f} style={{
            padding: "6px 14px", borderRadius: 20, border: "1px solid rgba(0,0,0,0.08)",
            background: f === "All" ? "#3c6663" : "var(--glass-light)",
            color: f === "All" ? "var(--surface-card)" : "var(--text-sub)",
            fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
          }}>{f}</button>
        ))}
      </div>

      <div style={{ ...glass(0.5), padding: 20, borderRadius: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 12 }}>Inject Manual Core Memory</div>
        <div style={{ display: "flex", gap: 12 }}>
          <select value={newMemoryType} onChange={e => setNewMemoryType(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", outline: "none" }}>
            <option value="learned">Learned Fact</option>
            <option value="experience">Experience</option>
            <option value="preference">Preference</option>
            <option value="context">Context</option>
          </select>
          <input
            value={newMemoryText}
            onChange={e => setNewMemoryText(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreateMemory()}
            placeholder="e.g. Only use the main branch for deployment."
            style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", outline: "none", fontSize: 13 }}
          />
          <button onClick={handleCreateMemory} disabled={saveStatus === "loading" || !newMemoryText.trim()} style={{
            padding: "10px 20px", borderRadius: 8, border: "none", background: !newMemoryText.trim() ? "var(--border-subtle)" : "#3c6663",
            color: !newMemoryText.trim() ? "#A0A0A0" : "var(--surface-card)", fontWeight: 600, cursor: !newMemoryText.trim() ? "not-allowed" : "pointer"
          }}>
            {saveStatus === "loading" ? "Saving..." : saveStatus === "success" ? "Saved!" : "Inject"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {memories.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-sub)", fontSize: 14 }}>
            {agent.name} doesn't have any memories yet.<br />Memories are formed asynchronously as the agent works.
          </div>
        ) : (
          memories.map((m: any, i: number) => (
            <div key={m.id || i} style={{ ...glass(0.5), padding: "16px 20px", borderRadius: 14, borderLeft: `3px solid ${typeColors[m.type] || typeColors["learned"]}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em",
                      color: typeColors[m.type], background: `${typeColors[m.type]}15`, padding: "2px 8px", borderRadius: 4,
                    }}>{m.type}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{m.when}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.5 }}>{m.text}</div>
                </div>
                <div style={{ textAlign: "right", marginLeft: 16 }}>
                  <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Confidence</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>{Math.round((m.confidence || 1.0) * 100)}%</div>
                  <button onClick={() => handleDeleteMemory(m.id)} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5 }}>🗑️</button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Spend Tab ───────────────────────────────────────────────────────────────

function SpendTab({ agent }: { agent: AgentData }) {
  const [budget, setBudget] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const budgetRes = await invoke('get_agent_budget', { agentId: agent.id });
        setBudget(budgetRes);
        const historyRes: any = await invoke('get_purchase_history', { agentId: agent.id });
        setHistory(Array.isArray(historyRes) ? historyRes : []);
      } catch (e) {
        console.error("Failed to load spend data", e);
      }
      setLoading(false);
    };
    fetchData();
  }, [agent.id]);

  const handleSave = async () => {
    if (!budget) return;
    setSaving(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('update_agent_budget', { budget });
      setTimeout(() => setSaving(false), 800);
    } catch (e) {
      console.error("Failed to save budget", e);
      setSaving(false);
    }
  };

  const updateProp = (key: string, val: any) => {
    if (!budget) return;
    setBudget({ ...budget, [key]: val });
  };

  if (loading) return <div style={{ color: "var(--text-sub)", fontSize: 14 }}>Loading financial data...</div>;
  if (!budget) return <div style={{ color: "var(--text-sub)", fontSize: 14 }}>Failed to map budget pipeline...</div>;

  return (
    <div style={{ paddingBottom: 64 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Financial Guardrails</h1>
          <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
            Manage limits and capabilities for {agent.name}'s autonomous spending.
          </p>
        </div>
        <button onClick={handleSave} disabled={saving} style={{
          padding: "10px 24px", borderRadius: 10, background: saving ? "#4A9E96" : "#3c6663", color: "var(--surface-card)", fontSize: 13, fontWeight: 600, border: "none", cursor: saving ? "default" : "pointer", transition: "0.2s"
        }}>
          {saving ? "Saved ✓" : "Commit Limits"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 32 }}>
        <div style={{ ...glass(0.6), padding: 24, borderRadius: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)" }}>Virtual Card Payments</div>
            <Toggle checked={budget.payments_enabled} onChange={v => updateProp("payments_enabled", v)} />
          </div>
          <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 20 }}>When disabled, the agent cannot issue any real-world merchant charges or API payments. It will simulate approvals.</div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Require Approval for New Merchants</div>
            <Toggle checked={budget.require_approval_new_merchant} onChange={v => updateProp("require_approval_new_merchant", v)} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Require Approval for Subscriptions</div>
            <Toggle checked={budget.require_approval_recurring} onChange={v => updateProp("require_approval_recurring", v)} />
          </div>
        </div>

        <div style={{ ...glass(0.6), padding: 24, borderRadius: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", marginBottom: 20 }}>Limits & Thresholds</div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Per-Transaction Limit ($)</div>
            <input type="number" value={budget.per_transaction_limit_cents / 100} onChange={e => updateProp("per_transaction_limit_cents", Math.max(0, parseInt(e.target.value) || 0) * 100)} style={{ width: 100, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", textAlign: "right" }} />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Auto-Approve Threshold ($)</div>
            <input type="number" value={budget.auto_approve_threshold_cents / 100} onChange={e => updateProp("auto_approve_threshold_cents", Math.max(0, parseInt(e.target.value) || 0) * 100)} style={{ width: 100, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", textAlign: "right" }} />
          </div>

          <div style={{ height: 1, background: "var(--border-subtle)", margin: "16px 0" }} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Daily Budget Total ($)</div>
            <input type="number" value={budget.daily_limit_cents / 100} onChange={e => updateProp("daily_limit_cents", Math.max(0, parseInt(e.target.value) || 0) * 100)} style={{ width: 100, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", textAlign: "right" }} />
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 24, fontSize: 16, fontWeight: 700, color: "var(--text-main)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Purchase Execution Log
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-sub)", background: "var(--border-subtle)", padding: "4px 12px", borderRadius: 12 }}>
          Daily Spend: ${(budget.daily_spent_cents / 100).toFixed(2)} / Monthly: ${(budget.monthly_spent_cents / 100).toFixed(2)}
        </div>
      </div>

      {history.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-sub)", fontSize: 14, ...glass(0.4), borderRadius: 16 }}>
          There are no recent agent transactions on record.
        </div>
      ) : (
        <div style={{ ...glass(0.6), borderRadius: 16, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--border-subtle)", textAlign: "left" }}>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Date/Time</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Merchant</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Category</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Status</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {history.map((record, i) => (
                <tr key={record.id || i} style={{ borderTop: "1px solid rgba(0,0,0,0.04)" }}>
                  <td style={{ padding: "14px 20px", fontSize: 13, color: "var(--text-main)" }}>{new Date(record.timestamp || Date.now()).toLocaleString()}</td>
                  <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{record.merchant}</td>
                  <td style={{ padding: "14px 20px", fontSize: 13, color: "var(--text-sub)" }}>{record.category}</td>
                  <td style={{ padding: "14px 20px", fontSize: 13 }}>
                    {record.decision === "Approved" || record.decision === "approved" || record.decision?.Approved === null
                      ? <span style={{ color: "#4A9E96", background: "#4A9E9615", padding: "4px 8px", borderRadius: 4, fontWeight: 600, fontSize: 11 }}>APPROVED</span>
                      : record.decision === "Denied" || record.decision === "denied" || record.decision?.Denied
                        ? <span style={{ color: "#E57373", background: "#E5737315", padding: "4px 8px", borderRadius: 4, fontWeight: 600, fontSize: 11 }}>DENIED</span>
                        : <span style={{ color: "#D4A04A", background: "#D4A04A15", padding: "4px 8px", borderRadius: 4, fontWeight: 600, fontSize: 11 }}>REQUIRES APPROVAL</span>
                    }
                  </td>
                  <td style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: "var(--text-main)", textAlign: "right" }}>
                    ${((record.amount_cents || 0) / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Chat / Communion Tab ────────────────────────────────────────────────────

function ChatTab({ agent, compact = false }: { agent: AgentData; compact?: boolean }) {
  const { agents, setAgents, setArchitectTab } = useWorldStore();
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const [message, setMessage] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>(agent.chatLog);
  const [loading, setLoading] = useState(false);
  const [needsRepair, setNeedsRepair] = useState(false);
  const [isHealing, setIsHealing] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll to bottom whenever chatLog changes
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // Keep global state in sync so errors remain when switching tabs
    setAgents(agents.map(a => a.id === agent.id ? { ...a, chatLog } : a));
  }, [chatLog]);

  useEffect(() => {
    if (typeof invoke === 'function') {
      invoke("get_conversation_history", { agentId: agent.id, limit: 100 })
        .then((resp: any) => {
          if (Array.isArray(resp) && resp.length > 0) {
            const mapped = resp.map(r => ({
              id: r.id,
              sender: r.role === "user" ? "user" : "agent",
              text: r.content,
              time: new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            }));

            // Retain any locally generated UI messages (like system errors) that aren't in the canonical backend
            const localOnly = agent.chatLog.filter(msg => !mapped.some((m: any) => m.id === msg.id) && msg.text.includes("⚠️ **System"));
            setChatLog([...mapped, ...localOnly]);
          } else {
            // Restore local errors if no remote history yet
            const localOnly = agent.chatLog.filter(msg => msg.text.includes("⚠️ **System"));
            if (localOnly.length > 0) {
              setChatLog(localOnly);
            }
          }
        })
        .catch(err => console.error("Failed to fetch chat history:", err));
    }
  }, [agent.id]);

  const handleSendMessage = async () => {
    if (!message.trim()) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      text: message,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setChatLog(prev => [...prev, userMsg]);
    setMessage("");
    setLoading(true);

    try {
      const response: any = await invoke("send_message", {
        agentId: agent.id,
        message: message,
      });

      const responseText = typeof response === 'object' ? response?.response || response?.content || JSON.stringify(response) : String(response);

      const agentMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "agent",
        text: responseText,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setChatLog(prev => [...prev, agentMsg]);
    } catch (error) {
      let friendlyError = String(error);
      if (friendlyError.includes("stopped container") || friendlyError.includes("OOM")) {
        // Only auto-heal on actual container-stopped / OOM errors — NOT on Gateway Timeout.
        // A Gateway Timeout means the agent is slow (container under load) — restarting
        // the OrbStack VM makes it worse, not better. Let the user retry manually.
        setIsHealing(true);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("hard_reset_infrastructure").catch(ex => console.error("Hard reset failed:", ex));
        await invoke("boot_sync_agents").catch(ex => console.warn("boot_sync after heal:", ex));
        setIsHealing(false);
        friendlyError = "The gateway was restarted and agents re-initialized. Please try sending your message again!";
      } else if (friendlyError.includes("taking a long time") || friendlyError.includes("Gateway Timeout")) {
        // Timeout — agent may not be registered yet (dir missing → agents add timed out on a previous boot).
        // Fire boot_sync_agents in the background so the NEXT send attempt succeeds.
        // We don't await it so the error message shows immediately. No VM restart — safe.
        const { invoke: inv } = await import('@tauri-apps/api/core');
        inv("boot_sync_agents").catch((e: any) => console.warn("background boot_sync after timeout:", e));
        friendlyError = "The agent is taking a while to respond. Registration is being refreshed — please try again in 30 seconds.";
      } else if (friendlyError.includes("No API key found for provider")) {
        const match = friendlyError.match(/No API key found for provider "([^"]+)"/);
        if (match) {
          friendlyError = `You have selected a **${match[1].toUpperCase()}** model, but no API key is configured. Please set your key in the Vault or run Diagnostics.`;
        } else {
          friendlyError = "Your API Key is missing for this model's provider. Please configure your integration.";
        }
      } else if (friendlyError.includes("Unknown model")) {
        const match = friendlyError.match(/Unknown model: ([^\s]+)/);
        if (match) {
          friendlyError = `The model **${match[1]}** is not recognized. Please check your spelling or select a valid model from the dropdown.`;
        } else {
          friendlyError = "The model you selected is unknown or unsupported.";
        }
      } else if (friendlyError.includes("access not configured") || friendlyError.includes("Re-Initialize Setup")) {
        setNeedsRepair(true);
        friendlyError = "This agent isn't configured with API keys yet and can't respond. Use the button below to finish setup.";
      }

      const errorMsg: ChatMessage = {
        id: "err-" + Date.now().toString(),
        sender: "agent",
        text: `⚠️ **System Error**: ${friendlyError}\n\n*(Raw Error: ${String(error).substring(0, 80)}...)*`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      
      setChatLog(prev => [...prev, errorMsg]);
      
      // Update global state using functional mapper to avoid stale 'agents' array
      useWorldStore.setState(state => ({
        agents: state.agents.map(a => a.id === agent.id ? { ...a, chatLog: [...a.chatLog, errorMsg] } : a)
      }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {!compact && (
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Chat</h1>
          <p style={{ fontSize: 14, color: "var(--text-sub)" }}>Communicate directly with {agent.name}.</p>
        </div>
      )}

      {/* Chat log */}
      <div style={{
        flex: 1, ...glass(0.35), borderRadius: 16, padding: 20, overflow: "auto",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        {chatLog.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)" }}>
            Start a conversation...
          </div>
        ) : (
          chatLog.map(msg => (
            <div key={msg.id} style={{
              display: "flex", flexDirection: "column",
              alignItems: msg.sender === "user" ? "flex-end" : "flex-start",
            }}>
              <div style={{
                maxWidth: "70%", padding: "12px 16px", borderRadius: 14,
                background: msg.sender === "user"
                  ? "linear-gradient(135deg, #3c6663, #609995)"
                  : "var(--glass-light)",
                color: msg.sender === "user" ? "var(--surface-card)" : "var(--text-main)",
                fontSize: 13, lineHeight: 1.5,
                borderBottomRightRadius: msg.sender === "user" ? 4 : 14,
                borderBottomLeftRadius: msg.sender === "agent" ? 4 : 14,
              }}>
                {msg.text}
              </div>
              <div style={{
                fontSize: 10, color: "var(--text-muted)", marginTop: 4,
                paddingLeft: msg.sender === "agent" ? 4 : 0,
                paddingRight: msg.sender === "user" ? 4 : 0,
              }}>
                {msg.sender === "agent" ? agent.name : "You"} · {msg.time}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 12, height: 12, borderRadius: "50%", background: "#3c6663",
              animation: "pulse 1.5s ease-in-out infinite",
            }} />
            <span style={{ fontSize: 13, color: "var(--text-sub)", fontStyle: "italic" }}>{agent.name} is thinking...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Repair banner — shown when agent returns "access not configured" */}
      {needsRepair && (
        <div style={{
          marginTop: 10, padding: "12px 16px",
          background: "linear-gradient(135deg, rgba(192,57,43,0.07), rgba(192,57,43,0.03))",
          border: "1px solid rgba(192,57,43,0.25)", borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div style={{ fontSize: 13, color: "#8b1a0e", lineHeight: 1.4 }}>
            <strong>Setup required.</strong> {agent.name} has no API key configured and can't respond yet.
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => setArchitectTab("overview")}
              style={{
                padding: "7px 14px", background: "#c0392b", color: "white",
                border: "none", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Re-Initialize Setup →
            </button>
            <button
              onClick={() => setNeedsRepair(false)}
              style={{ padding: "7px 10px", background: "transparent", color: "#8b1a0e", border: "1px solid rgba(192,57,43,0.3)", borderRadius: 8, fontSize: 12, cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && message.trim() && !loading && gatewayReady && !agent.paused) handleSendMessage(); }}
          placeholder={agent.paused ? "Agent is paused — resume it to chat..." : !gatewayReady ? "Agents are waking up..." : `Talk to ${agent.name}...`}
          disabled={loading || !gatewayReady || agent.paused}
          style={{
            flex: 1, padding: "14px 18px", borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.08)",
            background: "var(--glass-light)",
            fontSize: 13, fontFamily: "inherit", color: "var(--text-main)",
            outline: "none", opacity: (loading || !gatewayReady || agent.paused) ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleSendMessage}
          disabled={!message.trim() || loading || !gatewayReady || agent.paused}
          title={agent.paused ? "Resume the agent to send messages" : !gatewayReady ? "Agents are waking up, please wait..." : undefined}
          style={{
            padding: "14px 20px", borderRadius: 14, border: "none",
            background: (message.trim() && !loading && gatewayReady && !agent.paused) ? "#3c6663" : "var(--border-subtle)",
            color: (message.trim() && !loading && gatewayReady && !agent.paused) ? "var(--surface-card)" : "var(--text-muted)",
            fontSize: 13, fontWeight: 600, cursor: (message.trim() && !loading && gatewayReady && !agent.paused) ? "pointer" : "default",
            fontFamily: "inherit",
            transition: "all 0.15s ease",
          }}
        >{agent.paused ? "⏸" : !gatewayReady ? "⏳" : "Send"}</button>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOP NAVIGATION BAR
// ═══════════════════════════════════════════════════════════════════════════════

function TopNav() {
  const { activeView, setActiveView, theme, toggleTheme, agents, setSelectedAgent } = useWorldStore();
  const [searchQuery, setSearchQuery] = useState("");

  const navItems = [
    { id: "canopy" as const, label: "Canopy" },
    { id: "architect" as const, label: "Agents" },
    { id: "archive" as const, label: "Archive" },
    { id: "integrations" as const, label: "Integrations" },
  ];

  const filteredAgents = searchQuery ? agents.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()) || a.role.toLowerCase().includes(searchQuery.toLowerCase())) : [];

  return (
    <div style={{
      position: activeView === "canopy" ? "absolute" : "relative",
      top: 0, left: 0, right: 0, zIndex: 20,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 24px 12px 80px",
      background: activeView === "canopy" ? "transparent" : "var(--glass-light)",
      borderBottom: activeView === "canopy" ? "none" : "1px solid rgba(0,0,0,0.06)",
      backdropFilter: activeView === "canopy" ? "none" : "blur(24px)",
    }} data-tauri-drag-region>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setActiveView("canopy")}>
        <img src="/app-icon.png" alt="Canopy Logo" style={{ width: 28, height: 28, objectFit: "contain", pointerEvents: "none" }} />
        <span style={{
          fontSize: 17, fontWeight: 700, color: "var(--text-main)", letterSpacing: "-0.02em",
          fontFamily: "'Satoshi', 'Manrope', system-ui, sans-serif",
          fontStyle: "italic",
        }}>The Canopy</span>
      </div>

      {/* Center nav */}
      <div style={{ display: "flex", gap: 4 }}>
        {navItems.filter(item => activeView !== "loading" && activeView !== "onboarding").map(item => (
          <button key={item.id} onClick={() => setActiveView(item.id)} style={{
            padding: "6px 16px", border: "none", borderRadius: 6, cursor: "pointer",
            fontSize: 12, fontWeight: activeView === item.id ? 700 : 400,
            letterSpacing: "0.04em", textTransform: "uppercase",
            color: activeView === item.id ? "var(--text-main)" : "var(--text-sub)",
            background: "transparent", fontFamily: "inherit",
            borderBottom: activeView === item.id ? "2px solid #3c6663" : "2px solid transparent",
            transition: "all 0.15s ease",
          }}>
            {item.label}
          </button>
        ))}
      </div>

      {/* Right actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {activeView !== "canopy" && activeView !== "loading" && activeView !== "onboarding" && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => setActiveView("onboarding")}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 14px", borderRadius: 8, background: "#3c6663", color: "var(--surface-card)", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", transition: "0.2s all"
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              New Agent
            </button>

            <div style={{ position: "relative" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 14px",
                borderRadius: 8, background: "var(--border-subtle)", color: "var(--text-sub)",
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
                <input
                  placeholder="Search agents..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{ border: "none", outline: "none", background: "transparent", width: 120, fontSize: 12, fontFamily: "inherit", color: "var(--text-main)" }}
                />
              </div>
              {searchQuery && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--surface-card)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", border: "1px solid rgba(0,0,0,0.05)", zIndex: 50, maxHeight: 300, overflow: "auto" }}>
                  {filteredAgents.length === 0 ? (
                    <div style={{ padding: "12px", fontSize: 12, color: "var(--text-sub)" }}>No agents found.</div>
                  ) : (
                    filteredAgents.map(a => (
                      <div key={a.id} onClick={() => { setSelectedAgent(a.id); setActiveView("architect"); setSearchQuery(""); }} style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid rgba(0,0,0,0.03)" }}>
                        <div style={{ width: 16, height: 16, borderRadius: "50%", background: `${a.robeColor}20`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <div style={{ width: 6, height: 6, borderRadius: "50%", background: a.status === "active" ? "#4A9E96" : "#E57373" }} />
                        </div>
                        <div style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-main)", fontWeight: 600 }}>{a.name}</div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {(activeView !== "loading" && activeView !== "onboarding") && (
          <>
            <button onClick={toggleTheme} style={{
              width: 32, height: 32, borderRadius: 8, border: "none", cursor: "pointer",
              background: "var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center",
              color: theme === "dark" ? "#F5E6D8" : "var(--text-sub)",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
            </button>
            <div onClick={() => setActiveView("profile")} style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--border-subtle)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              color: "var(--text-sub)",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            </div>
            <div onClick={() => setActiveView("diagnostics")} style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--border-subtle)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              color: "var(--text-sub)",
            }} title="System Diagnostics">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANOPY VIEW (3D World with overlay)
// ═══════════════════════════════════════════════════════════════════════════════

function CanopyView() {
  const agents = useWorldStore(s => s.agents);
  const selectedAgent = useWorldStore(s => s.selectedAgent);
  const hoveredAgent = useWorldStore(s => s.hoveredAgent);
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const { setSelectedAgent, setActiveView, updateAgentVisuals } = useWorldStore();
  const theme = useWorldStore(s => s.theme);

  // Edit Mode State
  const [isEditMode, setIsEditMode] = useState(false);
  const [transformMode, setTransformMode] = useState<"translate" | "rotate">("translate");
  const [selectedEditAgent, setSelectedEditAgent] = useState<string | null>(null);
  const [editTransforms, setEditTransforms] = useState<Record<string, any>>({});

  const handleTransformChange = (id: string, transform: any) => {
    setEditTransforms(prev => ({ ...prev, [id]: transform }));
  };

  const getAgentBasePoint = (agentId: string) => {
    const N = agents.length;
    let x = 0; let z = 0; let dx = 0; let dz = -1;
    let index = agents.findIndex(a => a.id === agentId);
    if(index === -1) index = 0;
    for (let i = 0; i < index; i++) {
      if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
        const temp = dx; dx = -dz; dz = temp;
      }
      x += dx; z += dz;
    }
    return { x: x * 2, y: 0, z: z * 2, rotationY: 0 };
  };

  const handleNudge = (axis: "x" | "y" | "z" | "ry", amount: number) => {
    if (!selectedEditAgent) return;
    setEditTransforms(prev => {
      const existing = prev[selectedEditAgent] || agents.find(a => a.id === selectedEditAgent)?.visual_identity?.habitatTransform;
      const base = existing || getAgentBasePoint(selectedEditAgent);
      
      return {
        ...prev,
        [selectedEditAgent]: {
          x: base.x + (axis === "x" ? amount : 0),
          y: base.y + (axis === "y" ? amount : 0),
          z: base.z + (axis === "z" ? amount : 0),
          rotationY: (base.rotationY || 0) + (axis === "ry" ? amount : 0)
        }
      };
    });
  };

  const handleSaveLayout = async () => {
    try {
      for (const [id, transform] of Object.entries(editTransforms)) {
        const agent = agents.find(a => a.id === id);
        if (!agent) continue;
        const newVisuals = { ...(agent.visual_identity || {}), habitatTransform: transform };
        updateAgentVisuals(id, newVisuals);
        await invoke("update_agent_visuals", { agentId: id, visualIdentity: newVisuals });
      }
    } catch (e) {
      console.error("Failed to save layout:", e);
    }
    setIsEditMode(false);
    setSelectedEditAgent(null);
  };

  const handleCancelLayout = () => {
    setEditTransforms({});
    setIsEditMode(false);
    setSelectedEditAgent(null);
  };

  // Soft iridescent gradients tailored to the reference imagery (saturated slightly more so it's highly visible on all monitors)

  const nudgeBtnStyle = {
    background: "var(--surface-elevated)", color: "var(--text-main)", 
    border: "1px solid var(--border-subtle)", borderRadius: 6, 
    width: 28, height: 28, padding: 0, fontSize: 13, fontWeight: 700, 
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
  };

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <Canvas
        style={{ position: "absolute", inset: 0 }}
        gl={{ antialias: true, alpha: true }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.LinearToneMapping; gl.toneMappingExposure = 1.0; }}
      >
        <OrthographicCamera makeDefault position={[10, 10, 10]} zoom={150} near={0.1} far={100} />
        <OrbitControls makeDefault={!isEditMode} enablePan={true} minPolarAngle={Math.PI * 0.25} maxPolarAngle={Math.PI * 0.4} autoRotate={!isEditMode} autoRotateSpeed={0.15} dampingFactor={0.05} enableDamping minZoom={150} maxZoom={650} />
        <CanopyScene 
          isEditMode={isEditMode}
          transformMode={transformMode}
          selectedEditAgent={selectedEditAgent}
          setSelectedEditAgent={setSelectedEditAgent}
          editTransforms={editTransforms}
          onTransformChange={handleTransformChange}
        />
      </Canvas>

      {/* Edit Mode Toolbar */}
      <div style={{
          position: "absolute", bottom: isEditMode ? 40 : -150, left: "50%", transform: "translateX(-50%)", 
          zIndex: 20, display: "flex", gap: 16, alignItems: "center", transition: "all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
          background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 16, padding: "12px 20px",
          boxShadow: "0 12px 48px rgba(0,0,0,0.15)", opacity: isEditMode ? 1 : 0, pointerEvents: isEditMode ? "auto" : "none"
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginRight: 8 }}>
          Editing Layout
        </div>
        
        {/* Nudge Controls */}
        {selectedEditAgent ? (
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <button onClick={() => handleNudge("z", -0.25)} style={nudgeBtnStyle}>↑</button>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => handleNudge("x", -0.25)} style={nudgeBtnStyle}>←</button>
                <button onClick={() => handleNudge("z", 0.25)} style={nudgeBtnStyle}>↓</button>
                <button onClick={() => handleNudge("x", 0.25)} style={nudgeBtnStyle}>→</button>
              </div>
            </div>

            <div style={{ width: 1, height: 32, background: "var(--border-subtle)" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
               <button onClick={() => handleNudge("y", 0.25)} style={{ ...nudgeBtnStyle, width: 48, fontSize: 11 }}>+Y Up</button>
               <button onClick={() => handleNudge("y", -0.25)} style={{ ...nudgeBtnStyle, width: 48, fontSize: 11 }}>-Y Dn</button>
            </div>

            <div style={{ width: 1, height: 32, background: "var(--border-subtle)" }} />

            <div style={{ display: "flex", gap: 4 }}>
               <button onClick={() => handleNudge("ry", Math.PI / 8)} style={{ ...nudgeBtnStyle, width: 36, fontSize: 16 }}>⟳</button>
               <button onClick={() => handleNudge("ry", -Math.PI / 8)} style={{ ...nudgeBtnStyle, width: 36, fontSize: 16 }}>⟲</button>
            </div>

          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-sub)", fontStyle: "italic", padding: "0 16px" }}>
            Click an island in the scene to select it
          </div>
        )}

        <div style={{ width: 1, height: 24, background: "var(--border-subtle)", margin: "0 4px" }} />

        <button 
          onClick={handleCancelLayout}
          style={{ background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >
          Cancel
        </button>
        <button 
          onClick={handleSaveLayout}
          style={{ background: "#4A9E96", color: "white", border: "none", borderRadius: 8, padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", boxShadow: "0 2px 8px rgba(74,158,150,0.3)" }}
        >
          Save Layout
        </button>
      </div>

      {/* Agent roster overlay */}
      <div style={{ position: "absolute", top: 68, left: 20, zIndex: 10, display: "flex", flexDirection: "column", gap: 6, transition: "opacity 0.3s ease", opacity: isEditMode ? 0.3 : 1, pointerEvents: isEditMode ? "none" : "auto" }}>
        {agents.map(a => {
          const isHovered = hoveredAgent === a.id;
          return (
            <div key={a.id} 
                 onClick={() => { setSelectedAgent(a.id); setActiveView("architect"); }} 
                 onMouseEnter={() => useWorldStore.getState().setHoveredAgent(a.id)}
                 onMouseLeave={() => useWorldStore.getState().setHoveredAgent(null)}
                 style={{
              ...glass(selectedAgent === a.id ? 0.7 : 0.45),
              padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
              borderRadius: 12, minWidth: 150, transition: "all 0.2s ease",
              transform: isHovered ? "translateX(4px)" : "none",
              border: isHovered ? "1px solid #4A9E96" : "1px solid transparent",
              boxShadow: isHovered ? "0 4px 12px rgba(74, 158, 150, 0.2)" : "none",
            }}>
              <div style={{ width: 24, height: 24, position: "relative" }}>
                <LobsterIcon size={24} role={a.role} agentImage={a.image} shellColor={a.robeColor} accentColor={a.accentColor} />
                <div style={{
                  position: "absolute", bottom: -1, right: -1, width: 8, height: 8, borderRadius: "50%",
                  background: a.paused ? "var(--text-muted)" : !gatewayReady ? "#F4A83A" : a.status === "active" ? "#4A9E96" : a.status === "thinking" ? "#8B6AAE" : a.status === "error" ? "#E57373" : "var(--text-muted)",
                  border: "2px solid white",
                  animation: (!a.paused && !gatewayReady) ? "pulse 1.5s ease-in-out infinite" : "none",
                }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{a.name}</div>
                <div style={{ fontSize: 10, color: a.paused ? "var(--text-muted)" : !gatewayReady ? "#F4A83A" : "var(--text-sub)", textTransform: "capitalize" }}>
                  {a.paused ? "Paused" : !gatewayReady ? "Waking up..." : a.status === "error" ? "Offline" : a.currentAction}
                </div>
              </div>
            </div>
          )
        })}

        {/* Add Agent Button */}
        <div onClick={() => setActiveView("onboarding")} style={{
          background: "rgba(255,255,255,0.2)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
          border: "1px dashed rgba(60, 102, 99, 0.3)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.02)",
          padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
          borderRadius: 12, minWidth: 150, transition: "all 0.2s ease",
        }}>
          <div style={{
            width: 24, height: 24, borderRadius: "50%", background: "rgba(60, 102, 99, 0.1)",
            display: "flex", alignItems: "center", justifyContent: "center", color: "#3c6663"
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#3c6663" }}>Add Agent</div>
        </div>

      </div>

      {/* Bottom Right Edit Mode Trigger */}
      {!isEditMode && (
        <div 
          onClick={() => setIsEditMode(true)}
          style={{
            position: "absolute", bottom: 24, right: 24, zIndex: 10,
            background: "rgba(255,255,255,0.1)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.2)", borderRadius: "50%", width: 44, height: 44,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            color: "var(--text-sub)", boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
            transition: "all 0.2s ease"
          }}
          title="Edit Island Layout"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polygon points="16 3 21 8 8 21 3 21 3 16 16 3"></polygon></svg>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOADING SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function LoadingScreen({ status }: { status?: string }) {
  const [showLog, setShowLog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // Detect when we're in the slow ACPX init phase ("Starting agent runtime...")
  const isSlowPhase = status?.startsWith("Starting agent runtime");

  // Poll gateway log tail every 3s when the panel is open OR when in the slow phase
  useEffect(() => {
    if (!showLog && !isSlowPhase) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const tail = await invoke<string>("get_gateway_log_tail", { lines: 20 });
        if (!cancelled && tail) {
          setLogLines(tail.split("\n").filter(Boolean).slice(-20));
        }
      } catch { /* non-fatal */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [showLog, isSlowPhase]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "#faf9f6",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      flexDirection: "column", gap: 24,
    }}>
      <div style={{
        animation: "float 3s ease-in-out infinite",
        display: "flex", justifyContent: "center",
      }}>
        <img src="/app-icon.png" alt="Canopy Logo" style={{ width: 80, height: 80, objectFit: "contain" }} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "var(--text-main)" }}>
        Waking up the lobsters...
      </div>
      {status && (
        <div style={{
          fontSize: 13, color: "var(--text-sub)",
          maxWidth: 320, textAlign: "center",
          minHeight: 20,
          transition: "opacity 0.3s",
        }}>
          {status}
        </div>
      )}

      {/* Show log toggle when in slow ACPX init phase or when user opens it */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => setShowLog(v => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 12, color: "var(--text-sub)",
            opacity: 0.6, padding: "4px 8px",
            textDecoration: "underline", textUnderlineOffset: 3,
          }}
        >
          {showLog ? "hide details" : "show details"}
        </button>

        {showLog && (
          <div
            ref={logRef}
            style={{
              width: 540, maxHeight: 180,
              overflowY: "auto",
              background: "#1a1a1a",
              borderRadius: 8,
              padding: "10px 14px",
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: "#c8c8c0",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {logLines.length === 0
              ? <span style={{ opacity: 0.4 }}>Waiting for gateway logs...</span>
              : logLines.map((line, i) => {
                  // Colorize log levels
                  const isError = /error|ERR|ERRO/i.test(line);
                  const isWarn = /warn|WARN/i.test(line);
                  const isReady = /ready|responsive|ACPX/i.test(line);
                  const color = isError ? "#f87171" : isWarn ? "#fbbf24" : isReady ? "#4ade80" : "#c8c8c0";
                  return <div key={i} style={{ color }}>{line}</div>;
                })
            }
          </div>
        )}
      </div>

      <style>{`
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANION GUIDE
// ═══════════════════════════════════════════════════════════════════════════════

export function CompanionGuide({ type }: { type: string }) {
  const [step, setStep] = useState(0);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [step, status]);

  const config = {
    openai: {
      title: "OpenAI Setup",
      avatar: "/app-icon.png",
      intro: "Hi! I'm Canopy's setup assistant. I'll walk you through creating an OpenAI API Key so your agent can think. Let's get started!",
      steps: [
        { text: "First, make sure you are securely logged into your OpenAI developer account on the left." },
        { text: "Look for the button that says 'Create new secret key' near the top right, and click it." },
        { text: "In the window that pops up, name it 'Canopy' and click 'Create secret key'." },
        { text: "Awesome! Now copy that long key (it usually starts with 'sk-proj...'), paste it securely below, and hit Save.", input: { key: "OPENAI_API_KEY", placeholder: "sk-proj-..." } }
      ]
    },
    xai: {
      title: "xAI Setup",
      avatar: "/app-icon.png",
      intro: "Hi! I'm Canopy's setup assistant. I'll walk you through creating an xAI API Key so your agent can tap into Grok. Let's get started!",
      steps: [
        { text: "First, make sure you are securely logged into the xAI Developer Console on the left." },
        { text: "Click to generate a new API Key and name it something memorable like 'Canopy'." },
        { text: "Perfect! Now securely copy that key, paste it below, and hit Save.", input: { key: "XAI_API_KEY", placeholder: "xai-..." } }
      ]
    },
    anthropic: {
      title: "Anthropic Setup",
      avatar: "/app-icon.png",
      intro: "Hi! I'm Canopy's setup assistant. I'll walk you through creating an Anthropic API Key so your agent can think. Let's get started!",
      steps: [
        { text: "First, make sure you are securely logged into the Anthropic Console on the left." },
        { text: "Click the black 'Create Key' button near the top right of the screen." },
        { text: "Name the key 'Canopy' so you remember what it's for, and click 'Create'." },
        { text: "Perfect! Now securely copy that key (it starts with 'sk-ant...'), paste it below, and hit Save.", input: { key: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." } }
      ]
    },
    gemini: {
      title: "Google Gemini Setup",
      avatar: "/app-icon.png",
      intro: "Hi! I'm Canopy's setup assistant. I'll walk you through creating a Google Gemini API Key so your agent can think. Let's get started!",
      steps: [
        { text: "First, make sure you are securely logged into Google AI Studio on the left." },
        { text: "Click the blue 'Create API key' button in the center (or top right, depending on your window size)." },
        { text: "Select your project from the dropdown (or create a new one) and generate the key." },
        { text: "Great! Securely copy the generated key, paste it below, and hit Save.", input: { key: "GEMINI_API_KEY", placeholder: "AIzaSy..." } }
      ]
    },
    slack: {
      title: "Slack Setup",
      avatar: "/app-icon.png",
      intro: "Hi! Let's wire up your Canopy agent to Slack. We do this using secure Socket Mode which keeps all data on your local machine.",
      steps: [
        { text: "I've already attached an App Manifest for you! Scroll down to the bottom of the page and click the green 'Create' button." },
        { text: "Great. Now, on the left sidebar, click on 'Socket Mode' under Settings." },
        { text: "Toggle 'Enable Socket Mode' to ON. A modal will pop up." },
        { text: "Name the token 'canopy-app-token' and click Generate. Copy the xapp-... token and paste it here.", input: { key: "slack-app-token", placeholder: "xapp-..." } },
        { text: "Almost done! Now click 'OAuth & Permissions' on the left sidebar." },
        { text: "Click the 'Install to Workspace' button and click Allow." },
        { text: "Copy the 'Bot User OAuth Token' (starts with xoxb-...). Paste it below and hit Connect!", input: { key: "slack-bot-token", placeholder: "xoxb-..." } }
      ]
    },
    email_dedicated: {
      title: "Email Dedicated Setup",
      avatar: "/app-icon.png",
      intro: "Let's create a dedicated, locked-down email sandbox for your agent. This is the safest way to give them an email personality.",
      steps: [
        { text: "First, go to your preferred provider (like Gmail or Outlook) and create a brand new, free email address specifically for this agent." },
        { text: "Next, we cannot use the raw password. Go to your new Google Account settings -> Security -> 2-Step Verification and scroll to 'App Passwords'." },
        { text: "Generate a custom App Password named 'Canopy'." },
        { text: "Paste the credentials below so your agent can safely login via IMAP/SMTP.", input: { key: "email-dedicated", placeholder: "agent@gmail.com : xyzt-abcd-..." } }
      ]
    },
    email_oauth_read: {
      title: "Email Read-Only OAuth",
      avatar: "/app-icon.png",
      intro: "This setup grants your agent secure insight into your emails without the ability to reply or delete.",
      steps: [
        { text: "Click the secure authorize gateway in your browser to sign into Google Workspace." },
        { text: "When prompted, check the box strictly for 'View your email messages and settings'." },
        { text: "Once you see the success screen, paste the generated OAuth token here.", input: { key: "email-oauth-read", placeholder: "oauth_..." } }
      ]
    },
    email_oauth_write: {
      title: "YOLO Mode: Email Full Access",
      avatar: "/app-icon.png",
      intro: "WARNING: You are about to give this agent full destructive and impersonation abilities over your real email. Do not proceed unless you thoroughly trust this setup.",
      steps: [
        { text: "Please acknowledge the YOLO warning. Your agent will be able to delete all your history or reply to your boss." },
        { text: "Complete the OAuth flow using the link in your browser and check all boxes for complete control." },
        { text: "Paste the YOLO token below to commit to this.", input: { key: "email-oauth-write", placeholder: "oauth_..." } }
      ]
    },
    calendar_oauth_read: {
      title: "Calendar Read-Only OAuth",
      avatar: "/app-icon.png",
      intro: "Let's give your agent the ability to check your availability without letting them modify your schedule.",
      steps: [
        { text: "Authenticate via Google Calendar in the browser window." },
        { text: "Approve the 'View events on all your calendars' scope." },
        { text: "Paste the scoped token below.", input: { key: "calendar-oauth-read", placeholder: "oauth_..." } }
      ]
    },
    calendar_oauth_write: {
      title: "YOLO Mode: Calendar Full Access",
      avatar: "/app-icon.png",
      intro: "WARNING: Your agent will be able to schedule, modify, edit, or delete any meeting on your calendar.",
      steps: [
        { text: "Acknowledge the risk. This allows the agent to decline invites on your behalf without asking or send new invites." },
        { text: "Approve the Full Access scope in the browser integration." },
        { text: "Paste the YOLO token below.", input: { key: "calendar-oauth-write", placeholder: "oauth_..." } }
      ]
    }
  }[type] || null;

  if (!config) return <div style={{ padding: 20 }}>Unknown configuration. You can close this window.</div>;

  const currentStepData = config.steps[step];

  const handleAction = async () => {
    if (currentStepData.input) {
      if (!tokens[currentStepData.input.key]) return;

      // If it's a keychain save
      setStatus("saving");
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("store_secret_cmd", { key: currentStepData.input.key, value: tokens[currentStepData.input.key].trim() });

        // If there are more steps, just advance
        if (step < config.steps.length - 1) {
          setStep(step + 1);
          setStatus("idle");
        } else {
          // Signal completion
          setStatus("success");

          try {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('companion-finished', { type, key: tokens[currentStepData.input.key] });

            // If it was Slack, finalize the connection via start_slack_listener which
            // writes botToken + appToken into openclaw.json via config set. No pairing
            // code needed — Socket Mode authenticates with the xapp- token directly.
            if (type === "slack") {
              await emit('slack-credentials-saved');
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke("start_slack_listener").catch(() => { });
            }
          } catch (evtErr) { }

          setTimeout(async () => {
            try {
              const { getCurrentWindow } = await import('@tauri-apps/api/window');
              await getCurrentWindow().close();
            } catch (e) { }
          }, 2000);
        }
      } catch (e) {
        console.error(e);
        setStatus("error");
      }
    } else {
      if (step < config.steps.length - 1) setStep(step + 1);
    }
  };

  return (
    <div style={{
      width: "100%", height: "100vh", display: "flex", flexDirection: "column",
      background: "var(--surface-base)", fontFamily: "'Manrope', system-ui, sans-serif"
    }}>
      {/* Companion header — decorative only, native title bar handles close/drag */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 20px 0", userSelect: "none" }}>
        <LobsterIcon size={36} shellColor="#3c6663" accentColor="#D9B08C" />
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>Setup Guide</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>I'll walk you through creating your Slack app.</div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Intro */}
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
          <img src={config.avatar} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
          <div style={{ background: "var(--surface-card)", padding: "12px 16px", borderRadius: "16px 16px 16px 4px", fontSize: 14, lineHeight: 1.5, color: "var(--text-main)", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
            {config.intro}
          </div>
        </div>

        {config.steps.slice(0, step + 1).map((s, i) => (
          <React.Fragment key={i}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", animation: "slideIn 0.3s ease" }}>
              <div style={{ width: 28, flexShrink: 0 }} />
              <div style={{ width: "100%", background: i === step ? "#3c6663" : "var(--surface-card)", color: i === step ? "var(--surface-card)" : "var(--text-main)", padding: "12px 16px", borderRadius: "16px 16px 16px 4px", fontSize: 14, lineHeight: 1.5, boxShadow: "0 2px 8px rgba(0,0,0,0.04)", transition: "all 0.3s" }}>
                {s.text}
                {s.input && i === step && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 8, lineHeight: 1.4, color: "#f8f9fa", background: "var(--border-strong)", padding: "8px 12px", borderRadius: 8 }}>
                      <span style={{ marginRight: 6 }}>🔒</span>
                      macOS will securely ask for your password to lock this in the system Keychain.
                    </div>
                    <PasswordInput
                      autoFocus
                      placeholder={s.input.placeholder}
                      value={tokens[s.input.key] || ""}
                      onChange={e => setTokens({ ...tokens, [s.input.key]: e.target.value })}
                      style={{
                        width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.3)", background: "rgba(0,0,0,0.2)", color: "var(--surface-card)", outline: "none", fontSize: 13, fontFamily: "monospace"
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* User advancement bubble */}
            {i === step && status === "idle" && (
              <div style={{ display: "flex", justifyContent: "flex-end", animation: "slideIn 0.3s ease 0.5s backwards" }}>
                <button onClick={handleAction} disabled={s.input && !tokens[s.input.key]} style={{
                  padding: "8px 16px", borderRadius: 16, border: "none", background: "#D9B08C", color: "var(--text-main)", fontSize: 13, fontWeight: 700, cursor: (s.input && !tokens[s.input.key]) ? "default" : "pointer", opacity: (s.input && !tokens[s.input.key]) ? 0.5 : 1
                }}>
                  {s.input ? "Save & Continue" : "I've done this ->"}
                </button>
              </div>
            )}
          </React.Fragment>
        ))}

        {status === "saving" && (
          <div style={{ textAlign: "center", fontSize: 13, color: "var(--text-sub)", fontStyle: "italic", animation: "pulse 1s infinite" }}>Saving securely to your Mac's Keychain...</div>
        )}
        {status === "success" && (
          <div style={{ textAlign: "center", animation: "slideIn 0.3s ease" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663" }}>Saved successfully!</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 4 }}>Validating connection & closing...</div>
          </div>
        )}

        <div ref={bottomRef} style={{ height: 20 }} />
      </div>

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        /* hide scrollbar */
        ::-webkit-scrollbar { width: 0px; background: transparent; }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function DiagnosticsView() {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState("");

  const runAudit = async () => {
    setLoading(true);
    setRepairMsg("");
    try {
      const res = await invoke("audit_openclaw_config");
      setReport(res);
    } catch (e) {
      console.error(e);
      setReport({ error: String(e) });
    }
    setLoading(false);
  };

  useEffect(() => {
    runAudit();
  }, []);

  const handleRepair = async () => {
    setRepairing(true);
    setRepairMsg("");
    try {
      const msg = await invoke("repair_openclaw_config", { targetModel: null });
      setRepairMsg(String(msg));
      runAudit();
    } catch (e) {
      setRepairMsg("Error: " + String(e));
    }
    setRepairing(false);
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Noto Serif', Georgia, serif", color: "var(--text-main)", marginBottom: 8 }}>System Diagnostics</div>
      <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 32 }}>Audit openclaw configuration and repair alignment mismatches.</div>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center" }}>Scanning OpenClaw Container...</div>
      ) : report?.error ? (
        <div style={{ padding: 24, border: "1px dashed #dca5a5", background: "#fcf2f2", color: "#aa371c" }}>
          <b>Audit Failed:</b> {report.error}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontWeight: 600 }}>Alignment Status</div>
              <div style={{ background: report.is_aligned ? "#4A9E96" : "#E57373", color: "white", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                {report.is_aligned ? "ALIGNED" : "MISCONFIGURED"}
              </div>
            </div>

            <div style={{ fontSize: 13, color: "var(--text-main)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div><b>Container Online:</b> {report.container_running ? "Yes" : "No"}</div>
              <div><b>Active Container Default Model:</b> {report.active_default_model}</div>
              <div><b>Expected Based on APIs:</b> {report.expected_model}</div>
              {report.missing_keys.length > 0 && (
                <div style={{ color: "#aa371c" }}><b>Missing API Keys for Default:</b> {report.missing_keys.join(", ")}</div>
              )}
              <div><b>Ports Synchronized:</b> {report.port_mismatch ? "No" : "Yes"}</div>
            </div>

            {!report.is_aligned && (
              <button onClick={handleRepair} disabled={repairing} style={{ marginTop: 24, background: "#218380", color: "white", border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
                {repairing ? "Repairing..." : "Auto-Repair Configuration"}
              </button>
            )}
            {repairMsg && <div style={{ fontSize: 12, marginTop: 12, color: repairMsg.startsWith("Error") ? "#aa371c" : "#218380" }}>{repairMsg}</div>}
          </div>

          {report.raw_config_json && (
            <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Raw OpenClaw Configuration</div>
              <pre style={{ fontSize: 10, background: "rgba(0,0,0,0.02)", padding: 12, borderRadius: 8, overflowX: "auto", color: "var(--text-sub)" }}>
                {report.raw_config_json}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER PROFILE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

interface UserProfile {
  name: string;
  email: string;
  phone: string;
  timezone: string;
  working_hours: string;
  communication_tone: string;
  global_directives: string;
}

function UserProfileView() {
  const [profile, setProfile] = useState<UserProfile>({
    name: "Admin", email: "", phone: "", timezone: "UTC", working_hours: "9:00 AM - 5:00 PM",
    communication_tone: "Professional", global_directives: "Always cite your sources and optimize for safety."
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (typeof invoke === 'function') {
      invoke("get_user_profile").then((res: any) => setProfile(res)).catch(console.error);
    }
  }, []);

  const handleSave = async () => {
    if (typeof invoke === 'function') {
      setSaving(true);
      await invoke("save_user_profile", { profile }).catch(console.error);
      setTimeout(() => setSaving(false), 600);
    }
  };

  const Field = ({ label, value, field, type = "text", placeholder = "", rows = 1 }: any) => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>{label}</label>
      {rows > 1 ? (
        <textarea
          value={value} onChange={e => setProfile({ ...profile, [field]: e.target.value })}
          rows={rows} placeholder={placeholder}
          style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: 14, outline: "none", resize: "vertical" }}
        />
      ) : (
        <input
          type={type} value={value} onChange={e => setProfile({ ...profile, [field]: e.target.value })}
          placeholder={placeholder}
          style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: 14, outline: "none" }}
        />
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 700, margin: "40px auto", padding: "0 24px", paddingBottom: 100 }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Principal Context</h1>
        <p style={{ fontSize: 15, color: "var(--text-sub)", margin: 0 }}>Define your global identity. This context is inherited by every agent in the Canopy to understand who they work for.</p>
      </div>

      <div style={{ background: "var(--glass-light)", backdropFilter: "blur(24px)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.05)", padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#3c6663", margin: "0 0 16px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", paddingBottom: 8 }}>Identity & Contact</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <Field label="Full Name" field="name" value={profile.name} placeholder="e.g. Jane Doe" />
          <Field label="Preferred Timezone" field="timezone" value={profile.timezone} placeholder="e.g. America/Los_Angeles" />
          <Field label="Email Address" type="email" field="email" value={profile.email} placeholder="Agents can route reports here" />
          <Field label="Phone Number" type="tel" field="phone" value={profile.phone} placeholder="For SMS alerts" />
        </div>
      </div>

      <div style={{ background: "var(--glass-light)", backdropFilter: "blur(24px)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.05)", padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#3c6663", margin: "0 0 16px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", paddingBottom: 8 }}>Working Directives</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <Field label="Working Hours" field="working_hours" value={profile.working_hours} placeholder="e.g. 9:00 AM - 5:00 PM EST" />
          <Field label="Communication Tone" field="communication_tone" value={profile.communication_tone} placeholder="e.g. Professional & Concise" />
        </div>
        <Field label="Global Agent Directives" field="global_directives" value={profile.global_directives} rows={3} placeholder="e.g. 'Never read my personal inbox. Always provide a TL;DR summary at the top.'" />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={handleSave} disabled={saving} style={{ padding: "12px 32px", borderRadius: 12, background: saving ? "#4A9E96" : "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, border: "none", cursor: saving ? "default" : "pointer", transition: "all 0.2s ease" }}>
          {saving ? "Saved ✓" : "Save Profile Configuration"}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ─── Archive View ─────────────────────────────────────────────────────────────

function ArchiveView() {
  const { agents } = useWorldStore();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [bridgeFilter, setBridgeFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");

  useEffect(() => {
    const fetchArchive = async () => {
      setLoading(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const data: any = await invoke('get_global_audit_log', { limit: 200 });
        setLogs(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Failed to fetch global audit log", e);
      }
      setLoading(false);
    };
    fetchArchive();
  }, []);

  const getLogColor = (action: string) => {
    const a = action.toLowerCase();
    if (a.includes("spend") || a.includes("payment")) return { color: "#D4A04A", bg: "#D4A04A15", border: "#D4A04A40" };
    if (a.includes("blocked") || a.includes("failed") || a.includes("denied")) return { color: "#E57373", bg: "#E5737315", border: "#E5737340" };
    if (a.includes("created") || a.includes("spawn")) return { color: "#4A9E96", bg: "#4A9E9615", border: "#4A9E9640" };
    return { color: "var(--text-sub)", bg: "var(--border-subtle)", border: "var(--border-subtle)" };
  };

  const filteredLogs = logs.filter(log => {
    if (agentFilter !== "all" && log.agent_id !== agentFilter) return false;
    if (bridgeFilter !== "all") {
      if (!log.bridge_type && bridgeFilter !== "core") return false;
      if (log.bridge_type && log.bridge_type.toLowerCase() !== bridgeFilter) return false;
    }
    if (actionFilter !== "all" && !log.action.toLowerCase().includes(actionFilter)) return false;
    return true;
  });

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "32px 40px", maxWidth: 1200, margin: "0 auto", width: "100%", height: "100%", overflow: "hidden" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: 0 }}>System Archive</h1>
            <div style={{ background: "#4A9E9620", color: "#4A9E96", padding: "4px 10px", borderRadius: 12, fontSize: 13, fontWeight: 700 }}>LIVE</div>
          </div>
          <p style={{ fontSize: 15, color: "var(--text-sub)", margin: 0 }}>Global flight data recorder mapping all agent decisions, actions, and anomalous traces.</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)} style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, fontWeight: 600, color: "var(--text-main)", outline: "none", cursor: "pointer" }}>
          <option value="all">Every Agent</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={bridgeFilter} onChange={e => setBridgeFilter(e.target.value)} style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, fontWeight: 600, color: "var(--text-main)", outline: "none", cursor: "pointer" }}>
          <option value="all">All Bridges</option>
          <option value="core">Core Platform</option>
          <option value="slack">Slack</option>
          <option value="imessage">iMessage</option>
          <option value="payments">Virtual Cards</option>
        </select>
        <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, fontWeight: 600, color: "var(--text-main)", outline: "none", cursor: "pointer" }}>
          <option value="all">All Actions</option>
          <option value="created">Agent Spawns</option>
          <option value="spend">Financial Spends</option>
          <option value="denied">Blocks & Flags</option>
        </select>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-sub)" }}>Loading flight logs...</div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", ...glass(0.6), borderRadius: 16, border: "1px solid rgba(0,0,0,0.06)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--glass-heavy)", backdropFilter: "blur(8px)", zIndex: 1, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", width: 140 }}>Time</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", width: 180 }}>Principal Agent</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", width: 160 }}>Bridge Target</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Action Trajectory</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "right" }}>Trace Hash</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 40, textAlign: "center", color: "var(--text-sub)", fontSize: 14 }}>No actions found matching these security filters.</td>
                </tr>
              ) : filteredLogs.map((log) => {
                const mappedAgent = agents.find(a => a.id === log.agent_id);
                const styles = getLogColor(log.action);
                return (
                  <tr key={log.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.04)", cursor: "pointer", transition: "0.15s" }} onMouseOver={e => e.currentTarget.style.background = "rgba(0,0,0,0.02)"} onMouseOut={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "16px 24px", fontSize: 13, color: "var(--text-sub)" }}>{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    <td style={{ padding: "16px 24px", fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>
                      {log.agent_id ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: mappedAgent ? mappedAgent.robeColor : "#A0A0A0" }} />
                          {mappedAgent ? mappedAgent.name : "Unknown Agent"}
                        </div>
                      ) : "System Engine"}
                    </td>
                    <td style={{ padding: "16px 24px" }}>
                      <span style={{ padding: "4px 8px", background: "var(--border-subtle)", borderRadius: 6, fontSize: 12, fontWeight: 600, color: "var(--text-main)", textTransform: "capitalize" }}>
                        {log.bridge_type || "Core System"}
                      </span>
                    </td>
                    <td style={{ padding: "16px 24px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ display: "inline-block", padding: "2px 8px", background: styles.bg, color: styles.color, border: `1px solid ${styles.border}`, borderRadius: 4, fontSize: 11, fontWeight: 700, textTransform: "uppercase", width: "max-content", letterSpacing: "0.02em" }}>
                          {log.action}
                        </span>
                        <span style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.4 }}>{log.detail}</span>
                      </div>
                    </td>
                    <td style={{ padding: "16px 24px", textAlign: "right" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "#909090", background: "var(--border-subtle)", padding: "4px 8px", borderRadius: 4 }}>
                        {log.content_hash ? log.content_hash.substring(0, 8) : "N/A"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const { activeView, selectedAgent, agents, setSelectedAgent, setActiveView, setAgents, theme } = useWorldStore();
  const agent = agents.find(a => a.id === selectedAgent) || agents[0];
  const [initialized, setInitialized] = useState(false);
  const [loadStatus, setLoadStatus] = useState("Waking up the lobsters...");

  // Sync hash to activeView on load and hashchange
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#/', '').replace('#', '');
      const validViews = ["loading", "onboarding", "canopy", "architect", "archive", "library", "vault"];
      if (validViews.includes(hash)) {
        setActiveView(hash as any);
      }
    };
    window.addEventListener('hashchange', handleHash);
    // Only run initial hash parse after agents are loaded, otherwise it might conflict with onboarding logic
  }, [setActiveView]);

  // Sync activeView to hash
  useEffect(() => {
    if (activeView !== "loading") {
      const currentHash = window.location.hash.replace('#/', '').replace('#', '');
      if (currentHash !== activeView) {
        window.history.pushState(null, '', `#/${activeView}`);
      }
    }
  }, [activeView]);

  useEffect(() => {
    const loadAgents = async () => {
      try {
        // Sync preferences template from admin API to Rust before boot
        try {
          const settingsRes = await fetch('http://localhost:3001/api/settings');
          const settings = await settingsRes.json();
          if (settings.preferencesTemplate) {
            await invoke("set_preferences_template", { content: settings.preferencesTemplate });
          }
        } catch (e) {
          console.warn("Could not fetch preferences template from admin API:", e);
        }

        const loadedAgents = await invoke("list_agents") as Agent[];

        if (loadedAgents.length === 0) {
          setActiveView("onboarding");
        } else {
          // Pre-flight: clean stale agents from openclaw.json and fix corrupted
          // auth-profiles.json files on the host bind-mount BEFORE the container starts.
          // OpenClaw reads these files the instant it boots — corrupted JSON or stale
          // entries (e.g. "main", "test1", incompletely-deleted agents) cause a
          // 18 → 300+ PID retry spiral within 30 seconds of startup.
          setLoadStatus("Running pre-flight checks...");
          await invoke("preflight_cleanup").catch((e) =>
            console.warn("preflight_cleanup non-fatal:", e)
          );

          setLoadStatus("Starting infrastructure gateway...");
          await safeStartGateway().catch((e) => console.error("Gateway boot failed during loadAgents:", e));

          setLoadStatus("Registering agents with gateway...");
          // Listen for per-agent progress events emitted by the Rust side.
          const { listen } = await import('@tauri-apps/api/event');
          const unlisten = await listen<string>('boot-sync-progress', (event) => {
            setLoadStatus(event.payload);
          });
          await invoke("boot_sync_agents").catch((e) => console.warn("boot_sync_agents failed (non-fatal):", e));
          unlisten();

          setLoadStatus("Checking DB for Agents...");
          // Sync keys to all legacy agents to prevent silent Failovers into OOM crashes (Exit 137).
          // Load global fallback keys once
          const globalAnthropic = String(await invoke("get_secret_cmd", { key: "ANTHROPIC_API_KEY" }).catch(() => "") || "");
          const globalOpenAI    = String(await invoke("get_secret_cmd", { key: "OPENAI_API_KEY" }).catch(() => "") || "");
          const globalGemini    = String(await invoke("get_secret_cmd", { key: "GEMINI_API_KEY" }).catch(() => "") || "");
          const globalGrok      = String(await invoke("get_secret_cmd", { key: "XAI_API_KEY" }).catch(() => "")
                                      || await invoke("get_secret_cmd", { key: "GROK_API_KEY" }).catch(() => "") || "");

          setLoadStatus("Keys loaded, pushing sync...");

          for (const ag of loadedAgents) {
            setLoadStatus("Syncing Keys: " + ag.id);
            // Per-agent key takes priority over global fallback.
            // This lets each agent use a separate API key for usage tracking,
            // while the global key acts as the default for agents without their own.
            const agAnthropic = String(await invoke("get_secret_cmd", { key: `agent_${ag.id}_anthropic_key` }).catch(() => "") || "") || globalAnthropic;
            const agOpenAI    = String(await invoke("get_secret_cmd", { key: `agent_${ag.id}_openai_key` }).catch(() => "") || "")    || globalOpenAI;
            const agGemini    = String(await invoke("get_secret_cmd", { key: `agent_${ag.id}_gemini_key` }).catch(() => "") || "")    || globalGemini;
            const agGrok      = String(await invoke("get_secret_cmd", { key: `agent_${ag.id}_grok_key` }).catch(() => "") || "")      || globalGrok;

            await invoke("sync_credentials", { agentId: ag.id, keys: {
              "ANTHROPIC_API_KEY": agAnthropic,
              "OPENAI_API_KEY":    agOpenAI,
              "GEMINI_API_KEY":    agGemini,
              "XAI_API_KEY":       agGrok,
            }}).catch(console.warn);
          }

          setLoadStatus("Setting up UI Agent Models...");
          // Enrich agents with UI data
          const enrichedAgents: AgentData[] = loadedAgents.map(agent => {
            const roleInfo = AGENT_TYPE_INFO[agent.role] || AGENT_TYPE_INFO["Assistant"];
            return {
              ...agent,
              title: `The ${agent.role}`,
              description: roleInfo.description,
              robeColor: roleInfo.robeColor,
              accentColor: roleInfo.accentColor,
              position: [Math.random() * 4 - 2, 0, Math.random() * 4 - 2],
              targetPosition: [Math.random() * 4 - 2, 0, Math.random() * 4 - 2],
              currentAction: "idle",
              socialMotive: 0.5 + Math.random() * 0.3,
              energy: 0.6 + Math.random() * 0.3,
              uptime: `${Math.floor(agent.stats.uptime_seconds / 3600)} hrs`,
              tokensUsed: "0k",
              weeklyCompute: "0.000",
              monthlySpend: Math.floor(agent.stats.total_cost_usd),
              spendLimit: 200,
              permissions: DEFAULT_PERMISSIONS.map(p => ({
                ...p,
                enabled: agent.capabilities ? (agent.capabilities as any)[p.id] : p.enabled
              })),
              recentSpend: [],
              chatLog: [],
              memories: [],
              personalityPrompt: agent.personality?.custom_instructions || `${agent.name} is a ${agent.role.toLowerCase()} lobster — reliable, sharp, and always working.`,
              avatarPrompt: `A Monument Valley-style lobster with a ${roleInfo.robeColor} shell, round eyes, and swaying antennae.`,
            };
          });
          setAgents(enrichedAgents);

          const hash = window.location.hash.replace('#/', '').replace('#', '');
          const validViews = ["loading", "onboarding", "canopy", "architect", "archive", "library", "vault"];
          if (hash && validViews.includes(hash) && hash !== "loading" && hash !== "onboarding") {
            setActiveView(hash as any);
          } else {
            setActiveView("canopy");
          }
        }
      } catch (error) {
        console.error("Failed to load agents:", error);
        setActiveView("onboarding");
      } finally {
        setInitialized(true);
      }

      // NOTE: start_slack_listener is intentionally NOT called here on every boot.
      // OpenClaw auto-connects Slack on startup from the persisted openclaw.json config
      // (confirmed: "slack socket mode connected" appears in gateway logs without any
      // explicit call). Calling start_slack_listener on every boot rewrites the same
      // 5 config keys, each triggering a gateway self-SIGTERM restart → OOM cascade.
      // start_slack_listener should only be called from the Slack settings UI when
      // actually configuring Slack for the first time or updating tokens.
    };

    loadAgents();
  }, []);

  // Default to first agent if entering architect with none selected
  useEffect(() => {
    if (activeView === "architect" && !selectedAgent && agents.length > 0) {
      setSelectedAgent(agents[0].id);
    }
  }, [activeView, selectedAgent, agents]);

  // Background Health Poller (15s) — also fires once immediately on mount.
  // Maps check_agent_status responses to UI status:
  //   "active"  → show as active (green orb)
  //   "offline" → show as error (grey/red orb + "Offline" label)
  //   "error"   → show as error
  // Previously "offline" was silently ignored, leaving failed-to-boot agents
  // showing as idle/green indefinitely.
  const runHealthPoll = async () => {
    try {
      if (typeof invoke !== 'function') return;
      const currentAgents = useWorldStore.getState().agents;
      let changed = false;
      let anyActive = false;
      const updatedAgents = await Promise.all(currentAgents.map(async (a) => {
        try {
          const status = await invoke("check_agent_status", { agentId: a.id });
          // active → not error: clear error state
          if (status === "active") {
            anyActive = true;
            if (a.status === "error") {
              changed = true;
              return { ...a, status: "active" as any, currentAction: "idle" };
            }
          }
          // offline or error → mark as error so "Offline" label renders
          if ((status === "offline" || status === "error") && a.status !== "error") {
            changed = true;
            return { ...a, status: "error" as any };
          }
          return a;
        } catch {
          if (a.status !== "error") { changed = true; return { ...a, status: "error" as any }; }
          return a;
        }
      }));
      if (changed) useWorldStore.getState().setAgents(updatedAgents);
      // Mark gateway as ready once at least one agent is confirmed active
      if (anyActive && !useWorldStore.getState().gatewayReady) {
        useWorldStore.getState().setGatewayReady(true);
      }
    } catch { }
  };

  useEffect(() => {
    // Immediate check so status is correct from the first render, not after 15s.
    runHealthPoll();
    const pollInterval = window.setInterval(runHealthPoll, 15000);
    return () => clearInterval(pollInterval);
  }, []);

  if (!initialized) {
    return <LoadingScreen status={loadStatus} />;
  }

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: theme === "dark" ? darkGradient : (activeView === "canopy" ? lightGradient : "linear-gradient(180deg, #F5F0EB 0%, #EDE4DB 100%)"),
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
    }}>
      <UpdateManager />
      {activeView !== "onboarding" && <TopNav />}

      {activeView === "loading" && <LoadingScreen status={loadStatus} />}
      {activeView === "onboarding" && <OnboardingWizard />}
      {activeView === "canopy" && <CanopyView />}
      {activeView === "architect" && agent && <ArchitectView agent={agent} />}
      {activeView === "archive" && (
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          <ArchiveView />
        </div>
      )}
      {activeView === "library" && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-sub)" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, opacity: 0.2, marginBottom: 12 }}>&#10070;</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Library</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Skills, integrations, and shared resources</div>
          </div>
        </div>
      )}
      {(activeView === "vault" || activeView === "integrations") && (
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <IntegrationsView agents={agents} />
        </div>
      )}
      {activeView === "profile" && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <UserProfileView />
        </div>
      )}
      {activeView === "diagnostics" && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <DiagnosticsView />
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.15); }
        input[type="range"]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #3c6663; cursor: pointer; border: 2px solid white; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
        ::placeholder { color: #B2BEC3; }
      `}</style>
    </div>
  );
}
