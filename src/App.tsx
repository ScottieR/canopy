import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { WorldScene } from "./components/World/WorldScene";
import RAW_AGENT_TYPE_INFO from "../shared/agents.json";
import { GLBAgent } from "./components/World/GLBAgent";
import { GenerativeStudio, GenerativeResult } from "./components/GenerativeStudio";
import { ProvidersVault } from "./components/ProvidersVault";
import { UpdateManager } from "./components/shared/UpdateManager";

// ═══════════════════════════════════════════════════════════════════════════════
// CANOPY — Monument Valley Isometric World + Architect Agent Detail
// ═══════════════════════════════════════════════════════════════════════════════

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

export function LobsterIcon({ size = 48, className = "" }: { size?: number, shellColor?: string, accentColor?: string, className?: string }) {
  return (
    <img
      src="/app-icon.png"
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
  container_id: string | null;
  personality: {
    name: string;
    communication_style: string;
    expertise: string[];
    guardrails: string[];
    custom_instructions: string;
  };
  integrations: string[];
  created_at: string;
  stats: {
    tasks_today: number;
    messages_handled: number;
    uptime_seconds: number;
    total_cost_usd: number;
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
  activeView: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library" | "vault";
  architectTab: string;
  setSelectedAgent: (id: string | null) => void;
  setHoveredAgent: (id: string | null) => void;
  setActiveView: (view: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library") => void;
  setArchitectTab: (tab: string) => void;
  togglePermission: (agentId: string, permissionId: string) => void;
  updateAgentPosition: (id: string, pos: [number, number, number]) => void;
  updateAgentTarget: (id: string, target: [number, number, number]) => void;
  updateAgentAction: (id: string, action: string) => void;
  setAgents: (agents: AgentData[]) => void;
  addAgent: (agent: AgentData) => void;
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
  { id: "ext_network", label: "External Network", description: "Allow outbound API calls and web access", enabled: true, category: "network" },
  { id: "int_network", label: "Internal Network", description: "Communicate with other agents via data handoffs", enabled: true, category: "network" },
  { id: "autonomous", label: "Autonomous Execution", description: "Run tasks without manual approval", enabled: false, category: "execution" },
  { id: "scheduled", label: "Scheduled Tasks", description: "Execute on cron schedules", enabled: true, category: "execution" },
  { id: "memory_write", label: "Memory Write", description: "Store long-term data and learnings", enabled: true, category: "data" },
  { id: "file_read", label: "File System Read", description: "Read files in scoped directories", enabled: true, category: "data" },
  { id: "file_write", label: "File System Write", description: "Create and modify files", enabled: false, category: "data" },
  { id: "payments", label: "Payment Authorization", description: "Request virtual cards for purchases", enabled: false, category: "financial" },
  { id: "spend_auto", label: "Auto-Approve Under Limit", description: "Auto-approve purchases under threshold", enabled: false, category: "financial" },
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

// ─── Store ───────────────────────────────────────────────────────────────────

const useWorldStore = create<WorldState>((set) => ({
  agents: [],
  selectedAgent: null,
  hoveredAgent: null,
  activeView: "loading",
  architectTab: "overview",
  setSelectedAgent: (id) => set({ selectedAgent: id }),
  setHoveredAgent: (id) => set({ hoveredAgent: id }),
  setActiveView: (view) => set({ activeView: view }),
  setArchitectTab: (tab) => set({ architectTab: tab }),
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
    fragmentShader: `uniform float t;varying vec2 vU;void main(){vec3 top=vec3(.784,.847,.91);vec3 bot=vec3(.96,.902,.847);float s=sin(t*.02)*.03;top.r+=s;bot.b+=s;vec3 c=mix(bot,top,vU.y);vec2 cn=vU-.5;c*=1.-dot(cn,cn)*.5;gl_FragColor=vec4(c,1.);}`,
    uniforms: { t: { value: 0 } }, side: THREE.BackSide, depthWrite: false,
  }), []);
  useFrame(({ clock }) => { mat.uniforms.t.value = clock.getElapsedTime(); });
  return <mesh material={mat}><sphereGeometry args={[50, 16, 16]} /></mesh>;
}

function CanopyScene() {
  const agents = useWorldStore(s => s.agents);
  const setSelected = useWorldStore(s => s.setSelectedAgent);
  return (<>
    <ambientLight intensity={0.6} color="#F5E6D8" />
    <directionalLight position={[5, 10, 3]} intensity={0.8} />
    <directionalLight position={[-3, 5, -2]} intensity={0.2} color="#C8D8E8" />
    <SkyGradient />
    <Water />
    <FloatingMotes count={25} />
    <group>
      <IsoBlock position={[0, -0.8, 0]} size={[10, 0.6, 10]} lit="#C4B8A8" shadow="#A89C8C" top="#D8CCC0" />
      <IsoBlock position={[0, -1.5, 0]} size={[8, 0.8, 8]} lit="#B8ACA0" shadow="#9C9088" top="#CCC0B4" />
      <WorldArchitecture />
      {agents.map(a => <AgentCharacter key={a.id} agent={a} />)}
    </group>
    <mesh position={[0, -2, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false} onClick={() => setSelected(null)}><planeGeometry args={[100, 100]} /></mesh>
  </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const glass = (opacity = 0.55): React.CSSProperties => ({
  background: `rgba(255,255,255,${opacity})`,
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 16,
  boxShadow: "0 8px 32px rgba(0,0,0,0.06)",
});

function Toggle({ enabled, onChange, size = "normal" }: { enabled: boolean; onChange: () => void; size?: "normal" | "small" }) {
  const w = size === "small" ? 32 : 40;
  const h = size === "small" ? 18 : 22;
  const d = size === "small" ? 14 : 18;
  return (
    <button onClick={onChange} style={{
      width: w, height: h, borderRadius: h, border: "none", padding: 2, cursor: "pointer",
      background: enabled ? "#3c6663" : "rgba(0,0,0,0.08)", transition: "all 0.2s ease",
      display: "flex", alignItems: "center",
    }}>
      <div style={{
        width: d, height: d, borderRadius: "50%", background: "white",
        boxShadow: "0 1px 3px rgba(0,0,0,0.15)", transition: "transform 0.2s ease",
        transform: `translateX(${enabled ? w - d - 4 : 0}px)`,
      }} />
    </button>
  );
}

function ProgressBar({ value, max = 1, color = "#3c6663", height = 4 }: { value: number; max?: number; color?: string; height?: number }) {
  return (
    <div style={{ height, borderRadius: height / 2, background: "rgba(0,0,0,0.06)", width: "100%" }}>
      <div style={{ height: "100%", borderRadius: height / 2, background: color, width: `${(value / max) * 100}%`, transition: "width 0.5s ease" }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ═══════════════════════════════════════════════════════════════════════════════

function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [personalityPrompt, setPersonalityPrompt] = useState("");
  const [recentlyRead, setRecentlyRead] = useState<string[]>([]);
  const [customBookInput, setCustomBookInput] = useState("");
  const [llmProvider, setLlmProvider] = useState<"OpenAI" | "Google Gemini" | "Anthropic" | "">("");
  const [apiKeyMode, setApiKeyMode] = useState<"hidden" | "scan" | "manual">("hidden");
  const [customIdentity, setCustomIdentity] = useState<{ baseModelUrl: string | null; accessories: string[] } | null>(null);

  const [plugins, setPlugins] = useState<Record<string, boolean>>({ slack: false, imessage: false, email: false, calendar: false, folders: false });
  const [folderAccessType, setFolderAccessType] = useState<"specific" | "all">("specific");
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [testPluginIndex, setTestPluginIndex] = useState(-1);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const enabledPlugins = Object.entries(plugins).filter(([k, v]) => v).map(([k]) => k);

  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackWorkspaceMsg, setSlackWorkspaceMsg] = useState("");

  const [fullDiskAccessGranted, setFullDiskAccessGranted] = useState<boolean | null>(null);
  const [imessageThreads, setIMessageThreads] = useState<any[]>([]);
  const [selectedIMessageThreads, setSelectedIMessageThreads] = useState<string[]>([]);
  const [imessageAccessLevel, setImessageAccessLevel] = useState<"read-only" | "read-send">("read-only");

  const [googleTokens, setGoogleTokens] = useState<any>(null);

  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>([]);
  const [isDeployingImport, setIsDeployingImport] = useState(false);

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

  const [modelStrategies, setModelStrategies] = useState<any>(null);
  useEffect(() => {
    fetch('http://localhost:3001/api/models')
      .then(res => res.json())
      .then(data => setModelStrategies(data))
      .catch(err => console.warn("Failed to fetch model strategies proxy:", err));
  }, []);

  const getDynamicRecommendedModel = (role: string) => {
    if (!modelStrategies || !modelStrategies.strategies) return { provider: "OpenAI", model: "GPT-4o-mini (Fast & Light)", id: "gpt-4o-mini" };
    const { strategies, models } = modelStrategies;
    const isHeavy = strategies.heavy.includes(role);
    const targetId = isHeavy ? strategies.defaultHeavyModel : strategies.defaultLightModel;
    const match = models.find((m: any) => m.id === targetId);
    return { provider: match?.provider || "OpenAI", model: `${match?.name} (${match?.description})`, id: match?.id };
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

    try {
      const roleInfo = agentTypeInfo[selectedRole];
      let finalPrompt = personalityPrompt;
      if (recentlyRead.length > 0) {
        finalPrompt += `\n\nRecently Read Books: You have recently read the following books and found them very interesting: ${recentlyRead.join(', ')}.`;
      }
      
      let newAgentData: Agent;
      try {
        if (typeof invoke === 'function') {
          newAgentData = await invoke("create_agent", {
            name: agentName,
            role: selectedRole,
            emoji: "agent",
            personality: finalPrompt,
            isolated: false,
          }) as Agent;

          if (apiKey.trim()) {
            await invoke("store_secret_cmd", {
              key: `agent_${newAgentData.id}_api_key`,
              value: apiKey,
            });
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
        } else {
          throw new Error("Tauri invoke not found");
        }
      } catch (err) {
        console.warn("Backend not available, using mock agent data:", err);
        newAgentData = {
          id: `mock-${Date.now()}`,
          name: agentName,
          role: selectedRole,
          emoji: "agent",
          color: roleInfo.color,
          status: "active",
          isolated: false,
          container_id: null,
          personality: {
            name: agentName,
            communication_style: finalPrompt,
            expertise: [],
            guardrails: [],
            custom_instructions: ""
          },
          integrations: [],
          created_at: new Date().toISOString(),
          stats: {
            tasks_today: 0,
            messages_handled: 0,
            uptime_seconds: 0,
            total_cost_usd: 0,
          },
        };
      }

      const enrichedAgent: AgentData = {
        ...newAgentData,
        title: `The ${selectedRole}`,
        description: roleInfo?.description || "A custom agent",
        image: roleInfo?.image,
        color: customIdentity?.dynamicColors?.color || roleInfo?.color || "#888",
        robeColor: customIdentity?.dynamicColors?.robeColor || roleInfo?.robeColor || "#888",
        accentColor: customIdentity?.dynamicColors?.accentColor || roleInfo?.accentColor || "#ccc",
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
        personalityPrompt: finalPrompt || `${agentName} is a ${selectedRole.toLowerCase()} agent — reliable, sharp, and always working.`,
        avatarPrompt: `Isometric 3D-rendered agent character in Monument Valley art style. Rounded bell-shaped body with ${roleInfo?.robeColor || "#888"} shell, smooth round head, two swept-back antennae with bulbous ${roleInfo?.accentColor || "#ccc"} tips, small expressive claws at sides. Flat-shaded low-poly faces, soft directional lighting from upper-left. Warm muted pastel palette. No outlines. Ref: agent-style-grid.png`,
        visual_identity: customIdentity || {
          baseModelUrl: null,
          accessories: [],
        }
      };

      addAgent(enrichedAgent);
      setActiveView("canopy");
    } catch (error) {
      console.error("Failed to setup agent context:", error);
    }
  };



  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "#faf9f6",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      overflow: "hidden",
    }}>
      {/* Step 1: Welcome */}
      {step === 0 && (
        <>
          {/* Fullscreen Interactive 3D Background */}
          <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            <Canvas
              orthographic
              style={{ position: "absolute", inset: 0, pointerEvents: "auto", cursor: "grab" }}
              gl={{ antialias: true, alpha: true }}
              camera={{ position: [20, 20, 20], zoom: 60 }}
            >
              <ambientLight intensity={0.7} color="#F5E6D8" />
              <directionalLight position={[10, 20, 5]} intensity={0.8} />
              <OrbitControls enableZoom={true} enablePan={true} autoRotate autoRotateSpeed={0.8} />
              <WorldScene />
            </Canvas>
          </div>

          <div style={{ textAlign: "center", maxWidth: 640, zIndex: 1, position: "relative", pointerEvents: "none", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{
              background: "#ffffff", padding: "8px 16px", borderRadius: 20,
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
              <h1 style={{ fontSize: 56, fontWeight: 700, color: "#303330", marginBottom: 16, letterSpacing: "-0.02em", fontFamily: "'Noto Serif', Georgia, serif", textShadow: "0 4px 32px rgba(48,51,48,0.06)" }}>
                Welcome to The Canopy
              </h1>
              <p style={{ fontSize: 20, color: "#4A5568", marginBottom: 40, lineHeight: 1.6, maxWidth: 400, margin: "0 auto 40px", textShadow: "0 2px 8px rgba(255,255,255,0.8)" }}>
                Your agents live here. Let's set up your first one!
              </p>
              <button
                onClick={() => setStep(1)}
                style={{
                  pointerEvents: "auto",
                  padding: "18px 48px", borderRadius: 16, border: "none",
                  background: "linear-gradient(135deg, #3c6663, #b8e6e2)",
                  color: "white", fontSize: 18, fontWeight: 700, cursor: "pointer",
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

      {/* Step 2: Choose Role */}
      {step === 1 && (
        <div style={{ maxWidth: 900, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "#303330", marginBottom: 12, textAlign: "center", fontFamily: "'Noto Serif', Georgia, serif" }}>
              Create your first agent
            </h1>
            <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32, textAlign: "center" }}>
              You can create additional agents later
            </p>

            <div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 32 }}>
              <button onClick={() => handleRoleSelect("Custom")} style={{
                padding: "12px 24px", borderRadius: 12, background: "rgba(255,255,255,0.8)", border: selectedRole === "Custom" ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.1)", color: "#303330", fontSize: 14, fontWeight: 600, cursor: "pointer"
              }}>+ Create Custom Agent</button>
              <button onClick={startImportFlow} style={{
                padding: "12px 24px", borderRadius: 12, background: "transparent", border: "1px dashed rgba(0,0,0,0.2)", color: "#636E72", fontSize: 14, fontWeight: 600, cursor: "pointer"
              }}>↓ Import Agent</button>
            </div>

            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16,
              marginBottom: 40,
            }}>
              {roleTypes.map(role => (
                <div key={role.key} style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#303330", textAlign: "center", marginBottom: 8 }}>
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
                            background: "rgba(255,255,255,0.55)", borderRadius: 4,
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
                          : "rgba(255,255,255,0.96)",
                        padding: "9px 12px 10px",
                        borderTop: selectedRole === role.key
                          ? `1px solid ${role.color}40`
                          : "1px solid rgba(177,178,175,0.10)",
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", letterSpacing: "0.01em", marginBottom: 3, textAlign: "center" }}>
                          {role.key}
                        </div>
                        <div style={{ fontSize: 10, color: "#636E72", lineHeight: 1.4, textAlign: "center" }}>
                          {role.description}
                        </div>
                      </div>
                    )}
                    {role.image && (
                      <div style={{
                        background: selectedRole === role.key
                          ? `${role.color}18`
                          : "rgba(255,255,255,0.96)",
                        padding: "8px 10px",
                        borderTop: selectedRole === role.key
                          ? `1px solid ${role.color}40`
                          : "1px solid rgba(177,178,175,0.10)",
                        borderBottomLeftRadius: 10, borderBottomRightRadius: 10
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", letterSpacing: "0.01em", marginBottom: 3, textAlign: "center" }}>
                          {role.key}
                        </div>
                        <div style={{ fontSize: 10, color: "#636E72", lineHeight: 1.3, textAlign: "center" }}>
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
              padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => selectedRole === "Custom" ? setStep(1.5) : setStep(2)} disabled={!selectedRole} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: selectedRole ? "#3c6663" : "rgba(0,0,0,0.06)",
              color: selectedRole ? "white" : "#B2BEC3",
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
              <h1 style={{ fontSize: 32, fontWeight: 700, color: "#303330", margin: 0 }}>Design Custom Agent</h1>
              <p style={{ fontSize: 14, color: "#636E72", margin: "4px 0 0 0" }}>Describe the appearance and our AI will conform it to The Canopy's visual identity.</p>
            </div>
            <button onClick={() => setStep(1)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "white", cursor: "pointer", fontWeight: 600, color: "#636E72" }}>
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
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "#303330", marginBottom: 12, textAlign: "center", fontFamily: "'Noto Serif', Georgia, serif" }}>
            Import Existing Agent
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32, textAlign: "center" }}>
            Auto-discovered agents from Docker and your local filesystem
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 40 }}>
            {discoveredAgents.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", background: "rgba(255,255,255,0.6)", borderRadius: 16, border: "1px dashed rgba(0,0,0,0.1)" }}>
                <div style={{ fontSize: 16, color: "#636E72", marginBottom: 16 }}>No local agents detected.</div>
                <button style={{ padding: "12px 24px", borderRadius: 12, background: "transparent", border: "1px solid rgba(0,0,0,0.1)", color: "#303330", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  Select BlinkClaw .tar.gz Backup
                </button>
              </div>
            ) : discoveredAgents.map(a => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", justifyItems: "center", background: "white", padding: 20, borderRadius: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.05)" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#303330", marginBottom: 4 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: "#636E72" }}>Source: {a.source} ({a.path})</div>
                </div>
                <button onClick={() => handleImportAgent(a)} disabled={isDeployingImport} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#3c6663", color: "white", fontSize: 14, fontWeight: 600, cursor: isDeployingImport ? "wait" : "pointer" }}>
                  {isDeployingImport ? "Extracting..." : "Import"}
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => setStep(1)} style={{ padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Back</button>
          </div>
        </div>
      )}

      {/* Step 3: Name & Personality */}
      {step === 2 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "#303330", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
              Name Your Agent
            </h1>
            <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>
              Give them an identity
            </p>

            <div style={{ marginBottom: 32 }}>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "#303330", marginBottom: 8 }}>Agent Name</label>
              <input
                value={agentName}
                onChange={e => setAgentName(e.target.value)}
                placeholder="e.g., Atlas, Nova, Sage..."
                style={{
                  width: "100%", padding: "14px 18px", borderRadius: 12,
                  fontSize: 15,
                  fontFamily: "inherit", color: "#303330",
                  outline: "none", background: "#ffffff",
                }}
              />
            </div>

            {selectedRole && agentTypeInfo[selectedRole] && (
              <div style={{
                background: "#f4f4f0", padding: 20, borderRadius: 16, marginBottom: 32,
                display: "flex", gap: 16, alignItems: "flex-start", backdropFilter: "blur(4px)",
              }}>
                {agentTypeInfo[selectedRole].image ? (
                  <img src={agentTypeInfo[selectedRole].image} alt={selectedRole} style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />
                ) : (
                  <LobsterIcon size={48} shellColor={agentTypeInfo[selectedRole].robeColor} accentColor={agentTypeInfo[selectedRole].accentColor} />
                )}
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "#303330", marginBottom: 4 }}>
                    {agentName || "Your Agent"} the {selectedRole}
                  </div>
                  <div style={{ fontSize: 13, color: "#636E72", lineHeight: 1.5 }}>
                    {agentTypeInfo[selectedRole].description}
                  </div>
                </div>
              </div>
            )}

            <div style={{ background: "#f4f4f0", backdropFilter: "blur(4px)", padding: 24, borderRadius: 16, marginBottom: 32 }}>
              <h3 style={{ fontSize: 16, color: "#303330", margin: "0 0 4px 0" }}>Agent Personality</h3>
              <p style={{ fontSize: 13, color: "#636E72", marginBottom: 16 }}>Edit their core instructions below. This drives how they think and communicate.</p>

              <textarea
                value={personalityPrompt}
                onChange={e => setPersonalityPrompt(e.target.value)}
                rows={4}
                style={{
                  width: "100%", padding: "12px 16px", borderRadius: 12, resize: "vertical",
                  fontSize: 14, lineHeight: 1.5,
                  fontFamily: "inherit", color: "#303330", background: "#ffffff",
                  outline: "none"
                }}
              />

              <div style={{ marginTop: 24 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#303330", marginBottom: 6 }}>Recently Read</label>
                <p style={{ fontSize: 11, color: "#636E72", marginBottom: 12 }}>This gives your agent even more personality. Feel free to pick books unrelated to their job for a creative twist!</p>
                
                {recentlyRead.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                    {recentlyRead.map(book => (
                       <div key={book} style={{ padding: "6px 12px", background: "#3c6663", color: "white", borderRadius: 16, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                          {book}
                          <span style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => setRecentlyRead(recentlyRead.filter(b => b !== book))}>×</span>
                       </div>
                    ))}
                  </div>
                )}

                {agentTypeInfo[selectedRole || "Custom"]?.suggestedBooks?.length > 0 && (
                   <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                      {agentTypeInfo[selectedRole || "Custom"].suggestedBooks.filter((b: string) => !recentlyRead.includes(b)).map((book: string) => (
                        <div key={book} onClick={() => setRecentlyRead([...recentlyRead, book])} style={{ padding: "4px 10px", background: "rgba(0,0,0,0.05)", color: "#303330", borderRadius: 16, fontSize: 11, cursor: "pointer", border: "1px solid rgba(0,0,0,0.1)", transition: "all 0.2s ease" }}>
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
                         <button onClick={handleAddCustomBook} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#f4f4f0", color: "#303330", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>Add</button>
                       </>
                     );
                   })()}
                </div>
              </div>
            </div>

          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(1)} style={{
              padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(3)} disabled={!agentName.trim()} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: agentName.trim() ? "#3c6663" : "rgba(0,0,0,0.06)",
              color: agentName.trim() ? "white" : "#B2BEC3",
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
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "#303330", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>
              Power Up Your Agent
            </h1>
            <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>
              Provide an LLM API key so your agent can think.
            </p>

            {selectedRole && (
              <div style={{ marginBottom: 24, fontSize: 14, color: "#303330", background: "rgba(33,131,128,0.1)", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(33,131,128,0.2)" }}>
                Based on the <strong>{selectedRole}</strong> role, we default to the <strong>{getDynamicRecommendedModel(selectedRole).model}</strong> model.
              </div>
            )}

            <div style={{ marginBottom: 24, display: "flex", gap: 12 }}>
              {["OpenAI", "Google Gemini", "Anthropic"].map(prov => (
                <label key={prov} style={{ display: "flex", alignItems: "center", gap: 8, background: "#ffffff", padding: "12px 16px", borderRadius: 12, border: llmProvider === prov ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.1)", cursor: "pointer", opacity: llmProvider === prov ? 1 : 0.7 }}>
                  <input type="radio" name="provider" checked={llmProvider === prov} onChange={() => { setLlmProvider(prov as any); setApiKeyMode("hidden"); setApiKey(""); }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#303330" }}>{prov}</span>
                </label>
              ))}
            </div>

            <div style={{ marginBottom: 32 }}>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "#303330", marginBottom: 16 }}>
                API Key Setup
              </label>

              <div style={{ display: "flex", gap: 16, flexDirection: "column" }}>
                <button onClick={async () => {
                  if (!llmProvider) return;
                  setApiKeyMode("scan");
                  try {
                    const providerMap: any = { "OpenAI": "OPENAI", "Google Gemini": "GEMINI", "Anthropic": "ANTHROPIC" };
                    const provId = providerMap[llmProvider] + "_API_KEY";
                    const secret = await invoke<string>("get_secret_cmd", { key: provId });
                    if (secret) setApiKey(secret);
                    else alert("No existing key found in keychain.");
                  } catch (e) {
                    alert("No existing key found in keychain.");
                  }
                }} disabled={!llmProvider} style={{ padding: "12px 20px", borderRadius: 12, border: !llmProvider ? "1px solid rgba(0,0,0,0.1)" : "1px solid #3c6663", background: "rgba(60,102,99,0.05)", color: !llmProvider ? "#B2BEC3" : "#3c6663", cursor: !llmProvider ? "default" : "pointer", fontWeight: 600 }}>
                  Scan for existing API key
                </button>
                <div style={{ textAlign: "center", fontSize: 12, color: "#636E72", margin: "-6px 0" }}>— or —</div>
                <button onClick={async () => {
                  if (!llmProvider) return;
                  setApiKeyMode("manual");

                  try {
                    const providerMap: any = { "OpenAI": "openai", "Google Gemini": "gemini", "Anthropic": "anthropic" };
                    const providerId = providerMap[llmProvider];

                    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                    const windowLabel = 'providerCompanion_' + Date.now();
                    const companionWindow = new WebviewWindow(windowLabel, {
                      url: '/index.html?companion=' + providerId,
                      title: 'Agent Guide',
                      width: 380,
                      height: 800,
                      x: window.screen.availWidth - 400,
                      y: 50,
                      alwaysOnTop: true,
                      decorations: false,
                      transparent: true,
                    });

                    const launchBrowser = async () => {
                      const urls: any = {
                        "OpenAI": "https://platform.openai.com/api-keys",
                        "Google Gemini": "https://aistudio.google.com/app/apikey",
                        "Anthropic": "https://console.anthropic.com/settings/keys"
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
                      "Anthropic": "https://console.anthropic.com/settings/keys"
                    };
                    const { open } = await import('@tauri-apps/plugin-shell');
                    await open(urls[llmProvider]);
                  }
                }} disabled={!llmProvider} style={{ padding: "12px 20px", borderRadius: 12, border: "none", background: !llmProvider ? "rgba(0,0,0,0.06)" : "#3c6663", color: !llmProvider ? "#B2BEC3" : "white", cursor: !llmProvider ? "default" : "pointer", fontWeight: 600 }}>
                  Set up new API key ✨
                </button>
              </div>

              {apiKeyMode !== "hidden" && (
                <div style={{ marginTop: 24 }}>
                  <input
                    type="password"
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
              padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(4)} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: "#3c6663", color: "white",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 5: Plugins & Permissions */}
      {step === 4 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>
            <h1 style={{ fontSize: 40, fontWeight: 700, color: "#303330", marginBottom: 12, fontFamily: "'Noto Serif', Georgia, serif" }}>Skills & Access</h1>
            <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>Give your agent the tools they need to interact with your world.</p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
              {(["slack", "email", "calendar", "folders"] as const).map(p => (
                <div key={p} style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", padding: "16px 20px", borderRadius: plugins[p] && p === "folders" ? "12px 12px 0 0" : 12, border: plugins[p] ? "1px solid #3c6663" : "1px solid rgba(0,0,0,0.08)" }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "#303330", textTransform: "capitalize" }}>{p} Access</div>
                      <div style={{ fontSize: 13, color: "#636E72", marginTop: 4 }}>Allow {agentName || "the agent"} to interact with your {p}.</div>
                    </div>
                    <Toggle enabled={plugins[p]} onChange={() => setPlugins(prev => ({ ...prev, [p]: !prev[p] }))} />
                  </div>
                  {p === "folders" && plugins.folders && (
                    <div style={{ padding: "16px 20px", background: "rgba(255,255,255,0.6)", borderRadius: "0 0 12px 12px", border: "1px solid #3c6663", borderTop: "none" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#303330", marginBottom: 12 }}>Select Folder Scope</div>
                      <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#303330", cursor: "pointer" }}>
                          <input type="radio" checked={folderAccessType === "specific"} onChange={() => setFolderAccessType("specific")} />
                          Specific Folder
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#303330", cursor: "pointer" }}>
                          <input type="radio" checked={folderAccessType === "all"} onChange={() => setFolderAccessType("all")} />
                          All Folders
                        </label>
                      </div>

                      {folderAccessType === "specific" && (
                        <div style={{ display: "flex", gap: 8 }}>
                          <input type="text" readOnly placeholder="No folder selected..." value={selectedFolderPath} style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, background: "#ffffff", outline: "none" }} />
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
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 20, marginTop: "auto", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <button onClick={() => setStep(3)} style={{
              padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => {
              if (enabledPlugins.length > 0) {
                setTestPluginIndex(0);
                setStep(5);
              } else {
                setStep(6);
              }
            }} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: "#3c6663", color: "white",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 6: Integration Testing */}
      {step === 5 && testPluginIndex >= 0 && testPluginIndex < enabledPlugins.length && (
        <div style={{ maxWidth: 500, width: "90%", textAlign: "center" }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "#303330", marginBottom: 12, textTransform: "capitalize" }}>Test {enabledPlugins[testPluginIndex]}</h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>Let's make sure {agentName || "the agent"} can successfully connect.</p>

          <div style={{ background: "#ffffff", padding: 32, borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)", marginBottom: 32, minHeight: 180, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "slack" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "#303330", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Connect to Slack</div>
                <div style={{ fontSize: 13, color: "#636E72", marginBottom: 24, textAlign: "center" }}>
                  Canopy connects locally via Socket Mode. Setup is now 3 easy steps!
                </div>

                <div style={{ marginBottom: 20, padding: 24, textAlign: "center", background: "rgba(33,131,128,0.05)", borderRadius: 12, border: "1px solid rgba(33,131,128,0.15)" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#303330", marginBottom: 12 }}>Open the Side-by-Side Guide</div>
                  <div style={{ fontSize: 13, color: "#636E72", marginBottom: 20, lineHeight: 1.5 }}>
                    We'll open an always-on-top companion window alongside Slack to walk you through pasting your tokens step-by-step.
                  </div>
                  <button onClick={async () => {
                    try {
                      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

                      const windowLabel = 'slackCompanion_' + Date.now();
                      const companionWindow = new WebviewWindow(windowLabel, {
                        url: '/index.html?companion=slack',
                        title: 'Agent Guide',
                        width: 380,
                        height: 800,
                        x: window.screen.availWidth - 400,
                        y: 50,
                        alwaysOnTop: true,
                        decorations: false,
                        transparent: true,
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
                  }} style={{ padding: "12px 24px", borderRadius: 8, border: "none", background: "#3c6663", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(60,102,99,0.3)" }}>
                    Launch Slack Setup ✨
                  </button>
                </div>

                <div style={{ textAlign: "center", marginTop: 24, fontSize: 12, color: "#636E72" }}>
                  Listening for credentials from companion window...
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "imessage" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "#303330", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>iMessage Bridge</div>
                <div style={{ fontSize: 13, color: "#636E72", marginBottom: 24, textAlign: "center" }}>
                  Canopy reads iMessage directly from macOS. Keep your texts local.
                </div>

                {fullDiskAccessGranted === false && (
                  <div style={{ padding: 16, background: "rgba(229,62,62,0.05)", borderRadius: 12, border: "1px solid rgba(229,62,62,0.15)", marginBottom: 20 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#E53E3E", marginBottom: 8 }}>Full Disk Access Required</div>
                    <div style={{ fontSize: 12, color: "#636E72", marginBottom: 12, lineHeight: 1.4 }}>
                      macOS blocks access to iMessage. Please go to <strong>System Settings &gt; Privacy &amp; Security &gt; Full Disk Access</strong> and allow Canopy/development terminal.
                    </div>
                  </div>
                )}

                {fullDiskAccessGranted === true && (
                  <>
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", marginBottom: 8 }}>Access Level</div>
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
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", marginBottom: 8 }}>Allowed Conversations</div>
                      <div style={{ border: "1px solid rgba(0,0,0,0.1)", borderRadius: 8, maxHeight: 160, overflowY: "auto", background: "#f9f9f9" }}>
                        {imessageThreads.length === 0 ? (
                          <div style={{ padding: 16, fontSize: 13, color: "#636E72", textAlign: "center" }}>Loading threads...</div>
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
                              <div style={{ fontSize: 13, color: "#303330" }}>
                                {thread.display_name || thread.chat_identifier}
                                <span style={{ color: "#636E72", fontSize: 11, marginLeft: 6 }}>({thread.message_count} msgs)</span>
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
                    padding: "12px 32px", borderRadius: 12, border: "none", background: "#3c6663", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                  }}>
                    {fullDiskAccessGranted === true ? "Save Integration" : "Check Access & Load Threads"}
                  </button>
                </div>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] === "folders" && (
              <div style={{ width: "100%", textAlign: "left" }}>
                <div style={{ fontSize: 16, color: "#303330", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>Folder Permissions</div>
                <div style={{ fontSize: 13, color: "#636E72", marginBottom: 24, textAlign: "center" }}>
                  Select a local folder on your Mac for the agent to have complete read/write access to.
                </div>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", marginBottom: 8 }}>Access Type</div>
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
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#303330", marginBottom: 4 }}>Mapped Directory</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input type="text" readOnly value={selectedFolderPath} placeholder="No folder selected..." style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#f9f9f9" }} />
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
                    padding: "12px 32px", borderRadius: 12, border: "none", background: "#3c6663", color: "white", fontSize: 14, fontWeight: 600, cursor: (folderAccessType === "all" || selectedFolderPath) ? "pointer" : "default", transition: "all 0.2s", opacity: (folderAccessType === "all" || selectedFolderPath) ? 1 : 0.5
                  }}>Save Access Map</button>
                </div>
              </div>
            )}

            {testStatus === "idle" && (enabledPlugins[testPluginIndex] === "email" || enabledPlugins[testPluginIndex] === "calendar") && (
              <div style={{ width: "100%", textAlign: "center" }}>
                <div style={{ fontSize: 16, color: "#303330", fontWeight: 700, marginBottom: 8 }}>Google Workspace APIs</div>
                <div style={{ fontSize: 13, color: "#636E72", marginBottom: 24 }}>
                  Connect your Google account directly on your Mac using a secure local loopback. Canopy never proxies your data through our servers.
                </div>
                <button onClick={async () => {
                  setTestStatus("testing");
                  try {
                    if (typeof invoke === 'function') {
                      let tokens = await invoke("start_google_oauth", { scopes: [enabledPlugins[testPluginIndex]] });
                      if (tokens) {
                        // Merge tokens if they are authorizing multiple times (so we don't overwrite refresh token)
                        setGoogleTokens((prev: any) => ({ ...prev, ...tokens as any }));
                      }
                      setTestStatus("success");
                    } else {
                      // Mock UI
                      setTimeout(() => setTestStatus("success"), 2000);
                    }
                  } catch (e) {
                    console.error("Google OAuth error:", e);
                    setTestStatus("error");
                  }
                }} style={{
                  padding: "12px 24px", borderRadius: 12, border: "none", background: "white", color: "#3c6663", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, margin: "0 auto", border: "1px solid rgba(0,0,0,0.1)", boxShadow: "0 4px 12px rgba(0,0,0,0.05)"
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" /><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" /><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
                  Connect {enabledPlugins[testPluginIndex] === "email" ? "Gmail" : "Google Calendar"}
                </button>
              </div>
            )}

            {testStatus === "idle" && enabledPlugins[testPluginIndex] !== "slack" && enabledPlugins[testPluginIndex] !== "imessage" && enabledPlugins[testPluginIndex] !== "folders" && enabledPlugins[testPluginIndex] !== "email" && enabledPlugins[testPluginIndex] !== "calendar" && (
              <>
                <div style={{ fontSize: 14, color: "#303330", fontWeight: 600, marginBottom: 16 }}>Test Action: Send a test ping to your {enabledPlugins[testPluginIndex]}.</div>
                <button onClick={() => {
                  setTestStatus("testing");
                  setTimeout(() => setTestStatus("success"), 1500);
                }} style={{
                  padding: "12px 24px", borderRadius: 12, border: "none", background: "#3c6663", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
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
                <div style={{ fontSize: 13, color: "#636E72", marginTop: 8, fontWeight: 400 }}>Make sure both tokens are valid and the app is installed.</div>
                <button onClick={() => setTestStatus("idle")} style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "white", cursor: "pointer", fontSize: 13 }}>Try Again</button>
              </div>
            )}

            {testStatus === "success" && (
              <div style={{ color: "#4A9E96", fontSize: 18, fontWeight: 600, animation: "pulse 0.5s", textAlign: "center" }}>
                <span style={{ fontSize: 32, display: "block", marginBottom: 8 }}>✅</span>
                Connected successfully!
                {enabledPlugins[testPluginIndex] === "slack" && slackWorkspaceMsg && (
                  <div style={{ fontSize: 13, color: "#636E72", marginTop: 8, fontWeight: 400 }}>{slackWorkspaceMsg}</div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => {
              if (testStatus === "success") {
                if (testPluginIndex < enabledPlugins.length - 1) {
                  setTestPluginIndex(testPluginIndex + 1);
                  setTestStatus("idle");
                } else {
                  setStep(6);
                }
              }
            }} disabled={testStatus !== "success"} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: testStatus === "success" ? "#3c6663" : "rgba(0,0,0,0.06)",
              color: testStatus === "success" ? "white" : "#B2BEC3",
              fontSize: 14, fontWeight: 600, cursor: testStatus === "success" ? "pointer" : "default",
              fontFamily: "inherit",
              width: "100%", maxWidth: 200
            }}>
              {testPluginIndex < enabledPlugins.length - 1 ? "Next Integration" : "Finish Setup"}
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
                      background: "rgba(255,255,255,0.55)", borderRadius: 4, padding: "2px 7px",
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
                    background: "rgba(255,255,255,0.96)", padding: "10px 16px 11px",
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
          <h1 style={{ fontSize: 44, fontWeight: 700, color: "#303330", marginBottom: 12, letterSpacing: "-0.02em", fontFamily: "'Noto Serif', Georgia, serif" }}>
            {agentName} is Alive!
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 40, maxWidth: 400, margin: "0 auto 40px" }}>
            Your agent is ready. Drop them into The Canopy and watch them work.
          </p>
          <button onClick={handleCreateAgent} style={{
            padding: "16px 40px", borderRadius: 16, border: "none",
            background: "linear-gradient(135deg, #3c6663, #b8e6e2)",
            color: "white", fontSize: 16, fontWeight: 600, cursor: "pointer",
            boxShadow: "0 8px 40px rgba(48,51,48,0.08)",
            transition: "all 0.3s ease",
          }}>
            Go to Dashboard
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
  const { setActiveView, architectTab, setArchitectTab, togglePermission } = useWorldStore();

  const tabs = [
    { id: "overview", label: "Overview", icon: <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" /> },
    { id: "identity", label: "3D Identity", icon: <path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /> },
    { id: "personality", label: "Neural Path", icon: <path d="M13 10V3L4 14h7v7l9-11h-7z" /> },
    { id: "permissions", label: "Permissions", icon: <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /> },
    { id: "memory", label: "Memory", icon: <path d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7c0-2 1-3 3-3h10c2 0 3 1 3 3M4 7h16M10 11h4" /> },
    { id: "spend", label: "Spend", icon: <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" /> },
    { id: "chat", label: "Communion", icon: <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /> },
  ];

  const SvgIcon = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  );

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'Manrope', system-ui, sans-serif" }}>
      {/* ── Left Sidebar ── */}
      <div style={{
        width: 240, padding: "24px 16px", display: "flex", flexDirection: "column", gap: 4,
        borderRight: "1px solid rgba(0,0,0,0.06)", background: "rgba(255,255,255,0.3)",
      }}>
        {/* Agent identity */}
        <div style={{ padding: "0 8px 20px", borderBottom: "1px solid rgba(0,0,0,0.06)", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%", overflow: "hidden",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 0 0 3px rgba(255,255,255,0.6), 0 0 12px ${agent.robeColor}40`,
              background: `${agent.robeColor}15`,
            }}>
              {agent.image ? (
                <img src={agent.image} alt={agent.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <LobsterIcon size={32} shellColor={agent.robeColor} accentColor={agent.accentColor} />
              )}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#303330" }}>Architect View</div>
              <div style={{ fontSize: 11, color: "#636E72" }}>{agent.name} / {agent.role}</div>
            </div>
          </div>
        </div>

        {/* Nav tabs */}
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setArchitectTab(tab.id)} style={{
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

        {/* Deploy button */}
        <button style={{
          padding: "12px 16px", borderRadius: 12, border: "none", cursor: "pointer",
          background: "linear-gradient(135deg, #3c6663, #b8e6e2)", color: "white",
          fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          boxShadow: "0 4px 12px rgba(33,131,128,0.25)",
          transition: "all 0.2s ease",
        }}>
          Deploy Agent
        </button>

        <button onClick={() => setActiveView("canopy")} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "8px", border: "none", borderRadius: 8, cursor: "pointer",
          background: "transparent", color: "#636E72", fontSize: 12, fontFamily: "inherit",
          marginTop: 4,
        }}>
          <SvgIcon size={14}><path d="M11 17l-5-5m0 0l5-5m-5 5h12" /></SvgIcon>
          Back to Canopy
        </button>
      </div>

      {/* ── Main Content ── */}
      <div style={{ flex: 1, overflow: "auto", padding: "32px 40px" }}>
        {architectTab === "overview" && <OverviewTab agent={agent} />}
        {architectTab === "identity" && <IdentityTab agent={agent} />}
        {architectTab === "personality" && <PersonalityTab agent={agent} />}
        {architectTab === "permissions" && <PermissionsTab agent={agent} />}
        {architectTab === "memory" && <MemoryTab agent={agent} />}
        {architectTab === "spend" && <SpendTab agent={agent} />}
        {architectTab === "chat" && <ChatTab agent={agent} />}
      </div>
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({ agent }: { agent: AgentData }) {
  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 36, fontWeight: 700, color: "#303330", letterSpacing: "-0.02em", margin: 0, lineHeight: 1.1 }}>
          {agent.name}: <span style={{ color: "#636E72", fontWeight: 400 }}>{agent.title}</span>
        </h1>
        <p style={{ fontSize: 15, color: "#636E72", marginTop: 8, maxWidth: 600, lineHeight: 1.6 }}>
          {agent.description}
        </p>
      </div>

      {/* Status + Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 8 }}>Active State</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: agent.status === "active" ? "#4A9E96" : agent.status === "thinking" ? "#8B6AAE" : "#B2BEC3",
              boxShadow: agent.status === "active" ? "0 0 8px rgba(74,158,150,0.5)" : "none",
            }} />
            <span style={{ fontSize: 20, fontWeight: 600, color: "#303330", textTransform: "capitalize" }}>{agent.currentAction}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 11, color: "#636E72" }}>
            <span>Uptime</span>
            <span style={{ fontWeight: 500, color: "#303330" }}>{agent.uptime}</span>
          </div>
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 8 }}>Resource Consumption</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#636E72" }}>Weekly Compute</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#303330" }}>{agent.weeklyCompute}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#636E72" }}>Tokens Mined</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#303330" }}>
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
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 8 }}>Cost (Active)</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#303330" }}>${(agent.stats?.total_cost_usd || agent.monthlySpend || 0).toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "#636E72", marginBottom: 8 }}>of ${agent.spendLimit} limit</div>
          <ProgressBar value={agent.stats?.total_cost_usd || agent.monthlySpend || 0} max={agent.spendLimit} color={(agent.stats?.total_cost_usd || agent.monthlySpend || 0) > agent.spendLimit * 0.8 ? "#D4A04A" : "#4A9E96"} />
        </div>
      </div>

      {/* Core Nature + Permissions quick view */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 16 }}>Core Nature</div>
          <div style={{ fontSize: 12, color: "#636E72", fontStyle: "italic", lineHeight: 1.5 }}>
            "{agent.personalityPrompt}"
          </div>
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 16 }}>Key Permissions</div>
          {agent.permissions.filter(p => ["autonomous", "payments", "ext_network", "file_write"].includes(p.id)).map(p => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#303330" }}>{p.label}</div>
                <div style={{ fontSize: 11, color: "#636E72" }}>{p.description}</div>
              </div>
              <Toggle enabled={p.enabled} onChange={() => useWorldStore.getState().togglePermission(agent.id, p.id)} size="small" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Personality / Neural Path Tab ───────────────────────────────────────────

// ─── 3D Identity Tab ─────────────────────────────────────────────────────────

function IdentityTab({ agent }: { agent: AgentData }) {
  const { setAgents } = useWorldStore();

  const updateIdentity = (updates: Partial<AgentData["visual_identity"]>) => {
    setAgents(useWorldStore.getState().agents.map(a =>
      a.id === agent.id ? { ...a, visual_identity: { ...a.visual_identity, ...updates } } : a
    ));
  };

  const handleApplyGeneration = (res: GenerativeResult) => {
    setAgents(useWorldStore.getState().agents.map(a =>
      a.id === agent.id ? {
        ...a,
        color: res.dynamicParams.color || a.color,
        robeColor: res.dynamicParams.robeColor || a.robeColor,
        accentColor: res.dynamicParams.accentColor || a.accentColor,
        visual_identity: { ...a.visual_identity, accessories: [...(a.visual_identity?.accessories || []), ...res.dynamicParams.accessories] }
      } : a
    ));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 32, height: "100%" }}>
      {/* Left: 3D Dressing Room */}
      <div style={{ background: "rgba(255,255,255,0.4)", borderRadius: 24, overflow: "hidden", position: "relative", minHeight: 400, border: "1px solid rgba(0,0,0,0.06)" }}>
        <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 60 }}>
          <ambientLight intensity={0.8} color="#F5E6D8" />
          <directionalLight position={[10, 20, 5]} intensity={1} />
          <OrbitControls autoRotate autoRotateSpeed={1.5} enablePan={false} />
          <group position={[0, -1, 0]}>
            {/* Studio floor */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
              <planeGeometry args={[10, 10]} />
              <shadowMaterial transparent opacity={0.2} />
            </mesh>
            <GLBAgent
              fileUrl={agent.visual_identity?.baseModelUrl || undefined}
              accessories={agent.visual_identity?.accessories || []}
              isWorking={agent.status === "thinking" || agent.status === "active"}
              scale={1.5}
            />
          </group>
        </Canvas>
        <div style={{ position: "absolute", top: 16, left: 16, background: "rgba(255,255,255,0.8)", padding: "6px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, color: "#218380", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#218380", animation: "pulse 2s infinite" }} />
          Live Preview
        </div>
      </div>

      {/* Right: Generative Studio */}
      <div style={{ paddingRight: 8, height: "100%", overflow: "hidden" }}>
        <GenerativeStudio onApply={handleApplyGeneration} />
      </div>
    </div>
  );
}

function PersonalityTab({ agent }: { agent: AgentData }) {
  const [prompt, setPrompt] = useState(agent.personalityPrompt);
  const [avatarPrompt, setAvatarPrompt] = useState(agent.avatarPrompt);

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Neural Path</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>Shape how {agent.name} thinks, acts, and appears.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Personality Traits */}
        <div style={{ ...glass(0.5), padding: 24, borderRadius: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#303330", marginBottom: 16 }}>Personality Traits</div>
          <div style={{ fontSize: 13, color: "#636E72", fontStyle: "italic" }}>
            This agent's configuration is managed through the Rust backend.
          </div>
        </div>

        {/* Personality Prompt */}
        <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#303330", marginBottom: 6 }}>Personality Seed</div>
          <div style={{ fontSize: 11, color: "#636E72", marginBottom: 12 }}>Describe how this agent should behave. This shapes their decision-making and communication style.</div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={6} style={{
            flex: 1, padding: 12, borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)",
            background: "#f4f4f0", fontSize: 13, fontFamily: "inherit",
            color: "#303330", resize: "none", outline: "none", lineHeight: 1.6,
          }} />
          <button style={{
            marginTop: 12, padding: "8px 16px", borderRadius: 8, border: "none",
            background: "#3c6663", color: "white", fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", alignSelf: "flex-end",
          }}>Save Changes</button>
        </div>
      </div>

      {/* Avatar Customization */}
      <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, marginTop: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#303330" }}>Avatar Description</div>
            <div style={{ fontSize: 11, color: "#636E72", marginTop: 4 }}>Describe what your agent looks like. Changes to this prompt will regenerate their figure.</div>
          </div>
          <div style={{
            width: 80, height: 80, borderRadius: 16, background: `linear-gradient(135deg, ${agent.robeColor}20, ${agent.accentColor}30)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: "2px dashed rgba(0,0,0,0.08)",
          }}>
            <LobsterIcon size={56} shellColor={agent.robeColor} accentColor={agent.accentColor} />
          </div>
        </div>
        <textarea value={avatarPrompt} onChange={e => setAvatarPrompt(e.target.value)} rows={3} style={{
          width: "100%", padding: 12, borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)",
          background: "#f4f4f0", fontSize: 13, fontFamily: "inherit",
          color: "#303330", resize: "none", outline: "none", lineHeight: 1.6,
        }} />
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {["#8B6AAE", "#4A9E96", "#D47A54", "#5B88A6", "#C4785A", "#6B8E5A"].map(c => (
              <button key={c} style={{
                width: 24, height: 24, borderRadius: "50%", background: c, border: c === agent.robeColor ? "2px solid #2D3436" : "2px solid transparent",
                cursor: "pointer", transition: "all 0.15s ease",
              }} />
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <button style={{
            padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)",
            background: "#f4f4f0", fontSize: 12, fontWeight: 500,
            cursor: "pointer", fontFamily: "inherit", color: "#303330",
          }}>Regenerate Avatar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Permissions Tab ─────────────────────────────────────────────────────────

function PermissionsTab({ agent }: { agent: AgentData }) {
  const toggle = useWorldStore(s => s.togglePermission);
  const categories = [
    { id: "network", label: "Network Access", desc: "Control what this agent can reach externally and internally." },
    { id: "execution", label: "Execution", desc: "Control when and how this agent can act autonomously." },
    { id: "data", label: "Data Access", desc: "Control what files and memory this agent can read or modify." },
    { id: "financial", label: "Financial", desc: "Control payment capabilities and spending authorization." },
  ];

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Permissions</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: "#303330" }}>Shared Container</div>
          <div style={{ fontSize: 11, color: "#636E72" }}>This agent runs in the shared Gateway. Switch to isolated for OS-level sandboxing.</div>
        </div>
        <div style={{ flex: 1 }} />
        <button style={{
          padding: "6px 14px", borderRadius: 8, border: "1px solid #6B6BAE",
          background: "transparent", color: "#6B6BAE", fontSize: 12, fontWeight: 600,
          cursor: "pointer", fontFamily: "inherit",
        }}>Isolate</button>
      </div>

      {categories.map(cat => (
        <div key={cat.id} style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 4 }}>{cat.label}</div>
          <div style={{ fontSize: 12, color: "#636E72", marginBottom: 12 }}>{cat.desc}</div>
          <div style={{ ...glass(0.5), borderRadius: 14, overflow: "hidden" }}>
            {agent.permissions.filter(p => p.category === cat.id).map((p, i, arr) => (
              <div key={p.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 20px",
                borderBottom: i < arr.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none",
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#303330" }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: "#636E72", marginTop: 2 }}>{p.description}</div>
                </div>
                <Toggle enabled={p.enabled} onChange={() => toggle(agent.id, p.id)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Memory Tab ──────────────────────────────────────────────────────────────

function MemoryTab({ agent }: { agent: AgentData }) {
  const memories = agent.memories || [];

  const typeColors: Record<string, string> = { learned: "#4A9E96", experience: "#5B88A6", preference: "#8B6AAE", context: "#D4A04A" };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Memory</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>
        What {agent.name} has learned and remembers. Memories are versioned and can be pruned.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["All", "Learned", "Experience", "Preference"].map(f => (
          <button key={f} style={{
            padding: "6px 14px", borderRadius: 20, border: "1px solid rgba(0,0,0,0.08)",
            background: f === "All" ? "#3c6663" : "rgba(255,255,255,0.5)",
            color: f === "All" ? "white" : "#636E72",
            fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
          }}>{f}</button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {memories.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "#636E72", fontSize: 14 }}>
            {agent.name} doesn't have any memories yet.<br />Memories are formed asynchronously as the agent works.
          </div>
        ) : (
          memories.map((m, i) => (
            <div key={i} style={{ ...glass(0.5), padding: "16px 20px", borderRadius: 14, borderLeft: `3px solid ${typeColors[m.type]}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em",
                      color: typeColors[m.type], background: `${typeColors[m.type]}15`, padding: "2px 8px", borderRadius: 4,
                    }}>{m.type}</span>
                    <span style={{ fontSize: 11, color: "#B2BEC3" }}>{m.when}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#303330", lineHeight: 1.5 }}>{m.text}</div>
                </div>
                <div style={{ textAlign: "right", marginLeft: 16 }}>
                  <div style={{ fontSize: 10, color: "#636E72" }}>Confidence</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#303330" }}>{Math.round(m.confidence * 100)}%</div>
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
  const [overrideKey, setOverrideKey] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  useEffect(() => {
    if (typeof invoke === 'function') {
      invoke("get_secret_cmd", { key: `agent_${agent.id}_api_key` })
        .then(k => setOverrideKey(k as string))
        .catch(() => { }); // expected if not set
    }
  }, [agent.id]);

  const saveOverride = async () => {
    setSaveStatus("loading");
    try {
      if (typeof invoke === 'function') {
        if (overrideKey.trim()) {
          await invoke("store_secret_cmd", { key: `agent_${agent.id}_api_key`, value: overrideKey.trim() });
        } else {
          await invoke("delete_secret_cmd", { key: `agent_${agent.id}_api_key` });
        }
      }
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (e) {
      setSaveStatus("error");
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Spend & Utilization</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>
        {agent.name}'s financial activity and resource consumption.
      </p>

      {/* Budget overview */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase" }}>This Month</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#303330", marginTop: 4 }}>${(agent.stats?.total_cost_usd || agent.monthlySpend || 0).toFixed(2)}</div>
          <ProgressBar value={agent.stats?.total_cost_usd || agent.monthlySpend || 0} max={agent.spendLimit} color="#4A9E96" height={6} />
          <div style={{ fontSize: 11, color: "#636E72", marginTop: 6 }}>${agent.spendLimit} monthly limit</div>
        </div>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase" }}>Auto-Approve Limit</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#303330", marginTop: 4 }}>$25</div>
          <div style={{ fontSize: 11, color: "#636E72", marginTop: 6 }}>Purchases above this require your approval</div>
        </div>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase" }}>Active Cards</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#303330", marginTop: 4 }}>0</div>
          <div style={{ fontSize: 11, color: "#636E72", marginTop: 6 }}>Virtual cards currently issued</div>
        </div>
      </div>

      {/* Transaction table */}
      <div style={{ ...glass(0.5), borderRadius: 16, overflow: "hidden", marginBottom: 24 }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#303330" }}>Recent Transactions</div>
        </div>
        <div style={{ padding: "20px", textAlign: "center", color: "#636E72", fontSize: 13 }}>
          No transactions yet
        </div>
      </div>

      {/* Advanced Provider Configuration */}
      <div style={{ ...glass(0.5), borderRadius: 16, overflow: "hidden", padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#303330", marginBottom: 8 }}>Agent-Specific API Key</div>
        <div style={{ fontSize: 12, color: "#636E72", marginBottom: 16 }}>
          Override the global API vault. Useful for isolating billing or restricting usage explicitly for this agent. Keep empty to use defaults.
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="password"
            placeholder="sk-..."
            value={overrideKey}
            onChange={(e) => setOverrideKey(e.target.value)}
            style={{ padding: "10px 14px", flex: 1, borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "rgba(255,255,255,0.7)" }}
          />
          <button onClick={saveOverride} disabled={saveStatus === "loading"} style={{
            padding: "10px 20px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "#3c6663", color: "white", fontWeight: 600, fontSize: 13, minWidth: 100
          }}>
            {saveStatus === "loading" ? "Saving..." : saveStatus === "success" ? "Saved!" : saveStatus === "error" ? "Error" : "Save Override"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Chat / Communion Tab ────────────────────────────────────────────────────

function ChatTab({ agent }: { agent: AgentData }) {
  const [message, setMessage] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>(agent.chatLog);
  const [loading, setLoading] = useState(false);

  const handleSendMessage = async () => {
    if (!message.trim()) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      text: message,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setChatLog([...chatLog, userMsg]);
    setMessage("");
    setLoading(true);

    try {
      const response = await invoke("send_message", {
        agentId: agent.id,
        message: message,
      }) as string;

      const agentMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "agent",
        text: response,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setChatLog(prev => [...prev, agentMsg]);
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 64px)" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Communion</h1>
        <p style={{ fontSize: 14, color: "#636E72" }}>Communicate directly with {agent.name}.</p>
      </div>

      {/* Chat log */}
      <div style={{
        flex: 1, ...glass(0.35), borderRadius: 16, padding: 20, overflow: "auto",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        {chatLog.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#B2BEC3" }}>
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
                  ? "linear-gradient(135deg, #3c6663, #b8e6e2)"
                  : "rgba(255,255,255,0.7)",
                color: msg.sender === "user" ? "white" : "#303330",
                fontSize: 13, lineHeight: 1.5,
                borderBottomRightRadius: msg.sender === "user" ? 4 : 14,
                borderBottomLeftRadius: msg.sender === "agent" ? 4 : 14,
              }}>
                {msg.text}
              </div>
              <div style={{
                fontSize: 10, color: "#B2BEC3", marginTop: 4,
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
            <span style={{ fontSize: 13, color: "#636E72", fontStyle: "italic" }}>{agent.name} is thinking...</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && message.trim() && !loading) handleSendMessage(); }}
          placeholder={`Talk to ${agent.name}...`}
          disabled={loading}
          style={{
            flex: 1, padding: "14px 18px", borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.08)",
            background: "rgba(255,255,255,0.6)",
            fontSize: 13, fontFamily: "inherit", color: "#303330",
            outline: "none", opacity: loading ? 0.6 : 1,
          }}
        />
        <button onClick={handleSendMessage} disabled={!message.trim() || loading} style={{
          padding: "14px 20px", borderRadius: 14, border: "none",
          background: (message.trim() && !loading) ? "#3c6663" : "rgba(0,0,0,0.06)",
          color: (message.trim() && !loading) ? "white" : "#B2BEC3",
          fontSize: 13, fontWeight: 600, cursor: (message.trim() && !loading) ? "pointer" : "default",
          fontFamily: "inherit",
          transition: "all 0.15s ease",
        }}>Send</button>
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
  const { activeView, setActiveView } = useWorldStore();

  const navItems = [
    { id: "canopy" as const, label: "Canopy" },
    { id: "architect" as const, label: "Architect" },
    { id: "archive" as const, label: "Archive" },
    { id: "library" as const, label: "Library" },
    { id: "vault" as const, label: "Vault" },
  ];

  return (
    <div style={{
      position: activeView === "canopy" ? "absolute" : "relative",
      top: 0, left: 0, right: 0, zIndex: 20,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 24px",
      background: activeView === "canopy" ? "transparent" : "rgba(255,255,255,0.4)",
      borderBottom: activeView === "canopy" ? "none" : "1px solid rgba(0,0,0,0.06)",
      backdropFilter: activeView === "canopy" ? "none" : "blur(24px)",
    }}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setActiveView("canopy")}>
        <LobsterIcon size={28} shellColor="#3c6663" accentColor="#4A9E96" />
        <span style={{
          fontSize: 17, fontWeight: 700, color: "#303330", letterSpacing: "-0.02em",
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
            color: activeView === item.id ? "#303330" : "#636E72",
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
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "6px 14px",
            borderRadius: 8, background: "rgba(0,0,0,0.03)", fontSize: 12, color: "#636E72",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
            Search...
          </div>
        )}
        {(activeView !== "loading" && activeView !== "onboarding") && (
          <>
            <button style={{
              width: 32, height: 32, borderRadius: 8, border: "none", cursor: "pointer",
              background: "rgba(0,0,0,0.04)", display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#636E72" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
            </button>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", background: "rgba(0,0,0,0.06)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#636E72" strokeWidth={2}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
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
  const { setSelectedAgent, setActiveView } = useWorldStore();

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <Canvas
        style={{ position: "absolute", inset: 0 }}
        gl={{ antialias: true, alpha: false }}
        onCreated={({ gl }) => { gl.setClearColor("#EDE4DB"); gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.1; }}
      >
        <OrthographicCamera makeDefault position={[10, 10, 10]} zoom={65} near={0.1} far={100} />
        <OrbitControls enableZoom={false} enablePan={false} minPolarAngle={Math.PI * 0.25} maxPolarAngle={Math.PI * 0.4} autoRotate autoRotateSpeed={0.15} dampingFactor={0.05} enableDamping />
        <CanopyScene />
      </Canvas>

      {/* Agent roster overlay */}
      <div style={{ position: "absolute", top: 68, left: 20, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        {agents.map(a => (
          <div key={a.id} onClick={() => { setSelectedAgent(a.id); setActiveView("architect"); }} style={{
            ...glass(selectedAgent === a.id ? 0.7 : 0.45),
            padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
            borderRadius: 12, minWidth: 150, transition: "all 0.2s ease",
          }}>
            <div style={{ width: 24, height: 24, position: "relative" }}>
              <LobsterIcon size={24} shellColor={a.robeColor} accentColor={a.accentColor} />
              <div style={{
                position: "absolute", bottom: -1, right: -1, width: 8, height: 8, borderRadius: "50%",
                background: a.status === "active" ? "#4A9E96" : a.status === "thinking" ? "#8B6AAE" : "#B2BEC3",
                border: "2px solid white",
              }} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#303330" }}>{a.name}</div>
              <div style={{ fontSize: 10, color: "#636E72", textTransform: "capitalize" }}>{a.currentAction}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOADING SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function LoadingScreen() {
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
      <div style={{ fontSize: 24, fontWeight: 600, color: "#303330" }}>
        Waking up the lobsters...
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

function CompanionGuide({ type }: { type: string }) {
  const [step, setStep] = useState(0);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle"|"saving"|"success"|"error">("idle");
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
        { text: "Name the token 'canopy-app-token' and click Generate. Copy the xapp-... token and paste it here.", input: { key: "SLACK_APP_TOKEN", placeholder: "xapp-..." } },
        { text: "Almost done! Now click 'OAuth & Permissions' on the left sidebar." },
        { text: "Click the 'Install to Workspace' button and click Allow." },
        { text: "Copy the 'Bot User OAuth Token' (starts with xoxb-...). Paste it below and hit Connect!", input: { key: "SLACK_BOT_TOKEN", placeholder: "xoxb-..." } }
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
            
            // If it was Slack, we need to immediately test the connection so App.tsx can show it's connected
            if (type === "slack") {
               // Fire an event letting the main window know to test connection
               const { emit } = await import('@tauri-apps/api/event');
               await emit('slack-credentials-saved');
            }
            
            setTimeout(async () => {
              try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                await getCurrentWindow().close();
              } catch(e) {}
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
       width: "100%", height: "100%", display: "flex", flexDirection: "column",
       background: "rgba(255,255,255,0.85)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
       borderLeft: "1px solid rgba(0,0,0,0.1)", fontFamily: "'Manrope', system-ui, sans-serif"
    }}>
      <div data-tauri-drag-region style={{
         padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(0,0,0,0.06)",
         background: "linear-gradient(to right, rgba(237,228,219,0.5), rgba(255,255,255,0.4))",
         cursor: "grab"
      }}>
         <LobsterIcon size={32} shellColor="#3c6663" accentColor="#D9B08C" className="pulse-slow" />
         <div>
            <div data-tauri-drag-region style={{ fontSize: 14, fontWeight: 700, color: "#303330" }}>{config.title}</div>
            <div data-tauri-drag-region style={{ fontSize: 11, color: "#636E72" }}>Companion Walkthrough</div>
         </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 20 }}>
         {/* Intro */}
         <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <img src={config.avatar} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
            <div style={{ background: "#ffffff", padding: "12px 16px", borderRadius: "16px 16px 16px 4px", fontSize: 14, lineHeight: 1.5, color: "#303330", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
               {config.intro}
            </div>
         </div>

         {config.steps.slice(0, step + 1).map((s, i) => (
             <React.Fragment key={i}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-end", animation: "slideIn 0.3s ease" }}>
                   <div style={{ width: 28, flexShrink: 0 }} />
                   <div style={{ width: "100%", background: i === step ? "#3c6663" : "#ffffff", color: i === step ? "white" : "#303330", padding: "12px 16px", borderRadius: "16px 16px 16px 4px", fontSize: 14, lineHeight: 1.5, boxShadow: "0 2px 8px rgba(0,0,0,0.04)", transition: "all 0.3s" }}>
                      {s.text}
                      {s.input && i === step && (
                         <div style={{ marginTop: 12 }}>
                           <input
                             autoFocus
                             type="password"
                             placeholder={s.input.placeholder}
                             value={tokens[s.input.key] || ""}
                             onChange={e => setTokens({ ...tokens, [s.input.key]: e.target.value })}
                             style={{
                                width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8,
                                border: "1px solid rgba(255,255,255,0.3)", background: "rgba(0,0,0,0.2)", color: "white", outline: "none", fontSize: 13, fontFamily: "monospace"
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
                           padding: "8px 16px", borderRadius: 16, border: "none", background: "#D9B08C", color: "#303330", fontSize: 13, fontWeight: 700, cursor: (s.input && !tokens[s.input.key]) ? "default" : "pointer", opacity: (s.input && !tokens[s.input.key]) ? 0.5 : 1
                        }}>
                           {s.input ? "Save & Continue" : "I've done this ->"}
                        </button>
                     </div>
                )}
             </React.Fragment>
         ))}

         {status === "saving" && (
            <div style={{ textAlign: "center", fontSize: 13, color: "#636E72", fontStyle: "italic", animation: "pulse 1s infinite" }}>Saving securely to your Mac's Keychain...</div>
         )}
         {status === "success" && (
            <div style={{ textAlign: "center", animation: "slideIn 0.3s ease" }}>
               <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
               <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663" }}>Saved successfully!</div>
               <div style={{ fontSize: 12, color: "#636E72", marginTop: 4 }}>Validating connection & closing...</div>
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
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const isCompanion = new URLSearchParams(window.location.search).get('companion');
  if (isCompanion) {
    return <CompanionGuide type={isCompanion} />;
  }

  const { activeView, selectedAgent, agents, setSelectedAgent, setActiveView, setAgents } = useWorldStore();
  const agent = agents.find(a => a.id === selectedAgent) || agents[0];
  const [initialized, setInitialized] = useState(false);

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
        const loadedAgents = await invoke("list_agents") as Agent[];

        if (loadedAgents.length === 0) {
          setActiveView("onboarding");
        } else {
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
              permissions: DEFAULT_PERMISSIONS.map(p => ({ ...p })),
              recentSpend: [],
              chatLog: [],
              memories: [],
              personalityPrompt: `${agent.name} is a ${agent.role.toLowerCase()} lobster — reliable, sharp, and always working.`,
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
    };

    loadAgents();
  }, []);

  // Default to first agent if entering architect with none selected
  useEffect(() => {
    if (activeView === "architect" && !selectedAgent && agents.length > 0) {
      setSelectedAgent(agents[0].id);
    }
  }, [activeView, selectedAgent, agents]);

  if (!initialized) {
    return <LoadingScreen />;
  }

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: activeView === "canopy" ? "#EDE4DB" : "linear-gradient(180deg, #F5F0EB 0%, #EDE4DB 100%)",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
    }}>
      <UpdateManager />
      {activeView !== "onboarding" && <TopNav />}

      {activeView === "loading" && <LoadingScreen />}
      {activeView === "onboarding" && <OnboardingWizard />}
      {activeView === "canopy" && <CanopyView />}
      {activeView === "architect" && agent && <ArchitectView agent={agent} />}
      {activeView === "archive" && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#636E72" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, opacity: 0.2, marginBottom: 12 }}>&#9776;</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Archive</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Task history, decisions, and data flows</div>
          </div>
        </div>
      )}
      {activeView === "library" && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#636E72" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, opacity: 0.2, marginBottom: 12 }}>&#10070;</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Library</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Skills, integrations, and shared resources</div>
          </div>
        </div>
      )}
      {activeView === "vault" && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <ProvidersVault />
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
