import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// Dashboard is an alternative view — the primary UI is App.tsx (isometric world).
// This is kept as a secondary route for a more traditional dashboard layout.

interface Agent {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;
  status: "active" | "sleeping" | "thinking" | "stopped" | "error";
  isolated: boolean;
  stats: {
    tasks_today: number;
    messages_handled: number;
    uptime_seconds: number;
    total_cost_usd: number;
    total_tokens_in: number;
    total_tokens_out: number;
    custom_metrics?: {
      label: string;
      value: string | number;
    }[];
  };
}

interface AggregatedRole {
  role: string;
  emoji: string; // The emoji of the first agent or a generic one
  agentCount: number;
  activeCount: number;
  tasksToday: number;
  messagesHandled: number;
  tokensIn: number;
  tokensOut: number;
}

function formatTokens(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

export function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke("list_agents")
      .then((data) => setAgents(data as Agent[]))
      .catch((e) => console.error("Failed to load agents:", e))
      .finally(() => setLoading(false));
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const activeCount = agents.filter((a) => a.status === "active").length;
  const isolatedCount = agents.filter((a) => a.isolated).length;

  // Aggregate agents by role
  const roleMap = new Map<string, AggregatedRole>();
  for (const agent of agents) {
    const roleKey = agent.role?.trim() || "General Assistant";
    if (!roleMap.has(roleKey)) {
      roleMap.set(roleKey, {
        role: roleKey,
        emoji: agent.emoji || "🤖",
        agentCount: 0,
        activeCount: 0,
        tasksToday: 0,
        messagesHandled: 0,
        tokensIn: 0,
        tokensOut: 0,
      });
    }
    const aggr = roleMap.get(roleKey)!;
    aggr.agentCount++;
    if (agent.status === "active" || agent.status === "thinking") {
      aggr.activeCount++;
    }
    aggr.tasksToday += agent.stats?.tasks_today || 0;
    aggr.messagesHandled += agent.stats?.messages_handled || 0;
    aggr.tokensIn += agent.stats?.total_tokens_in || 0;
    aggr.tokensOut += agent.stats?.total_tokens_out || 0;
  }
  const aggregatedRoles = Array.from(roleMap.values());

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-canopy-text-muted">Loading agents...</p>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full gap-4">
        <div className="text-6xl opacity-30">🌲</div>
        <p className="text-canopy-text-muted text-sm">No agents yet. Create your first agent to get started.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1200px]">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-[22px] font-bold text-canopy-text">
            {greeting}
          </h1>
          <p className="text-xs text-canopy-text-muted mt-0.5">
            {activeCount} agents active · {isolatedCount} isolated
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3.5 mb-5">
        {aggregatedRoles.map((aggr) => (
          <div
            key={aggr.role}
            className="p-4 rounded-xl border border-canopy-border bg-canopy-surface hover:bg-canopy-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">{aggr.emoji}</span>
              <div>
                <div className="font-semibold text-canopy-text">{aggr.role}</div>
                <div className="text-xs text-canopy-text-muted">{aggr.agentCount} Agent{aggr.agentCount !== 1 ? 's' : ''}</div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="text-xs text-canopy-text-muted">
                  {aggr.activeCount > 0 ? "Active" : "Idle"}
                </div>
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{
                    background: aggr.activeCount > 0 ? "#34D399" : "#94A3B8"
                  }}
                />
              </div>
            </div>
            <div className="text-xs text-canopy-text-muted flex justify-between mt-3 pt-3 border-t border-canopy-border">
              <div>
                <strong>{aggr.tasksToday}</strong> tasks · <strong>{aggr.messagesHandled}</strong> msgs
              </div>
              <div>
                <strong>{formatTokens(aggr.tokensIn + aggr.tokensOut)}</strong> tokens
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
