import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu,
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../store/worldStore";
import { GenerativeResult } from "../components/GenerativeStudio";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";
import { CanopyScene } from "../App";
import { LobsterIcon } from "../components/World/LobsterIcon";
import { Toggle, ServiceRow, glass } from "../App";
import { ForumBriefModal } from "./ForumView/ForumBriefModal";

export // ═══════════════════════════════════════════════════════════════════════════════
  // CANOPY VIEW (3D World with overlay)
  // ═══════════════════════════════════════════════════════════════════════════════

  function CanopyView() {
  const agents = useWorldStore(s => s.agents);
  const selectedAgent = useWorldStore(s => s.selectedAgent);
  const hoveredAgent = useWorldStore(s => s.hoveredAgent);
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const { setSelectedAgent, setActiveView, updateAgentVisuals } = useWorldStore();
  const theme = useWorldStore(s => s.theme);

  // Forum modal
  const [forumModalOpen, setForumModalOpen] = useState(false);

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
    if (index === -1) index = 0;
    for (let i = 0; i < index; i++) {
      if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
        const temp = dx; dx = -dz; dz = temp;
      }
      x += dx; z += dz;
    }
    return { x: x * 2, y: 0, z: z * 2, rotationY: 0 };
  };

  const worldBounds = useMemo(() => {
    let minX = 0, maxX = 0, minZ = 0, maxZ = 0;
    let hasAgents = false;

    agents.forEach(agent => {
      hasAgents = true;
      const transform = (agent.visual_identity as any)?.habitatTransform || getAgentBasePoint(agent.id);
      if (transform.x < minX) minX = transform.x;
      if (transform.x > maxX) maxX = transform.x;
      if (transform.z < minZ) minZ = transform.z;
      if (transform.z > maxZ) maxZ = transform.z;
    });

    if (!hasAgents) {
      return { center: [0, 0, 0] as [number, number, number], minZoom: 150 };
    }

    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    const width = maxX - minX;
    const depth = maxZ - minZ;
    const maxDimension = Math.max(width, depth);

    let calcMinZoom = 100;
    if (maxDimension > 6) {
      calcMinZoom = 100 * (6 / maxDimension);
    }

    return {
      center: [centerX, 0, centerZ] as [number, number, number],
      minZoom: Math.max(10, Math.floor(calcMinZoom))
    };
  }, [agents]);

  const handleNudge = (axis: "x" | "y" | "z" | "ry", amount: number) => {
    if (!selectedEditAgent) return;
    setEditTransforms(prev => {
      const existing = prev[selectedEditAgent] || (agents.find(a => a.id === selectedEditAgent)?.visual_identity as any)?.habitatTransform;
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
      {forumModalOpen && <ForumBriefModal onClose={() => setForumModalOpen(false)} />}
      <Canvas
        style={{ position: "absolute", inset: 0 }}
        gl={{ antialias: true, alpha: true }}
        onCreated={({ gl }: any) => { gl.toneMapping = THREE.LinearToneMapping; gl.toneMappingExposure = 1.0; }}
      >
        <OrthographicCamera makeDefault position={[worldBounds.center[0] + 10, 10, worldBounds.center[2] + 10]} zoom={150} near={0.1} far={100} />
        <OrbitControls makeDefault={!isEditMode} enablePan={true} minPolarAngle={Math.PI * 0.25} maxPolarAngle={Math.PI * 0.4} autoRotate={!isEditMode} autoRotateSpeed={0.15} dampingFactor={0.05} enableDamping minZoom={worldBounds.minZoom} maxZoom={650} target={worldBounds.center} />
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
                  background: a.paused ? "var(--text-muted)" : (!gatewayReady || a.status === "deploying") ? "#F4A83A" : a.status === "active" ? "#4A9E96" : a.status === "thinking" ? "#8B6AAE" : a.status === "error" ? "#E57373" : "var(--text-muted)",
                  border: "2px solid white",
                  animation: (!a.paused && (!gatewayReady || a.status === "deploying")) ? "pulse 1.5s ease-in-out infinite" : "none",
                }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{a.name}</div>
                <div style={{ fontSize: 10, color: a.paused ? "var(--text-muted)" : (!gatewayReady || a.status === "deploying") ? "#F4A83A" : "var(--text-sub)", textTransform: "capitalize" }}>
                  {a.paused ? "Paused" : (!gatewayReady || a.status === "deploying") ? "Waking up..." : a.status === "error" ? "Offline" : a.currentAction}
                </div>
              </div>
            </div>
          )
        })}

        {/* Action Buttons */}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {/* Add Agent Button */}
          <div onClick={() => setActiveView("onboarding")} style={{
            background: "rgba(255,255,255,0.2)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
            border: "1px dashed rgba(60, 102, 99, 0.3)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.02)",
            padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
            borderRadius: 12, flex: 1, transition: "all 0.2s ease",
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%", background: "rgba(60, 102, 99, 0.1)",
              display: "flex", alignItems: "center", justifyContent: "center", color: "#3c6663"
            }}>
              <Plus size={14} strokeWidth={2.5} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#3c6663" }}>Add Agent</div>
          </div>

          {/* New Forum Button */}
          <div onClick={() => setForumModalOpen(true)} style={{
            background: "rgba(60, 102, 99, 0.8)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(60, 102, 99, 0.9)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
            borderRadius: 12, flex: 1, transition: "all 0.2s ease",
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%", background: "rgba(255, 255, 255, 0.2)",
              display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF"
            }}>
              <Users size={12} strokeWidth={2.5} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#FFF" }}>New Forum</div>
          </div>
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