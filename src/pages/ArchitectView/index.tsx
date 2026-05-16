import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, Monitor, Smartphone
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, glass, LobsterIcon } from "../../App";

import { ConnectionsTab } from './ConnectionsTab';
import { TerminalPane } from './TerminalPane';
import { OverviewTab } from './OverviewTab';
import { IdentityTab } from './IdentityTab';
import { PersonalityTab } from './PersonalityTab';
// PermissionsTab was merged into ConnectionsTab (Skills & Access). Kept in the tree
// for now as a reference but no longer imported or rendered.

import { SpendTab } from './SpendTab';
import { ActivityTab } from './ActivityTab';
import { ChatTab } from './ChatTab';
import { BrowserTab } from './BrowserTab';
import { DiagnosticsTab } from './DiagnosticsTab';
import { MobilePairingModal } from '../../components/Companion/MobilePairingModal';

export // ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ═══════════════════════════════════════════════════════════════════════════════

// function OnboardingWizard() { Extracted

function ArchitectView({ agent: rawAgent }: { agent: AgentData }) {
  const agent = useMemo(() => ({
    ...rawAgent,
    integrations: rawAgent.integrations || [],
    permissions: rawAgent.permissions || []
  }), [rawAgent]);

  const { agents, setSelectedAgent, setActiveView, architectTab, setArchitectTab, togglePermission } = useWorldStore();
  const [showPairingModal, setShowPairingModal] = useState(false);
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [diagErrors, setDiagErrors] = useState<string[]>([]);
  const [diagSuccess, setDiagSuccess] = useState<string>("");
  const [openclawStatusOutput, setOpenclawStatusOutput] = useState<string>("");
  const [showDiagnosticsPane, setShowDiagnosticsPane] = useState(false);
  const [showTerminalPane, setShowTerminalPane] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState<string>("");
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [isHealing, setIsHealing] = useState(false);
  const [showUpdateTip, setShowUpdateTip] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});

  useEffect(() => {
    // Reset Diagnostic UI states when selecting a different agent
    setDiagErrors([]);
    setDiagSuccess("");
    setOpenclawStatusOutput("");
    setShowDiagnosticsPane(false);
    setShowUpdateTip(false);
    
    // Clear scroll memory when switching agents
    scrollPositions.current = {};
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [agent.id]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollPositions.current[architectTab] || 0;
    }
  }, [architectTab]);

  // Redirect: the old standalone Permissions tab was merged into Skills & Access.
  // Any persisted state, deep-link, or in-app navigation that still points at
  // "permissions" should land on "connections" instead, not a blank pane.
  useEffect(() => {
    if (architectTab === "permissions") setArchitectTab("connections");
  }, [architectTab, setArchitectTab]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    scrollPositions.current[architectTab] = e.currentTarget.scrollTop;
  };

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
          errors.push(`Model mismatch: the agent is using ${res.active_default_model}, but it should be ${res.expected_model} based on your API keys. Auto-repair will fix this.`);
        }
        if (res.port_mismatch) {
          errors.push("Port configuration mismatch detected on gateway proxy.");
        }
        if (!res.container_running) {
          errors.push("The local engine is offline. Open OrbStack to bring it back up — Canopy will reconnect automatically.");
        }
        setDiagErrors(errors);
        setDiagSuccess("");
        if (btn) btn.innerText = "Errors Found";
      } else if (statusStr && statusStr.toLowerCase().includes("error")) {
        setDiagErrors(["The agent reported some warnings — open the advanced log below for details."]);
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


  // Tabs are ordered by the user's mental model: who they are → how they think → what they can do → what they've done.
  // IDs stay stable so persisted state and any deep-links don't break — only labels and order change.
  const tabs = [
    { id: "overview",    label: "Home",            icon: <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" /> },
    { id: "identity",    label: "Appearance",      icon: <path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /> },
    { id: "personality", label: "Instructions",    icon: <path d="M13 10V3L4 14h7v7l9-11h-7z" /> },
    { id: "connections", label: "Skills & Access", icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /> },
    { id: "browser",     label: "Web Browser",     icon: <path d="M22 12H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /> },
    { id: "activity",    label: "Activity",        icon: <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /> },
    { id: "spend",       label: "Spending",        icon: <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" /> },
    { id: "diagnostics", label: "Diagnostics",     icon: <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path> },
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
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-main)", marginBottom: 16 }}>Restarting your agent…</h2>
            <p style={{ fontSize: 15, color: "var(--text-sub)", lineHeight: 1.6 }}>
              Something got stuck, so we're cleanly restarting the workspace. This usually takes about 10 seconds.
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
            <LobsterIcon
              size={32}
              role={agent.role}
              agentImage={agent.image}
              shellColor={agent.robeColor}
              accentColor={agent.accentColor}
              reactState={agent.paused ? "off" : agent.status === "thinking" ? "thinking" : agent.status === "error" ? "error" : "idle"}
            />
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

        <button onClick={() => setShowPairingModal(true)} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "10px", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 8, cursor: "pointer",
          background: "var(--surface-base)", color: "var(--text-main)", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          marginBottom: 10,
        }}>
          <Smartphone size={16} />
          Pair Mobile Device
        </button>

        {/* Danger Zone */}
        <div style={{ padding: showDangerZone ? "10px 0" : "10px 0 0 0", borderTop: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
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
                onClick={() => {
                  setTerminalCommand("");
                  setShowTerminalPane(true);
                }}
                style={{ width: "100%", padding: "8px 12px", background: "var(--surface-base)", color: "var(--text-main)", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                <Terminal size={14} /> Open Agent Terminal
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
      {showTerminalPane ? (
        <TerminalPane agent={agent} onClose={() => setShowTerminalPane(false)} initialCommand={terminalCommand} />
      ) : showDiagnosticsPane ? (
        <div style={{ flex: 1, overflow: "auto", padding: "32px 40px", display: "flex", flexDirection: "column", position: "relative", background: "var(--surface-base)" }}>
          <button
            onClick={() => setShowDiagnosticsPane(false)}
            style={{ position: "absolute", top: 24, right: 32, background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", padding: 8, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <SvgIcon size={24}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></SvgIcon>
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, paddingRight: 32 }}>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-main)", margin: 0 }}>Diagnostics</h1>
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
          <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 24 }}>Real-time check of {agent.name}'s health and configuration.</p>

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
        <div 
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{ flex: 1, overflow: "auto", padding: "32px 40px", display: "flex", flexDirection: "column" }}
        >
          {architectTab === "overview" && <OverviewTab key={agent.id} agent={agent} onUpdate={() => setShowUpdateTip(true)} onNavigate={setArchitectTab} />}
          {architectTab === "identity" && <IdentityTab key={agent.id} agent={agent} />}
          {architectTab === "personality" && <PersonalityTab key={agent.id} agent={agent} />}
          {architectTab === "connections" && <ConnectionsTab key={agent.id} agent={agent} onOpenTerminal={(cmd) => {
            if (cmd) setTerminalCommand(cmd);
            setShowTerminalPane(true);
          }} />}
          {/* The legacy "permissions" tab was merged into Skills & Access. Anything
              still routing to `permissions` (e.g. saved deep-links) falls through
              to Skills & Access via the redirect effect below. */}
          {architectTab === "browser" && <BrowserTab key={agent.id} agent={agent} />}
          {architectTab === "spend" && <SpendTab key={agent.id} agent={agent} />}
          {architectTab === "activity" && <ActivityTab key={agent.id} agent={agent} onNavigate={setArchitectTab} />}
          {architectTab === "diagnostics" && <DiagnosticsTab key={agent.id} agent={agent} onNavigate={setArchitectTab} />}
        </div>
      )}
      
      <MobilePairingModal isOpen={showPairingModal} onClose={() => setShowPairingModal(false)} />
    </div>
  );
}