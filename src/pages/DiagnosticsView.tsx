import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, AlertTriangle
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../store/worldStore";
import type { GenerativeResult } from "../types/generative";
import { Toggle, ServiceRow, glass } from "../App";

export // ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function DiagnosticsView() {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [agentDiagnostics, setAgentDiagnostics] = useState<{agentName: string, diagnostics: any[]}[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [applyingMemory, setApplyingMemory] = useState(false);

  const runConnectionDiagnostics = async () => {
    setLoadingConnections(true);
    try {
      const agents: any[] = await invoke("list_agents");
      const results = [];
      for (const agent of agents) {
        if (agent.integrations && agent.integrations.length > 0) {
          const diags: any[] = await invoke("ping_agent_connections", { agentId: agent.id });
          results.push({ agentName: agent.name, diagnostics: diags });
        }
      }
      setAgentDiagnostics(results);
    } catch (e) {
      console.error(e);
    }
    setLoadingConnections(false);
  };

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  useEffect(() => {
    const unlisten = listen<string>("diagnostics-log", (event) => {
      setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${event.payload}`]);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const runAudit = async () => {
    setLoading(true);
    setLogs([]);
    setRepairMsg("");
    try {
      const res = await invoke("audit_openclaw_config");
      setReport(res);
    } catch (e) {
      console.error(e);
      setReport({ error: String(e) });
    }
    setLoading(false);
  };

  useEffect(() => {
    runAudit();
    runConnectionDiagnostics();
  }, []);

  const handleRepair = async () => {
    setRepairing(true);
    setRepairMsg("");
    try {
      const msg = await invoke("repair_openclaw_config", { targetModel: null });
      setRepairMsg(String(msg));
      runAudit();
    } catch (e) {
      setRepairMsg("Error: " + String(e));
    }
    setRepairing(false);
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Noto Serif', Georgia, serif", color: "var(--text-main)", marginBottom: 8 }}>System Diagnostics</div>
      <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 32 }}>Audit openclaw configuration and repair alignment mismatches.</div>

      {loading ? (
        <div style={{ padding: 24, background: "var(--glass-light)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
            <RefreshCw className="spin" size={16} /> Scanning OpenClaw Container...
          </div>
          <div style={{ background: "rgba(0,0,0,0.8)", color: "#00ff00", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, height: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {logs.map((log, i) => <div key={i}>{log}</div>)}
            <div ref={logsEndRef} />
          </div>
        </div>
      ) : report?.error ? (
        <div style={{ padding: 24, border: "1px dashed #dca5a5", background: "#fcf2f2", color: "#aa371c" }}>
          <b>Audit Failed:</b> {report.error}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontWeight: 600 }}>Alignment Status</div>
              <div style={{ background: report.is_aligned ? "#4A9E96" : "#E57373", color: "white", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                {report.is_aligned ? "ALIGNED" : "MISCONFIGURED"}
              </div>
            </div>

            <div style={{ fontSize: 13, color: "var(--text-main)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div><b>Container Online:</b> {report.container_running ? "Yes" : "No"}</div>
              <div><b>Active Container Default Model:</b> {report.active_default_model}</div>
              <div><b>Expected Based on APIs:</b> {report.expected_model}</div>
              {report.missing_keys.length > 0 && (
                <div style={{ color: "#aa371c" }}><b>Missing API Keys for Default:</b> {report.missing_keys.join(", ")}</div>
              )}
              <div><b>Ports Synchronized:</b> {report.port_mismatch ? "No" : "Yes"}</div>
              <hr style={{ margin: "8px 0", borderTop: "1px solid rgba(0,0,0,0.05)" }} />
              <div><b>Slack DM Policy (Open):</b> {report.slack_group_policy_open ? <span style={{ color: "#4A9E96", fontWeight: 600 }}>Verified</span> : <span style={{ color: "#E57373", fontWeight: 600 }}>Restricted (Agents cannot reply)</span>}</div>
              <div><b>GitHub Authentication (Injected):</b> {report.github_token_injected ? <span style={{ color: "#4A9E96", fontWeight: 600 }}>Active</span> : "Not configured or missing"}</div>
            </div>

            {!report.is_aligned && (
              <button onClick={handleRepair} disabled={repairing} style={{ marginTop: 24, background: "#218380", color: "white", border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
                {repairing ? "Repairing..." : "Auto-Repair Configuration"}
              </button>
            )}
            {repairMsg && <div style={{ fontSize: 12, marginTop: 12, color: repairMsg.startsWith("Error") ? "#aa371c" : "#218380" }}>{repairMsg}</div>}
          </div>

          {report.raw_config_json && (
            <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Raw OpenClaw Configuration</div>
              <pre style={{ fontSize: 10, background: "rgba(0,0,0,0.02)", padding: 12, borderRadius: 8, overflowX: "auto", color: "var(--text-sub)" }}>
                {report.raw_config_json}
              </pre>
            </div>
          )}

          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <Terminal size={16} /> Machine Browser Controls
            </div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 16 }}>
              Forcefully terminate all active Chrome browser sessions managed by OpenClaw. Use this as a panic button if the browser proxy becomes stuck or unresponsive.
            </div>
            <button 
              onClick={async () => {
                try {
                  await invoke("reset_machine_browsers");
                  setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Browsers successfully reset.`]);
                } catch (e) {
                  setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Error resetting browsers: ${e}`]);
                }
              }} 
              style={{ background: "#aa371c", color: "white", border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}
            >
              <Zap size={16} /> Force Reset Browsers
            </button>
          </div>

          {/* ── OrbStack / VM memory ── */}
          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <Server size={16} /> Infrastructure — OrbStack VM Memory
            </div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 16 }}>
              Canopy requires the OrbStack Linux VM to have at least <strong>16 GB</strong> of RAM.
              Running below this causes OpenClaw to be killed mid-task (exit 137 / OOM).
              This button reads <code style={{ fontSize: 11, background: "rgba(0,0,0,0.05)", padding: "1px 5px", borderRadius: 4 }}>~/.orbstack/config/config.json</code> and raises
              the limit if needed, then restarts the VM.
            </div>
            <button
              onClick={async () => {
                setApplyingMemory(true);
                setMemoryStatus(null);
                try {
                  const msg: string = await invoke("configure_orbstack_memory");
                  setMemoryStatus(msg);
                } catch (e) {
                  setMemoryStatus("Error: " + String(e));
                }
                setApplyingMemory(false);
              }}
              disabled={applyingMemory}
              style={{
                background: "#218380", color: "white", border: "none",
                padding: "8px 16px", borderRadius: 8, cursor: applyingMemory ? "default" : "pointer",
                fontWeight: 600, display: "flex", alignItems: "center", gap: 8,
                opacity: applyingMemory ? 0.6 : 1,
              }}
            >
              <HardDrive size={15} />
              {applyingMemory ? "Applying (restarting VM…)" : "Ensure 16 GB VM Memory"}
            </button>
            {memoryStatus && (
              <div style={{
                marginTop: 12, fontSize: 12, padding: "8px 12px", borderRadius: 8,
                background: memoryStatus.startsWith("Error") ? "rgba(239,68,68,0.08)" : "rgba(74,158,150,0.08)",
                color: memoryStatus.startsWith("Error") ? "#aa371c" : "#218380",
                border: `1px solid ${memoryStatus.startsWith("Error") ? "rgba(239,68,68,0.2)" : "rgba(74,158,150,0.2)"}`,
              }}>
                {memoryStatus}
              </div>
            )}
          </div>

          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)", marginTop: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Activity size={16} /> Agent Connection Health
              </div>
              <button 
                onClick={runConnectionDiagnostics} 
                disabled={loadingConnections}
                style={{ background: "transparent", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 8, padding: "4px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
              >
                <RefreshCw size={12} className={loadingConnections ? "spin" : ""} /> Refresh
              </button>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 16 }}>
              Verifies the live connection status for each agent's configured 3rd-party integrations using their saved credentials.
            </div>

            {loadingConnections ? (
              <div style={{ padding: 20, textAlign: "center", color: "var(--text-sub)", fontSize: 13 }}>Pinging services...</div>
            ) : agentDiagnostics.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: "var(--text-sub)", fontSize: 13 }}>No active connections found for any agents.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {agentDiagnostics.map((ad, idx) => (
                  <div key={idx} style={{ background: "rgba(0,0,0,0.02)", padding: 16, borderRadius: 8 }}>
                    <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>{ad.agentName}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {ad.diagnostics.map((diag: any, dIdx: number) => (
                        <div key={dIdx} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "8px 12px", background: "white", borderRadius: 8, border: "1px solid rgba(0,0,0,0.05)" }}>
                          <div style={{ marginTop: 2 }}>
                            {/* level "warn" = enabled but unverified / capability gap —
                                amber, same semantics as the per-agent Diagnostics tab */}
                            {!diag.is_ok ? <X size={16} color="#E57373" />
                              : diag.level === "warn" ? <AlertTriangle size={16} color="#B58A2E" />
                              : <CheckCircle2 size={16} color="#4A9E96" />}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: !diag.is_ok ? "#aa371c" : diag.level === "warn" ? "#8A6614" : "var(--text-main)" }}>
                              {diag.service}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>
                              {diag.message}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
