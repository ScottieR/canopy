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
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});

  const groupedLogs = useMemo(() => {
    if (!recentLogs || recentLogs.length === 0) return [];
    
    // Sort from oldest to newest to build sessions properly
    const sorted = [...recentLogs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    const groups: any[] = [];
    let currentSession: any = null;

    sorted.forEach(log => {
      if (log.action === "chatted") {
        const logTime = new Date(log.timestamp).getTime();
        
        if (currentSession) {
          const lastLogTime = new Date(currentSession.logs[currentSession.logs.length - 1].timestamp).getTime();
          if (logTime - lastLogTime < 60 * 60 * 1000) { // < 60 mins
            currentSession.logs.push(log);
            if (!currentSession.topicSummary && log.detail.toLowerCase().includes("user said:")) {
              const text = log.detail.replace(/user said:/i, "").trim();
              currentSession.topicSummary = text.length > 50 ? text.slice(0, 50) + "..." : text;
            }
          } else {
            groups.push(currentSession);
            const isUser = log.detail.toLowerCase().includes("user said:");
            const text = isUser ? log.detail.replace(/user said:/i, "").trim() : "";
            currentSession = {
              type: "session",
              id: log.timestamp,
              timestamp: log.timestamp,
              logs: [log],
              topicSummary: text ? (text.length > 50 ? text.slice(0, 50) + "..." : text) : "Chat interaction"
            };
          }
        } else {
          const isUser = log.detail.toLowerCase().includes("user said:");
          const text = isUser ? log.detail.replace(/user said:/i, "").trim() : "";
          currentSession = {
            type: "session",
            id: log.timestamp,
            timestamp: log.timestamp,
            logs: [log],
            topicSummary: text ? (text.length > 50 ? text.slice(0, 50) + "..." : text) : "Chat interaction"
          };
        }
      } else {
        if (currentSession) {
          groups.push(currentSession);
          currentSession = null;
        }
        groups.push({ type: "single", id: log.timestamp + Math.random(), log, timestamp: log.timestamp });
      }
    });

    if (currentSession) {
      groups.push(currentSession);
    }

    // Sort back to newest first
    return groups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [recentLogs]);

  const toggleSession = (id: string) => {
    setExpandedSessions(prev => ({ ...prev, [id]: !prev[id] }));
  };

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
          {groupedLogs && groupedLogs.length > 0 ? (
             groupedLogs.map((group, i) => {
               if (group.type === "single") {
                 const log = group.log;
                 let color = "var(--text-main)";
                 let bg = "var(--surface-base)";
                 if (log.action.includes("spend")) {
                   color = "#D4A04A";
                   bg = "#D4A04A15";
                 } else if (log.action.includes("denied") || log.action.includes("failed")) {
                   color = "#E57373";
                   bg = "#E5737315";
                 }
                 return (
                   <div key={group.id} style={{ fontSize: 13, color: "var(--text-main)", padding: "10px 14px", background: "var(--surface-base)", borderRadius: 8, border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 4 }}>
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
               } else {
                 const isExpanded = expandedSessions[group.id];
                 return (
                   <div key={group.id} style={{ fontSize: 13, color: "var(--text-main)", background: "var(--surface-base)", borderRadius: 8, border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                     <div 
                       onClick={() => toggleSession(group.id)}
                       style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: isExpanded ? "rgba(0,0,0,0.02)" : "transparent" }}
                     >
                       <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                         <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                           <strong style={{ color: "#4A9E96", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", background: "#4A9E9615", padding: "2px 6px", borderRadius: 4 }}>
                             Chat Session
                           </strong>
                           <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>{group.logs.length} messages</span>
                         </div>
                         <div style={{ color: "var(--text-main)", fontSize: 12, fontWeight: 500 }}>
                           "{group.topicSummary}"
                         </div>
                       </div>
                       <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                         <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                           {new Date(group.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                         </span>
                         <div style={{ color: "var(--text-muted)", transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)", transition: "0.2s" }}>▼</div>
                       </div>
                     </div>
                     
                     {isExpanded && (
                       <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border-subtle)", background: "var(--surface-card)" }}>
                         {group.logs.map((log: any, idx: number) => {
                           const isUser = log.detail.toLowerCase().includes("user said:");
                           const bg = isUser ? "rgba(0,0,0,0.03)" : "rgba(74, 158, 150, 0.05)";
                           const border = isUser ? "var(--border-subtle)" : "rgba(74, 158, 150, 0.2)";
                           return (
                             <div key={idx} style={{ background: bg, border: `1px solid ${border}`, padding: "8px 12px", borderRadius: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                               <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                 <strong style={{ fontSize: 11, color: isUser ? "var(--text-main)" : "#4A9E96" }}>{isUser ? "USER" : "AGENT"}</strong>
                                 <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                               </div>
                               <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.4 }}>
                                 {log.detail.replace(/user said:/i, "").replace(/agent said:/i, "").trim()}
                               </div>
                             </div>
                           );
                         })}
                       </div>
                     )}
                   </div>
                 );
               }
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