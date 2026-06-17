import React, { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera, Billboard, Image, Environment } from "@react-three/drei";
import * as THREE from "three";
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
import { WorldScene, TerrariumBase } from "./components/World/WorldScene";
import { KeeperPanel } from "./components/Keeper/KeeperPanel";
import { GLBAgent, Pedestal, SingleGLB } from "./components/World/GLBAgent";
import { GenerativeStudio, GenerativeResult } from "./components/GenerativeStudio";
import { ProvidersVault } from "./components/ProvidersVault";
import { IntegrationsView } from "./components/IntegrationsView";
import { WebVault } from "./components/WebVault";
import { UpdateManager } from "./components/shared/UpdateManager";
import { PasswordInput } from "./components/shared/PasswordInput";
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from "rehype-sanitize";
import { Edit2, Calendar, HardDrive, Github, MessageCircle, Link, Cloud, Database, Globe, Play, Pause, Square, Plus, Settings, ChevronRight, ChevronDown, ChevronUp, Activity, Terminal, Shield, RefreshCw, Layers, Lock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Agent, AgentData, Permission, ChatMessage, DiscoveredAgent, WorldState, ZONES, DEFAULT_PERMISSIONS, AGENT_TYPE_INFO, getDefaultPersonality, injectPrincipalContext, useWorldStore, pickNextAction, UserProfile } from "./store/worldStore";
import { LoadingScreen } from "./components/LoadingScreen";
import { OnboardingWizard } from "./pages/OnboardingWizard";
import { LockScreen } from "./components/LockScreen";
import { useIdleTimer } from "./utils/useIdleTimer";

import { ArchitectView } from './pages/ArchitectView';
import { ArchiveView } from './pages/ArchiveView';
import { UserProfileView } from './pages/UserProfileView';
import { DiagnosticsView } from './pages/DiagnosticsView';
import { CanopyView } from './pages/CanopyView';
import { ForumView } from './pages/ForumView';
import { TopNav } from './components/shared/TopNav';
import { ExportInterceptModal } from './components/ExportInterceptModal';
import { deriveMobileInboxEffects } from "./utils/mobileInbox";
import { AgentRequestNotifier } from './components/shared/AgentRequestNotifier';
import { getAssetUrl } from './utils/assets';
import { LobsterIcon } from './components/World/LobsterIcon';
import { initializeGlobalBackgroundOrchestrator } from './pages/ForumView/forumOrchestrator';
import { useForumStore } from './store/forumStore';
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

export class SafeBillboard extends React.Component<{ url: string, position: [number, number, number] }, { hasError: boolean }> {
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
  const headColor = useMemo(() => { const c = new THREE.Color(agent.robeColor); c.lerp(new THREE.Color("#F5E6D8"), 0.6); return c.getStyle(); }, [agent.robeColor]);

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
    <IsoBlock position={[3, 2.6, -4]} size={[1.8, 0.05, 1.8]} lit="#718096" shadow="#4A5568" top="#A0AEC0" />

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

export function CanopyScene({ 
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
  
  const setAgents = useWorldStore(s => s.setAgents);
  const updateAgentAction = useWorldStore(s => s.updateAgentAction);
  // CRITICAL: use the proper Tauri v2 invoke. The earlier `(window as any).__TAURI__.invoke`
  // shadowed `tauriInvoke` with `undefined` (the v1 global doesn't exist in v2), falling back
  // to `() => Promise.resolve()`. Every sync_mobile_state call became a silent no-op — which
  // is why mobile saw empty forums even after the projects → forums rename was done correctly.
  const invoke = tauriInvoke;

  // Subscribe to forumStore so we re-sync when forums change
  const forums = useForumStore(s => s.forums);

  useEffect(() => {
    // 1. Keep the Rust dispatch bridge synced with forum + inbox state.
    const worldState = useWorldStore.getState();
    const forumState = useForumStore.getState();

    // Map agents to mobile shape, including the individual chat session ID
    const mobileAgents = worldState.agents.map((a: any) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      color: a.color,
      image_url: a.image ?? null,
      // The individual chat session — mobile must use this so it never touches a forum session
      conversation_id: a.activeConversationId ?? null,
    }));

    // Map forumStore forums into the mobile Forum shape
    const mobileForms = forumState.forums
      .filter(f => f.status !== "archived")
      .map(f => {
        const completedMilestones = (f.milestones || []).filter(m => m.status === "done").length;
        const activeMilestone = (f.milestones || []).find(m => m.status === "active")?.label;
        return {
          id: f.id,
          title: f.title,
          brief: f.brief,
          status: f.status,
          agents: (f.agents || []).map(a => ({
            agentId: a.agentId,
            name: a.name,
            robeColor: a.robeColor,
            image: a.image ?? null,
          })),
          currentPhase: activeMilestone ?? null,
          completedMilestones,
          totalMilestones: (f.milestones || []).length,
          artifactCount: (f.artifacts || []).length,
          hasDeliverable: (f.artifacts || []).some(a => a.isDeliverable),
          lastActiveAt: f.lastActiveAt ?? f.createdAt ?? Date.now(),
        };
      });

    invoke("sync_mobile_state", {
      payload: {
        forums: mobileForms,
        projects: mobileForms, // backwards compat alias
        agents: mobileAgents,  // includes conversation_id for session isolation
        inbox: worldState.inbox ?? [],
      }
    }).catch((e: any) => console.warn("Failed to sync mobile state:", e));
  }, [agents, forums, useWorldStore.getState().inbox]);

  useEffect(() => {
    // 2. Listen for mobile commands (e.g. Quick Capture)
    let unlistenFn: (() => void) | undefined;
    let unlistenResolvedFn: (() => void) | undefined;
    async function setupMobileListener() {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ command: string }>("mobile_system_command", (event) => {
        if (!event.payload || !event.payload.command) return;
        
        const cmd = event.payload.command;
        if (cmd.startsWith("COMMAND: CAPTURE_NOTE:")) {
          const text = cmd.replace("COMMAND: CAPTURE_NOTE:", "").trim();
          useWorldStore.getState().addInboxItem({
            type: "voice_note",
            content: text,
            suggestion: "Route to Triage Agent or default Project space."
          });
        } else if (cmd === "COMMAND: CREATE_PROJECT_SPACE_AUTO") {
          // Find an orchestrator or default agent to create it under
          const firstAgent = useWorldStore.getState().agents[0];
          if (firstAgent) {
            useWorldStore.getState().createForumSpace(firstAgent.id);
            useWorldStore.getState().setActiveView("canopy");
          }
        } else if (cmd.startsWith("COMMAND: DISMISS_INBOX_ITEM:")) {
          const id = cmd.replace("COMMAND: DISMISS_INBOX_ITEM:", "").trim();
          useWorldStore.getState().removeInboxItem(id);
        } else if (cmd.startsWith("COMMAND: APPROVE_INBOX_ITEM:")) {
          const id = cmd.replace("COMMAND: APPROVE_INBOX_ITEM:", "").trim();
          const item = useWorldStore.getState().inbox.find(i => i.id === id);
          if (item) {
            useWorldStore.getState().removeInboxItem(id);
            // In a real flow, we would route this to the suggested agent or project here!
            // For now, we'll auto-create a project space if it's a voice note, or grant permission.
            if (item.type === "voice_note") {
              const firstAgent = useWorldStore.getState().agents[0];
              if (firstAgent) {
                useWorldStore.getState().createForumSpace(firstAgent.id);
              }
            }
          }
        }
      });
      unlistenFn = unlisten;

      const unlistenResolved = await listen<{ id?: string; resolution?: "approved" | "dismissed" }>(
        "mobile_inbox_resolved",
        (event) => {
          const id = event.payload?.id?.trim();
          const resolution = event.payload?.resolution === "approved" ? "approved" : "dismissed";
          if (!id) return;

          const state = useWorldStore.getState();
          const item = state.inbox.find((entry) => entry.id === id);
          if (!item) return;

          const effects = deriveMobileInboxEffects({
            item,
            resolution,
            fallbackAgentId: state.agents[0]?.id ?? null,
          });

          state.removeInboxItem(effects.removeId);
          if (effects.createForumForAgentId) {
            state.createForumSpace(effects.createForumForAgentId);
          }
          if (effects.navigateToCanopy) {
            state.setActiveView("canopy");
          }
        }
      );
      unlistenResolvedFn = unlistenResolved;
    }
    setupMobileListener();
    return () => {
      if (unlistenFn) unlistenFn();
      if (unlistenResolvedFn) unlistenResolvedFn();
    };
  }, []);

  const handleAgentClick = (id: string) => {
    if (isEditMode) {
      if (setSelectedEditAgent) setSelectedEditAgent(id);
    } else {
      setSelected(id);
      setActiveView("architect");
    }
  };

  return (<>
    <Environment preset="city" />
    <ambientLight intensity={0.5} />
    <directionalLight position={[5, 5, 5]} intensity={1} castShadow />

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

export const glass = (opacity = 0.55): React.CSSProperties => {
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

export function Toggle({ enabled, onChange, size = "normal" }: { enabled: boolean; onChange: () => void; size?: "normal" | "small" }) {
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

export function ProgressBar({ value, max = 1, color = "#3c6663", height = 4 }: { value: number; max?: number; color?: string; height?: number }) {
  return (
    <div style={{ height, borderRadius: height / 2, background: "var(--border-subtle)", width: "100%" }}>
      <div style={{ height: "100%", borderRadius: height / 2, background: color, width: `${(value / max) * 100}%`, transition: "width 0.5s ease" }} />
    </div>
  );
}

// ─── Connections Tab ─────────────────────────────────────────────────────────
// Per-agent: toggles + channel/contact pickers only. No OAuth here.
// All gateway-level service setup lives in the top-level Integrations tab.

export const ServiceRow = ({
  icon, name, subtitle, connected, gatewayLabel, enabled, onToggle, children, statusBadge, onSetup, initialOpen = false
}: {
  icon: React.ReactNode; name: string; subtitle: string;
  connected: boolean; gatewayLabel?: string;
  enabled?: boolean; onToggle?: (v: boolean) => void;
  children?: React.ReactNode;
  statusBadge?: React.ReactNode;
  onSetup?: () => void;
  initialOpen?: boolean;
}) => {
  const [open, setOpen] = useState(initialOpen);
  const setActiveView = useWorldStore(s => s.setActiveView);
  
  React.useEffect(() => {
    if (initialOpen) setOpen(true);
  }, [initialOpen]);
  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, overflow: "hidden", background: "var(--surface-card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{name}</span>
            {statusBadge ? statusBadge : (
              connected
                ? <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Connected{gatewayLabel ? ` · ${gatewayLabel}` : ""}</span>
                : <span style={{ fontSize: 10, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Not set up</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 2 }}>{subtitle}</div>
        </div>
        {!connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {children && (
              <button onClick={() => setOpen(v => !v)} style={{
                fontSize: 11, fontWeight: 600, color: "var(--text-sub)", background: "none",
                border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "5px 10px",
                cursor: "pointer", fontFamily: "inherit",
              }}>
                {open ? "Close" : "Options"}
              </button>
            )}
            <button onClick={() => {
              if (onSetup) onSetup();
              else if (children) setOpen(true);
              else setActiveView("integrations");
            }} style={{
              padding: "5px 12px", border: "1px solid var(--border-subtle)", borderRadius: 6,
              background: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
              color: "#3c6663", fontFamily: "inherit",
            }}>
              Set up →
            </button>
          </div>
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
      {((connected && open) || (!connected && children && open)) && (
        <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "14px 16px" }}>
          {children}
        </div>
      )}
    </div>
  );
};

// ── Multi-select picker
export const MultiPicker = ({
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
        {searchValue.trim().length > 0 && !items.find(i => i[labelKey]?.toLowerCase() === searchValue.trim().toLowerCase()) && (
          <button
            onClick={() => {
              if (!selected.includes(searchValue.trim())) {
                onToggle(searchValue.trim());
              }
              onSearch("");
            }}
            style={{
              padding: "6px 8px", background: "var(--border-subtle)", border: "none", borderRadius: 5,
              fontSize: 12, color: "var(--text-main)", cursor: "pointer", textAlign: "left", marginTop: 4
            }}
          >
            + Add "{searchValue.trim()}"
          </button>
        )}
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
// ─── Personality / Neural Path Tab ───────────────────────────────────────────

// ─── 3D Identity Tab ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// LOADING SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

// function LoadingScreen({ status }: { status?: string }) { Extracted

export function CompanionGuide({ type }: { type: string }) {
  const agentId = new URLSearchParams(window.location.search).get("agentId");
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
        { text: <span key="1">First, click here to <a href="#" onClick={(e) => { e.preventDefault(); import('@tauri-apps/plugin-shell').then(({ open }) => open("https://platform.openai.com/api-keys")).catch(console.error); }} style={{ color: "#3c6663", fontWeight: 600, textDecoration: "none" }}>open your OpenAI developer account</a> securely in your browser.</span> },
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
        { text: <span key="1">First, click here to <a href="#" onClick={(e) => { e.preventDefault(); import('@tauri-apps/plugin-shell').then(({ open }) => open("https://console.x.ai/")).catch(console.error); }} style={{ color: "#3c6663", fontWeight: 600, textDecoration: "none" }}>open the xAI Developer Console</a> securely in your browser.</span> },
        { text: "Click to generate a new API Key and name it something memorable like 'Canopy'." },
        { text: "Perfect! Now securely copy that key, paste it below, and hit Save.", input: { key: "XAI_API_KEY", placeholder: "xai-..." } }
      ]
    },
    anthropic: {
      title: "Anthropic Setup",
      avatar: "/app-icon.png",
      intro: "Hi! I'm Canopy's setup assistant. I'll walk you through creating an Anthropic API Key so your agent can think. Let's get started!",
      steps: [
        { text: <span key="1">First, click here to <a href="#" onClick={(e) => { e.preventDefault(); import('@tauri-apps/plugin-shell').then(({ open }) => open("https://console.anthropic.com/settings/keys")).catch(console.error); }} style={{ color: "#3c6663", fontWeight: 600, textDecoration: "none" }}>open the Anthropic Console</a> securely in your browser.</span> },
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
        { text: <span key="1">First, click here to <a href="#" onClick={(e) => { e.preventDefault(); import('@tauri-apps/plugin-shell').then(({ open }) => open("https://aistudio.google.com/app/apikey")).catch(console.error); }} style={{ color: "#3c6663", fontWeight: 600, textDecoration: "none" }}>open Google AI Studio</a> securely in your browser.</span> },
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
    },
    github: {
      title: "GitHub Setup",
      avatar: "/app-icon.png",
      intro: "Let's give your agent access to GitHub so it can read repositories, create PRs, and review code.",
      steps: [
        { text: "First, click this link to open the GitHub Token settings page: https://github.com/settings/tokens/new" },
        { text: "Name the token 'Canopy Agent'." },
        { text: "Check the following scopes: 'repo', 'read:org', and 'user'." },
        { text: "Click 'Generate token' at the bottom of the page." },
        { text: "Copy the generated token (starts with ghp_ or github_pat_) and paste it into the input field in the main app window." }
      ]
    },
    apple_health: {
      title: "Apple Health Setup",
      avatar: "/app-icon.png",
      intro: "Let's give your agent access to your Apple Health data so it can read and analyze your workouts and vitals.",
      steps: [
        { text: "Since Apple Health data stays exclusively on your iPhone, you'll need the Canopy Mobile App to create a secure, ongoing background bridge." },
        { text: "Open the Canopy Mobile App on your iPhone and go to the Sensors tab." },
        { text: "Select this agent, toggle 'Apple Health Sync' on, and tap 'Generate Bridge Token'." },
        { text: "Paste that secure token below to link the background sync.", input: { key: "APPLE_HEALTH_TOKEN", placeholder: "ah_..." } }
      ]
    },
    live_location: {
      title: "Live Location Setup",
      avatar: "/app-icon.png",
      intro: "Allow your agent to see when you leave or arrive at saved locations.",
      steps: [
        { text: "Location tracking is handled securely via the Canopy Mobile App." },
        { text: "Open the Canopy Mobile App on your iPhone and go to the Sensors tab." },
        { text: "Select this agent, toggle 'Live Location' on, and tap 'Generate Bridge Token'." },
        { text: "Paste that secure token below to link the background sync.", input: { key: "LIVE_LOCATION_TOKEN", placeholder: "ll_..." } }
      ]
    },
    shortcuts: {
      title: "Apple Shortcuts Setup",
      avatar: "/app-icon.png",
      intro: "Let your agent trigger Siri Intents and run Apple Shortcuts on your phone.",
      steps: [
        { text: "Shortcuts are triggered securely via the Canopy Mobile App." },
        { text: "Open the Canopy Mobile App on your iPhone and go to the Sensors tab." },
        { text: "Select this agent, toggle 'Apple Shortcuts' on, and tap 'Generate Bridge Token'." },
        { text: "Paste that secure token below to link the connection.", input: { key: "SHORTCUTS_TOKEN", placeholder: "sh_..." } }
      ]
    },
    vision: {
      title: "Vision & Photo Sync Setup",
      avatar: "/app-icon.png",
      intro: "Allow your agent to securely index your recent photos to understand your visual context.",
      steps: [
        { text: "Photo indexing is handled securely via the Canopy Mobile App." },
        { text: "Open the Canopy Mobile App on your iPhone and go to the Sensors tab." },
        { text: "Select this agent, toggle 'Vision & Photo Sync' on, and tap 'Generate Bridge Token'." },
        { text: "Paste that secure token below to link the background sync.", input: { key: "VISION_TOKEN", placeholder: "vs_..." } }
      ]
    },
    notifications: {
      title: "Actionable Push Notifications",
      avatar: "/app-icon.png",
      intro: "Allow your agent to send you interactive push notifications for fast approvals.",
      steps: [
        { text: "Push notifications are routed securely via the Canopy Mobile App." },
        { text: "Open the Canopy Mobile App on your iPhone and go to the Sensors tab." },
        { text: "Select this agent, toggle 'Actionable Notifications' on, and tap 'Generate Bridge Token'." },
        { text: "Paste that secure token below to link the connection.", input: { key: "NOTIFICATIONS_TOKEN", placeholder: "pn_..." } }
      ]
    },
    homekit: {
      title: "Smart Home / HomeKit",
      avatar: "/app-icon.png",
      intro: "Allow your agent to securely control lights and smart home devices via your iPhone.",
      steps: [
        { text: "HomeKit access requires the Canopy Mobile App acting as a local bridge." },
        { text: "Open the Canopy Mobile App on your iPhone and go to the Sensors tab." },
        { text: "Select this agent, toggle 'Smart Home / HomeKit' on, and tap 'Generate Bridge Token'." },
        { text: "Paste that secure token below to link the connection.", input: { key: "HOMEKIT_TOKEN", placeholder: "hk_..." } }
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
        const secureKey = (agentId && (type === 'slack' || type === 'gmail' || type === 'calendar' || type === 'drive' || type === 'apple_health' || type === 'live_location' || type === 'shortcuts' || type === 'vision' || type === 'notifications' || type === 'homekit'))
          ? `agent_${agentId}_${currentStepData.input.key.replace(/-/g, '_')}`
          : currentStepData.input.key;
        await invoke("store_secret_cmd", { key: secureKey, value: tokens[currentStepData.input.key].trim() });

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

            // If it was Slack, finalize the connection by syncing all per-agent
            // gateway channels to openclaw.json. This respects the Zero-Trust mandate.
            if (type === "slack") {
              await emit('slack-credentials-saved');
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke("sync_gateway_channels").catch(() => { });
            }

            // If it was GitHub, finalize the connection by installing the CLI
            // and securely writing the token wrapper to the agent's bin directory.
            if (type === "github" && agentId) {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke("configure_github", { agentId: agentId, personalAccessToken: tokens[currentStepData.input.key].trim() }).catch(() => { });
            }
          } catch (evtErr) { }

          setTimeout(async () => {
            try {
              const { getCurrentWindow, getAllWindows } = await import('@tauri-apps/api/window');
              const mainWindow = (await getAllWindows()).find(w => w.label === 'main');
              if (mainWindow) await mainWindow.setFocus();
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
          <img src={getAssetUrl(config.avatar)} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
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
// AGENT WARMUP GATE
// ═══════════════════════════════════════════════════════════════════════════════
// Slim non-blocking banner shown while agents are still initializing.
// Sits below the TopNav and auto-polls every 15s. Disappears when gatewayReady
// becomes true — no full overlay, user can still browse the rest of the app.
// ═══════════════════════════════════════════════════════════════════════════════

function GatewayWarmupBanner() {
  const setGatewayReady = useWorldStore(s => s.setGatewayReady);
  const agents = useWorldStore(s => s.agents);
  const [checking, setChecking] = useState(false);
  const [failedCheck, setFailedCheck] = useState(false);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setFailedCheck(false);
    for (const agent of agents) {
      try {
        const status = await invoke<string>("check_agent_status", { agentId: agent.id });
        if (status === "active") {
          setGatewayReady(true);
          setChecking(false);
          return;
        }
      } catch { }
    }
    setChecking(false);
    setFailedCheck(true);
  };

  // Auto-poll every 15s so the banner disappears on its own without user action
  useEffect(() => {
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, [agents]);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "0 16px", height: 36,
      background: failedCheck ? "rgba(245,158,11,0.1)" : "rgba(74,158,150,0.08)",
      borderBottom: failedCheck ? "1px solid rgba(245,158,11,0.2)" : "1px solid rgba(74,158,150,0.15)",
      flexShrink: 0,
    }}>
      {/* Animated pulse dot */}
      <div style={{
        width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
        background: failedCheck ? "#F59E0B" : "#4A9E96",
        animation: checking ? "none" : "pulse 1.5s ease-in-out infinite",
        opacity: checking ? 0.4 : 1,
      }} />
      <span style={{ fontSize: 12, color: failedCheck ? "#B45309" : "var(--text-sub)", flex: 1 }}>
        {failedCheck
          ? "Agents still offline — check OrbStack is running"
          : "Agents are waking up, this usually takes 30–60 seconds…"}
      </span>
      <button
        onClick={check}
        disabled={checking}
        style={{
          fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 6,
          background: "transparent",
          color: failedCheck ? "#B45309" : "#4A9E96",
          border: `1px solid ${failedCheck ? "rgba(245,158,11,0.4)" : "rgba(74,158,150,0.3)"}`,
          cursor: checking ? "default" : "pointer", opacity: checking ? 0.5 : 1,
          fontFamily: "inherit", transition: "opacity 0.15s",
        }}
      >
        {checking ? "Checking…" : "Check now"}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const { activeView, selectedAgent, agents, setSelectedAgent, setActiveView, setAgents, theme, isAutoCloakEnabled, autoCloakTimeout, setIsCloaked, gatewayReady } = useWorldStore();
  
  useEffect(() => {
    initializeGlobalBackgroundOrchestrator();
  }, []);

  const agent = agents.find(a => a.id === selectedAgent) || agents[0];
  const [initialized, setInitialized] = useState(false);
  const [loadStatus, setLoadStatus] = useState("Waking up the lobsters...");
  const [pendingJitAuth, setPendingJitAuth] = useState<any>(null);
  const [jitDuration, setJitDuration] = useState("session");

  // Auto-cloak implementation
  useIdleTimer(
    autoCloakTimeout,
    () => {
      if (isAutoCloakEnabled) setIsCloaked(true);
    },
    isAutoCloakEnabled
  );

  useEffect(() => {
    let unlisten: any;
    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<any>('jit_auth_requested', (event) => {
        setPendingJitAuth(event.payload);
      });
    };
    setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Health monitor: react to gateway going offline/degraded mid-session.
  // The health_monitor daemon fires this event every 60s. If the gateway
  // goes down while the user is active, we reset gatewayReady so the UI
  // shows the reconnect prompt rather than silently failing on the next message.
  useEffect(() => {
    let unlisten: any;
    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ status: string }>('gateway-health', (event) => {
        const { status } = event.payload;
        if (status === "offline" || status === "degraded") {
          // Only reset if we thought we were ready — avoids fighting with boot polling.
          if (useWorldStore.getState().gatewayReady) {
            console.warn("[gateway-health] Gateway went", status, "— resetting ready state");
            useWorldStore.getState().setGatewayReady(false);
          }
        } else if (status === "active") {
          if (!useWorldStore.getState().gatewayReady) {
            console.info("[gateway-health] Gateway back online — marking ready");
            useWorldStore.getState().setGatewayReady(true);
          }
        }
      });
    };
    setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Sync hash to activeView on load and hashchange
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#/', '').replace('#', '');
      const validViews = ["loading", "onboarding", "canopy", "architect", "archive", "library", "vault", "forum"];
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
          const settingsRes = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/settings`);
          const settings = await settingsRes.json();
          if (settings.preferencesTemplate) {
            await invoke("set_preferences_template", { content: settings.preferencesTemplate });
          }
        } catch (e) {
          console.warn("Could not fetch preferences template from admin API:", e);
        }

        const loadedAgents = await invoke("list_agents") as Agent[];

        // Sync real stats to admin dashboard periodically
        const reportUsage = async () => {
          for (const a of loadedAgents) {
            try {
              await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/usage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  agentId: a.id,
                  role: a.role,
                  tokensIn: a.stats?.total_tokens_in || 0,
                  tokensOut: a.stats?.total_tokens_out || 0,
                  messagesHandled: a.stats?.messages_handled || 0,
                  tasksToday: a.stats?.tasks_today || 0
                })
              });
            } catch (e) {}
          }
        };
        reportUsage();
        setInterval(reportUsage, 60000);

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

          // Listen for progress events emitted by the Rust side (gateway + agents).
          const { listen } = await import('@tauri-apps/api/event');
          const unlisten = await listen<string>('boot-sync-progress', (event) => {
            setLoadStatus(event.payload);
          });

          setLoadStatus("Starting infrastructure gateway...");
          await safeStartGateway().catch((e) => console.error("Gateway boot failed during loadAgents:", e));

          setLoadStatus("Registering agents with gateway...");
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
          // Fetch weekly token usage records to calculate compute
          const weeklyRecords = await invoke<any[]>("get_token_usage_history", {
            agentId: null,
            conversationId: null,
            days: 7
          }).catch(err => {
            console.error("Failed to load weekly token usage history:", err);
            return [];
          });

          // Enrich agents with UI data
          const enrichedAgents = loadedAgents.map(agent => {
            const roleInfo = AGENT_TYPE_INFO[agent.role] || AGENT_TYPE_INFO["Assistant"];
            const vi = agent.visual_identity || {};
            const dbPaused = (agent as any).paused === true || (agent as any).paused === 1;
            
            const totalTokens = (agent.stats?.total_tokens_in || 0) + (agent.stats?.total_tokens_out || 0);
            const tokensUsed = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : `${totalTokens}`;

            const agentWeeklyCost = weeklyRecords
              .filter(r => r.agent_id === agent.id)
              .reduce((sum, r) => sum + (r.cost_usd || 0), 0);
            const weeklyCompute = agentWeeklyCost.toFixed(3);

            return {
              ...agent,
              paused: dbPaused,
              visual_identity: vi,
              title: `The ${agent.role}`,
              description: roleInfo.description,
              robeColor: (vi as any).robeColor || (vi as any).color || roleInfo.robeColor,
              accentColor: (vi as any).accentColor || (vi as any).color || roleInfo.accentColor,
              color: (vi as any).color || roleInfo.color,
              position: [Math.random() * 4 - 2, 0, Math.random() * 4 - 2] as [number, number, number],
              targetPosition: [Math.random() * 4 - 2, 0, Math.random() * 4 - 2] as [number, number, number],
              currentAction: "idle",
              socialMotive: 0.5 + Math.random() * 0.3,
              energy: 0.6 + Math.random() * 0.3,
              uptime: `${Math.floor(agent.stats.uptime_seconds / 3600)} hrs`,
              tokensUsed,
              weeklyCompute,
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
          const currentAgents = useWorldStore.getState().agents;
          const mergedAgents = (enrichedAgents as unknown as AgentData[]).map(ea => {
             const ca = currentAgents.find(x => x.id === ea.id);
             if (ca) {
                 return { ...ea, conversations: ca.conversations || [], activeConversationId: ca.activeConversationId || null, miniApps: ca.miniApps || [] };
             }
             return ea;
          });
          setAgents(mergedAgents);

          // ── Wait for gateway readiness ──────────────────────────────────────
          // boot_sync_agents registers agents in OpenClaw's DB, but the gateway
          // spends a further 30-60s initialising channels and ACPX sidecars for
          // each agent. During that window any agent call returns "Unknown agent id".
          // We hold the loading screen here until at least one agent confirms "active"
          // (or 60 s elapses, in which case we proceed with a warning banner).
          {
            const agentIds = loadedAgents.map(a => a.id);
            const READY_TIMEOUT_MS = 60_000;
            const POLL_INTERVAL_MS = 2_500;
            const deadline = Date.now() + READY_TIMEOUT_MS;
            let agentsReady = false;

            setLoadStatus("Waiting for agents to come online…");

            while (Date.now() < deadline && !agentsReady) {
              await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
              for (const id of agentIds) {
                try {
                  const status = await invoke("check_agent_status", { agentId: id }) as string;
                  if (status === "active") { agentsReady = true; break; }
                } catch { /* non-fatal — keep polling */ }
              }
              if (!agentsReady) {
                const elapsed = Math.round((Date.now() - (deadline - READY_TIMEOUT_MS)) / 1000);
                setLoadStatus(`Agents warming up… ${elapsed}s`);
              }
            }

            if (agentsReady) {
              useWorldStore.getState().setGatewayReady(true);
              setLoadStatus("Agents ready ✓");
              // Brief pause so the "ready" state is visible before the app appears
              await new Promise<void>(r => setTimeout(r, 400));
            } else {
              // Timeout — proceed anyway so the user isn't stuck forever.
              // They'll see a warning if they try to start a project before agents warm up.
              setLoadStatus("Gateway is taking longer than usual — proceeding. Some features may not be ready yet.");
              await new Promise<void>(r => setTimeout(r, 2500));
            }
          }

          const hash = window.location.hash.replace('#/', '').replace('#', '');
          const validViews = ["loading", "onboarding", "canopy", "architect", "archive", "library", "vault", "forum"];
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
      if (currentAgents.length === 0) return;
      
      let changed = false;
      let anyActive = false;
      let ocStatus: any = null;
      
      try {
         const statusStr: any = await invoke("get_openclaw_status_json");
         ocStatus = JSON.parse(statusStr);
      } catch (e) {
         console.warn("Failed to get openclaw status:", e);
      }

      const mergedAgents = currentAgents.map(a => {
        let newStatus = a.status;
        let newAction = a.currentAction;
        
        if (!ocStatus || !ocStatus.agents || !ocStatus.agents.entries) {
            // Gateway might be restarting or unresponsive
            return a;
        }
        
        const agentEntry = ocStatus.agents.entries.find((e: any) => e.id === a.id);
        
        if (!agentEntry) {
            if (a.status !== "error") {
                newStatus = "error" as any;
                changed = true;
            }
        } else {
            anyActive = true;
            if (agentEntry.bootstrapPending) {
                newStatus = "deploying" as any;
                newAction = "installing dependencies...";
            } else if (agentEntry.lastActiveAgeMs === null) {
                newStatus = "sleeping" as any;
                newAction = "idle";
            } else if (agentEntry.lastActiveAgeMs < 60000) {
                newStatus = "thinking" as any;
                newAction = "processing task...";
            } else if (agentEntry.lastActiveAgeMs < 300000) {
                newStatus = "active" as any;
                newAction = "recently active";
            } else {
                newStatus = "sleeping" as any;
                newAction = "idle";
            }
            
            if (newStatus !== a.status) {
                changed = true;
            }
            if (newAction !== a.currentAction) {
                changed = true;
            }
        }
        
        if (newStatus !== a.status || newAction !== a.currentAction) {
          return { ...a, status: newStatus, currentAction: newAction };
        }
        return a;
      });

      if (changed) useWorldStore.getState().setAgents(mergedAgents);
      // Mark gateway as ready once at least one agent is confirmed active
      if (anyActive && !useWorldStore.getState().gatewayReady) {
        useWorldStore.getState().setGatewayReady(true);
      }
    } catch { }
  };

  useEffect(() => {
    let isPolling = false;
    const poll = async () => {
      if (isPolling) return;
      isPolling = true;
      try { await runHealthPoll(); }
      finally { isPolling = false; }
    };
    // Immediate check so status is correct from the first render, not after 15s.
    poll();
    const pollInterval = window.setInterval(poll, 15000);
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
      <LockScreen />
      <UpdateManager />
      {activeView !== "onboarding" && <TopNav />}
      {/* Non-blocking warmup banner — sits below nav, auto-dismisses when agents ready */}
      {activeView !== "onboarding" && activeView !== "loading" && !gatewayReady && <GatewayWarmupBanner />}

      {activeView === "loading" && <LoadingScreen status={loadStatus} />}
      {activeView === "onboarding" && <OnboardingWizard />}
      {activeView === "canopy" && <CanopyView />}
      {activeView === "forum" && <ForumView />}
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

      {/* The Keeper (Eddy) — persistent helper pill on every view but loading */}
      {activeView !== "loading" && <KeeperPanel />}

      {/* JIT Credential Auth Modal */}
      {pendingJitAuth && (() => {
        const isHighRisk = pendingJitAuth.credential_id.includes("_write") || ["aws", "stripe", "banking"].some(k => pendingJitAuth.credential_id.toLowerCase().includes(k));
        const accentColor = isHighRisk ? "#e63946" : "#3c6663";
        const accentBg = isHighRisk ? "rgba(230, 57, 70, 0.1)" : "rgba(60, 102, 99, 0.1)";
        
        return (
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.6)", zIndex: 999999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ background: "var(--surface)", borderRadius: 16, padding: 24, maxWidth: 450, width: "100%", boxShadow: "0 12px 32px rgba(0,0,0,0.3)", border: `1px solid ${isHighRisk ? '#e6394644' : 'var(--border)'}` }}>
              {isHighRisk && (
                <div style={{ background: "#e63946", color: "#fff", padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 16, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={14} /> High Risk Access
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: 20, background: accentBg, color: accentColor, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Shield size={20} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, color: "var(--text-main)" }}>Credential Access Required</h3>
                  <div style={{ fontSize: 13, color: "var(--text-sub)" }}>Agent: <strong>{pendingJitAuth.agent_id}</strong></div>
                </div>
              </div>
              
              <p style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.5, marginBottom: 16 }}>
                This agent is requesting access to the <strong style={{ color: accentColor }}>{pendingJitAuth.credential_id}</strong> credential. Execution is paused until you grant access.
              </p>
              
              <div style={{ background: "rgba(0,0,0,0.03)", padding: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,0.05)", marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-sub)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Agent's Justification</div>
                <div style={{ fontSize: 13, fontStyle: "italic", color: "var(--text-main)", whiteSpace: "pre-wrap" }}>"{pendingJitAuth.justification}"</div>
              </div>
              
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Access Duration</label>
                <select 
                  value={jitDuration} 
                  onChange={(e) => setJitDuration(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", color: "var(--text-main)", fontSize: 14, outline: "none", appearance: "none" }}
                >
                  <option value="one_time">Just This Once (Auto-revokes after 5 mins)</option>
                  <option value="session">This Session (Until Restart)</option>
                  <option value="permanent">Always (Save permanently to profile)</option>
                </select>
              </div>
              
              <div style={{ display: "flex", gap: 12 }}>
                <button 
                  style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface)", color: "var(--text-main)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                  onClick={async () => {
                    await invoke("approve_jit_request", { 
                      requestId: pendingJitAuth.request_id, 
                      approved: false, 
                      agentId: pendingJitAuth.agent_id, 
                      credentialId: pendingJitAuth.credential_id,
                      duration: jitDuration
                    });
                    setPendingJitAuth(null);
                  }}
                >
                  Deny
                </button>
                <button 
                  style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: accentColor, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                  onClick={async () => {
                    await invoke("approve_jit_request", { 
                      requestId: pendingJitAuth.request_id, 
                      approved: true, 
                      agentId: pendingJitAuth.agent_id, 
                      credentialId: pendingJitAuth.credential_id,
                      duration: jitDuration
                    });
                    setPendingJitAuth(null);
                  }}
                >
                  <CheckCircle2 size={16} /> Approve Access
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <ExportInterceptModal />

      {/* Global listener for agent → user signals: attention toasts and permission
          modals. Mounted once at the app root so it works regardless of which view
          is active. See `AgentRequestNotifier.tsx` for the contract. */}
      <AgentRequestNotifier agents={agents.map(a => ({ id: a.id, name: a.name }))} />

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* Lobster avatar micro-reactions — driven by LobsterIcon's reactState prop. */
        @keyframes lobster-breathe {
          0%, 100% { transform: scale(1) translateY(0); }
          50%      { transform: scale(1.025) translateY(-1px); }
        }
        @keyframes lobster-think {
          0%, 100% { transform: rotate(-1.5deg) scale(1.01); }
          50%      { transform: rotate(1.5deg) scale(1.02); }
        }
        @keyframes lobster-error {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(8deg) translateY(2px); }
        }
        @keyframes lobster-happy {
          0%   { transform: scale(1); }
          40%  { transform: scale(1.10) rotate(-3deg); }
          70%  { transform: scale(1.04) rotate(2deg); }
          100% { transform: scale(1); }
        }
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
