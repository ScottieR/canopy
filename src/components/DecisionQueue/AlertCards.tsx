import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldAlert, AlertTriangle, CheckCircle, Info } from "lucide-react";
import { SecurityAlert, SystemWarning, useWorldStore } from "../../store/worldStore";

export function SecurityAlertCard({ alert }: { alert: SecurityAlert }) {
  const { agents, resolveSecurityAlertState, setSelectedAgent, setArchitectTab, setActiveView } = useWorldStore();
  const agent = agents.find(a => a.id === alert.agent_id);

  const handleResolve = async () => {
    try {
      await invoke("resolve_network_security_alert", { alertId: alert.id });
      resolveSecurityAlertState(alert.id);
    } catch (e) {
      console.error(e);
    }
  };


  const handleFixAction = () => {
    setSelectedAgent(alert.agent_id);
    setArchitectTab("diagnostics");
    setActiveView("architect");
  };

  return (
    <div style={{ background: "var(--surface-card)", border: "1px solid #FCA5A5", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ background: "#FEF2F2", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #FCA5A5" }}>
        <ShieldAlert size={14} color="#DC2626" />
        <div style={{ fontSize: 11, fontWeight: 700, color: "#DC2626", textTransform: "uppercase", letterSpacing: "0.05em" }}>Security Alert · {alert.severity} Risk</div>
      </div>
      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Agent: {agent?.name || alert.agent_id}</div>
        <div style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.4, marginBottom: 12 }}>{alert.description}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleResolve} style={{ flex: 1, padding: "6px 0", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--text-main)" }}>
            Dismiss
          </button>
          <button onClick={handleFixAction} style={{ flex: 1, padding: "6px 0", background: "#DC2626", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "white" }}>
            Fix Issue
          </button>
        </div>
      </div>
    </div>
  );
}

export function SystemWarningCard({ warning }: { warning: SystemWarning }) {
  const { agents, resolveSystemWarningState, setSelectedAgent, setArchitectTab, setActiveView } = useWorldStore();
  const agent = agents.find(a => a.id === warning.agent_id);

  const handleResolve = async () => {
    try {
      await invoke("resolve_system_warning", { warningId: warning.id });
      resolveSystemWarningState(warning.id);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFixAction = () => {
    setSelectedAgent(warning.agent_id);
    setArchitectTab("diagnostics");
    setActiveView("architect");
  };

  const hasFixAction = true;

  return (
    <div style={{ background: "var(--surface-card)", border: "1px solid #FCD34D", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ background: "#FFFBEB", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #FCD34D" }}>
        <AlertTriangle size={14} color="#D97706" />
        <div style={{ fontSize: 11, fontWeight: 700, color: "#D97706", textTransform: "uppercase", letterSpacing: "0.05em" }}>System Warning</div>
      </div>
      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Agent: {agent?.name || warning.agent_id}</div>
        <div style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.4, marginBottom: 12 }}>{warning.message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleResolve} style={{ flex: 1, padding: "6px 0", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--text-main)" }}>
            Dismiss
          </button>
          {hasFixAction && (
            <button onClick={handleFixAction} style={{ flex: 1, padding: "6px 0", background: "#D97706", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "white" }}>
              Fix Issue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
