import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { WorldScene } from "./components/World/WorldScene";

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

export function LobsterIcon({ shellColor = "#C0392B", accentColor = "#E74C3C", size = 48 }: {
  shellColor?: string; accentColor?: string; size?: number;
}) {
  const robeMat = useMemo(() => new THREE.MeshStandardMaterial({ color: shellColor, flatShading: true }), [shellColor]);
  const headColor = useMemo(() => { const c = new THREE.Color(shellColor); c.lerp(new THREE.Color("#F5E6D8"), 0.6); return c; }, [shellColor]);

  // Scale factor: the full AgentCharacter is ~0.8 units tall; we map that to fill the canvas
  return (
    <Canvas
      style={{ width: size, height: size, pointerEvents: "none" }}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [0, 0.5, 1.8], fov: 30 }}
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[2, 3, 2]} intensity={0.8} />
      <group position={[0, -0.25, 0]}>
        <OrganicLobsterBody robeMat={robeMat} headColor={headColor} />

        {/* Static Claws for UI Icon */}
        <group position={[-0.26, 0.25, 0.15]} rotation={[0, 0.1, 0.4]}>
          <mesh position={[0, -0.06, 0]}>
            <cylinderGeometry args={[0.01, 0.015, 0.12, 6]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
          <mesh position={[0, -0.13, 0]} scale={[1, 1.2, 1]}>
            <sphereGeometry args={[0.035, 12, 12]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
        </group>
        <group position={[0.26, 0.25, 0.15]} rotation={[0, -0.1, -0.4]}>
          <mesh position={[0, -0.06, 0]}>
            <cylinderGeometry args={[0.01, 0.015, 0.12, 6]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
          <mesh position={[0, -0.13, 0]} scale={[1, 1.2, 1]}>
            <sphereGeometry args={[0.035, 12, 12]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
        </group>

        {/* Static Antennae for UI Icon */}
        <group position={[-0.05, 0.65, -0.02]} rotation={[-0.1, 0, 0.2]}>
          <mesh position={[0, 0.12, 0]}>
            <cylinderGeometry args={[0.008, 0.012, 0.24, 6]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
          <mesh position={[0, 0.24, 0]}>
            <sphereGeometry args={[0.03, 12, 12]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
        </group>
        <group position={[0.05, 0.65, -0.02]} rotation={[-0.1, 0, -0.2]}>
          <mesh position={[0, 0.12, 0]}>
            <cylinderGeometry args={[0.008, 0.012, 0.24, 6]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
          <mesh position={[0, 0.24, 0]}>
            <sphereGeometry args={[0.03, 12, 12]} />
            <meshStandardMaterial color={accentColor} />
          </mesh>
        </group>
      </group>
    </Canvas>
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
  personalityPrompt: string;
  avatarPrompt: string;
}

interface WorldState {
  agents: AgentData[];
  selectedAgent: string | null;
  hoveredAgent: string | null;
  activeView: "loading" | "onboarding" | "canopy" | "architect" | "archive" | "library";
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

const AGENT_TYPE_INFO: Record<string, { description: string; color: string; robeColor: string; accentColor: string; habitatColor: string; habitatLabel: string; image?: string }> = {
  "Researcher":   { description: "Deep dives — data analysis, trends & insights",        color: "#7AAC7A", robeColor: "#5E8E5E", accentColor: "#96C496", habitatColor: "#BDD4BD", habitatLabel: "The Sanctuary", image: "/agents/Researcher.png" },
  "Tutor":        { description: "Teaches & guides — education, onboarding & mentoring", color: "#A882D8", robeColor: "#8A62C0", accentColor: "#C8A4F0", habitatColor: "#CEC4E4", habitatLabel: "The Axis", image: "/agents/Tutor.png" },
  
  "Interior Designer": { description: "Curates spaces with impeccable style.", color: "#82A4A8", robeColor: "#82A4A8", accentColor: "#C1D3D5", habitatColor: "#A6C2C5", habitatLabel: "Design", image: "/agents/InteriorDesigner.png" },
  "Fashion Stylist": { description: "Curates your wardrobe and looks.", color: "#B85C82", robeColor: "#B85C82", accentColor: "#E5A8C1", habitatColor: "#D6A3B9", habitatLabel: "Fashion", image: "/agents/FashionStylist.png" },
  "Therapist": { description: "Listens, guides, and supports your well-being.", color: "#E0908B", robeColor: "#E0908B", accentColor: "#FACCC9", habitatColor: "#EFAFA9", habitatLabel: "Wellness", image: "/agents/Therapist.png" },
  "Chef": { description: "Plans meals and creates culinary magic.", color: "#D96C3B", robeColor: "#D96C3B", accentColor: "#F4AD8A", habitatColor: "#E8A381", habitatLabel: "Kitchen", image: "/agents/Chef1.png" },
  "Travel Agent": { description: "Plans itineraries and perfect getaways.", color: "#6AA89E", robeColor: "#6AA89E", accentColor: "#AEE5DB", habitatColor: "#94C9C0", habitatLabel: "Travel", image: "/agents/TravelAgent.png" },
  "Media Advisor": { description: "Navigates news, entertainment & PR.", color: "#63476E", robeColor: "#63476E", accentColor: "#A485B0", habitatColor: "#7D6288", habitatLabel: "Media", image: "/agents/MediaAdvisor.png" },
  "Relationship Guru": { description: "Helps you navigate social connections.", color: "#DB998A", robeColor: "#DB998A", accentColor: "#F4CCC3", habitatColor: "#EAB3A6", habitatLabel: "Social", image: "/agents/RelationshipGuru.png" },
  "Kids Coordinator": { description: "Manages schedules, activities & fun.", color: "#BFCB75", robeColor: "#BFCB75", accentColor: "#E5EEAF", habitatColor: "#D8E38E", habitatLabel: "Family", image: "/agents/KidsCoordinator.png" },

  "Accountant":   { description: "Balances the books & compliance.", color: "#8E9EAA", robeColor: "#8E9EAA", accentColor: "#D7DFE5", habitatColor: "#BCCAD6", habitatLabel: "Finance", image: "/agents/Accountant.png" },
  "Business Strategist": { description: "Plots long-term growth & objectives.", color: "#E2936B", robeColor: "#E2936B", accentColor: "#F5C2A8", habitatColor: "#EDAA87", habitatLabel: "Strategy", image: "/agents/BusinessStrategist.png" },
  "Marketing Guru": { description: "Drives traffic, campaigns and virality.", color: "#F0B466", robeColor: "#F0B466", accentColor: "#FCE1B6", habitatColor: "#F5CC8E", habitatLabel: "Marketing", image: "/agents/MarketingGuru.png" },
  "Educator": { description: "Builds curriculums and learning paths.", color: "#95B589", robeColor: "#95B589", accentColor: "#CFE5C6", habitatColor: "#B6D2AA", habitatLabel: "Education", image: "/agents/Educator.png" },
  "Artist": { description: "Brings creative visions to life.", color: "#D07C82", robeColor: "#D07C82", accentColor: "#F3BCC1", habitatColor: "#E29DA3", habitatLabel: "Creative", image: "/agents/Artist.png" },
  "Coder": { description: "Writes logic, ships code, squashes bugs.", color: "#545281", robeColor: "#545281", accentColor: "#918ECA", habitatColor: "#7472A5", habitatLabel: "Engineering", image: "/agents/Coder.png" },
  "Architect": { description: "Designs systems and structures.", color: "#8AA3C6", robeColor: "#8AA3C6", accentColor: "#C7D8F2", habitatColor: "#A9C1E1", habitatLabel: "Architecture", image: "/agents/Architect.png" },
  "Musician": { description: "Composes, mixes, and scores your life.", color: "#3B4262", robeColor: "#3B4262", accentColor: "#757D9D", habitatColor: "#535C80", habitatLabel: "Music", image: "/agents/Musician.png" },
  "Investment Manager": { description: "Grows your portfolio and assets.", color: "#615C9C", robeColor: "#615C9C", accentColor: "#A09CDF", habitatColor: "#7F7AB9", habitatLabel: "Capital", image: "/agents/InvestmentManager.png" },
  "Trainer": { description: "Pushes your fitness & health goals.", color: "#74AFA0", robeColor: "#74AFA0", accentColor: "#B1E1D5", habitatColor: "#95CBB9", habitatLabel: "Fitness", image: "/agents/Trainer.png" },
  "Strategist":  { description: "Decision memos, competitive scans & long-range planning",   color: "#9A94AC", robeColor: "#9A94AC", accentColor: "#E2DFF0", habitatColor: "#C5C0D0", habitatLabel: "The Citadel" },
  "Negotiator":  { description: "Deal prep, BATNA analysis & high-stakes conversations",       color: "#A8917E", robeColor: "#A8917E", accentColor: "#EDE0D5", habitatColor: "#D4C5B8", habitatLabel: "The Exchange" },
  "Engineer":    { description: "Code review, architecture decisions & debugging deep-dives",  color: "#8AA3B5", robeColor: "#8AA3B5", accentColor: "#D5E5F0", habitatColor: "#B8C8D4", habitatLabel: "The Workshop" },
  "Editor":      { description: "Prose tightening, structure feedback & developmental edits",  color: "#A8967E", robeColor: "#A8967E", accentColor: "#EDE4D5", habitatColor: "#D4C8B8", habitatLabel: "The Archive" },
  "Coach":       { description: "Habit tracking, goal-setting & personal reflection partner",  color: "#96A88E", robeColor: "#96A88E", accentColor: "#DFF0D8", habitatColor: "#C8D4C0", habitatLabel: "The Grove" },
  "Custom": { description: "A blank slate. You define their role, permissions, and skills.", color: "#7F8C8D", robeColor: "#95A5A6", accentColor: "#BDC3C7", habitatColor: "#ECF0F1", habitatLabel: "Unknown" }
};

function getRecommendedModel(role: string) {
  const heavyRoles = ["Researcher", "Coder", "Architect", "Financial", "Accountant", "Business Strategist", "Investment Manager"];
  if (heavyRoles.includes(role)) {
    return { provider: "Anthropic", model: "Claude 3.5 Sonnet (Powerful & Deep)" };
  }
  return { provider: "OpenAI", model: "GPT-4o-mini (Fast & Light)" };
}

function getDefaultPersonality(role: string, name: string) {
  if (!role || role === "Custom") return `You are ${name ? name : 'a custom AI agent'}. Your primary objective is to execute instructions cleanly and effectively. Always maintain a helpful tone.`;
  const info = AGENT_TYPE_INFO[role];
  return `You are ${name ? name : 'a'} ${role} agent. Your primary objective is to ${info?.description.toLowerCase() || 'assist the user'}. Make decisions efficiently and always maintain a professional tone.`;
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

function IsoBlock({ position, size = [1,1,1], lit = "#D4A574", shadow = "#B88A5E", top = "#E8C9A0" }: { position: [number,number,number]; size?: [number,number,number]; lit?: string; shadow?: string; top?: string }) {
  const m = useCardinalMaterial(lit, shadow, top);
  return <mesh position={position} material={m}><boxGeometry args={size} /></mesh>;
}

function Column({ position, height = 1.5, color = "#C4A0C9" }: { position: [number,number,number]; height?: number; color?: string }) {
  return (<group position={position}>
    <mesh position={[0,height/2,0]}><cylinderGeometry args={[0.08,0.1,height,6]} /><meshStandardMaterial color={color} flatShading /></mesh>
    <mesh position={[0,height+0.05,0]}><boxGeometry args={[0.25,0.1,0.25]} /><meshStandardMaterial color={color} flatShading /></mesh>
  </group>);
}

function Arch({ position, rotation = [0,0,0], scale = 1, lit = "#9EB4C7", shadow = "#7E98AD", top = "#BED0DE" }: { position: [number,number,number]; rotation?: [number,number,number]; scale?: number; lit?: string; shadow?: string; top?: string }) {
  const m = useCardinalMaterial(lit, shadow, top);
  return (<group position={position} rotation={rotation as any} scale={scale}>
    <mesh position={[-0.6,0.5,0]} material={m}><boxGeometry args={[0.3,1,0.3]} /></mesh>
    <mesh position={[0.6,0.5,0]} material={m}><boxGeometry args={[0.3,1,0.3]} /></mesh>
    <mesh position={[0,1.1,0]} material={m}><boxGeometry args={[1.5,0.25,0.3]} /></mesh>
    <mesh position={[0,1.35,0]} material={m}><boxGeometry args={[1.1,0.15,0.35]} /></mesh>
  </group>);
}

function Stairs({ position, rotation = [0,0,0], steps = 5, lit = "#D4A574", shadow = "#B88A5E", top = "#E8C9A0" }: { position: [number,number,number]; rotation?: [number,number,number]; steps?: number; lit?: string; shadow?: string; top?: string }) {
  const m = useCardinalMaterial(lit, shadow, top);
  return (<group position={position} rotation={rotation as any}>
    {Array.from({ length: steps }).map((_,i) => <mesh key={i} position={[0,i*0.15,i*0.25]} material={m}><boxGeometry args={[0.8,0.15,0.25]} /></mesh>)}
  </group>);
}

function GeometricPlant({ position, height = 0.5, color = "#6B8E5A" }: { position: [number,number,number]; height?: number; color?: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => { if (ref.current) ref.current.rotation.z = Math.sin(clock.getElapsedTime() * 0.8 + position[0]) * 0.03; });
  return (<group ref={ref} position={position}>
    <mesh position={[0,height*0.3,0]}><cylinderGeometry args={[0.02,0.03,height*0.6,4]} /><meshStandardMaterial color="#B5A898" flatShading /></mesh>
    <mesh position={[0,height*0.6,0]}><octahedronGeometry args={[height*0.25,0]} /><meshStandardMaterial color={color} flatShading /></mesh>
    <mesh position={[0,height*0.8,0]}><octahedronGeometry args={[height*0.18,0]} /><meshStandardMaterial color={color} flatShading /></mesh>
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
  return <mesh position={[0,-0.6,0]} rotation={[-Math.PI/2,0,0]} material={mat}><planeGeometry args={[20,20,32,32]} /></mesh>;
}

function FloatingMotes({ count = 20 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const motes = useMemo(() => Array.from({ length: count }).map(() => ({
    x: (Math.random()-0.5)*12, y: Math.random()*3-0.3, z: (Math.random()-0.5)*12,
    s: 0.1+Math.random()*0.2, p: Math.random()*Math.PI*2, sz: 0.02+Math.random()*0.03,
  })), [count]);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    motes.forEach((m, i) => {
      dummy.position.set(m.x+Math.sin(t*m.s+m.p)*0.5, m.y+Math.sin(t*m.s*1.3+m.p)*0.3, m.z+Math.cos(t*m.s*0.7+m.p)*0.5);
      dummy.scale.setScalar(m.sz*(0.8+Math.sin(t*2+m.p)*0.2));
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[undefined, undefined, count]}><sphereGeometry args={[1,6,6]} /><meshBasicMaterial color="#F5E6D8" transparent opacity={0.4} /></instancedMesh>;
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
      {isHovered && <mesh position={[0,0.01,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[0.3,0.38,24]} /><meshBasicMaterial color="#83C5BE" transparent opacity={0.5} /></mesh>}
      
      {/* 3D Body rendered from exact Lathe */}
      <OrganicLobsterBody robeMat={robeMat} headColor={headColor} />

      {/* Claws — dynamic expressive arms */}
      <ClawArm side={-1} color={agent.accentColor} id={agent.id} />
      <ClawArm side={1} color={agent.accentColor} id={agent.id} />

      {/* Antennae — dynamic swept stalks */}
      <AntennaStalk base={[-0.05,0.65,-0.02]} h={0.24} c={0.2} color={agent.accentColor} id={agent.id} />
      <AntennaStalk base={[0.05,0.65,-0.02]} h={0.24} c={-0.2} color={agent.accentColor} id={agent.id} />

      {agent.status === "thinking" && <ThinkBubbles color={agent.accentColor} />}
    </group>
  );
}

function AntennaStalk({ base, h, c, color, id }: { base: [number,number,number]; h: number; c: number; color: string; id: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => { 
    if (!ref.current) return; 
    const t = clock.getElapsedTime(); 
    ref.current.rotation.z = Math.sin(t*2+id.length)*0.08+c; 
    ref.current.rotation.x = -0.1 + Math.sin(t*1.5+id.length*0.7)*0.05; 
  });
  return (<group ref={ref} position={base}>
    <mesh position={[0,h/2,0]}><cylinderGeometry args={[0.008,0.012,h,6]} /><meshStandardMaterial color={color} /></mesh>
    <mesh position={[0,h,0]}><sphereGeometry args={[0.03, 12, 12]} /><meshStandardMaterial color={color} /></mesh>
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
  useFrame(({ clock }) => { if (!ref.current) return; const t = clock.getElapsedTime(); ref.current.children.forEach((c,i) => { c.position.y = 0.8+Math.sin(t*2+i*1.5)*0.1+i*0.08; c.position.x = Math.sin(t*1.5+i*2)*0.08; c.position.z = Math.cos(t*1.2+i*2)*0.08; }); });
  return (<group ref={ref}>{[0,1,2].map(i => <mesh key={i}><sphereGeometry args={[0.02,6,6]} /><meshBasicMaterial color={color} transparent opacity={0.5} /></mesh>)}</group>);
}

function WorldArchitecture() {
  return (<group>
    {/* Base Platform */}
    <IsoBlock position={[0,-0.25,0]} size={[10,0.5,10]} lit="#D1C4B4" shadow="#B5A898" top="#E8DDD0" />
    
    {/* Plaza (Center) with fountain */}
    <mesh position={[0,0.05,0]}><cylinderGeometry args={[0.5,0.6,0.1,8]} /><meshStandardMaterial color="#83C5BE" flatShading /></mesh>
    <mesh position={[0,0.15,0]}><cylinderGeometry args={[0.15,0.15,0.3,6]} /><meshStandardMaterial color="#9EB4C7" flatShading /></mesh>

    {/* Executive's Axis (Assistant) - [4, 1.5, -2] - Teal */}
    <IsoBlock position={[4,0.5,-2]} size={[2,1.5,2]} lit="#64C8C0" shadow="#4AA8A1" top="#81DCD5" />
    <IsoBlock position={[4,1.75,-2]} size={[1.2,1,1.2]} lit="#64C8C0" shadow="#4AA8A1" top="#81DCD5" />
    {/* Floating Data Screens */}
    <mesh position={[3.3,2.5,-1.5]} rotation={[0,Math.PI/4,0]}><boxGeometry args={[1,0.6,0.05]} /><meshBasicMaterial color="#81DCD5" transparent opacity={0.6} /></mesh>
    <mesh position={[4.5,2.0,-1.3]} rotation={[0,-Math.PI/6,0]}><boxGeometry args={[0.8,0.5,0.05]} /><meshBasicMaterial color="#81DCD5" transparent opacity={0.6} /></mesh>

    {/* Accountant's Labyrinth (Financial) - [-3, 0.5, -2] - Peach/Salmon */}
    <Stairs position={[-2,0,-1]} rotation={[0,-Math.PI/2,0]} steps={5} />
    <IsoBlock position={[-3,0.25,-2]} size={[2.5,0.5,2.5]} lit="#F39B88" shadow="#D87F6C" top="#FFAF9F" />
    <IsoBlock position={[-3.5,0.75,-2.5]} size={[1,0.5,1]} lit="#F39B88" shadow="#D87F6C" top="#FFAF9F" />
    <IsoBlock position={[-2.5,0.75,-2.5]} size={[0.5,0.8,0.5]} lit="#F39B88" shadow="#D87F6C" top="#FFAF9F" />
    <Stairs position={[-2.5,0.5,-3]} rotation={[0,0,0]} steps={3} />

    {/* Strategist's Terrace (STR Manager) - [3, 2.5, -4] - Slate/Navy */}
    <IsoBlock position={[3,1.25,-4]} size={[2,2.5,2]} lit="#718096" shadow="#4A5568" top="#A0AEC0" />
    {/* Overlook railings */}
    <Column position={[2.1,2.6,-3.1]} height={0.3} color="#A0AEC0" />
    <Column position={[3.9,2.6,-3.1]} height={0.3} color="#A0AEC0" />
    <Column position={[2.1,2.6,-4.9]} height={0.3} color="#A0AEC0" />
    <Column position={[3.9,2.6,-4.9]} height={0.3} color="#A0AEC0" />
    <IsoBlock position={[3,2.6,-4]} size={[1.8,0.05,1.8]} lit="#718096" shadow="#4A5568" top="#A0AEC0" transparent opacity={0.3} />

    {/* Scientist's Sanctuary (Researcher) - [0, 1.0, -4] - Sage Green */}
    <IsoBlock position={[0,0.5,-4]} size={[2.5,1,2.5]} lit="#8FBC8F" shadow="#6E9C6E" top="#AADBAA" />
    {/* Lab Flasks */}
    <mesh position={[-0.6,1.4,-4]}><cylinderGeometry args={[0.15,0.3,0.8,8]} /><meshStandardMaterial color="#AADBAA" flatShading transparent opacity={0.7} /></mesh>
    <mesh position={[0.5,1.3,-4.2]}><sphereGeometry args={[0.35,8,8]} /><meshStandardMaterial color="#8FBC8F" flatShading transparent opacity={0.7} /></mesh>
    <mesh position={[0,1.2,-3.5]}><cylinderGeometry args={[0.1,0.1,0.4,8]} /><meshStandardMaterial color="#AADBAA" flatShading transparent opacity={0.7} /></mesh>

    {/* Educator's Enclave (Tutor) - [-3, 0, 3] - Soft Purple */}
    <IsoBlock position={[-3,0,3]} size={[3.5,0.4,3.5]} lit="#B892FF" shadow="#9670D8" top="#D4B3FF" />
    <Arch position={[-2,0.4,3]} rotation={[0,Math.PI/2,0]} scale={1.2} />
    <Arch position={[-3,0.4,2]} scale={1.2} />
    <Arch position={[-3,0.4,4]} scale={1.2} />
    {/* Trees & Study objects */}
    <GeometricPlant position={[-3.8,0.2,3.8]} height={0.7} color="#B892FF" />
    <GeometricPlant position={[-2.4,0.2,4.2]} height={0.5} color="#9670D8" />
    <IsoBlock position={[-3.5,0.35,2.5]} size={[0.6,0.3,0.6]} lit="#D1C4B4" shadow="#B5A898" top="#E8DDD0" />
  </group>);
}

function SkyGradient() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform float t;varying vec2 vU;void main(){vec3 top=vec3(.784,.847,.91);vec3 bot=vec3(.96,.902,.847);float s=sin(t*.02)*.03;top.r+=s;bot.b+=s;vec3 c=mix(bot,top,vU.y);vec2 cn=vU-.5;c*=1.-dot(cn,cn)*.5;gl_FragColor=vec4(c,1.);}`,
    uniforms: { t: { value: 0 } }, side: THREE.BackSide, depthWrite: false,
  }), []);
  useFrame(({ clock }) => { mat.uniforms.t.value = clock.getElapsedTime(); });
  return <mesh material={mat}><sphereGeometry args={[50,16,16]} /></mesh>;
}

function CanopyScene() {
  const agents = useWorldStore(s => s.agents);
  const setSelected = useWorldStore(s => s.setSelectedAgent);
  return (<>
    <ambientLight intensity={0.6} color="#F5E6D8" />
    <directionalLight position={[5,10,3]} intensity={0.8} />
    <directionalLight position={[-3,5,-2]} intensity={0.2} color="#C8D8E8" />
    <SkyGradient />
    <Water />
    <FloatingMotes count={25} />
    <group>
      <IsoBlock position={[0,-0.8,0]} size={[10,0.6,10]} lit="#C4B8A8" shadow="#A89C8C" top="#D8CCC0" />
      <IsoBlock position={[0,-1.5,0]} size={[8,0.8,8]} lit="#B8ACA0" shadow="#9C9088" top="#CCC0B4" />
      <WorldArchitecture />
      {agents.map(a => <AgentCharacter key={a.id} agent={a} />)}
    </group>
    <mesh position={[0,-2,0]} rotation={[-Math.PI/2,0,0]} visible={false} onClick={() => setSelected(null)}><planeGeometry args={[100,100]} /></mesh>
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
      background: enabled ? "#218380" : "rgba(0,0,0,0.08)", transition: "all 0.2s ease",
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

function ProgressBar({ value, max = 1, color = "#218380", height = 4 }: { value: number; max?: number; color?: string; height?: number }) {
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
  const [llmProvider, setLlmProvider] = useState<"OpenAI"|"Google Gemini"|"Anthropic"|"">("");
  
  const [plugins, setPlugins] = useState<Record<string, boolean>>({ slack: false, email: false, calendar: false, folders: false });
  const [testPluginIndex, setTestPluginIndex] = useState(-1);
  const [testStatus, setTestStatus] = useState<"idle"|"testing"|"success">("idle");
  const enabledPlugins = Object.entries(plugins).filter(([k,v]) => v).map(([k]) => k);

  const { setActiveView, addAgent } = useWorldStore();

  const roleTypes = Object.entries(AGENT_TYPE_INFO).filter(([key]) => key !== "Custom").map(([key, val]) => ({ key, ...val }));

  const handleRoleSelect = (roleKey: string) => {
    setSelectedRole(roleKey);
    setLlmProvider(getRecommendedModel(roleKey).provider as any);
    setPersonalityPrompt(getDefaultPersonality(roleKey, agentName));
  };

  const handleCreateAgent = async () => {
    if (!selectedRole || !agentName.trim()) return;

    try {
      const roleInfo = AGENT_TYPE_INFO[selectedRole];
      let newAgentData: Agent;
      try {
        if (typeof invoke === 'function') {
          newAgentData = await invoke("create_agent", {
            name: agentName,
            role: selectedRole,
            emoji: "agent",
            personality: personalityPrompt,
            isolated: false,
          }) as Agent;

          if (apiKey.trim()) {
            await invoke("store_secret_cmd", {
              key: `agent_${newAgentData.id}_api_key`,
              value: apiKey,
            });
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
            communication_style: personalityPrompt,
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
        personalityPrompt: personalityPrompt || `${agentName} is a ${selectedRole.toLowerCase()} agent — reliable, sharp, and always working.`,
        avatarPrompt: `Isometric 3D-rendered agent character in Monument Valley art style. Rounded bell-shaped body with ${roleInfo?.robeColor || "#888"} shell, smooth round head, two swept-back antennae with bulbous ${roleInfo?.accentColor || "#ccc"} tips, small expressive claws at sides. Flat-shaded low-poly faces, soft directional lighting from upper-left. Warm muted pastel palette. No outlines. Ref: agent-style-grid.png`,
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
      background: "linear-gradient(135deg, #EDE4DB 0%, #F5EEE8 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
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
              <OrbitControls enableZoom={true} enablePan={true} autoRotate autoRotateSpeed={0.8} minPolarAngle={Math.PI * 0.2} maxPolarAngle={Math.PI * 0.4} />
              <WorldScene />
            </Canvas>
          </div>

          <div style={{ textAlign: "center", maxWidth: 640, zIndex: 1, position: "relative", pointerEvents: "none", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{
              background: "rgba(255,255,255,0.7)", padding: "8px 16px", borderRadius: 20, 
              fontSize: 12, fontWeight: 700, color: "#218380", backdropFilter: "blur(8px)", 
              display: "flex", alignItems: "center", gap: 8, marginBottom: 40,
              boxShadow: "0 4px 12px rgba(0,0,0,0.05)"
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#218380", display: "inline-block", animation: "pulse 2s infinite" }} />
              Interactive Habitat (Drag to rotate)
            </div>
            
            <div style={{ 
              background: "radial-gradient(ellipse at center, rgba(237,228,219,0.9) 0%, rgba(237,228,219,0) 70%)", 
              padding: "40px", borderRadius: "50%" 
            }}>
              <h1 style={{ fontSize: 56, fontWeight: 800, color: "#2D3436", marginBottom: 16, letterSpacing: "-0.03em", textShadow: "0 4px 16px rgba(255,255,255,0.8)" }}>
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
                  background: "linear-gradient(135deg, #218380, #4A9E96)",
                  color: "white", fontSize: 18, fontWeight: 700, cursor: "pointer",
                  boxShadow: "0 8px 24px rgba(33,131,128,0.3)",
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
        <div style={{ maxWidth: 900, width: "90%", maxHeight: "90vh", overflow: "auto", padding: "20px 0" }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "#2D3436", marginBottom: 12, textAlign: "center" }}>
            Choose Your Agent
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32, textAlign: "center" }}>
            Every agent has a specialty — pick the right one for the job
          </p>

          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 32 }}>
             <button onClick={() => handleRoleSelect("Custom")} style={{
               padding: "12px 24px", borderRadius: 12, background: "rgba(255,255,255,0.8)", border: selectedRole === "Custom" ? "2px solid #218380" : "1px solid rgba(0,0,0,0.1)", color: "#2D3436", fontSize: 14, fontWeight: 600, cursor: "pointer"
             }}>+ Create Custom Agent</button>
             <button onClick={() => alert("Import flow coming soon")} style={{
               padding: "12px 24px", borderRadius: 12, background: "transparent", border: "1px dashed rgba(0,0,0,0.2)", color: "#636E72", fontSize: 14, fontWeight: 600, cursor: "pointer"
             }}>↓ Import Agent</button>
          </div>

          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16,
            marginBottom: 40,
          }}>
            {roleTypes.map(role => (
              <div
                key={role.key}
                onClick={() => handleRoleSelect(role.key)}
                style={{
                  borderRadius: 10,
                  cursor: "pointer",
                  overflow: "hidden",
                  border: selectedRole === role.key
                    ? `2px solid ${role.color}`
                    : "1px solid rgba(0,0,0,0.10)",
                  transition: "all 0.25s ease",
                  transform: selectedRole === role.key
                    ? "scale(1.05) translateY(-4px)"
                    : "scale(1)",
                  boxShadow: selectedRole === role.key
                    ? `5px 5px 0 ${role.color}45, 0 14px 32px rgba(0,0,0,0.13)`
                    : "3px 3px 0 rgba(0,0,0,0.07), 0 2px 6px rgba(0,0,0,0.05)",
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
                    : "1px solid rgba(0,0,0,0.07)",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#2D3436", letterSpacing: "0.01em", marginBottom: 3 }}>
                    {role.key}
                  </div>
                  <div style={{ fontSize: 10, color: "#636E72", lineHeight: 1.4 }}>
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
                    : "1px solid rgba(0,0,0,0.07)",
                  borderBottomLeftRadius: 10, borderBottomRightRadius: 10
                }}>
                  <div style={{ fontSize: 10, color: "#636E72", lineHeight: 1.3, textAlign: "center" }}>
                    {role.description}
                  </div>
                </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => setStep(0)} style={{
              padding: "12px 28px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)",
              background: "rgba(255,255,255,0.6)", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(2)} disabled={!selectedRole} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: selectedRole ? "#218380" : "rgba(0,0,0,0.06)",
              color: selectedRole ? "white" : "#B2BEC3",
              fontSize: 14, fontWeight: 600, cursor: selectedRole ? "pointer" : "default",
              fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 3: Name & Personality */}
      {step === 2 && (
        <div style={{ maxWidth: 600, width: "90%", maxHeight: "90vh", overflow: "auto" }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "#2D3436", marginBottom: 12 }}>
            Name Your Agent
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>
            Give them an identity
          </p>

          <div style={{ marginBottom: 32 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "#2D3436", marginBottom: 8 }}>Agent Name</label>
            <input
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              placeholder="e.g., Atlas, Nova, Sage..."
              style={{
                width: "100%", padding: "14px 18px", borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.08)", fontSize: 15,
                fontFamily: "inherit", color: "#2D3436",
                outline: "none", background: "rgba(255,255,255,0.7)",
              }}
            />
          </div>

          {selectedRole && AGENT_TYPE_INFO[selectedRole] && (
            <div style={{
              background: "rgba(255,255,255,0.5)", padding: 20, borderRadius: 16, marginBottom: 32,
              display: "flex", gap: 16, alignItems: "flex-start", backdropFilter: "blur(4px)",
            }}>
              <LobsterIcon size={48} shellColor={AGENT_TYPE_INFO[selectedRole].robeColor} accentColor={AGENT_TYPE_INFO[selectedRole].accentColor} />
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "#2D3436", marginBottom: 4 }}>
                  {agentName || "Your Agent"} the {selectedRole}
                </div>
                <div style={{ fontSize: 13, color: "#636E72", lineHeight: 1.5 }}>
                  {AGENT_TYPE_INFO[selectedRole].description}
                </div>
              </div>
            </div>
          )}

          <div style={{ background: "rgba(255,255,255,0.5)", backdropFilter: "blur(4px)", padding: 24, borderRadius: 16, marginBottom: 32 }}>
            <h3 style={{ fontSize: 16, color: "#2D3436", margin: "0 0 4px 0" }}>Agent Personality</h3>
            <p style={{ fontSize: 13, color: "#636E72", marginBottom: 16 }}>Edit their core instructions below. This drives how they think and communicate.</p>
            
            <textarea
              value={personalityPrompt}
              onChange={e => setPersonalityPrompt(e.target.value)}
              rows={4}
              style={{
                width: "100%", padding: "12px 16px", borderRadius: 12, resize: "vertical",
                border: "1px solid rgba(0,0,0,0.08)", fontSize: 14, lineHeight: 1.5,
                fontFamily: "inherit", color: "#2D3436", background: "rgba(255,255,255,0.7)",
                outline: "none"
              }}
            />
            
            <div style={{ marginTop: 24 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#2D3436", marginBottom: 6 }}>Initial Training Books</label>
                <div style={{ border: "1px dashed rgba(0,0,0,0.2)", borderRadius: 8, padding: "16px", textAlign: "center", color: "#636E72", fontSize: 12, cursor: "pointer", background: "rgba(255,255,255,0.3)" }}>
                  Click to attach PDFs or URLs
                </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
            <button onClick={() => setStep(1)} style={{
              padding: "12px 28px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)",
              background: "rgba(255,255,255,0.6)", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(3)} disabled={!agentName.trim()} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: agentName.trim() ? "#218380" : "rgba(0,0,0,0.06)",
              color: agentName.trim() ? "white" : "#B2BEC3",
              fontSize: 14, fontWeight: 600, cursor: agentName.trim() ? "pointer" : "default",
              fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 4: API Key */}
      {step === 3 && (
        <div style={{ maxWidth: 600, width: "90%", maxHeight: "90vh", overflow: "auto" }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "#2D3436", marginBottom: 12 }}>
            Power Up Your Agent
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>
            Provide an LLM API key so your agent can think.
          </p>
          
          {selectedRole && (
            <div style={{ marginBottom: 24, fontSize: 14, color: "#2D3436", background: "rgba(33,131,128,0.1)", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(33,131,128,0.2)" }}>
              Based on the <strong>{selectedRole}</strong> role, we default to the <strong>{getRecommendedModel(selectedRole).model}</strong> model.
            </div>
          )}

          <div style={{ marginBottom: 24, display: "flex", gap: 12 }}>
            {["OpenAI", "Google Gemini", "Anthropic"].map(prov => (
              <label key={prov} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.7)", padding: "12px 16px", borderRadius: 12, border: llmProvider === prov ? "1px solid #218380" : "1px solid rgba(0,0,0,0.1)", cursor: "pointer", opacity: llmProvider === prov ? 1 : 0.7 }}>
                <input type="radio" name="provider" checked={llmProvider === prov} onChange={() => setLlmProvider(prov as any)} />
                <span style={{ fontSize: 14, fontWeight: 600, color: "#2D3436" }}>{prov}</span>
              </label>
            ))}
          </div>

          <div style={{ marginBottom: 32 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "#2D3436", marginBottom: 8 }}>
              API Key (Optional for now)
            </label>
            <textarea
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-..."
              style={{
                width: "100%", padding: "14px 18px", borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.08)", fontSize: 13,
                fontFamily: "monospace", color: "#2D3436",
                outline: "none", background: "rgba(255,255,255,0.7)",
                minHeight: 100, resize: "vertical",
              }}
            />
          </div>

          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{
            display: "inline-block", fontSize: 12, color: "#218380", background: "none", border: "none",
            cursor: "pointer", fontFamily: "inherit", textDecoration: "underline",
            marginBottom: 32,
          }}>How do I get an API Key?</a>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
            <button onClick={() => setStep(2)} style={{
              padding: "12px 28px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)",
              background: "rgba(255,255,255,0.6)", color: "#636E72", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>Back</button>
            <button onClick={() => setStep(4)} style={{
              padding: "12px 28px", borderRadius: 12, border: "none",
              background: "#218380", color: "white",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 5: Plugins & Permissions */}
      {step === 6 && (
        <div style={{ maxWidth: 600, width: "90%", maxHeight: "90vh", overflow: "auto" }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, color: "#2D3436", marginBottom: 12 }}>Skills & Access</h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>Give your agent the tools they need to interact with your world.</p>
          
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
            {(["slack", "email", "calendar", "folders"] as const).map(p => (
              <div key={p} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.7)", padding: "16px 20px", borderRadius: 12, border: plugins[p] ? "1px solid #218380" : "1px solid rgba(0,0,0,0.08)" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#2D3436", textTransform: "capitalize" }}>{p} Access</div>
                  <div style={{ fontSize: 13, color: "#636E72", marginTop: 4 }}>Allow {agentName || "the agent"} to interact with your {p}.</div>
                </div>
                <Toggle enabled={plugins[p]} onChange={() => setPlugins(prev => ({ ...prev, [p]: !prev[p] }))} />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
            <button onClick={() => setStep(3)} style={{
              padding: "12px 28px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)",
              background: "rgba(255,255,255,0.6)", color: "#636E72", fontSize: 14, fontWeight: 600,
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
              background: "#218380", color: "white",
              fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>Next</button>
          </div>
        </div>
      )}

      {/* Step 6: Integration Testing */}
      {step === 5 && testPluginIndex >= 0 && testPluginIndex < enabledPlugins.length && (
        <div style={{ maxWidth: 500, width: "90%", textAlign: "center" }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "#2D3436", marginBottom: 12, textTransform: "capitalize" }}>Test {enabledPlugins[testPluginIndex]}</h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 32 }}>Let's make sure {agentName || "the agent"} can successfully connect.</p>

          <div style={{ background: "rgba(255,255,255,0.7)", padding: 32, borderRadius: 16, border: "1px solid rgba(0,0,0,0.08)", marginBottom: 32, minHeight: 180, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            {testStatus === "idle" && (
              <>
                <div style={{ fontSize: 14, color: "#2D3436", fontWeight: 600, marginBottom: 16 }}>Test Action: Send a test ping to your {enabledPlugins[testPluginIndex]}.</div>
                <button onClick={() => {
                  setTestStatus("testing");
                  setTimeout(() => setTestStatus("success"), 1500);
                }} style={{
                  padding: "12px 24px", borderRadius: 12, border: "none", background: "#218380", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                }}>Run Test</button>
              </>
            )}
            {testStatus === "testing" && (
              <div style={{ color: "#218380", fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ display: "inline-block", width: 16, height: 16, border: "3px solid rgba(33,131,128,0.2)", borderTopColor: "#218380", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                Testing connection...
              </div>
            )}
            {testStatus === "success" && (
              <div style={{ color: "#4A9E96", fontSize: 18, fontWeight: 600, animation: "pulse 0.5s" }}>
                <span style={{ fontSize: 32, display: "block", marginBottom: 8 }}>✅</span>
                Connected successfully!
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
              background: testStatus === "success" ? "#218380" : "rgba(0,0,0,0.06)",
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
              const role = selectedRole ? AGENT_TYPE_INFO[selectedRole] : null;
              const shellColor = role?.robeColor ?? "#218380";
              const accentColor = role?.accentColor ?? "#4A9E96";
              const habitatColor = role?.habitatColor ?? "#BDD5D2";
              const habitatLabel = role?.habitatLabel ?? "The Canopy";
              const borderColor = role?.color ?? "#218380";
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
                    <LobsterIcon size={100} shellColor={shellColor} accentColor={accentColor} />
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
          <h1 style={{ fontSize: 44, fontWeight: 700, color: "#2D3436", marginBottom: 12, letterSpacing: "-0.02em" }}>
            {agentName} is Alive!
          </h1>
          <p style={{ fontSize: 16, color: "#636E72", marginBottom: 40, maxWidth: 400, margin: "0 auto 40px" }}>
            Your agent is ready. Drop them into The Canopy and watch them work.
          </p>
          <button onClick={handleCreateAgent} style={{
            padding: "16px 40px", borderRadius: 16, border: "none",
            background: "linear-gradient(135deg, #218380, #4A9E96)",
            color: "white", fontSize: 16, fontWeight: 600, cursor: "pointer",
            boxShadow: "0 8px 24px rgba(33,131,128,0.25)",
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
    <div style={{ display: "flex", height: "100vh", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
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
              <LobsterIcon size={32} shellColor={agent.robeColor} accentColor={agent.accentColor} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#2D3436" }}>Architect View</div>
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
            color: architectTab === tab.id ? "#218380" : "#636E72",
            background: architectTab === tab.id ? "rgba(33,131,128,0.08)" : "transparent",
            borderLeft: architectTab === tab.id ? "3px solid #218380" : "3px solid transparent",
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
          background: "linear-gradient(135deg, #218380, #4A9E96)", color: "white",
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
        <h1 style={{ fontSize: 36, fontWeight: 700, color: "#2D3436", letterSpacing: "-0.02em", margin: 0, lineHeight: 1.1 }}>
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
            <span style={{ fontSize: 20, fontWeight: 600, color: "#2D3436", textTransform: "capitalize" }}>{agent.currentAction}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 11, color: "#636E72" }}>
            <span>Uptime</span>
            <span style={{ fontWeight: 500, color: "#2D3436" }}>{agent.uptime}</span>
          </div>
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 8 }}>Resource Consumption</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#636E72" }}>Weekly Compute</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#2D3436" }}>{agent.weeklyCompute}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#636E72" }}>Token Usage</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#2D3436" }}>{agent.tokensUsed}</div>
            </div>
          </div>
          <ProgressBar value={parseFloat(agent.weeklyCompute)} max={0.1} color="#4A9E96" />
        </div>

        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase", marginBottom: 8 }}>Monthly Spend</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#2D3436" }}>${agent.monthlySpend}</div>
          <div style={{ fontSize: 11, color: "#636E72", marginBottom: 8 }}>of ${agent.spendLimit} limit</div>
          <ProgressBar value={agent.monthlySpend} max={agent.spendLimit} color={agent.monthlySpend > agent.spendLimit * 0.8 ? "#D4A04A" : "#4A9E96"} />
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
                <div style={{ fontSize: 13, fontWeight: 500, color: "#2D3436" }}>{p.label}</div>
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

function PersonalityTab({ agent }: { agent: AgentData }) {
  const [prompt, setPrompt] = useState(agent.personalityPrompt);
  const [avatarPrompt, setAvatarPrompt] = useState(agent.avatarPrompt);

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", margin: "0 0 8px 0" }}>Neural Path</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>Shape how {agent.name} thinks, acts, and appears.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Personality Traits */}
        <div style={{ ...glass(0.5), padding: 24, borderRadius: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#2D3436", marginBottom: 16 }}>Personality Traits</div>
          <div style={{ fontSize: 13, color: "#636E72", fontStyle: "italic" }}>
            This agent's configuration is managed through the Rust backend.
          </div>
        </div>

        {/* Personality Prompt */}
        <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#2D3436", marginBottom: 6 }}>Personality Seed</div>
          <div style={{ fontSize: 11, color: "#636E72", marginBottom: 12 }}>Describe how this agent should behave. This shapes their decision-making and communication style.</div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={6} style={{
            flex: 1, padding: 12, borderRadius: 10, border: "1px solid rgba(0,0,0,0.08)",
            background: "rgba(255,255,255,0.5)", fontSize: 13, fontFamily: "inherit",
            color: "#2D3436", resize: "none", outline: "none", lineHeight: 1.6,
          }} />
          <button style={{
            marginTop: 12, padding: "8px 16px", borderRadius: 8, border: "none",
            background: "#218380", color: "white", fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", alignSelf: "flex-end",
          }}>Save Changes</button>
        </div>
      </div>

      {/* Avatar Customization */}
      <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, marginTop: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#2D3436" }}>Avatar Description</div>
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
          background: "rgba(255,255,255,0.5)", fontSize: 13, fontFamily: "inherit",
          color: "#2D3436", resize: "none", outline: "none", lineHeight: 1.6,
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
            background: "rgba(255,255,255,0.5)", fontSize: 12, fontWeight: 500,
            cursor: "pointer", fontFamily: "inherit", color: "#2D3436",
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
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", margin: "0 0 8px 0" }}>Permissions</h1>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: "#2D3436" }}>Shared Container</div>
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
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#2D3436" }}>{p.label}</div>
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
  const memories = [
    { type: "learned", text: "Guest check-in time preference: most guests prefer 3pm-4pm window", when: "2 days ago", confidence: 0.92 },
    { type: "experience", text: "Airbnb API rate limits are stricter on weekends — batch requests before Friday", when: "1 week ago", confidence: 0.87 },
    { type: "preference", text: "User prefers concise status updates without technical details", when: "3 days ago", confidence: 0.95 },
  ];

  const typeColors: Record<string, string> = { learned: "#4A9E96", experience: "#5B88A6", preference: "#8B6AAE", context: "#D4A04A" };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", margin: "0 0 8px 0" }}>Memory</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>
        What {agent.name} has learned and remembers. Memories are versioned and can be pruned.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["All", "Learned", "Experience", "Preference"].map(f => (
          <button key={f} style={{
            padding: "6px 14px", borderRadius: 20, border: "1px solid rgba(0,0,0,0.08)",
            background: f === "All" ? "#218380" : "rgba(255,255,255,0.5)",
            color: f === "All" ? "white" : "#636E72",
            fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
          }}>{f}</button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {memories.map((m, i) => (
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
                <div style={{ fontSize: 13, color: "#2D3436", lineHeight: 1.5 }}>{m.text}</div>
              </div>
              <div style={{ textAlign: "right", marginLeft: 16 }}>
                <div style={{ fontSize: 10, color: "#636E72" }}>Confidence</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#2D3436" }}>{Math.round(m.confidence * 100)}%</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Spend Tab ───────────────────────────────────────────────────────────────

function SpendTab({ agent }: { agent: AgentData }) {
  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", margin: "0 0 8px 0" }}>Spend & Utilization</h1>
      <p style={{ fontSize: 14, color: "#636E72", marginBottom: 28 }}>
        {agent.name}'s financial activity and resource consumption.
      </p>

      {/* Budget overview */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase" }}>This Month</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", marginTop: 4 }}>${agent.monthlySpend}</div>
          <ProgressBar value={agent.monthlySpend} max={agent.spendLimit} color="#4A9E96" height={6} />
          <div style={{ fontSize: 11, color: "#636E72", marginTop: 6 }}>${agent.spendLimit} monthly limit</div>
        </div>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase" }}>Auto-Approve Limit</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", marginTop: 4 }}>$25</div>
          <div style={{ fontSize: 11, color: "#636E72", marginTop: 6 }}>Purchases above this require your approval</div>
        </div>
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#636E72", textTransform: "uppercase" }}>Active Cards</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", marginTop: 4 }}>0</div>
          <div style={{ fontSize: 11, color: "#636E72", marginTop: 6 }}>Virtual cards currently issued</div>
        </div>
      </div>

      {/* Transaction table */}
      <div style={{ ...glass(0.5), borderRadius: 16, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#2D3436" }}>Recent Transactions</div>
        </div>
        <div style={{ padding: "20px", textAlign: "center", color: "#636E72", fontSize: 13 }}>
          No transactions yet
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
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#2D3436", margin: "0 0 8px 0" }}>Communion</h1>
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
                  ? "linear-gradient(135deg, #218380, #4A9E96)"
                  : "rgba(255,255,255,0.7)",
                color: msg.sender === "user" ? "white" : "#2D3436",
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
              width: 12, height: 12, borderRadius: "50%", background: "#218380",
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
            fontSize: 13, fontFamily: "inherit", color: "#2D3436",
            outline: "none", opacity: loading ? 0.6 : 1,
          }}
        />
        <button onClick={handleSendMessage} disabled={!message.trim() || loading} style={{
          padding: "14px 20px", borderRadius: 14, border: "none",
          background: (message.trim() && !loading) ? "#218380" : "rgba(0,0,0,0.06)",
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
        <LobsterIcon size={28} shellColor="#218380" accentColor="#4A9E96" />
        <span style={{
          fontSize: 17, fontWeight: 700, color: "#2D3436", letterSpacing: "-0.02em",
          fontFamily: "'Satoshi', 'DM Sans', system-ui, sans-serif",
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
            color: activeView === item.id ? "#2D3436" : "#636E72",
            background: "transparent", fontFamily: "inherit",
            borderBottom: activeView === item.id ? "2px solid #218380" : "2px solid transparent",
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
              <div style={{ fontSize: 13, fontWeight: 600, color: "#2D3436" }}>{a.name}</div>
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
      background: "linear-gradient(135deg, #EDE4DB 0%, #F5EEE8 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
      flexDirection: "column", gap: 24,
    }}>
      <div style={{
        animation: "float 3s ease-in-out infinite",
        display: "flex", justifyContent: "center",
      }}>
        <LobsterIcon size={80} shellColor="#218380" accentColor="#4A9E96" />
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "#2D3436" }}>
        Waking up the lobsters...
      </div>
      <style>{`
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const { activeView, selectedAgent, agents, setSelectedAgent, setActiveView, setAgents } = useWorldStore();
  const agent = agents.find(a => a.id === selectedAgent) || agents[0];
  const [initialized, setInitialized] = useState(false);

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
              personalityPrompt: `${agent.name} is a ${agent.role.toLowerCase()} lobster — reliable, sharp, and always working.`,
              avatarPrompt: `A Monument Valley-style lobster with a ${roleInfo.robeColor} shell, round eyes, and swaying antennae.`,
            };
          });

          setAgents(enrichedAgents);
          setActiveView("canopy");
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
      fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
    }}>
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
        input[type="range"]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #218380; cursor: pointer; border: 2px solid white; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
        ::placeholder { color: #B2BEC3; }
      `}</style>
    </div>
  );
}
