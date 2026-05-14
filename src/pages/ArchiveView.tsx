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
// MAIN APP
// ─── Archive View ─────────────────────────────────────────────────────────────

function ArchiveView() {
  const { agents } = useWorldStore();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [bridgeFilter, setBridgeFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");

  useEffect(() => {
    const fetchArchive = async () => {
      setLoading(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const data: any = await invoke('get_global_audit_log', { limit: 200 });
        setLogs(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Failed to fetch global audit log", e);
      }
      setLoading(false);
    };
    fetchArchive();
  }, []);

  const getLogColor = (action: string) => {
    const a = action.toLowerCase();
    if (a.includes("spend") || a.includes("payment")) return { color: "#D4A04A", bg: "#D4A04A15", border: "#D4A04A40" };
    if (a.includes("blocked") || a.includes("failed") || a.includes("denied")) return { color: "#E57373", bg: "#E5737315", border: "#E5737340" };
    if (a.includes("created") || a.includes("spawn")) return { color: "#4A9E96", bg: "#4A9E9615", border: "#4A9E9640" };
    return { color: "var(--text-sub)", bg: "var(--border-subtle)", border: "var(--border-subtle)" };
  };

  const filteredLogs = logs.filter(log => {
    if (agentFilter !== "all" && log.agent_id !== agentFilter) return false;
    if (bridgeFilter !== "all") {
      if (!log.bridge_type && bridgeFilter !== "core") return false;
      if (log.bridge_type && log.bridge_type.toLowerCase() !== bridgeFilter) return false;
    }
    if (actionFilter !== "all") {
      if (actionFilter === "chatted" && log.action !== "chatted") return false;
      if (actionFilter !== "chatted" && !log.action.toLowerCase().includes(actionFilter)) return false;
    }
    return true;
  });

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "32px 40px", maxWidth: 1200, margin: "0 auto", width: "100%", height: "100%", overflow: "hidden" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: 0 }}>Archive</h1>
            <div style={{ background: "#4A9E9620", color: "#4A9E96", padding: "4px 10px", borderRadius: 12, fontSize: 13, fontWeight: 700 }}>LIVE</div>
          </div>
          <p style={{ fontSize: 15, color: "var(--text-sub)", margin: 0 }}>Everything your agents have done — decisions, actions, and anything flagged for review.</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)} style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, fontWeight: 600, color: "var(--text-main)", outline: "none", cursor: "pointer" }}>
          <option value="all">Every Agent</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={bridgeFilter} onChange={e => setBridgeFilter(e.target.value)} style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, fontWeight: 600, color: "var(--text-main)", outline: "none", cursor: "pointer" }}>
          <option value="all">All Connections</option>
          <option value="core">Canopy</option>
          <option value="slack">Slack</option>
          <option value="imessage">iMessage</option>
          <option value="payments">Virtual Cards</option>
        </select>
        <select value={actionFilter} onChange={e => setActionFilter(e.target.value)} style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontSize: 13, fontWeight: 600, color: "var(--text-main)", outline: "none", cursor: "pointer" }}>
          <option value="all">All Actions</option>
          <option value="chatted">Chats & Messages</option>
          <option value="created">Agent Spawns</option>
          <option value="spend">Financial Spends</option>
          <option value="denied">Blocks & Flags</option>
        </select>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-sub)" }}>Loading activity…</div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", ...glass(0.6), borderRadius: 16, border: "1px solid rgba(0,0,0,0.06)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--glass-heavy)", backdropFilter: "blur(8px)", zIndex: 1, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", width: 140 }}>Time</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", width: 180 }}>Agent</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", width: 160 }}>Service</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Action</th>
                <th style={{ padding: "16px 24px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "right" }}>ID</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 40, textAlign: "center", color: "var(--text-sub)", fontSize: 14 }}>Nothing matches these filters yet.</td>
                </tr>
              ) : filteredLogs.map((log) => {
                const mappedAgent = agents.find(a => a.id === log.agent_id);
                const styles = getLogColor(log.action);
                return (
                  <tr key={log.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.04)", cursor: "pointer", transition: "0.15s" }} onMouseOver={e => e.currentTarget.style.background = "rgba(0,0,0,0.02)"} onMouseOut={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "16px 24px", fontSize: 13, color: "var(--text-sub)" }}>{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    <td style={{ padding: "16px 24px", fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>
                      {log.agent_id ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: mappedAgent ? mappedAgent.robeColor : "#A0A0A0" }} />
                          {mappedAgent ? mappedAgent.name : "Unknown Agent"}
                        </div>
                      ) : "System Engine"}
                    </td>
                    <td style={{ padding: "16px 24px" }}>
                      <span style={{ padding: "4px 8px", background: "var(--border-subtle)", borderRadius: 6, fontSize: 12, fontWeight: 600, color: "var(--text-main)", textTransform: "capitalize" }}>
                        {log.bridge_type || "Core System"}
                      </span>
                    </td>
                    <td style={{ padding: "16px 24px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ display: "inline-block", padding: "2px 8px", background: styles.bg, color: styles.color, border: `1px solid ${styles.border}`, borderRadius: 4, fontSize: 11, fontWeight: 700, textTransform: "uppercase", width: "max-content", letterSpacing: "0.02em" }}>
                          {log.action}
                        </span>
                        <span style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.4 }}>{log.detail}</span>
                      </div>
                    </td>
                    <td style={{ padding: "16px 24px", textAlign: "right" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "#909090", background: "var(--border-subtle)", padding: "4px 8px", borderRadius: 4 }}>
                        {log.content_hash ? log.content_hash.substring(0, 8) : "N/A"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}