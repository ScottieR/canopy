import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu,
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import type { GenerativeResult } from "../../types/generative";
import { Toggle, ServiceRow, glass, ProgressBar } from "../../App";
import { AgentActivityHeatmap } from "../../components/agents/AgentActivityHeatmap";
import { TokenSpendChart } from "../../components/agents/TokenSpendChart";
import { detectCurrentTier } from "./accessTiers";
import { DecisionCard } from "../../components/DecisionQueue/DecisionCard";

export // ─── Activity Tab ────────────────────────────────────────────────────────────

function ActivityTab({ agent, onNavigate }: { agent: AgentData; onNavigate?: (tab: string) => void }) {
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const { pendingDecisions } = useWorldStore();
  const agentDecisions = useMemo(
    () => pendingDecisions.filter(d => d.agentId === agent.id),
    [pendingDecisions, agent.id]
  );

  // Tier label matches Skills & Access (driven by accessTiers.ts — single source of truth).
  const currentTier = useMemo(() => detectCurrentTier(agent.permissions), [agent.permissions]);
  const tierLabel = currentTier?.label || "Custom";
  const tierColor = currentTier?.color || "var(--text-muted)";
  // Map tier to a 0–2 position on the green→amber→red gradient track.
  const tierPosition = currentTier?.id === "unrestricted" ? 2 : currentTier?.id === "balanced" ? 1 : 0;

  // Work-log entries speak infrastructure ("FILES_BRIDGE_SYNCED VIA FILES");
  // the log is for the person deciding whether to trust the agent, so render a
  // human action narrative and keep the machine code in the hover title
  // (issue #64, 2026-08-24 CUJ test).
  const humanizeAuditAction = (action: string, bridgeType?: string | null): string => {
    const known: Record<string, string> = {
      chatted: "Chat",
      created: "Created",
      updated: "Updated",
      delete: "Deleted",
      run_failed: "Task failed",
      files_bridge_synced: "Files synced",
      bridge_access: "Used a connected service",
      bridge_enabled: "Service connected",
      bridge_disabled: "Service disconnected",
    };
    const base = known[action.toLowerCase()] || action.replace(/_/g, " ").toLowerCase();
    const via = bridgeType && !["openclaw", "files"].includes(bridgeType.toLowerCase()) ? ` via ${bridgeType}` : "";
    return `${base}${via}`;
  };

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
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%" }}>
      {/* H1 + subtitle — frames this tab as the agent's dashboard, not its workbench. */}
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 6px 0" }}>Activity</h1>
        <p style={{ fontSize: 13, color: "var(--text-sub)", margin: 0 }}>
          What {agent.name} has been up to — usage, cost, and a record of every action.
        </p>
      </div>

      {/* ── Stats strip — moved here from Home so Home can stay focused on chat. ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {/* Current State */}
        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Current State</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: agent.paused ? "var(--text-muted)" : (!gatewayReady || agent.status === "deploying") ? "#F4A83A" : agent.status === "active" ? "#4A9E96" : agent.status === "thinking" ? "#8B6AAE" : agent.status === "error" ? "#E57373" : "var(--text-muted)",
              boxShadow: agent.paused ? "none" : (!gatewayReady || agent.status === "deploying") ? "0 0 8px rgba(244,168,58,0.5)" : agent.status === "active" ? "0 0 8px rgba(74,158,150,0.5)" : agent.status === "error" ? "0 0 8px rgba(229,115,115,0.5)" : "none",
              animation: (!agent.paused && (!gatewayReady || agent.status === "deploying")) ? "pulse 1.5s ease-in-out infinite" : "none",
            }} />
            <span style={{ fontSize: 18, fontWeight: 600, color: agent.paused ? "var(--text-muted)" : (!gatewayReady || agent.status === "deploying") ? "#F4A83A" : "var(--text-main)", textTransform: "capitalize" }}>
              {agent.paused ? "Paused" : (!gatewayReady || agent.status === "deploying") ? "Waking up" : agent.status === "error" ? "Offline" : agent.currentAction || "Idle"}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 11, color: "var(--text-sub)" }}>
            <span>Uptime</span>
            <span style={{ fontWeight: 500, color: "var(--text-main)" }}>{agent.uptime}</span>
          </div>
        </div>

        {/* Resource Consumption */}
        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Resource Use</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Weekly Compute</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>{agent.weeklyCompute}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Tokens</div>
              {(() => {
                const totalTokensIn = agent.stats?.total_tokens_in || 0;
                const totalTokensOut = agent.stats?.total_tokens_out || 0;
                const totalTokens = totalTokensIn + totalTokensOut;
                return (
                  <>
                    <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>
                      {totalTokens > 0 ? (totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens) : "0"}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 2 }}>
                      <span style={{ color: "#4A9E96" }}>{totalTokensIn > 1000 ? `${(totalTokensIn / 1000).toFixed(1)}k` : totalTokensIn} in</span> / <span style={{ color: "#D4A04A" }}>{totalTokensOut > 1000 ? `${(totalTokensOut / 1000).toFixed(1)}k` : totalTokensOut} out</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
          <ProgressBar value={parseFloat(agent.weeklyCompute)} max={0.1} color="#4A9E96" />
        </div>

        {/* Cost */}
        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Cost (Active)</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text-main)" }}>${(agent.stats?.total_cost_usd || agent.monthlySpend || 0).toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 8 }}>of ${agent.spendLimit} limit</div>
          <ProgressBar value={agent.stats?.total_cost_usd || agent.monthlySpend || 0} max={agent.spendLimit} color={(agent.stats?.total_cost_usd || agent.monthlySpend || 0) > agent.spendLimit * 0.8 ? "#D4A04A" : "#4A9E96"} />
        </div>
      </div>

      {/* ── Access Level + Activity Patterns side-by-side ────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 12, alignItems: "stretch" }}>
        {/* Access Level — compact gauge. Edit jumps to Skills & Access. */}
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 14, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase" }}>Access Level</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-main)", marginTop: 6 }}>{tierLabel}</div>
            </div>
            <button onClick={() => onNavigate?.("connections")} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "var(--text-sub)" }}>Edit</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <Lock size={14} color={tierColor as string} strokeWidth={2.5} />
            <div style={{ position: "relative", flex: 1, height: 6, background: "linear-gradient(to right, #22c55e, #f59e0b, #ef4444)", borderRadius: 3 }}>
              <div style={{ position: "absolute", top: -3, left: `${tierPosition * 50}%`, width: 12, height: 12, borderRadius: "50%", background: "#fff", border: "2px solid #333", transform: "translateX(-50%)", transition: "left 0.3s" }} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>
            {agent.permissions.filter(p => p.enabled).length} of {agent.permissions.length} capabilities on · {(agent.integrations || []).length} services connected
          </div>
        </div>

        {/* Activity Patterns heatmap */}
        <div style={{ ...glass(0.5), padding: 20, borderRadius: 14, display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 12 }}>Activity Patterns</div>
          <AgentActivityHeatmap agentId={agent.id} />
        </div>
      </div>

      {/* ── Pending Decisions — shown only when this agent has items in the queue ── */}
      {agentDecisions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
            textTransform: "uppercase", color: "#D4A04A",
            paddingBottom: 4, borderBottom: "1px solid rgba(212,160,74,0.2)",
          }}>
            Needs your attention · {agentDecisions.length}
          </div>
          {agentDecisions.map(d => <DecisionCard key={d.id} decision={d} compact />)}
        </div>
      )}

      
      {/* ── Token Spend Chart ── */}
      <div style={{ ...glass(0.5), padding: "20px 24px", borderRadius: 16, display: "flex", flexDirection: "column", minHeight: 220 }}>
        <TokenSpendChart agentId={agent.id} />
      </div>

      {/* ── Work Log — full width, the main reading surface on this tab ── */}
      <div style={{ ...glass(0.5), padding: "20px 24px", borderRadius: 16, display: "flex", flexDirection: "column", minHeight: 320 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase" }}>Work Log</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Chats are grouped into sessions. Click to expand.
          </div>
        </div>
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
                       <strong
                         title={`${log.action}${log.bridge_type ? ` via ${log.bridge_type}` : ""}`}
                         style={{ color: color, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", background: bg, padding: "2px 6px", borderRadius: 4 }}
                       >
                         {humanizeAuditAction(log.action, log.bridge_type)}
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
