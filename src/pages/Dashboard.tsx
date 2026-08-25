import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorldStore, effectiveAgentStatus } from "../store/worldStore";
import { TokenSpendChart } from "../components/agents/TokenSpendChart";
import { LobsterIcon } from "../components/World/LobsterIcon";
import { PaymentSummary } from "../components/payments/PaymentSummary";

// glass()/ProgressBar are copied locally (rather than imported from ../App,
// which also exports them) so this page doesn't pull in App.tsx's whole
// module graph — App.tsx is the top-level app shell with a lot of other
// weight in it. Keep these in sync with App.tsx if their styling changes.
function glass(opacity = 0.55): React.CSSProperties {
  const isDark = useWorldStore.getState().theme === "dark";
  return {
    background: isDark ? `rgba(17,21,32,${opacity})` : `rgba(255,255,255,${opacity})`,
    backdropFilter: "blur(24px)",
    WebkitBackdropFilter: "blur(24px)",
    border: isDark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.3)",
    borderRadius: 16,
    boxShadow: isDark ? "0 8px 32px rgba(0,0,0,0.3)" : "0 8px 32px rgba(0,0,0,0.06)",
  };
}

function ProgressBar({ value, max = 1, color = "#3c6663", height = 4 }: { value: number; max?: number; color?: string; height?: number }) {
  return (
    <div style={{ height, borderRadius: height / 2, background: "var(--border-subtle)", width: "100%" }}>
      <div style={{ height: "100%", borderRadius: height / 2, background: color, width: `${(value / max) * 100}%`, transition: "width 0.5s ease" }} />
    </div>
  );
}

// "My Usage" — a personal, local aggregate rollup of every stat shown on a
// single agent's Activity tab (ArchitectView/ActivityTab.tsx), summed across
// all of this user's agents. Reachable from the profile menu (top right).
//
// This is unrelated to the cross-user anonymized admin telemetry pipeline
// (spec-global-usage-telemetry.md) — that one is opt-in, sends only a random
// ID + aggregate stats to Canopy's server, and never includes anything
// agent- or user-identifiable. This page is the opposite: purely local,
// reads directly from this install's own agent data, and never leaves the
// device.
//
// Cost/token/message figures are sourced from real per-event data
// (get_token_usage_history's ledger table + get_agent_activity_heatmap's
// daily interaction/tool counts), NOT from `agent.stats.total_cost_usd` /
// `messages_handled` / `tasks_today` (`messages_handled`/`tasks_today` are
// never incremented anywhere in the Rust codebase).
//
// The ledger is fed by extract_usage_from_response in openclaw.rs, which
// reads the camelCase `meta.agentMeta.usage` block (input/output/cacheRead/
// cacheWrite) from the openclaw CLI's `--json` output. Rows recorded before
// 2026-08 are missing: the old extraction read a nonexistent
// `meta.usage.prompt_tokens` path, so the table stayed empty until that fix
// landed. Figures on this page only cover usage metered since then.

interface HeatmapEntry {
  date: string;
  interactions: number;
  tools: number;
  system: number;
  total: number;
}

interface AuditEntry {
  id: number;
  timestamp: string;
  agent_id?: string | null;
  action: string;
  bridge_type?: string | null;
  detail: string;
}

interface TokenUsageRecord {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  timestamp: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

interface AgentRangeStats {
  messages: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const EMPTY_RANGE_STATS: AgentRangeStats = { messages: 0, tools: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

function formatTokens(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

// Work Log can now span up to 90 days (driven by the range filter), so a
// bare time-of-day ("9:10 AM") is ambiguous — two entries from different
// days can have the same clock time and, since the list is genuinely sorted
// by full timestamp descending, look "out of order" when only the time is
// shown. Always include the date to make the real chronological order
// legible.
function formatLogTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function heatmapColor(count: number): string {
  if (count === 0) return "rgba(255, 255, 255, 0.05)";
  if (count <= 2) return "#4a7c59";
  if (count <= 5) return "#40c463";
  if (count <= 10) return "#30a14e";
  return "#216e39";
}

export function Dashboard() {
  const agents = useWorldStore(s => s.agents);

  // ── Dashboard-wide date range filter — drives stats, heatmap, work log, ──
  // and the token spend chart below. Defaults to a rolling last-7-days view.
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(7);

  // ── Per-agent activity heatmaps ─────────────────────────────────────────
  // get_agent_activity_heatmap is per-agent only (no "all agents" mode on
  // the backend) and always returns a fixed 90-day window, so fetch every
  // agent's heatmap in parallel, keep it keyed by agent id (used for
  // per-agent message/tool-call counts within the selected range), and
  // separately merge it into one combined series for the heatmap viz.
  const [perAgentHeatmap, setPerAgentHeatmap] = useState<Record<string, HeatmapEntry[]>>({});
  const [heatmapLoading, setHeatmapLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      if (agents.length === 0) {
        setPerAgentHeatmap({});
        setHeatmapLoading(false);
        return;
      }
      try {
        const results = await Promise.all(
          agents.map(a =>
            invoke<HeatmapEntry[]>("get_agent_activity_heatmap", { agentId: a.id })
              .then(entries => [a.id, entries] as const)
              .catch(() => [a.id, [] as HeatmapEntry[]] as const)
          )
        );
        if (cancelled) return;
        const map: Record<string, HeatmapEntry[]> = {};
        for (const [id, entries] of results) map[id] = entries;
        setPerAgentHeatmap(map);
      } finally {
        if (!cancelled) setHeatmapLoading(false);
      }
    };
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length]);

  const mergedHeatmap = useMemo(() => {
    const byDate = new Map<string, HeatmapEntry>();
    for (const perAgent of Object.values(perAgentHeatmap)) {
      for (const entry of perAgent || []) {
        const existing = byDate.get(entry.date);
        if (existing) {
          existing.interactions += entry.interactions;
          existing.tools += entry.tools;
          existing.system += entry.system;
          existing.total += entry.total;
        } else {
          byDate.set(entry.date, { ...entry });
        }
      }
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [perAgentHeatmap]);

  // Heatmap entries come back sorted ascending, one per day, 90 days total —
  // slicing the tail gives the last N days for the selected range.
  const rangeHeatmap = useMemo(() => mergedHeatmap.slice(-rangeDays), [mergedHeatmap, rangeDays]);

  // ── Token/cost usage ledger, scoped to the selected range ──────────────
  // agentId: null aggregates every row in token_usage_history, including
  // canopy_helper's (Eddy/Keeper) — it isn't in the `agents` table so it'd
  // never show up in a per-agent-invoke loop, but this single call covers it.
  const [usageRecords, setUsageRecords] = useState<TokenUsageRecord[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setUsageLoading(true);
    invoke<TokenUsageRecord[]>("get_token_usage_history", { agentId: null, conversationId: null, days: rangeDays })
      .then(records => { if (!cancelled) setUsageRecords(Array.isArray(records) ? records : []); })
      .catch(() => { if (!cancelled) setUsageRecords([]); })
      .finally(() => { if (!cancelled) setUsageLoading(false); });
    return () => { cancelled = true; };
  }, [rangeDays]);

  // ── Work log — every agent's activity, same grouping as ActivityTab ────
  // get_global_audit_log already supports "all agents" when agentId is
  // omitted. Fetch a generous limit and filter to the selected range
  // client-side (the command has no native date param).
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const data = await invoke<AuditEntry[]>("get_global_audit_log", { limit: 500 });
        setLogs(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Failed to fetch global audit log", e);
      }
    };
    fetchLogs();
  }, []);

  const rangeCutoff = useMemo(() => Date.now() - rangeDays * 24 * 60 * 60 * 1000, [rangeDays]);
  const rangeLogs = useMemo(() => logs.filter(l => new Date(l.timestamp).getTime() >= rangeCutoff), [logs, rangeCutoff]);

  // Same session-grouping algorithm as ActivityTab.tsx (chats within 60 min
  // of each other collapse into one expandable session), applied here across
  // every agent's logs instead of one.
  const groupedLogs = useMemo(() => {
    if (!rangeLogs || rangeLogs.length === 0) return [];
    const sorted = [...rangeLogs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const groups: any[] = [];
    let currentSession: any = null;

    sorted.forEach(log => {
      if (log.action === "chatted") {
        const logTime = new Date(log.timestamp).getTime();
        if (currentSession) {
          const lastLogTime = new Date(currentSession.logs[currentSession.logs.length - 1].timestamp).getTime();
          if (logTime - lastLogTime < 60 * 60 * 1000) {
            currentSession.logs.push(log);
            // Sort/display key is the session's most recent message, not its
            // first — a session can run for hours, and "recent activity"
            // should reflect where it left off, not where it started.
            currentSession.timestamp = log.timestamp;
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
    if (currentSession) groups.push(currentSession);
    return groups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [rangeLogs]);

  const toggleSession = (id: string) => setExpandedSessions(prev => ({ ...prev, [id]: !prev[id] }));

  // ── Fleet-wide status (instantaneous, not range-scoped) ──────────────────
  const activeCount = agents.filter(a => { const st = effectiveAgentStatus(a); return st === "active" || st === "thinking"; }).length;
  const errorCount = agents.filter(a => a.status === "error").length;
  const idleCount = agents.length - activeCount - errorCount;
  const isolatedCount = agents.filter(a => a.isolated).length;

  // ── Per-agent stats within the selected range ────────────────────────────
  // Messages/tool-calls come from the heatmap (backed by the `messages` and
  // `audit_log` tables, logged unconditionally whenever a chat happens —
  // reliable regardless of the token-extraction bug described above).
  // Tokens/cost come from the usage ledger (currently empty until that bug
  // is fixed, but this is the correct source once it is).
  const perAgentStats = useMemo(() => {
    const map = new Map<string, AgentRangeStats>();
    for (const agent of agents) {
      const entries = (perAgentHeatmap[agent.id] || []).slice(-rangeDays);
      const messages = entries.reduce((sum, e) => sum + e.interactions, 0);
      const tools = entries.reduce((sum, e) => sum + e.tools, 0);
      map.set(agent.id, { messages, tools, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    }
    for (const rec of usageRecords) {
      const cur = map.get(rec.agent_id);
      if (cur) {
        cur.tokensIn += rec.tokens_in || 0;
        cur.tokensOut += rec.tokens_out || 0;
        cur.costUsd += rec.cost_usd || 0;
      }
    }
    return map;
  }, [agents, perAgentHeatmap, usageRecords, rangeDays]);

  // Canopy Helper (Eddy/Keeper) — a pseudo-agent with no row in the `agents`
  // table, so it's not in perAgentStats above. Its usage lives in the same
  // ledger under agent_id "canopy_helper".
  const eddyStats = useMemo(() => {
    return usageRecords
      .filter(r => r.agent_id === "canopy_helper")
      .reduce((acc, r) => ({
        tokensIn: acc.tokensIn + (r.tokens_in || 0),
        tokensOut: acc.tokensOut + (r.tokens_out || 0),
        costUsd: acc.costUsd + (r.cost_usd || 0),
        eventCount: acc.eventCount + 1,
      }), { tokensIn: 0, tokensOut: 0, costUsd: 0, eventCount: 0 });
  }, [usageRecords]);

  // ── Fleet-wide totals within the selected range ──────────────────────────
  const totals = useMemo(() => {
    let spendLimit = 0, uptimeSeconds = 0, messages = 0, tools = 0, tokensIn = 0, tokensOut = 0, costUsd = 0;
    for (const agent of agents) {
      uptimeSeconds += agent.stats?.uptime_seconds || 0;
      spendLimit += (agent as any).spendLimit || 0;
    }
    for (const stats of perAgentStats.values()) {
      messages += stats.messages;
      tools += stats.tools;
    }
    for (const rec of usageRecords) {
      tokensIn += rec.tokens_in || 0;
      tokensOut += rec.tokens_out || 0;
      costUsd += rec.cost_usd || 0;
    }
    return { spendLimit, uptimeSeconds, messages, tools, tokensIn, tokensOut, costUsd };
  }, [agents, perAgentStats, usageRecords]);

  if (agents.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full gap-4">
        <div className="text-6xl opacity-30">🌲</div>
        <p className="text-canopy-text-muted text-sm">No agents yet. Create your first agent to get started.</p>
      </div>
    );
  }

  const rangeLabel = `${rangeDays}d`;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 6px 0" }}>My Usage</h1>
          <p style={{ fontSize: 13, color: "var(--text-sub)", margin: 0 }}>
            Aggregate activity, cost, and usage across all {agents.length} of your agents — the same stats each agent's
            Activity tab shows, summed up. {activeCount} active · {idleCount} idle{errorCount > 0 ? ` · ${errorCount} erroring` : ""} · {isolatedCount} isolated.
          </p>
        </div>
        <div style={{ display: "flex", background: "var(--surface-base)", borderRadius: 8, border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setRangeDays(d as 7 | 30 | 90)}
              style={{
                padding: "6px 14px", fontSize: 12, fontWeight: rangeDays === d ? 700 : 500,
                color: rangeDays === d ? "var(--text-main)" : "var(--text-sub)",
                background: rangeDays === d ? "rgba(74, 158, 150, 0.12)" : "transparent",
                border: "none", borderRight: d !== 90 ? "1px solid var(--border-subtle)" : "none",
                cursor: "pointer",
              }}
            >
              Last {d}d
            </button>
          ))}
        </div>
      </div>

      {/* ── Stats strip — mirrors ActivityTab's Current State / Resource Use / Cost cards, aggregated ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Fleet State</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#4A9E96" }} />
              <span style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>{activeCount}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--text-muted)" }} />
              <span style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>{idleCount}</span>
            </div>
            {errorCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#E57373" }} />
                <span style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>{errorCount}</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 11, color: "var(--text-sub)" }}>
            <span>Combined uptime</span>
            <span style={{ fontWeight: 500, color: "var(--text-main)" }}>{(totals.uptimeSeconds / 3600).toFixed(1)} agent-hrs</span>
          </div>
        </div>

        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Resource Use ({rangeLabel}){usageLoading ? " · loading…" : ""}</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Messages</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>{totals.messages.toLocaleString()}</div>
              <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 2 }}>{totals.tools.toLocaleString()} tool calls</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Tokens</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text-main)" }}>{formatTokens(totals.tokensIn + totals.tokensOut)}</div>
              <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 2 }}>
                <span style={{ color: "#4A9E96" }}>{formatTokens(totals.tokensIn)} in</span> / <span style={{ color: "#D4A04A" }}>{formatTokens(totals.tokensOut)} out</span>
              </div>
            </div>
          </div>
          <ProgressBar value={totals.messages} max={Math.max(totals.messages, 10)} color="#4A9E96" />
        </div>

        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8 }}>Cost ({rangeLabel}){usageLoading ? " · loading…" : ""}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text-main)" }}>${totals.costUsd.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 8 }}>of ${totals.spendLimit.toFixed(0)} combined limit</div>
          <ProgressBar value={totals.costUsd} max={totals.spendLimit || 1} color={totals.spendLimit && totals.costUsd > totals.spendLimit * 0.8 ? "#D4A04A" : "#4A9E96"} />
        </div>
      </div>

      <PaymentSummary />

      {/* ── Per-agent breakdown — real avatar, given name, role beneath it ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {agents.map((agent) => {
          const stats = perAgentStats.get(agent.id) || EMPTY_RANGE_STATS;
          const agentStatus = effectiveAgentStatus(agent);
          const isActive = agentStatus === "active" || agentStatus === "thinking";
          return (
            <div key={agent.id} style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: `${agent.robeColor || "#CCC"}15`,
                  boxShadow: `0 0 0 1px ${agent.robeColor || "#CCC"}40`,
                }}>
                  <LobsterIcon
                    size={36}
                    role={agent.role}
                    agentImage={agent.image}
                    shellColor={agent.robeColor}
                    accentColor={agent.accentColor}
                    reactState={agent.paused ? "off" : agentStatus === "thinking" ? "thinking" : agent.status === "error" ? "error" : "idle"}
                  />
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: "var(--text-main)" }}>{agent.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)" }}>{agent.role}</div>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 12, color: "var(--text-sub)" }}>{isActive ? "Active" : "Idle"}</div>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: isActive ? "#34D399" : "var(--text-muted)" }} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
                <div><strong>{stats.messages}</strong> msgs · <strong>{stats.tools}</strong> tool calls</div>
                <div><strong>${stats.costUsd.toFixed(2)}</strong> · <strong>{formatTokens(stats.tokensIn + stats.tokensOut)}</strong> tokens</div>
              </div>
            </div>
          );
        })}

        {/* Canopy Helper (Eddy) — not a real agent row, shown separately since
            its usage lives in the same ledger under agent_id "canopy_helper". */}
        <div style={{ ...glass(0.5), padding: 16, borderRadius: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{
              width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, background: "#4A9E9615", boxShadow: "0 0 0 1px #4A9E9640",
            }}>
              🧭
            </div>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-main)" }}>Canopy Helper</div>
              <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Eddy · Keeper</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
            <div><strong>{eddyStats.eventCount}</strong> exchanges</div>
            <div><strong>${eddyStats.costUsd.toFixed(2)}</strong> · <strong>{formatTokens(eddyStats.tokensIn + eddyStats.tokensOut)}</strong> tokens</div>
          </div>
        </div>
      </div>

      {/* ── Activity Patterns heatmap, aggregated across all agents ── */}
      <div style={{ ...glass(0.5), padding: 20, borderRadius: 14, display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 12 }}>Activity Patterns — All Agents</div>
        {heatmapLoading ? (
          <div style={{ minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-sub)" }}>Loading activity...</div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}>Less</div>
              {[0, 2, 5, 10, 20].map(c => <div key={c} style={{ width: 10, height: 10, borderRadius: 2, background: heatmapColor(c) }} />)}
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}>More</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10px, 1fr))", gridAutoFlow: "column", gridTemplateRows: "repeat(7, 10px)", gap: 4, overflowX: "auto", paddingBottom: 8 }}>
              {rangeHeatmap.map((val, i) => (
                <div
                  key={i}
                  title={`${val.date}: ${val.total} total events across all agents (${val.interactions} chats, ${val.tools} tools, ${val.system} system)`}
                  style={{ width: 10, height: 10, borderRadius: 2, background: heatmapColor(val.total), transition: "background 0.3s ease", cursor: "help" }}
                />
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>
              <span>{rangeDays} Days Ago</span>
              <span>Today</span>
            </div>
          </>
        )}
      </div>

      {/* ── Token Spend Chart — TokenSpendChart already aggregates across all agents when agentId is omitted; timeframe is driven by the range filter above ── */}
      <div style={{ ...glass(0.5), padding: "20px 24px", borderRadius: 16, display: "flex", flexDirection: "column", minHeight: 220 }}>
        <TokenSpendChart timeframe={rangeDays} />
      </div>

      {/* ── Work Log — every agent's activity, same grouping as ActivityTab ── */}
      <div style={{ ...glass(0.5), padding: "20px 24px", borderRadius: 16, display: "flex", flexDirection: "column", minHeight: 320 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase" }}>Work Log — All Agents ({rangeLabel})</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Chats are grouped into sessions. Click to expand.</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 8 }}>
          {groupedLogs && groupedLogs.length > 0 ? (
            groupedLogs.map((group) => {
              const agentName = (id: string | null | undefined) => agents.find(a => a.id === id)?.name || "Unknown agent";
              if (group.type === "single") {
                const log = group.log;
                let color = "var(--text-main)";
                let bg = "var(--surface-base)";
                if (log.action.includes("spend")) { color = "#D4A04A"; bg = "#D4A04A15"; }
                else if (log.action.includes("denied") || log.action.includes("failed")) { color = "#E57373"; bg = "#E5737315"; }
                return (
                  <div key={group.id} style={{ fontSize: 13, color: "var(--text-main)", padding: "10px 14px", background: "var(--surface-base)", borderRadius: 8, border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ color, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", background: bg, padding: "2px 6px", borderRadius: 4 }}>
                        {log.action} {log.bridge_type ? `via ${log.bridge_type}` : ""}
                      </strong>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{agentName(log.agent_id)} · {formatLogTimestamp(log.timestamp)}</span>
                    </div>
                    <div style={{ color: "var(--text-sub)", fontSize: 12, lineHeight: 1.4, marginTop: 4 }}>{log.detail}</div>
                  </div>
                );
              } else {
                const isExpanded = expandedSessions[group.id];
                const groupAgentName = agentName(group.logs[0]?.agent_id);
                return (
                  <div key={group.id} style={{ fontSize: 13, color: "var(--text-main)", background: "var(--surface-base)", borderRadius: 8, border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    <div onClick={() => toggleSession(group.id)} style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: isExpanded ? "rgba(0,0,0,0.02)" : "transparent" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <strong style={{ color: "#4A9E96", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", background: "#4A9E9615", padding: "2px 6px", borderRadius: 4 }}>Chat Session</strong>
                          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>{groupAgentName} · {group.logs.length} messages</span>
                        </div>
                        <div style={{ color: "var(--text-main)", fontSize: 12, fontWeight: 500 }}>"{group.topicSummary}"</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{formatLogTimestamp(group.timestamp)}</span>
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
                              <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.4 }}>{log.detail.replace(/user said:/i, "").replace(/agent said:/i, "").trim()}</div>
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
            <div style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", textAlign: "center", marginTop: 40 }}>No recent activity recorded.</div>
          )}
        </div>
      </div>
    </div>
  );
}
