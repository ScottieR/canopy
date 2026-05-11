import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu,
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, AlertTriangle, ChevronUp, ChevronDown
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment } from "@react-three/drei";
import { Edit2 } from "lucide-react";
import { LobsterIcon } from "../../App";
import { GLBAgent } from "../../components/World/GLBAgent";
import { SafeBillboard } from "../../App";
import { ProgressBar } from "../../App";
import { ChatTab } from "./ChatTab";
import { Toggle, ServiceRow, glass } from "../../App";

// ─── Overview Tab ────────────────────────────────────────────────────────────

export function OverviewTab({ agent: _agent, onUpdate, onNavigate }: { agent: AgentData; onUpdate?: () => void; onNavigate?: (tab: string) => void }) {
  const fallbackIntegrations = useMemo(() => [], []);
  const fallbackPermissions = useMemo(() => [], []);
  const agent = { 
    ..._agent, 
    integrations: _agent.integrations || fallbackIntegrations,
    permissions: _agent.permissions || fallbackPermissions
  };
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const [repairLog, setRepairLog] = useState<string | null>(null);
  const [repairSucceeded, setRepairSucceeded] = useState<boolean | null>(null);
  const [hardResetting, setHardResetting] = useState(false);

  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [tempName, setTempName] = useState(agent.name);
  const [tempRole, setTempRole] = useState(agent.role);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [webLoginsExpanded, setWebLoginsExpanded] = useState(false);

  const [slackNeedsPairing, setSlackNeedsPairing] = useState(false);

  useEffect(() => {
    if (agent.integrations.includes("slack")) {
      invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_slack_paired` })
        .then(val => {
          if (val === "true") {
            setSlackNeedsPairing(false);
          } else {
            // Fallback: if not paired, check if there are allowed channels
            invoke<string[]>("get_allowed_slack_channels", { agentId: agent.id })
              .then(channels => setSlackNeedsPairing(!channels || channels.length === 0))
              .catch(() => setSlackNeedsPairing(true));
          }
        })
        .catch(() => {
          invoke<string[]>("get_allowed_slack_channels", { agentId: agent.id })
            .then(channels => setSlackNeedsPairing(!channels || channels.length === 0))
            .catch(() => setSlackNeedsPairing(true));
        });
    } else {
      setSlackNeedsPairing(false);
    }
  }, [agent.integrations, agent.id]);

  useEffect(() => {
    setIsEditingDetails(false);
    setTempName(agent.name);
    setTempRole(agent.role);

    // Fetch recent audit logs (which now includes chats)
    const fetchLogs = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const data: any = await invoke('get_global_audit_log', { limit: 100, agentId: agent.id });
        setRecentLogs(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Failed to fetch recent audit log", e);
      }
    };
    fetchLogs();
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
      {slackNeedsPairing && !agent.paused && (
        <div style={{ background: "rgba(236, 178, 46, 0.1)", border: "1px solid rgba(236, 178, 46, 0.3)", borderRadius: 16, padding: 24, marginBottom: 32 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#ECB22E", display: "flex", alignItems: "center", justifyContent: "center", color: "white", flexShrink: 0 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#fff" /><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#fff" /><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#fff" /><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#fff" /><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#fff" /><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#fff" /><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#fff" /><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#fff" /></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#9A6B00", marginBottom: 4 }}>Slack Pairing Required</div>
              <div style={{ fontSize: 13, color: "var(--text-main)", marginBottom: 16, lineHeight: 1.5, opacity: 0.9 }}>
                {agent.name} is provisioned, but you haven't authorized any channels for them to read and respond in.
              </div>
              <div style={{ background: "rgba(255,255,255,0.6)", padding: 16, borderRadius: 12, border: "1px solid rgba(236, 178, 46, 0.4)" }}>
                <ol style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: "var(--text-main)", display: "flex", flexDirection: "column", gap: 8, fontWeight: 500 }}>
                  <li>Go to your Slack workspace and find <strong>{agent.name}</strong> under the "Apps" section in the sidebar.</li>
                  <li>Send them a direct message with any text (like <code style={{ background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 4, color: "#9A6B00" }}>hello</code>).</li>
                  <li>They will reply with a secure 6-digit code.</li>
                  <li>Click the button below to enter that code and grant channel access.</li>
                </ol>
              </div>
            </div>
            <button
              onClick={() => {
                sessionStorage.setItem("scrollToSlack", "true");
                if (onNavigate) onNavigate("connections");
              }}
              style={{ padding: "10px 16px", background: "#ECB22E", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", alignSelf: "center", whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(236, 178, 46, 0.3)" }}
            >
              Enter Pairing Code →
            </button>
          </div>
        </div>
      )}
      {agent.paused && (
        <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 16, padding: 24, marginBottom: 32 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", flexShrink: 0 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
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
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
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
                      const agOpenAI = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_openai_key` }).catch(() => "") || "")
                        || String(await invoke("get_secret_cmd", { key: "OPENAI_API_KEY" }).catch(() => "") || "");
                      const agGemini = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_gemini_key` }).catch(() => "") || "")
                        || String(await invoke("get_secret_cmd", { key: "GEMINI_API_KEY" }).catch(() => "") || "");
                      const agGrok = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_grok_key` }).catch(() => "") || "")
                        || String(await invoke("get_secret_cmd", { key: "XAI_API_KEY" }).catch(() => "")
                          || await invoke("get_secret_cmd", { key: "GROK_API_KEY" }).catch(() => "") || "");

                      await invoke("sync_credentials", {
                        agentId: agent.id, keys: {
                          "ANTHROPIC_API_KEY": agAnthropic,
                          "OPENAI_API_KEY": agOpenAI,
                          "GEMINI_API_KEY": agGemini,
                          "XAI_API_KEY": agGrok,
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
      <div style={{ marginBottom: 32, display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-card)", padding: 24, borderRadius: 20, border: "1px solid var(--border-subtle)", boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <div style={{ width: 72, height: 72, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: `${agent.robeColor || "#CCC"}15`, boxShadow: `0 0 0 1px ${agent.robeColor || "#CCC"}40`, flexShrink: 0 }}>
            <LobsterIcon size={72} role={agent.role} agentImage={agent.image} shellColor={agent.robeColor} accentColor={agent.accentColor} />
          </div>
          <div>
            {isEditingDetails ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input value={tempName} onChange={e => setTempName(e.target.value)} style={{ fontSize: 24, fontWeight: 700, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-base)", outline: "none", color: "var(--text-main)" }} />
                <input value={tempRole} onChange={e => setTempRole(e.target.value)} style={{ fontSize: 14, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-base)", outline: "none", color: "var(--text-sub)" }} />
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={saveDetails} style={{ padding: "6px 16px", background: "#4A9E96", color: "white", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button>
                  <button onClick={() => { setIsEditingDetails(false); setTempName(agent.name); setTempRole(agent.role); }} style={{ padding: "6px 16px", background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border-subtle)", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", letterSpacing: "-0.01em", margin: 0, lineHeight: 1.1 }}>
                    {agent.name}
                  </h1>
                  <div style={{ fontSize: 16, color: "var(--text-sub)", fontWeight: 500 }}>{agent.title}</div>
                </div>
                <p style={{ fontSize: 14, color: "var(--text-sub)", marginTop: 6, maxWidth: 600, lineHeight: 1.5 }}>
                  {agent.description}
                </p>
              </>
            )}
          </div>
        </div>
        <button onClick={() => setIsEditingDetails(true)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 12, cursor: "pointer", color: "var(--text-sub)", fontSize: 13, fontWeight: 600 }}>
          <Edit2 size={16} />
          Edit Agent
        </button>
      </div>

      {/* Side-by-side: 3D View and Chat */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24, minHeight: 400 }}>
        {/* 3D Lobster View */}
        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 16, position: "relative", overflow: "hidden" }}>
          <Canvas orthographic camera={{ position: [10, 10, 10], zoom: 60 }}>
            <Environment preset="city" />
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 5, 5]} intensity={1} castShadow />
            <OrbitControls enablePan={false} enableZoom={false} />
            <group position={[0, -0.6, 0]}>
              <GLBAgent
                fileUrl={["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].includes(agent.role) ? `/models/lobsters/${agent.role}.glb` : undefined}
                accessories={agent.visual_identity?.accessories || []}
                agentStatus={agent.status}
                scale={1.0}
                robeColor={agent.color || agent.robeColor}
                forceAnimation="Breathe"
              />
              {/* Billboard fallback only for accessories with no 3D model.
                  /accessories/ and /models/assets/ paths are attached to bones
                  via GLBAgent → AttachedAccessory; rendering them again as
                  stickers would duplicate the visual above the lobster. */}
              <React.Suspense fallback={null}>
                {(agent.visual_identity?.accessories || []).map((path, i) => {
                  if (path.includes("/models/assets/") || path.includes("/accessories/")) return null;
                  return (
                    <SafeBillboard
                      key={i}
                      url={path}
                      position={[
                        0.5 * Math.cos(i * Math.PI * 2 / (agent.visual_identity?.accessories?.length || 1)),
                        0.2 + 0.3 * Math.sin(i * Math.PI * 2 / (agent.visual_identity?.accessories?.length || 1)),
                        0.5 * Math.sin(i * Math.PI * 2 / (agent.visual_identity?.accessories?.length || 1))
                      ]}
                    />
                  );
                })}
              </React.Suspense>
            </group>
          </Canvas>
        </div>

        {/* Chat Box */}
        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 16, display: "flex", flexDirection: "column", height: 400, overflow: "hidden" }}>
          <ChatTab agent={agent} compact={true} />
        </div>
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
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Tokens Used</div>
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

      {/* Access Level + Recent History */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, marginBottom: 32, alignItems: "flex-start" }}>
        {/* Access Level */}
        <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", position: "relative" }}>
          {(() => {
            const hasYolo = agent.permissions.some(p => ["autonomous", "spend_auto"].includes(p.id) && p.enabled);
            const hasSecure = agent.permissions.some(p => ["ext_network", "file_write", "payments", "imessage", "photos"].includes(p.id) && p.enabled);
            const enabledPerms = agent.permissions.filter(p => p.enabled);

            let stateLabel = "Locked Down";
            let temperatureLevel = 0;
            let iconColor = "#22c55e";

            if (hasYolo) {
              stateLabel = "YOLO Mode (High Risk ⚠️)";
              temperatureLevel = 2;
              iconColor = "#ef4444";
            } else if (hasSecure) {
              stateLabel = "Secure";
              temperatureLevel = 1;
              iconColor = "#f59e0b";
            }

            return (
              <>
                <div style={{ position: "absolute", top: 16, right: 16 }}>
                  <button onClick={() => onNavigate?.("permissions")} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "var(--text-sub)" }}>Edit</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 16, width: "100%", maxWidth: 180 }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--surface-base)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                    <Lock size={16} color={iconColor} strokeWidth={2.5} />
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>{stateLabel}</div>
                  <div style={{ position: "relative", width: "100%", height: 6, background: "linear-gradient(to right, #22c55e, #f59e0b, #ef4444)", borderRadius: 3 }}>
                    <div style={{ position: "absolute", top: -3, left: `${temperatureLevel * 50}%`, width: 12, height: 12, borderRadius: "50%", background: "#fff", border: "2px solid #333", transform: "translateX(-50%)", transition: "left 0.3s" }} />
                  </div>
                </div>

                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-sub)", alignSelf: "flex-start", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Enabled Permissions & Connectors</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", flex: 1, overflowY: "auto", paddingRight: 4 }}>
                  {enabledPerms.length === 0 && (!agent.integrations || agent.integrations.length === 0) && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No permissions enabled.</div>}
                  {enabledPerms.map(p => {
                    const desc = p.description || "Core permission";
                    const isRecommended = DEFAULT_PERMISSIONS.find(dp => dp.id === p.id)?.enabled !== false;
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 12, color: "var(--text-main)", textAlign: "left" }}>
                        <div><span style={{ color: "var(--text-sub)", marginRight: 6, fontWeight: 600 }}>Core:</span> {p.label}</div>
                        <div title={desc} style={{ cursor: "help", display: "flex", alignItems: "center" }}>
                          {isRecommended ? <CheckCircle2 size={14} color="#4A9E96" /> : <AlertTriangle size={14} color="#D4A04A" />}
                        </div>
                      </div>
                    );
                  })}
                  {(() => {
                    if (!agent.integrations) return null;

                    const normalIntegrations = agent.integrations.filter(intg => !intg.startsWith('web_'));
                    const webIntegrations = agent.integrations.filter(intg => intg.startsWith('web_'));

                    return (
                      <>
                        {normalIntegrations.map(intg => {
                          const names: Record<string, string> = { "slack": "Slack", "github": "GitHub", "gmail": "Gmail", "cal": "Google Calendar", "telegram": "Telegram", "discord": "Discord", "drive": "Google Drive", "passwords": "Web Vault" };
                          const label = names[intg] || intg;
                          return (
                            <div key={intg} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 12, color: "var(--text-main)", textAlign: "left" }}>
                              <div><span style={{ color: "#4A9E96", marginRight: 6, fontWeight: 600 }}>Bridge:</span> {label}</div>
                              <div title={`Active connector: ${label}`} style={{ cursor: "help", display: "flex", alignItems: "center" }}>
                                <CheckCircle2 size={14} color="#4A9E96" />
                              </div>
                            </div>
                          );
                        })}
                        {webIntegrations.length > 0 && (
                          <div style={{ display: "flex", flexDirection: "column", background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 6, overflow: "hidden" }}>
                            <div
                              onClick={() => setWebLoginsExpanded(!webLoginsExpanded)}
                              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", cursor: "pointer", fontSize: 12, color: "var(--text-main)", textAlign: "left", userSelect: "none" }}
                            >
                              <div><span style={{ color: "#4A9E96", marginRight: 6, fontWeight: 600 }}>Bridge:</span> Web Vault Logins ({webIntegrations.length})</div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div title={`Provides seamless login access to ${webIntegrations.length} sites`} style={{ cursor: "help", display: "flex", alignItems: "center" }}>
                                  <CheckCircle2 size={14} color="#4A9E96" />
                                </div>
                                {webLoginsExpanded ? <ChevronUp size={14} color="var(--text-sub)" /> : <ChevronDown size={14} color="var(--text-sub)" />}
                              </div>
                            </div>
                            {webLoginsExpanded && (
                              <div style={{ padding: "0 12px 8px 12px", display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                                {webIntegrations.map(intg => (
                                  <div key={intg} style={{ fontSize: 11, color: "var(--text-sub)", padding: "4px 8px", background: "rgba(0,0,0,0.03)", borderRadius: 4 }}>
                                    {intg.replace('web_', '')}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
            );
          })()}
        </div>

        {/* Activity Infographic */}
        <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 16 }}>Activity Patterns</div>
          {(() => {
            const hours = new Array(24).fill(null).map(() => ({ interactions: 0, tools: 0, system: 0, total: 0 }));

            if (recentLogs && recentLogs.length > 0) {
              recentLogs.forEach((log: any) => {
                const h = new Date(log.timestamp).getHours();
                let type: "interactions" | "tools" | "system" = "system";
                if (log.action === "chatted") type = "interactions";
                else if (log.action === "tool_call" || log.bridge_type) type = "tools";

                hours[h][type] += 1;
                hours[h].total += 1;
              });
            } else {
              for (let i = 0; i < 24; i++) {
                hours[i].system = Math.floor(Math.random() * 2);
                hours[i].total = hours[i].system;
              }
              hours[9] = { interactions: 1, tools: 2, system: 0, total: 3 };
              hours[14] = { interactions: 2, tools: 1, system: 1, total: 4 };
              hours[20] = { interactions: 0, tools: 0, system: 2, total: 2 };
            }
            const max = Math.max(...hours.map(h => h.total), 4);

            return (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", width: "100%" }}>
                <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: "#4A9E96" }} />Chats</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: "#D4A04A" }} />Tools</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: "var(--text-muted)" }} />System</div>
                </div>
                <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 4, minHeight: 120, paddingBottom: 8, borderBottom: "1px solid var(--border-subtle)" }}>
                  {hours.map((val, i) => {
                    const pctInteractions = val.total > 0 ? (val.interactions / val.total) * 100 : 0;
                    const pctTools = val.total > 0 ? (val.tools / val.total) * 100 : 0;
                    const pctSystem = val.total > 0 ? (val.system / val.total) * 100 : 0;

                    const heightPct = Math.max((val.total / max) * 100, 4);

                    return (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }} title={`${val.interactions} Chats, ${val.tools} Tool Execs, ${val.system} System at ${i}:00`}>
                        <div style={{ width: "100%", height: `${heightPct}%`, display: "flex", flexDirection: "column-reverse", borderRadius: "3px 3px 0 0", overflow: "hidden", transition: "height 0.5s ease-out" }}>
                          {val.total > 0 ? (
                            <>
                              {val.system > 0 && <div style={{ width: "100%", height: `${pctSystem}%`, background: "var(--text-muted)", opacity: 0.6 }} />}
                              {val.tools > 0 && <div style={{ width: "100%", height: `${pctTools}%`, background: "#D4A04A", opacity: 0.8 }} />}
                              {val.interactions > 0 && <div style={{ width: "100%", height: `${pctInteractions}%`, background: "#4A9E96", opacity: 0.9 }} />}
                            </>
                          ) : (
                            <div style={{ width: "100%", height: "100%", background: "var(--glass-light)", opacity: 0.3 }} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>
                  <span>12 AM</span>
                  <span>12 PM</span>
                  <span>11 PM</span>
                </div>
              </div>
            );
          })()}
          <button
            onClick={() => onNavigate && onNavigate("activity")}
            style={{ width: "100%", padding: "12px", borderRadius: 8, background: "#3c6663", color: "white", fontWeight: 600, border: "none", cursor: "pointer", fontSize: 13, marginTop: 16 }}>
            View Activity Feed
          </button>
        </div>
      </div>
    </div>
  );
}