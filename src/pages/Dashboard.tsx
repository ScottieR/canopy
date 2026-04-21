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
    custom_metrics?: {
      label: string;
      value: string | number;
    }[];
  };
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
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="p-4 rounded-xl border border-canopy-border bg-canopy-surface hover:bg-canopy-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">{agent.emoji}</span>
              <div>
                <div className="font-semibold text-canopy-text">{agent.name}</div>
                <div className="text-xs text-canopy-text-muted">{agent.role}</div>
              </div>
              <div className="ml-auto">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{
                    background:
                      agent.status === "active" ? "#34D399" :
                      agent.status === "thinking" ? "#A78BFA" :
                      agent.status === "sleeping" ? "#94A3B8" : "#EF4444",
                  }}
                />
              </div>
            </div>
            <div className="text-xs text-canopy-text-muted">
              {agent.stats.tasks_today} tasks today · {agent.stats.messages_handled} messages
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
