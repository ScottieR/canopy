import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { TerrariumBase } from "../../components/World/WorldScene";
import { GLBAgent, SingleGLB } from "../../components/World/GLBAgent";
import { Toggle, ServiceRow, glass, ACCESSORIES, PASTEL_COLORS, SafeBillboard , HABITATS } from "../../App";

export function IdentityTab({ agent }: { agent: AgentData }) {
  const { setAgents } = useWorldStore();
  const [accessorySearch, setAccessorySearch] = useState("");
  const [decorSearch, setDecorSearch] = useState("");
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
      a.id === agent.id ? { ...a, color: updatedVi.color || a.color, robeColor: updatedVi.color || a.robeColor, accentColor: updatedVi.color || a.accentColor, visual_identity: updatedVi } as unknown as AgentData : a
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

  const [habitats, setHabitats] = useState<any[]>([]);
  useEffect(() => {
    fetch('http://localhost:3001/api/habitats')
      .then(r => r.json())
      .then(d => setHabitats(d))
      .catch(() => { });
  }, []);

  const selectedHabitat = habitats.find(h => h.id === (stagedVisuals?.habitatId || agent.visual_identity?.habitatId || 1));
  const placement = selectedHabitat?.placement || { x: 0, y: 0, z: 0, rotationY: 0 };

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
  }, [agent.role, accessorySearch, visibleAccessories]);

  const sortedDecor = useMemo(() => {
    const copy = [...visibleAccessories];
    const seed = agent.role.charCodeAt(1) % 6; // slightly different suggestions
    const suggestions = copy.splice(seed * 25, 5);
    const combined = [...suggestions, ...copy];
    if (!decorSearch) return combined;
    return combined.filter(a => a.toLowerCase().includes(decorSearch.toLowerCase()));
  }, [agent.role, decorSearch, visibleAccessories]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, height: "100%", paddingRight: 8 }}>
      {/* 3D Dressing Room Areas */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Area 1: Base Lobster & Accessories */}
        <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", flex: 2, border: "1px solid rgba(0,0,0,0.06)", minHeight: 400 }}>
          <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 60 }}>
            <ambientLight intensity={0.8} color="#F5E6D8" />
            <directionalLight position={[10, 20, 5]} intensity={1} />
            <OrbitControls enablePan={false} />
            <group position={[0, -0.6, 0]}>
              <React.Suspense fallback={null}>
                <group 
                  position={[-placement.x * 10.0, (-0.1 - placement.y) * 10.0, -placement.z * 10.0]} 
                  scale={10.0} 
                  rotation={[0, Math.PI / 4 - (placement.rotationY * Math.PI / 180), 0]}
                >
                  <TerrariumBase 
                    habitatId={selectedHabitat?.id || stagedVisuals?.habitatId || agent.visual_identity?.habitatId || 1} 
                    modelUrl={selectedHabitat?.path} 
                  />
                  {(stagedVisuals?.decor || []).map((path, i) => {
                    const angle = (i / (stagedVisuals?.decor?.length || 1)) * Math.PI * 2;
                    const radius = 1.2;
                    const is3D = path.includes("/models/assets/");
                    
                    if (is3D) {
                      const glbPath = `http://localhost:3001${path.replace('.png', '.glb')}`;
                      return (
                        <group key={path} position={[Math.cos(angle) * radius, 0, Math.sin(angle) * radius]}>
                          <SingleGLB url={glbPath} scale={0.5} />
                        </group>
                      );
                    }

                    return (
                      <SafeBillboard
                        key={path}
                        url={`http://localhost:3001${path}`}
                        position={[Math.cos(angle) * radius, 0.5, Math.sin(angle) * radius]}
                      />
                    );
                  })}
                </group>
              </React.Suspense>
              <GLBAgent
                fileUrl={stagedVisuals?.baseModelUrl || (["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].includes(agent.role) ? `/models/lobsters/${agent.role}.glb` : undefined)}
                accessories={stagedVisuals?.accessories || []}
                agentStatus={agent.status}
                scale={1.0}
                robeColor={stagedVisuals?.color || agent.color}
                forceAnimation="none"
              />
              {/* Fallback Accessory Stickers for Preview */}
              <React.Suspense fallback={null}>
                {(stagedVisuals?.accessories || []).map((path, i) => {
                  if (path.includes("/models/assets/")) return null; // Handled by GLBAgent 3D renderer
                  return (
                    <SafeBillboard
                      key={path}
                      url={`http://localhost:3001${path}`}
                      position={[(i - ((stagedVisuals?.accessories?.length || 1) - 1) / 2) * 1.2, 2.5, 0]}
                    />
                  );
                })}
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

          {/* Selector 1: Decor Grid */}
          <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>DECOR</span>
              <input
                type="text"
                placeholder="Search..."
                value={decorSearch}
                onChange={e => setDecorSearch(e.target.value)}
                style={{ background: "rgba(0,0,0,0.05)", border: "none", borderRadius: 12, padding: "4px 8px", fontSize: 9, width: 60, outline: "none", color: "var(--text-main)" }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, overflowY: "auto", flex: 1, paddingRight: 4, paddingBottom: 16 }}>
              {sortedDecor.map(acc => {
                let isActive = stagedVisuals?.decor?.includes(acc);
                return (
                  <img key={acc} src={acc}
                    onClick={() => {
                      const current = stagedVisuals?.decor || [];
                      handleUpdateStaged({ decor: isActive ? current.filter(x => x !== acc) : [...current, acc] });
                    }}
                    style={{ width: "100%", aspectRatio: "1/1", objectFit: "contain", background: "rgba(0,0,0,0.03)", borderRadius: 8, cursor: "pointer", border: isActive ? '2px solid var(--text-main)' : '2px solid transparent', transition: "all 0.1s ease" }}
                  />
                )
              })}
            </div>
          </div>

          {/* Selector 2: Accessories Grid */}
          <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>ACCESSORIES</span>
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
              {HABITATS.map((h: any) => (
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