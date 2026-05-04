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

  const runAudit = async () => {
    setLoading(true);
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
        <div style={{ padding: 24, textAlign: "center" }}>Scanning OpenClaw Container...</div>
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
        </div>
      )}
    </div>
  );
}