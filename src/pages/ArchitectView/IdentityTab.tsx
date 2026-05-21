import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as THREE from "three";
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
import { OrbitControls, TransformControls, Environment } from "@react-three/drei";
import { TerrariumBase, HabitatErrorBoundary } from "../../components/World/WorldScene";
import { GLBAgent, GLBModel } from "../../components/World/GLBAgent";
import { Toggle, ServiceRow, glass, SafeBillboard } from "../../App";
import { PASTEL_COLORS, HABITATS, ACCESSORIES } from '../../constants/assets';
import { getAssetUrl } from "../../utils/assets";

export function IdentityTab({ agent }: { agent: AgentData }) {
  const { setAgents } = useWorldStore();
  const [accessorySearch, setAccessorySearch] = useState("");
  const [decorSearch, setDecorSearch] = useState("");
  const [selectedDecor, setSelectedDecor] = useState<string | null>(null);
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
    const fetchAccessories = () => {
      fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/accessories`)
        .then(r => r.json())
        .then(d => setCatalog(d))
        .catch(() => { });
    };
    fetchAccessories();
    const interval = setInterval(fetchAccessories, 2000);
    return () => clearInterval(interval);
  }, []);

  const [habitats, setHabitats] = useState<any[]>([]);
  useEffect(() => {
    const fetchHabitats = () => {
      fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/habitats`)
        .then(r => r.json())
        .then(d => setHabitats(d))
        .catch(() => { });
    };
    fetchHabitats();
    const interval = setInterval(fetchHabitats, 2000);
    return () => clearInterval(interval);
  }, []);

  const selectedHabitat = habitats.find(h => h.id === (stagedVisuals?.habitatId || agent.visual_identity?.habitatId || 1));
  const placement = selectedHabitat?.placement || { x: 0, y: 0, z: 0, rotationY: 0 };

  const visibleAccessories = React.useMemo(() => {
    if (!catalog || !catalog.items) return ACCESSORIES;
    const allPaths = new Set([...ACCESSORIES, ...Object.keys(catalog.items)]);
    return Array.from(allPaths).filter(path => {
      if (catalog.items[path] && catalog.items[path].isVisible === false) return false;
      return true;
    });
  }, [catalog]);

  // Search across the catalog's human-readable name/description/labels in
  // addition to the raw path. Accessory paths look like
  // /accessories/accessories_set_3_item_25.png — searching the path alone
  // would never match queries like "chef" or "clipboard".
  const matchesQuery = useCallback((path: string, q: string) => {
    if (!q) return true;
    const ql = q.toLowerCase();
    if (path.toLowerCase().includes(ql)) return true;
    const meta = catalog?.items?.[path];
    if (!meta) return false;
    if (meta.name && meta.name.toLowerCase().includes(ql)) return true;
    if (meta.description && meta.description.toLowerCase().includes(ql)) return true;
    if (Array.isArray(meta.labels) && meta.labels.some((l: string) => l.toLowerCase().includes(ql))) return true;
    return false;
  }, [catalog]);

  const sortedAccessories = useMemo(() => {
    const copy = visibleAccessories.filter(p => !catalog?.items?.[p]?.type || catalog.items[p].type === 'wearable' || catalog.items[p].type === 'both');
    const seed = agent.role.charCodeAt(0) % 6;
    const suggestions = copy.splice(seed * 25, 5);
    const combined = [...suggestions, ...copy];
    if (!accessorySearch) return combined;
    return combined.filter(a => matchesQuery(a, accessorySearch));
  }, [agent.role, accessorySearch, visibleAccessories, catalog, matchesQuery]);

  const sortedDecor = useMemo(() => {
    const copy = visibleAccessories.filter(p => catalog?.items?.[p]?.type === 'decor' || catalog?.items?.[p]?.type === 'both');
    const seed = agent.role.charCodeAt(1) % 6; // slightly different suggestions
    const suggestions = copy.splice(seed * 25, 5);
    const combined = [...suggestions, ...copy];
    if (!decorSearch) return combined;
    return combined.filter(a => matchesQuery(a, decorSearch));
  }, [agent.role, decorSearch, visibleAccessories, catalog, matchesQuery]);

  const nudgeBtnStyle = {
    background: "var(--surface-elevated)", color: "var(--text-main)",
    border: "1px solid var(--border-subtle)", borderRadius: 6,
    width: 28, height: 28, padding: 0, fontSize: 13, fontWeight: 700,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
  };

  const handleDecorNudge = (axis: "x" | "y" | "z" | "ry", amount: number) => {
    if (!selectedDecor) return;
    const path = selectedDecor;
    const current = stagedVisuals?.decorTransforms || {};
    const existing = current[path] || {};
    const index = (stagedVisuals?.decor || []).indexOf(path);
    if (index === -1) return;

    let base = { x: 0, y: 0, z: 0, rotationY: 0 };
    if (existing.x !== undefined) {
      base.x = existing.x;
      base.y = existing.y;
      base.z = existing.z;
    } else {
      const decorPoints = selectedHabitat?.decorPoints || [];
      if (decorPoints.length > 0) {
        const ptIdx = pickDecorPointIndex(agent.id, index, decorPoints.length);
        base.x = decorPoints[ptIdx].x * ADMIN_TO_MAIN_DECOR_SCALE;
        base.y = decorPoints[ptIdx].y * ADMIN_TO_MAIN_DECOR_SCALE;
        base.z = decorPoints[ptIdx].z * ADMIN_TO_MAIN_DECOR_SCALE;
      } else {
        const seed = path.length + index;
        base.x = Math.sin(seed * 1.1) * 0.6;
        base.y = 0;
        base.z = Math.cos(seed * 1.3) * 0.6;
      }
    }

    if (existing.rotationY !== undefined) {
      base.rotationY = existing.rotationY;
    } else {
      const defaultDecorRotation = catalog?.items?.[path]?.decorRotation;
      const fallbackYaw = Math.sin((path.length + index * 13) * 1.7) * Math.PI;
      base.rotationY = defaultDecorRotation ? defaultDecorRotation[1] : fallbackYaw;
    }

    handleUpdateStaged({
      decorTransforms: {
        ...current,
        [path]: {
          ...existing,
          x: base.x + (axis === "x" ? amount : 0),
          y: base.y + (axis === "y" ? amount : 0),
          z: base.z + (axis === "z" ? amount : 0),
          rotationY: base.rotationY + (axis === "ry" ? amount : 0)
        }
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, height: "100%", paddingRight: 8 }}>
      {/* 3D Dressing Room Areas */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Area 1: Base Lobster & Accessories */}
        <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", flex: 2, border: "1px solid rgba(0,0,0,0.06)", minHeight: 400 }}>
          <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 600 }}>
            <Environment preset="city" />
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 5, 5]} intensity={1} castShadow />
            <OrbitControls enablePan={false} />
            <group position={[0, -0.06, 0]}>
              <React.Suspense fallback={null}>
                <group
                  position={[-placement.x, -0.01 - placement.y, -placement.z]}
                  scale={1.0}
                  rotation={[0, Math.PI / 4 - (placement.rotationY * Math.PI / 180), 0]}
                >
                  <HabitatErrorBoundary fallback={<mesh><boxGeometry args={[1, 1, 1]}/><meshBasicMaterial color="red" wireframe/></mesh>}>
                    <TerrariumBase
                      habitatId={selectedHabitat?.id || stagedVisuals?.habitatId || agent.visual_identity?.habitatId || 1}
                      modelUrl={selectedHabitat?.path}
                    />
                  </HabitatErrorBoundary>
                  {(stagedVisuals?.decor || []).map((path, i) => {
                    const glbPath = path.replace('.png', '.glb');
                    return (
                      <DecorObject
                        key={path}
                        agentId={agent.id}
                        path={path}
                        glbPath={glbPath}
                        isSelected={selectedDecor === path}
                        onSelect={() => setSelectedDecor(path)}
                        transform={stagedVisuals?.decorTransforms?.[path]}
                        decorPoints={selectedHabitat?.decorPoints || []}
                        index={i}
                        defaultDecorRotation={catalog?.items?.[path]?.decorRotation}
                        defaultScale={catalog?.items?.[path]?.scale}
                        onTransformChange={(updates: any) => {
                          const current = stagedVisuals?.decorTransforms || {};
                          handleUpdateStaged({ decorTransforms: { ...current, [path]: { ...current[path], ...updates } } });
                        }}
                      />
                    );
                  })}
                </group>
              </React.Suspense>
              <group position={[0, 0, 0]}>
                <GLBAgent
                  fileUrl={stagedVisuals?.baseModelUrl || (["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].includes(agent.role) ? `/models/lobsters/${agent.role}.glb` : undefined)}
                  accessories={stagedVisuals?.accessories || []}
                  agentStatus={agent.status}
                  scale={0.25}
                  robeColor={stagedVisuals?.color || agent.color}
                  forceAnimation="Breathe"
                />
              </group>
              {/* Fallback Accessory Stickers for Preview — only for paths that
                  don't have a 3D model bound to a bone via GLBAgent. Anything
                  under /accessories/ or /models/assets/ has a baked GLB and is
                  rendered through AttachedAccessory, so showing a 2D sticker
                  here would just float a duplicate above the lobster. */}
              <React.Suspense fallback={null}>
                {(stagedVisuals?.accessories || []).map((path, i) => {
                  if (path.includes("/models/assets/") || path.includes("/accessories/")) return null;
                  return (
                    <SafeBillboard
                      key={path}
                      url={`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}${path}`}
                      position={[(i - ((stagedVisuals?.accessories?.length || 1) - 1) / 2) * 0.3, 0.6, 0]}
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

          {/* Nudge Controls */}
          {selectedDecor && (
            <div style={{
              position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
              zIndex: 20, display: "flex", gap: 16, alignItems: "center",
              background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 16, padding: "8px 16px",
              boxShadow: "0 12px 48px rgba(0,0,0,0.15)"
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-main)", marginRight: 4 }}>
                Move Decor
              </div>

              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <button onClick={() => handleDecorNudge("z", -0.1)} style={nudgeBtnStyle}>↑</button>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => handleDecorNudge("x", -0.1)} style={nudgeBtnStyle}>←</button>
                  <button onClick={() => handleDecorNudge("z", 0.1)} style={nudgeBtnStyle}>↓</button>
                  <button onClick={() => handleDecorNudge("x", 0.1)} style={nudgeBtnStyle}>→</button>
                </div>
              </div>

              <div style={{ width: 1, height: 32, background: "var(--border-subtle)" }} />

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button onClick={() => handleDecorNudge("y", 0.1)} style={{ ...nudgeBtnStyle, width: 48, fontSize: 11 }}>+Y Up</button>
                <button onClick={() => handleDecorNudge("y", -0.1)} style={{ ...nudgeBtnStyle, width: 48, fontSize: 11 }}>-Y Dn</button>
              </div>

              <div style={{ width: 1, height: 32, background: "var(--border-subtle)" }} />

              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => handleDecorNudge("ry", Math.PI / 16)} style={{ ...nudgeBtnStyle, width: 36, fontSize: 16 }}>⟳</button>
                <button onClick={() => handleDecorNudge("ry", -Math.PI / 16)} style={{ ...nudgeBtnStyle, width: 36, fontSize: 16 }}>⟲</button>
              </div>

              <div style={{ width: 1, height: 32, background: "var(--border-subtle)" }} />

              <button
                onClick={() => setSelectedDecor(null)}
                style={{ background: "transparent", color: "var(--text-sub)", border: "none", padding: "4px", cursor: "pointer", display: "flex", alignItems: "center" }}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>

        {/* Lower row: Interactive Selectors */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, height: 260 }}>
          
          {/* Selector 0: Color (Shell tint) */}
          <div style={{ background: "var(--glass-light)", borderRadius: 24, overflow: "hidden", position: "relative", border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-sub)", marginBottom: 12 }}>COLOR</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, overflowY: "auto", flex: 1, paddingRight: 4, paddingBottom: 16 }}>
              {PASTEL_COLORS.map(color => (
                <div key={color}
                  onClick={() => handleUpdateStaged({ color: color })}
                  style={{
                    backgroundColor: color,
                    width: "100%", aspectRatio: "1/1",
                    borderRadius: 8, cursor: "pointer",
                    border: stagedVisuals?.color === color ? '2px solid var(--text-main)' : '2px solid rgba(0,0,0,0.1)',
                    transition: "all 0.1s ease"
                  }}
                />
              ))}
            </div>
          </div>

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
                  <div key={acc} style={{ position: "relative" }}>
                    <img src={getAssetUrl(acc)}
                      onClick={() => {
                        const current = stagedVisuals?.decor || [];
                        if (isActive) {
                          handleUpdateStaged({ decor: current.filter(x => x !== acc) });
                          if (selectedDecor === acc) setSelectedDecor(null);
                        } else {
                          handleUpdateStaged({ decor: [...current, acc] });
                          setSelectedDecor(acc);
                        }
                      }}
                      style={{ width: "100%", aspectRatio: "1/1", objectFit: "contain", background: "rgba(0,0,0,0.03)", borderRadius: 8, cursor: "pointer", border: isActive ? '2px solid var(--text-main)' : '2px solid transparent', transition: "all 0.1s ease" }}
                    />
                    {isActive && (
                      <button
                        onClick={() => setSelectedDecor(acc)}
                        style={{ position: "absolute", top: 4, right: 4, background: selectedDecor === acc ? "var(--primary)" : "rgba(0,0,0,0.5)", color: "white", border: "none", borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                      >
                        <Settings size={12} />
                      </button>
                    )}
                  </div>
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
                  <img key={acc} src={getAssetUrl(acc)}
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
              {habitats.map((h: any) => (
                <div key={h.id}
                  onClick={() => {
                    // Switching habitats: strip the position fields (x/y/z) from
                    // each saved decorTransform so the runtime auto-snaps every
                    // decor item to a valid decor point on the NEW habitat.
                    // Preserve rotation and scale — those are per-item user
                    // customizations that aren't habitat-specific. Without
                    // this, AgentNeighborhood would keep using stale x/y/z that
                    // belonged to the previous habitat and items would float
                    // off-surface.
                    const currentHabitatId = stagedVisuals?.habitatId ?? agent.visual_identity?.habitatId;
                    if (h.id !== currentHabitatId) {
                      setSelectedDecor(null);
                      const existingTransforms = stagedVisuals?.decorTransforms || {};
                      const repositionedTransforms: Record<string, any> = {};
                      for (const [path, t] of Object.entries(existingTransforms)) {
                        const { x, y, z, ...rest } = (t || {}) as any;
                        if (Object.keys(rest).length > 0) {
                          repositionedTransforms[path] = rest;
                        }
                      }
                      handleUpdateStaged({ habitatId: h.id, decorTransforms: repositionedTransforms });
                    } else {
                      handleUpdateStaged({ habitatId: h.id });
                    }
                  }}
                  style={{ background: "rgba(0,0,0,0.03)", borderRadius: 12, height: 100, overflow: "hidden", position: "relative", cursor: "pointer", border: stagedVisuals?.habitatId === h.id ? "2px solid #218380" : "2px solid rgba(0,0,0,0)", transition: "all 0.1s ease" }}>
                  {h.imageUrl ? (
                    <img src={getAssetUrl(h.imageUrl)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt={h.name || "Habitat"} />
                  ) : (
                    <Canvas orthographic camera={{ position: [5, 5, 5], zoom: 16 }} style={{ pointerEvents: "none" }}>
                      <ambientLight intensity={1} />
                      <directionalLight position={[10, 20, 5]} intensity={1} />
                      <group position={[0, -0.6, 0]} rotation={[0, Math.PI / 4, 0]}>
                        <HabitatErrorBoundary fallback={<mesh><boxGeometry args={[1, 1, 1]}/><meshBasicMaterial color="red" wireframe/></mesh>}>
                          <React.Suspense fallback={null}>
                            <TerrariumBase habitatId={h.id} />
                          </React.Suspense>
                        </HabitatErrorBoundary>
                      </group>
                    </Canvas>
                  )}
                  {h.name && <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(0,0,0,0.4)", color: "white", fontSize: 9, padding: "2px 4px", fontWeight: "bold", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{h.name}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Admin's HabitatPlacementScene scales the habitat clone by `(2.2 / maxDim) * 2`
// (twice the size of the main app's TerrariumBase, which uses `2.2 / maxDim`),
// for ergonomic painting. DecorPoints are saved in that 2x admin frame, so we
// halve them whenever we apply them inside the main-app habitat group, where
// the habitat is at 1x scale.
const ADMIN_TO_MAIN_DECOR_SCALE = 0.5;

// Same seeded RNG used by AgentNeighborhood so the IdentityTab preview snaps
// each decor item to the EXACT point the runtime view would pick. If the
// formula here drifts from the runtime one, the dressing-room preview lies.
function decorSeededRandom(seed: number) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}
function pickDecorPointIndex(agentId: string | undefined, itemIndex: number, total: number) {
  const seed = (agentId?.length || 0) + itemIndex;
  return Math.floor(decorSeededRandom(seed) * total);
}

// Tiny error boundary so a single missing/broken .glb doesn't blank out the
// whole decor cluster. Falls back to a small wireframe placeholder so the user
// can see WHICH item failed (typically: it hasn't been baked to 3D yet).
class DecorErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: any) { console.warn("[DecorObject] failed to render decor GLB:", err); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

function DecorObject({ agentId, path, glbPath, isSelected, onSelect, transform, decorPoints, index, onTransformChange, defaultDecorRotation, defaultScale }: any) {
  const [target, setTarget] = useState<THREE.Group | null>(null);

  // Stable random yaw per (path, index) so an item doesn't twitch each render
  const fallbackYaw = useMemo(() => {
    const seed = (path?.length || 0) + index * 13;
    return Math.sin(seed * 1.7) * Math.PI;
  }, [path, index]);

  useEffect(() => {
    if (!target) return;

    // --- Position --------------------------------------------------------
    // Prefer an explicit user-saved transform, otherwise auto-snap to a
    // valid decor point painted in the admin app for THIS habitat. Halve
    // admin-frame coordinates so they land on the main-app surface. Pick
    // the point with the same seeded RNG used at runtime so the dressing-
    // room preview matches what the user will see in the world.
    const hasSavedPos =
      transform?.x !== undefined &&
      transform?.y !== undefined &&
      transform?.z !== undefined;

    if (hasSavedPos) {
      target.position.set(transform.x, transform.y, transform.z);
    } else if (decorPoints && decorPoints.length > 0) {
      const pointIndex = pickDecorPointIndex(agentId, index, decorPoints.length);
      const pt = decorPoints[pointIndex];
      target.position.set(
        pt.x * ADMIN_TO_MAIN_DECOR_SCALE,
        pt.y * ADMIN_TO_MAIN_DECOR_SCALE,
        pt.z * ADMIN_TO_MAIN_DECOR_SCALE
      );
    } else {
      const seed = path.length + index;
      target.position.set((Math.sin(seed * 1.1) * 0.6), 0, (Math.cos(seed * 1.3) * 0.6));
    }

    // --- Rotation --------------------------------------------------------
    // Use the catalog's `decorRotation` when present (the upright-display
    // pose authored in AccessoryManager). Do NOT fall back to the wearable
    // `rotation` — that's tuned for hat-on-bone poses and would lay decor
    // flat. With no decor pose set, default to upright with a deterministic
    // yaw so items don't all face the same direction.
    const rotX = defaultDecorRotation ? defaultDecorRotation[0] : 0;
    const defaultY = defaultDecorRotation ? defaultDecorRotation[1] : fallbackYaw;
    const rotZ = defaultDecorRotation ? defaultDecorRotation[2] : 0;
    const rotY = transform?.rotationY !== undefined ? transform.rotationY : defaultY;

    target.rotation.set(
      transform?.rotationX !== undefined ? transform.rotationX : rotX,
      rotY,
      transform?.rotationZ !== undefined ? transform.rotationZ : rotZ
    );

    // --- Scale -----------------------------------------------------------
    // Match the decor-to-HABITAT ratio you see in the runtime world view —
    // habitat geometry is identical across both views, so it's the stable
    // reference. Runtime: decor at `catalogScale * 0.01 * 0.25` ≈ 0.1875
    // sits inside a 2.2-unit habitat → ~8.5%.
    const catalogScale = (transform?.scale !== undefined ? transform.scale : (defaultScale ?? 75));
    const s = catalogScale * 0.01 * 0.25;
    target.scale.set(s, s, s);
  }, [target, transform, decorPoints, index, path, defaultDecorRotation, defaultScale, fallbackYaw, agentId]);

  return (
    <group
      ref={setTarget}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    >
      <DecorErrorBoundary fallback={
        <mesh>
          <boxGeometry args={[0.4, 0.4, 0.4]} />
          <meshBasicMaterial color="#E57373" wireframe />
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
      </DecorErrorBoundary>
    </group>
  );
}