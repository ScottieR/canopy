import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, glass } from "../../App";
import { ChatTab } from "./ChatTab";

export // ─── Activity Tab ────────────────────────────────────────────────────────────

function ActivityTab({ agent }: { agent: AgentData }) {
  const [recentLogs, setRecentLogs] = useState<any[]>([]);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const data: any = await invoke('get_global_audit_log', { limit: 50, agentId: agent.id });
        setRecentLogs(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Failed to fetch recent audit log", e);
      }
    };
    fetchLogs();
  }, [agent.id]);

  return (
    <div style={{ display: "flex", gap: 24, height: "100%", width: "100%", overflow: "hidden", minHeight: 0 }}>
      {/* Left side: Chat (2/3 width) */}
      <div style={{ flex: 2, display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
        <ChatTab agent={agent} compact={false} />
      </div>

      {/* Right side: Activity Feed (1/3 width) */}
      <div style={{ flex: 1, ...glass(0.5), padding: "20px 24px", borderRadius: 16, display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 16 }}>Activity Feed</div>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 8 }}>
          {recentLogs && recentLogs.length > 0 ? (
             recentLogs.map((log: any, i: number) => {
               let color = "var(--text-main)";
               let bg = "var(--surface-base)";
               if (log.action === "chatted") {
                 color = "#4A9E96";
                 bg = "#4A9E9615";
               } else if (log.action.includes("spend")) {
                 color = "#D4A04A";
                 bg = "#D4A04A15";
               } else if (log.action.includes("denied") || log.action.includes("failed")) {
                 color = "#E57373";
                 bg = "#E5737315";
               }
               return (
                 <div key={i} style={{ fontSize: 13, color: "var(--text-main)", padding: "10px 14px", background: "var(--surface-base)", borderRadius: 8, border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 4 }}>
                   <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                     <strong style={{ color: color, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", background: bg, padding: "2px 6px", borderRadius: 4 }}>
                       {log.action} {log.bridge_type ? `via ${log.bridge_type}` : ""}
                     </strong>
                     <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                       {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                     </span>
                   </div>
                   <div style={{ color: "var(--text-sub)", fontSize: 12, lineHeight: 1.4, marginTop: 4 }}>
                     {log.detail}
                   </div>
                 </div>
               );
             })
          ) : (
             <div style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", textAlign: "center", marginTop: 40 }}>
               No recent activity recorded.
             </div>
          )}
        </div>
      </div>
    </div>
  );
}