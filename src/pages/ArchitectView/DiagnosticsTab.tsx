import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { 
  Terminal, Server, Globe, RefreshCw, CheckCircle2, X, AlertTriangle, Cpu, Play
} from "lucide-react";
import { AgentData } from "../../store/worldStore";

export function DiagnosticsTab({ agent }: { agent: AgentData }) {
  const [runningRouting, setRunningRouting] = useState(false);
  const [routingResult, setRoutingResult] = useState<boolean | null>(null);
  const [routingError, setRoutingError] = useState<string>("");

  const [runningBrowser, setRunningBrowser] = useState(false);
  const [browserResult, setBrowserResult] = useState<boolean | null>(null);

  const [runningConnections, setRunningConnections] = useState(false);
  const [connections, setConnections] = useState<any[]>([]);
  
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState("");

  const runRoutingTest = async () => {
    setRunningRouting(true);
    setRoutingResult(null);
    setRoutingError("");
    setRepairMsg("");
    try {
      // 1. Sync agent first to ensure it's mapped in the container
      await invoke("boot_sync_agents").catch(() => {});
      
      const success: boolean = await invoke("ping_agent_routing", { agentId: agent.id });
      setRoutingResult(success);
      if (!success) {
        setRoutingError("Agent failed to respond or OpenClaw routing is broken.");
      }
    } catch (e) {
      setRoutingResult(false);
      setRoutingError(String(e));
    }
    setRunningRouting(false);
  };

  const runBrowserTest = async () => {
    setRunningBrowser(true);
    setBrowserResult(null);
    try {
      const isResponsive: boolean = await invoke("ping_agent_browser", { agentId: agent.id });
      setBrowserResult(isResponsive);
    } catch (e) {
      setBrowserResult(false);
    }
    setRunningBrowser(false);
  };

  const runConnectionsTest = async () => {
    if (!agent.integrations || agent.integrations.length === 0) {
      setConnections([]);
      return;
    }
    setRunningConnections(true);
    setConnections([]);
    try {
      const results: any[] = await invoke("ping_agent_connections", { agentId: agent.id });
      setConnections(results);
    } catch (e) {
      console.error(e);
    }
    setRunningConnections(false);
  };

  const runAll = () => {
    runRoutingTest();
    if (agent.capabilities?.browser) runBrowserTest();
    runConnectionsTest();
  };

  useEffect(() => {
    runAll();
  }, [agent.id]);

  const handleRepair = async () => {
    setRepairing(true);
    setRepairMsg("Applying Repairs...");
    try {
      await invoke("repair_openclaw_config");
      await invoke("boot_sync_agents").catch(() => {});
      setRepairMsg("Repaired! Re-running tests...");
      runAll();
    } catch (e) {
      setRepairMsg("Repair failed: " + e);
    }
    setRepairing(false);
  };

  const handleRestartBrowser = async () => {
    try {
      await invoke("stop_machine_browser", { agentId: agent.id });
      setTimeout(runBrowserTest, 2000);
    } catch (e) {
      console.error("Failed to stop browser", e);
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 800, color: "var(--text-main)", margin: "0 0 8px 0" }}>Agent Diagnostics</h2>
          <p style={{ fontSize: 13, color: "var(--text-sub)", margin: 0 }}>
            End-to-end health checks for {agent.name}'s specific environment and integrations.
          </p>
        </div>
        <button 
          onClick={runAll}
          style={{ background: "#218380", color: "white", padding: "8px 16px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
        >
          <Play size={14} /> Run All Tests
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        
        {/* Routing / Core Health */}
        <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <Server size={18} /> OpenClaw Message Routing
              </div>
              <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Verifies that the OpenClaw gateway can actively route messages and receive model completions for this agent.</div>
            </div>
            {runningRouting ? (
              <RefreshCw size={18} className="spin" color="var(--text-sub)" />
            ) : routingResult === true ? (
              <CheckCircle2 size={24} color="#4A9E96" />
            ) : routingResult === false ? (
              <X size={24} color="#E57373" />
            ) : null}
          </div>

          {routingResult === false && (
            <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: 16, marginTop: 16 }}>
              <div style={{ fontWeight: 600, color: "#B91C1C", fontSize: 13, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={14} /> Routing Check Failed
              </div>
              <div style={{ fontSize: 12, color: "#991B1B", marginBottom: 16 }}>
                {routingError}
              </div>
              <button 
                onClick={handleRepair}
                disabled={repairing}
                style={{ background: "#B91C1C", color: "white", padding: "6px 12px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              >
                {repairing ? "Repairing..." : "Auto-Repair Configuration"}
              </button>
              {repairMsg && <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 8 }}>{repairMsg}</div>}
            </div>
          )}
        </div>

        {/* Browser Health */}
        {agent.capabilities?.browser && (
          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Globe size={18} /> Machine Browser Process
                </div>
                <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Checks if the dedicated Chromium process for this agent is alive and accepting CDP connections.</div>
              </div>
              {runningBrowser ? (
                <RefreshCw size={18} className="spin" color="var(--text-sub)" />
              ) : browserResult === true ? (
                <CheckCircle2 size={24} color="#4A9E96" />
              ) : browserResult === false ? (
                <X size={24} color="#E57373" />
              ) : null}
            </div>

            {browserResult === false && (
              <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: 16, marginTop: 16 }}>
                <div style={{ fontWeight: 600, color: "#B91C1C", fontSize: 13, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={14} /> Browser Unresponsive
                </div>
                <div style={{ fontSize: 12, color: "#991B1B", marginBottom: 16 }}>
                  The browser container is either stopped or the process has hung.
                </div>
                <button 
                  onClick={handleRestartBrowser}
                  style={{ background: "#B91C1C", color: "white", padding: "6px 12px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                >
                  Restart Browser Process
                </button>
              </div>
            )}
          </div>
        )}

        {/* Connected Services Health */}
        {agent.integrations && agent.integrations.length > 0 && (
          <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Cpu size={18} /> API & Service Connections
                </div>
                <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Pings the third-party integrations {agent.name} is configured to use.</div>
              </div>
              {runningConnections ? (
                <RefreshCw size={18} className="spin" color="var(--text-sub)" />
              ) : (
                <button onClick={runConnectionsTest} style={{ background: "transparent", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600 }}>
                  <RefreshCw size={12} /> Retry
                </button>
              )}
            </div>

            {connections.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {connections.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px", background: "white", borderRadius: 8, border: "1px solid rgba(0,0,0,0.05)" }}>
                    <div style={{ marginTop: 2 }}>
                      {c.is_ok ? <CheckCircle2 size={16} color="#4A9E96" /> : <X size={16} color="#E57373" />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: c.is_ok ? "var(--text-main)" : "#aa371c" }}>
                        {c.service}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>
                        {c.message}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : runningConnections ? (
              <div style={{ fontSize: 12, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>
                Pinging services...
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>
                No connection diagnostics ran.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
