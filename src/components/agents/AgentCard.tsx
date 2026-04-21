import { useState } from "react";

import { Agent } from "../../types";

interface AgentCardProps {
  agent: Agent & { lastAction?: string };
  isSelected?: boolean;
  onClick?: (id: string) => void;
}

export function AgentCard({ agent, isSelected, onClick }: AgentCardProps) {
  const [hovered, setHovered] = useState(false);

  const statusColor =
    agent.isolated ? "#A78BFA" :
    agent.status === "active" ? "#4ADE80" :
    agent.status === "thinking" ? "#34D399" : "#6B7280";

  return (
    <div
      data-testid="agent-card"
      onClick={() => onClick?.(agent.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.(agent.id);
        }
      }}
      tabIndex={0}
      role="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`
        relative bg-canopy-surface rounded-xl p-4 cursor-pointer
        transition-all duration-200 ease-out
        ${isSelected ? "border-l-[3px]" : "border"}
        ${hovered ? "-translate-y-px" : ""}
        ${agent.status === "active" ? "animate-breathe" : ""}
      `}
      style={{
        borderColor: isSelected ? agent.color : hovered ? `${agent.color}44` : "var(--border)",
        boxShadow: hovered ? `0 4px 20px rgba(0,0,0,0.3), 0 0 15px ${agent.color}10` : "none",
      }}
    >
      {/* Header row */}
      <div className="flex items-center gap-3 mb-2.5">
        <div
          className={`w-[42px] h-[42px] rounded-full flex items-center justify-center text-xl ${
            agent.status === "thinking" ? "animate-glow-pulse" : ""
          }`}
          style={{
            background: `${agent.color}15`,
            border: `2px solid ${agent.color}40`,
          }}
        >
          {agent.emoji}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-canopy-text">
              {agent.name}
            </span>
            {agent.isolated && (
              <span
                data-testid="isolation-badge"
                className="text-[9px] px-1.5 py-0.5 rounded border"
                style={{
                  background: "rgba(167,139,250,0.1)",
                  color: "#A78BFA",
                  borderColor: "rgba(167,139,250,0.2)",
                }}
              >
                🛡️ Isolated
              </span>
            )}
          </div>
          <span className="text-[11px] text-canopy-text-muted">{agent.role}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            data-testid="status-indicator"
            className={`w-[7px] h-[7px] rounded-full ${agent.status} ${
              agent.status !== "sleeping" ? "animate-pulse" : ""
            }`}
            style={{
              background: statusColor,
              boxShadow: agent.status !== "sleeping" ? `0 0 8px ${statusColor}` : "none",
            }}
          />
          <span
            className="text-[11px] text-canopy-text-muted capitalize"
            role="status"
            aria-live="polite"
          >
            {agent.isolated ? "isolated" : agent.status}
          </span>
        </div>
      </div>

      {/* Last action */}
      {agent.lastAction && (
        <div className="text-[11px] text-canopy-text-muted/80 leading-relaxed p-2.5 bg-canopy-surface-hover rounded-lg border border-[rgba(52,211,153,0.08)]">
          {agent.lastAction}
        </div>
      )}

      {/* Expanded stats */}
      {isSelected && (
        <div className="flex gap-4 mt-3 pt-2.5 border-t border-canopy-border animate-fade-slide-up flex-wrap">
          {[
            ["Tasks", agent.stats.tasks_today],
            ["Messages", agent.stats.messages_handled],
            ["Uptime", `${agent.stats.uptime_seconds}s`],
            ...(agent.stats.custom_metrics ? agent.stats.custom_metrics.map(m => [m.label, m.value]) : [])
          ].map(([label, val]) => (
            <div key={label as string} className="min-w-[60px]">
              <div className="text-base font-semibold" style={{ color: agent.color }}>
                {val}
              </div>
              <div className="text-[10px] text-canopy-text-muted">{label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
