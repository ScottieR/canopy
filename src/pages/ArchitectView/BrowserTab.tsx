import React, { useState, useEffect } from "react";
import { 
  Globe, Play, Square, Shield, Lock, AlertTriangle, 
  ExternalLink, Eye, RefreshCw, Terminal, Monitor, 
  Zap, Settings, Info, CheckCircle2, Activity
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentData, useWorldStore, BrowserStatus } from "../../store/worldStore";
import { glass, Toggle } from "../../App";

export function BrowserTab({ agent }: { agent: AgentData }) {
  const updateAgentBrowserStatus = useWorldStore(s => s.updateAgentBrowserStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameData, setFrameData] = useState<string | null>(null);

  const browserStatus = agent.browser_status;
  const isRunning = browserStatus?.is_running || false;

  const refreshStatus = async () => {
    try {
      const status: BrowserStatus | null = await invoke("get_browser_status", { agentId: agent.id });
      updateAgentBrowserStatus(agent.id, status);
    } catch (e) {
      console.error("Failed to get browser status:", e);
    }
  };

  useEffect(() => {
    refreshStatus();
    
    let unlisten: () => void;
    listen<any>("browser_stream_frame", (e) => {
      if (e.payload.agent_id === agent.id) {
        setFrameData(e.payload.frame);
      }
    }).then(f => {
      unlisten = f;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [agent.id]);

  const handleShowBrowser = async () => {
    try {
      await invoke("show_browser", { agentId: agent.id });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleHideBrowser = async () => {
    try {
      await invoke("hide_browser", { agentId: agent.id });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header / Main Control */}
      <div style={{ ...glass(0.6), padding: 24, borderRadius: 20, border: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ 
              width: 48, height: 48, borderRadius: 12, 
              background: isRunning ? "rgba(60, 102, 99, 0.1)" : "var(--surface-base)", 
              display: "flex", alignItems: "center", justifyContent: "center",
              color: isRunning ? "#3c6663" : "var(--text-sub)"
            }}>
              <Monitor size={24} />
            </div>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--text-main)" }}>Machine Browser</h2>
              <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "4px 0 0 0" }}>
                Browser dynamically spawns off-screen only when the agent requests it.
              </p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {loading && <RefreshCw size={16} className="animate-spin" style={{ color: "var(--text-sub)" }} />}
            {isRunning ? (
              <>
                <button onClick={handleShowBrowser} style={{ padding: "6px 12px", borderRadius: 8, background: "#3c6663", color: "white", border: "none", fontWeight: 600, display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 }}>
                  Bring to Front
                </button>
                <button onClick={handleHideBrowser} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--surface-base)", color: "var(--text-main)", border: "1px solid var(--border-subtle)", fontWeight: 600, display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 }}>
                  Hide Off-Screen
                </button>
              </>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-sub)", fontWeight: 600, padding: "6px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
                JIT Proxy Idle
              </span>
            )}
          </div>
        </div>

        {error && (
          <div style={{ 
            background: "rgba(229, 115, 115, 0.1)", border: "1px solid rgba(229, 115, 115, 0.3)", 
            borderRadius: 12, padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center",
            color: "#c62828", fontSize: 13
          }}>
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div style={{ background: "var(--surface-base)", padding: 12, borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 4 }}>Status</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: isRunning ? "#3c6663" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              {isRunning ? <><CheckCircle2 size={14} /> Active</> : "Offline"}
            </div>
          </div>
          <div style={{ background: "var(--surface-base)", padding: 12, borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 4 }}>CDP Port</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>
              {browserStatus?.port || "—"}
            </div>
          </div>
          <div style={{ background: "var(--surface-base)", padding: 12, borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 4 }}>Type</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Host Bridge</div>
          </div>
        </div>
      </div>

      {/* Profile Info */}
      {isRunning && (
        <div style={{ ...glass(0.4), padding: 20, borderRadius: 16, border: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Shield size={16} style={{ color: "#3c6663" }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Sandbox Profile</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", background: "var(--surface-base)", padding: 10, borderRadius: 8, fontFamily: "monospace", overflowX: "auto" }}>
            {browserStatus?.profile_path}
          </div>
          <p style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 10, lineHeight: 1.4 }}>
            This agent is using a strictly isolated browser profile. It cannot see your primary Chrome tabs, history, or passwords.
          </p>
        </div>
      )}

      {/* File Exfiltration Edge-Case Warning */}
      {isRunning && agent.permissions?.find(p => p.id === "file_write")?.enabled && (
        <div style={{ padding: 16, background: "rgba(212, 160, 74, 0.1)", border: "1px solid rgba(212, 160, 74, 0.3)", borderRadius: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertTriangle size={20} color="#D4A04A" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#D4A04A", marginBottom: 4 }}>Security Warning: File Exfiltration Risk</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
              This agent has <strong>File System Write</strong> permissions enabled. While its browser profile is isolated, it could theoretically download files from the web into its workspace and use its file-write tools to copy them elsewhere on your local disk. 
              Only use this combination if explicitly needed.
            </div>
          </div>
        </div>
      )}

      {/* Guardrails Section */}
      <div style={{ ...glass(0.4), padding: 20, borderRadius: 16, border: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Lock size={16} style={{ color: "#D4A04A" }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Active Guardrails</span>
        </div>
        
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Globe size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Navigation Approval</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Pauses agent on sensitive domains</div>
              </div>
            </div>
            <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Eye size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Optical Monitoring</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Headed mode ensures visibility</div>
              </div>
            </div>
            <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Zap size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Bot-Blocker Bypass</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Using high-fidelity host fingerprint</div>
              </div>
            </div>
            <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
          </div>
        </div>
      </div>

      {/* Live View */}
      {isRunning && (
        <div style={{ 
          background: "#000", borderRadius: 16, overflow: "hidden", 
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          color: "white", border: "1px solid rgba(255,255,255,0.1)",
          backgroundImage: frameData ? "none" : "linear-gradient(45deg, #000 25%, #111 25%, #111 50%, #000 50%, #000 75%, #111 75%, #111 100%)",
          backgroundSize: "20px 20px",
          position: "relative",
          minHeight: 300,
        }}>
          {frameData ? (
            <img 
              src={`data:image/jpeg;base64,${frameData}`} 
              style={{ width: "100%", height: "auto", display: "block" }} 
              alt="Live Browser View" 
            />
          ) : (
            <>
              <Monitor size={32} opacity={0.5} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 14, fontWeight: 600 }}>Connecting to Host Browser...</div>
            </>
          )}
          
          <div style={{ 
            position: "absolute", top: 12, right: 12, 
            display: "flex", gap: 8, alignItems: "center" 
          }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: frameData ? "#10b981" : "#f59e0b", boxShadow: "0 0 8px currentColor" }}></div>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", background: "rgba(0,0,0,0.6)", padding: "4px 8px", borderRadius: 6, backdropFilter: "blur(4px)" }}>
              {frameData ? "LIVE" : "WAITING"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
