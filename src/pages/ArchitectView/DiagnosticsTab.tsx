import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Terminal, Server, Globe, RefreshCw, CheckCircle2, X, AlertTriangle, Cpu, Play, MessageCircle
} from "lucide-react";
import { AgentData } from "../../store/worldStore";

export function DiagnosticsTab({ agent, onNavigate }: { agent: AgentData, onNavigate?: (tab: string) => void }) {
  const [runningRouting, setRunningRouting] = useState(false);
  const [routingResult, setRoutingResult] = useState<boolean | null>(null);
  const [routingError, setRoutingError] = useState<string>("");

  const [runningBrowser, setRunningBrowser] = useState(false);
  const [browserResult, setBrowserResult] = useState<boolean | null>(null);

  const [runningConnections, setRunningConnections] = useState(false);
  const [connections, setConnections] = useState<any[]>([]);
  
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState("");

  // Browser-restart UX: the previous version called only stop_machine_browser
  // and then re-tested 2s later. That always reports "not running" because
  // stop_machine_browser doesn't restart anything. The button looked broken.
  // We now show a multi-step progress message and call start_machine_browser
  // (which is idempotent: kills any existing + starts fresh + ensures JIT proxy).
  const [restartingBrowser, setRestartingBrowser] = useState(false);
  const [restartBrowserMsg, setRestartBrowserMsg] = useState("");

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
        setRoutingError(`${agent.name} didn't respond. Try auto-repair below — if that doesn't help, hard-reset from the agent's Home tab.`);
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

  // Ask the agent itself to introspect its connections. In practice the agent
  // is often more accurate than our system-side checks — it sees the actual
  // env vars, auth-profile files, and the errors it gets when it tries to use
  // them. The structured prompt forces it to actually attempt a trivial call
  // per integration rather than just reciting what's "configured".
  const handleAskAgent = async () => {
    const prompt = [
      "Run a self-diagnostic and report back, no preamble. For EACH integration you have configured (Slack, Gmail/Google, GitHub, browser, etc.):",
      "",
      "1. List the credentials/tokens you can see (env vars, auth-profiles.json — describe what's there, NEVER paste actual token values).",
      "2. Attempt one cheap test call (Slack: auth.test; Gmail: list 1 message; GitHub: /user; browser: navigate to about:blank). Report the exact response or error.",
      "3. State plainly: working / partially working / broken, and why.",
      "",
      "Finish with a one-line summary of which integrations are actually usable right now.",
    ].join("\n");

    try {
      await invoke("send_message", {
        agentId: agent.id,
        message: prompt,
        sessionId: `diagnostics_${agent.id}`,
      });
    } catch (e) {
      console.error("Failed to send diagnostic prompt to agent:", e);
    }
    // Switch to the chat tab so the user sees the reply stream in.
    if (onNavigate) onNavigate("chat");
  };

  const handleRestartBrowser = async () => {
    setRestartingBrowser(true);
    setRestartBrowserMsg("Stopping any existing Chrome process...");
    try {
      // Step 1: stop. Safe to call even if nothing is running — kill_leftover_processes
      // cleans up SIGTERM/SIGKILL pairs.
      await invoke("stop_machine_browser", { agentId: agent.id }).catch(() => {});

      // Step 2: actually start a fresh process. start_machine_browser is
      // idempotent on the Rust side (start_browser kills any existing entry
      // for this agent, runs kill_leftover_processes, then spawns Chrome).
      // Without this call the previous "restart" was a stop-only no-op and
      // the button appeared broken.
      setRestartBrowserMsg("Starting a fresh browser for this agent...");
      await invoke("start_machine_browser", { agentId: agent.id });

      // Step 3: give Chrome ~3s to bind the CDP port and accept connections
      // before we re-probe. start_machine_browser returns once the spawn call
      // succeeds, but the CDP /json/version endpoint takes a moment to come up.
      setRestartBrowserMsg("Waiting for CDP endpoint to come up...");
      await new Promise(r => setTimeout(r, 3000));

      setRestartBrowserMsg("Verifying...");
      await runBrowserTest();
      setRestartBrowserMsg("");
    } catch (e: any) {
      console.error("Failed to restart browser", e);
      setRestartBrowserMsg("Restart failed: " + (e?.toString?.() || e));
    } finally {
      setRestartingBrowser(false);
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

        {/* Ask the agent itself — often more accurate than our system-side checks.
            The agent sees its actual env vars and what happens when it tries to
            use them, whereas system checks can miss runtime/wiring issues. */}
        <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 20, border: "1px solid rgba(0,0,0,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <MessageCircle size={18} /> Ask {agent.name} About Connections
            </div>
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>
              Send {agent.name} a structured self-diagnostic prompt. They'll attempt a real test call for each integration and report what actually works. Often catches things the system checks miss.
            </div>
          </div>
          <button
            onClick={handleAskAgent}
            style={{ background: "#3c6663", color: "white", padding: "8px 16px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}
          >
            <MessageCircle size={14} /> Ask {agent.name}
          </button>
        </div>

        {/* Routing / Core Health */}
        <div style={{ background: "var(--glass-light)", borderRadius: 16, padding: 24, border: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <Server size={18} /> Can the agent respond?
              </div>
              <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Sends a test message to {agent.name} and checks it comes back with a reply.</div>
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
                  disabled={restartingBrowser}
                  style={{ background: "#B91C1C", color: "white", padding: "6px 12px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 600, cursor: restartingBrowser ? "default" : "pointer", opacity: restartingBrowser ? 0.7 : 1 }}
                >
                  {restartingBrowser ? "Restarting..." : "Restart Browser Process"}
                </button>
                {restartBrowserMsg && (
                  <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 8 }}>
                    {restartBrowserMsg}
                  </div>
                )}
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
