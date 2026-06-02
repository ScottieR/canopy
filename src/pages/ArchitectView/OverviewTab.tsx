import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu,
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity as ActivityIcon, Brain, Server, Search, CheckCircle, Database, AlertTriangle, ChevronUp, ChevronDown
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage, MiniApp } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment } from "@react-three/drei";
import { Edit2 } from "lucide-react";
import { LobsterIcon } from "../../components/World/LobsterIcon";
import { GLBAgent } from "../../components/World/GLBAgent";
import { SafeBillboard } from "../../App";
import { ProgressBar } from "../../App";
import { ChatTab } from "./ChatTab";
import { Toggle, ServiceRow, glass } from "../../App";
import { AgentActivityHeatmap } from "../../components/agents/AgentActivityHeatmap";
import { WorkspaceFilesDrawer } from "./WorkspaceFilesDrawer";
import { ThreadsRail } from "./ThreadsRail";
import { LiveVoiceOverlay } from "./LiveVoiceOverlay";
// ProjectSpaceView removed — multi-agent collaboration now lives in ForumView

// ─── Mini Apps Drawer ─────────────────────────────────────────────────────────

function MiniAppsDrawer({ agent, open, onClose }: { agent: AgentData; open: boolean; onClose: () => void }) {
  const deleteMiniApp = useWorldStore(s => s.deleteMiniApp);
  const [selectedApp, setSelectedApp] = React.useState<MiniApp | null>(null);
  const apps = agent.miniApps ?? [];

  if (!open) return null;

  const download = (app: MiniApp) => {
    const blob = new Blob([app.htmlContent], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${app.name.replace(/\s+/g, "-").toLowerCase()}.html`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{
      position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 200,
      width: 400, maxHeight: 540,
      background: "var(--surface-card, #fff)",
      border: "1px solid var(--border-subtle)",
      borderRadius: 14,
      boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth={2.5} strokeLinecap="round">
          <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", flex: 1 }}>Mini Apps · {agent.name}</span>
        {selectedApp && <button onClick={() => setSelectedApp(null)} style={{ fontSize: 11, color: "var(--text-sub)", background: "transparent", border: "none", cursor: "pointer" }}>← Back</button>}
        <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 2 }}>✕</button>
      </div>
      {selectedApp ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "7px 12px", background: "rgba(129,140,248,0.06)", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, flex: 1, color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedApp.name}</span>
            <button onClick={() => download(selectedApp)} style={{ fontSize: 10, color: "#818CF8", background: "transparent", border: "none", cursor: "pointer", fontWeight: 600 }}>↓ Download</button>
          </div>
          <iframe srcDoc={selectedApp.htmlContent} sandbox="allow-scripts allow-same-origin" style={{ flex: 1, border: "none", minHeight: 400 }} title={selectedApp.name} />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {apps.length === 0 ? (
            <div style={{ padding: "32px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🧩</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>No mini-apps yet</div>
              <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.6, maxWidth: 260, margin: "0 auto" }}>
                Ask {agent.name} to build a tool and click "Pin to shelf" on any HTML response to save it here.
              </div>
            </div>
          ) : (
            apps.map(app => (
              <div key={app.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(129,140,248,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth={2} strokeLinecap="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.name}</div>
                  {app.description && <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.description}</div>}
                </div>
                <button onClick={() => setSelectedApp(app)} style={{ fontSize: 11, color: "#818CF8", background: "rgba(129,140,248,0.1)", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>Open</button>
                <button onClick={() => download(app)} title="Download" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4, flexShrink: 0 }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button onClick={() => deleteMiniApp(agent.id, app.id)} title="Remove" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4, opacity: 0.45, flexShrink: 0 }}>
                  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

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
  const [emailNeedsConnection, setEmailNeedsConnection] = useState(false);
  const [calendarNeedsConnection, setCalendarNeedsConnection] = useState(false);

  // Workspace files popover open/closed.
  const [filesOpen, setFilesOpen] = useState(false);
  const filesPopoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filesPopoverRef.current && !filesPopoverRef.current.contains(e.target as Node)) {
        setFilesOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filesOpen]);

  // Mini Apps popover open/closed.
  const [appsOpen, setAppsOpen] = useState(false);
  const appsPopoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!appsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (appsPopoverRef.current && !appsPopoverRef.current.contains(e.target as Node)) {
        setAppsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [appsOpen]);

  // Voice toggle — V1 uses the browser Web Speech API (single-turn: agent reply
  // text → spoken). Persisted in sessionStorage so the choice survives agent
  // switches within a session. ChatTab subscribes to `canopy:voice-toggle` to
  // know when to speak; we also pre-seed the same storage key for the
  // initial-mount read in ChatTab.
  const [voiceOn, setVoiceOn] = useState<boolean>(() => sessionStorage.getItem("canopy:voice-on") === "1");
  // Live voice — bidirectional duplex via OpenClaw realtime brain. Distinct
  // from the single-turn voice toggle above (TTS-only playback of agent
  // replies). Live is modal: it takes over the screen while active.
  const [liveOpen, setLiveOpen] = useState(false);
  const flipVoice = useCallback((next: boolean) => {
    setVoiceOn(next);
    sessionStorage.setItem("canopy:voice-on", next ? "1" : "0");
    window.dispatchEvent(new CustomEvent("canopy:voice-toggle", { detail: { enabled: next } }));
    // Stop any utterance mid-speech when toggling off.
    if (!next && typeof window.speechSynthesis !== "undefined") {
      window.speechSynthesis.cancel();
    }
  }, []);

  // Check email and calendar connection status
  useEffect(() => {
    const checkConnections = async () => {
      if (agent.integrations.includes("email")) {
        try {
          const tok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_google_email_access_token` });
          setEmailNeedsConnection(!tok || tok.length < 10);
        } catch {
          setEmailNeedsConnection(true);
        }
      } else {
        setEmailNeedsConnection(false);
      }
      if (agent.integrations.includes("calendar")) {
        try {
          const tok = await invoke<string>("get_secret_cmd", { key: `agent_${agent.id}_google_calendar_access_token` });
          setCalendarNeedsConnection(!tok || tok.length < 10);
        } catch {
          setCalendarNeedsConnection(true);
        }
      } else {
        setCalendarNeedsConnection(false);
      }
    };
    checkConnections();
  }, [agent.integrations, agent.id]);

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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
      {/* Email connection warning */}
      {emailNeedsConnection && !agent.paused && (
        <div style={{ background: "rgba(74,158,150,0.06)", border: "1px solid rgba(74,158,150,0.25)", borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(74,158,150,0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#4A9E96", flexShrink: 0 }}>
              <Mail size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 3 }}>Email isn't connected</div>
              <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
                {agent.name} may ask you to connect email to do their best work.
              </div>
            </div>
            <button
              onClick={() => onNavigate?.("connections")}
              style={{ padding: "8px 14px", background: "#4A9E96", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Connect Email →
            </button>
          </div>
        </div>
      )}

      {/* Calendar connection warning */}
      {calendarNeedsConnection && !agent.paused && (
        <div style={{ background: "rgba(74,158,150,0.06)", border: "1px solid rgba(74,158,150,0.25)", borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(74,158,150,0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#4A9E96", flexShrink: 0 }}>
              <Calendar size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 3 }}>Calendar isn't connected</div>
              <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
                {agent.name} may ask you to connect your calendar to do their best work.
              </div>
            </div>
            <button
              onClick={() => onNavigate?.("connections")}
              style={{ padding: "8px 14px", background: "#4A9E96", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Connect Calendar →
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
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Agent is offline</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)" }}>{agent.name}'s workspace stopped unexpectedly. Try repair first — if that doesn't work, a hard reset rebuilds everything from scratch.</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleHardReset}
                disabled={hardResetting}
                title="Rebuild this agent's workspace from scratch. Use only if repair fails."
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

      {/* ── High-risk banner ────────────────────────────────────────────────
          Slim sticky banner that appears when this agent is at Unrestricted
          tier AND autonomous is on — i.e. they can act on your behalf without
          asking. Quiet amber, never red, with a one-click way to pause or
          step down to Balanced. */}
      {(() => {
        const isUnrestricted = agent.permissions.find(p => p.id === "autonomous")?.enabled
          && agent.permissions.find(p => p.id === "ext_network")?.enabled
          && agent.permissions.find(p => p.id === "file_write")?.enabled;
        if (!isUnrestricted || agent.paused) return null;
        const stepDownToBalanced = async () => {
          // Inline the Balanced preset's deltas without importing from accessTiers
          // here (keeps the dependency surface small in this file).
          const toBalanced: Record<string, boolean> = {
            autonomous: false, proxy: false, file_write: false,
            payments: false, spend_auto: false, imessage: false, photos: false, scheduled: false,
          };
          const { invoke } = await import('@tauri-apps/api/core');
          const toggle = useWorldStore.getState().togglePermission;
          Object.entries(toBalanced).forEach(([id, desired]) => {
            const p = agent.permissions.find(x => x.id === id);
            if (p && p.enabled !== desired) toggle(agent.id, id);
          });
          setTimeout(async () => {
            const current = useWorldStore.getState().agents.find(a => a.id === agent.id);
            if (!current) return;
            const caps: Record<string, boolean> = {};
            current.permissions.forEach(p => (caps[p.id] = p.enabled));
            try { await invoke("update_agent_capabilities", { agentId: agent.id, capabilities: caps }); }
            catch (e) { console.error("Failed to step down access:", e); }
          }, 100);
        };
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            background: "rgba(212,160,74,0.08)", border: "1px solid rgba(212,160,74,0.3)",
            borderRadius: 12, padding: "10px 16px", marginBottom: 16, flexShrink: 0,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D4A04A" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div style={{ flex: 1, fontSize: 12, color: "var(--text-main)", lineHeight: 1.4 }}>
              <strong>{agent.name} can act on your behalf without asking.</strong>{" "}
              <span style={{ color: "var(--text-sub)" }}>You're at Unrestricted access with autonomy on. Step down when you're done.</span>
            </div>
            <button
              onClick={async () => {
                useWorldStore.getState().setAgents(
                  useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, paused: true, status: "sleeping" as any } : a)
                );
                try { await invoke("set_agent_paused", { agentId: agent.id, paused: true }); }
                catch (e) { console.error("Pause failed:", e); }
              }}
              style={{
                padding: "5px 11px", borderRadius: 6, border: "1px solid var(--border-subtle)",
                background: "var(--surface-card)", color: "var(--text-main)",
                fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
            >Pause</button>
            <button
              onClick={stepDownToBalanced}
              style={{
                padding: "5px 11px", borderRadius: 6, border: "none",
                background: "#3c6663", color: "white",
                fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
            >Switch to Balanced</button>
          </div>
        );
      })()}

      {/* ── Minimal single-line agent header ────────────────────────────────
          Avatar, name + role, a status dot + pill, and an overflow ⋯ menu
          for Edit Agent. The full description and edit form live behind the
          overflow to keep this row scannable. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, marginBottom: 16,
        padding: "10px 14px", background: "var(--surface-card)",
        border: "1px solid var(--border-subtle)", borderRadius: 14, flexShrink: 0,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: `${agent.robeColor || "#CCC"}15`,
          boxShadow: `0 0 0 1px ${agent.robeColor || "#CCC"}40`,
        }}>
          {/* Avatar micro-reactions: thinking shimmers, error tilts, otherwise breathes. */}
          <LobsterIcon
            size={36}
            role={agent.role}
            agentImage={agent.image}
            shellColor={agent.robeColor}
            accentColor={agent.accentColor}
            reactState={agent.paused ? "off" : agent.status === "thinking" ? "thinking" : agent.status === "error" ? "error" : "idle"}
          />
        </div>
        {isEditingDetails ? (
          <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 8 }}>
            <input value={tempName} onChange={e => setTempName(e.target.value)} placeholder="Name" style={{ fontSize: 14, fontWeight: 700, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", outline: "none", color: "var(--text-main)", width: 160 }} />
            <input value={tempRole} onChange={e => setTempRole(e.target.value)} placeholder="Role" style={{ fontSize: 13, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", outline: "none", color: "var(--text-sub)", width: 160 }} />
            <button onClick={saveDetails} style={{ padding: "6px 14px", background: "#3c6663", color: "white", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button>
            <button onClick={() => { setIsEditingDetails(false); setTempName(agent.name); setTempRole(agent.role); }} style={{ padding: "6px 12px", background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border-subtle)", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>Cancel</button>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)", whiteSpace: "nowrap" }}>{agent.name}</span>
              <span style={{ fontSize: 12, color: "var(--text-sub)", textTransform: "capitalize", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{agent.role}{agent.title ? ` · ${agent.title}` : ""}</span>
            </div>
            {/* Threads now live in the ThreadsRail on the left of the chat —
                no need for a header switcher. */}
            {/* Status dot + pill */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: agent.paused ? "var(--text-muted)" : (!gatewayReady || agent.status === "deploying") ? "#F4A83A" : agent.status === "thinking" ? "#8B6AAE" : agent.status === "error" ? "#E57373" : "#4A9E96",
                boxShadow: !agent.paused && agent.status === "active" ? "0 0 6px rgba(74,158,150,0.5)" : "none",
                animation: (!agent.paused && (!gatewayReady || agent.status === "deploying")) ? "pulse 1.5s ease-in-out infinite" : "none",
              }} />
              <span style={{ fontSize: 11, color: "var(--text-sub)", fontWeight: 500, textTransform: "capitalize" }}>
                {agent.paused ? "Paused" : (!gatewayReady || agent.status === "deploying") ? "Waking up…" : agent.status === "thinking" ? "Thinking…" : agent.status === "error" ? "Offline" : "Idle"}
              </span>
            </div>
            <button
              onClick={() => setIsEditingDetails(true)}
              title="Edit name and role"
              style={{
                padding: "6px 8px", background: "transparent", border: "1px solid var(--border-subtle)",
                borderRadius: 8, cursor: "pointer", color: "var(--text-sub)", display: "flex", alignItems: "center",
              }}
            >
              <Edit2 size={14} />
            </button>
          </>
        )}
      </div>

      {/* ── Quick actions row ───────────────────────────────────────────────
          Sit just above the chat panel — small affordances for the things a
          user most often wants to do next with this agent. Mini-apps is a
          forward-looking slot for the generative-UI work coming in Phase 2.
          Voice is a single-turn V1 (browser Web Speech API); the "Go live"
          sub-option is the path to bidirectional Gemini Live audio. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <button
          onClick={async () => {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              
              try {
                await invoke("show_browser", { agentId: agent.id });
              } catch (err) {
                console.log("Browser not running, starting it now...");
                await invoke("start_machine_browser", { agentId: agent.id });
                await new Promise(resolve => setTimeout(resolve, 500));
                await invoke("show_browser", { agentId: agent.id });
              }
              
              const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
              new WebviewWindow('chat_companion_' + agent.id + '_' + Date.now(), {
                url: `/index.html?chatCompanion=${agent.id}`,
                title: `${agent.name} Chat`,
                width: 380,
                height: 800,
                x: window.screen.availWidth - 400,
                y: 100,
                decorations: true,
                alwaysOnTop: true,
              });
            } catch (e) {
              console.error("Failed to launch co-browsing:", e);
              onNavigate?.("browser");
            }
          }}
          title={`Open ${agent.name}'s browser side-by-side so you can co-browse.`}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
            background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
            borderRadius: 12, fontSize: 13, fontWeight: 600, color: "var(--text-main)",
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s ease",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="16" cy="9" r="1"/></svg>
          Browse with me
        </button>
        <button
          onClick={() => {
            // Fire a chat send through the bridge event ChatTab listens for.
            window.dispatchEvent(new CustomEvent("canopy:send-chat", { detail: { agentId: agent.id, text: `Introduce yourself and tell me three concrete things you can help me with right now.` } }));
          }}
          title="Have the agent introduce themselves and pitch three things they can do."
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
            background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
            borderRadius: 12, fontSize: 13, fontWeight: 600, color: "var(--text-main)",
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s ease",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          What can you do?
        </button>
        <button
          disabled
          title="Coming soon — your agent will be able to spin up small apps and tools tailored to what you're working on. This is where they'll live."
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
            background: "var(--surface-card)", border: "1px dashed var(--border-subtle)",
            borderRadius: 12, fontSize: 13, fontWeight: 600, color: "var(--text-muted)",
            cursor: "not-allowed", fontFamily: "inherit",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          Mini-apps
          <span style={{ fontSize: 9, background: "var(--border-subtle)", color: "var(--text-sub)", padding: "1px 5px", borderRadius: 4, fontWeight: 700, letterSpacing: "0.02em" }}>SOON</span>
        </button>

        {/* Files — opens a popover with the agent's workspace files. Sits
            next to Mini-apps because they're adjacent concepts (artifacts vs
            apps), but the popover and the future mini-apps panel stay
            visually + conceptually distinct. */}
        <div ref={filesPopoverRef} style={{ position: "relative" }}>
          <button
            onClick={() => setFilesOpen(o => !o)}
            title={`Files ${agent.name} has created or that you've uploaded.`}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
              background: filesOpen ? "rgba(60,102,99,0.10)" : "var(--surface-card)",
              border: filesOpen ? "1px solid #3c6663" : "1px solid var(--border-subtle)",
              borderRadius: 12, fontSize: 13, fontWeight: 600,
              color: filesOpen ? "#218380" : "var(--text-main)",
              cursor: "pointer", fontFamily: "inherit",
              transition: "all 0.15s ease",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Files
          </button>
          <WorkspaceFilesDrawer agent={agent} open={filesOpen} onClose={() => setFilesOpen(false)} />
        </div>

        {/* Mini Apps — HTML tools saved from chat */}
        <div ref={appsPopoverRef} style={{ position: "relative" }}>
          <button
            onClick={() => setAppsOpen(o => !o)}
            title="Mini apps saved from your chats with this agent"
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
              background: appsOpen ? "rgba(129,140,248,0.1)" : "var(--surface-card)",
              border: appsOpen ? "1px solid #818CF8" : "1px solid var(--border-subtle)",
              borderRadius: 12, fontSize: 13, fontWeight: 600,
              color: appsOpen ? "#818CF8" : "var(--text-main)",
              cursor: "pointer", fontFamily: "inherit",
              transition: "all 0.15s ease",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            Apps
            {(agent.miniApps?.length ?? 0) > 0 && (
              <span style={{ fontSize: 10, background: "#818CF8", color: "#fff", borderRadius: 10, padding: "0 5px", marginLeft: 2, fontWeight: 700 }}>
                {agent.miniApps!.length}
              </span>
            )}
          </button>
          <MiniAppsDrawer agent={agent} open={appsOpen} onClose={() => setAppsOpen(false)} />
        </div>

        {/* Voice toggle — single-turn TTS playback of agent replies via the
            browser Web Speech API. The "Go live" button next to it is a
            different gesture: full bidirectional duplex voice. */}
        <button
          onClick={() => flipVoice(!voiceOn)}
          title={
            voiceOn
              ? `Voice on — ${agent.name}'s replies will be spoken aloud.`
              : `Voice off — turn on to hear ${agent.name}'s replies.`
          }
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
            background: voiceOn ? "rgba(33,131,128,0.10)" : "var(--surface-card)",
            border: voiceOn ? "1px solid #218380" : "1px solid var(--border-subtle)",
            borderRadius: 12, fontSize: 13, fontWeight: 600,
            color: voiceOn ? "#218380" : "var(--text-main)",
            cursor: "pointer", fontFamily: "inherit", marginLeft: "auto",
            transition: "all 0.15s ease",
          }}
        >
          {voiceOn ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
          )}
          Voice {voiceOn ? "on" : "off"}
        </button>

        {/* Go live — opens the modal overlay and starts a real-time duplex
            voice session via OpenClaw's realtime brain endpoint (Gemini Live).
            This is conceptually distinct from the voice toggle: that's
            "speak agent replies", this is "have a live conversation". */}
        <button
          onClick={() => setLiveOpen(true)}
          title={`Start a live voice call with ${agent.name}. Requires OpenClaw 2026.4.24 or newer.`}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
            background: "linear-gradient(135deg, #3c6663, #609995)",
            border: "1px solid #3c6663", color: "#fff",
            borderRadius: 12, fontSize: 13, fontWeight: 700,
            cursor: "pointer", fontFamily: "inherit",
            boxShadow: "0 2px 8px rgba(60,102,99,0.25)",
            transition: "all 0.15s ease",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          Go live
        </button>

        {/* "New conversation" used to live here — moved into the ThreadsRail
            as a more prominent "+ New chat" button at the top of the rail. */}
      </div>

      {/* Live voice overlay — only mounted while open. Mounting/unmounting
          aligns the audio session lifecycle with the user's intent. */}
      {liveOpen && <LiveVoiceOverlay agent={agent} onClose={() => setLiveOpen(false)} />}

      {/* ── Empty-state intro card ──────────────────────────────────────────
          Rendered above the chat when there's no conversation yet. Suggestion
          pills dispatch the same canopy:send-chat event the quick-actions row
          uses. Disappears the moment the agent has at least one exchange. */}
      {(!agent.chatLog || agent.chatLog.length === 0) && (
        <div style={{
          ...glass(0.5), padding: "20px 24px", borderRadius: 16, marginBottom: 16,
          display: "flex", alignItems: "center", gap: 16,
          borderLeft: `3px solid ${agent.robeColor || "#3c6663"}`,
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: "50%", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: `${agent.robeColor || "#CCC"}15`,
            boxShadow: `0 0 0 1px ${agent.robeColor || "#CCC"}40`,
          }}>
            <LobsterIcon
              size={48}
              role={agent.role}
              agentImage={agent.image}
              shellColor={agent.robeColor}
              accentColor={agent.accentColor}
              reactState="idle"
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
              Hi, I'm {agent.name}.
            </div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 10, lineHeight: 1.5 }}>
              Pick a starter below, or just type what you need.
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                "What kind of things should I bring to you?",
                "Help me think through what I'm working on today.",
                "Show me what you're best at.",
              ].map(text => (
                <button
                  key={text}
                  onClick={() => window.dispatchEvent(new CustomEvent("canopy:send-chat", { detail: { agentId: agent.id, text } }))}
                  style={{
                    padding: "6px 12px", borderRadius: 999,
                    background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
                    fontSize: 12, fontWeight: 500, color: "var(--text-main)",
                    cursor: "pointer", fontFamily: "inherit",
                    transition: "all 0.15s ease",
                  }}
                >{text}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Workbench row — chat (primary) + threads rail (left)
          Threads are now first-class: open by default, ~260px. Files moved
          to the popover in the quick-actions row. */}
      <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 480, minWidth: 0 }}>
        <ThreadsRail agent={agent} />
        <div style={{
          background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
          borderRadius: 16, display: "flex", flexDirection: "column",
          flex: 1, minHeight: 480, minWidth: 0, overflow: "hidden",
        }}>
          <ChatTab agent={agent} compact={false} />
        </div>
      </div>
    </div>
  );
}