import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AuditEntry {
  id: number;
  timestamp: string;
  agent_id: string | null;
  action: string;
  bridge_type: string | null;
  detail: string;
  content_hash: string | null;
}

export function ActivityFeed() {
  const [items, setItems] = useState<AuditEntry[]>([]);

  useEffect(() => {
    invoke("get_audit_log", { agentId: null, limit: 10 })
      .then((data) => setItems(data as AuditEntry[]))
      .catch(() => {});
  }, []);

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  if (items.length === 0) {
    return (
      <div className="bg-canopy-surface border border-canopy-border rounded-xl p-[18px]">
        <div className="flex items-center gap-2 mb-3.5">
          <span className="text-sm">🫧</span>
          <span className="text-[13px] font-semibold text-canopy-accent">Recent Activity</span>
        </div>
        <p className="text-[12px] text-canopy-text-muted/60">No activity yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-canopy-surface border border-canopy-border rounded-xl p-[18px]">
      <div className="flex items-center gap-2 mb-3.5">
        <span className="text-sm">🫧</span>
        <span className="text-[13px] font-semibold text-canopy-accent">Recent Activity</span>
      </div>
      <div className="flex flex-col">
        {items.map((item, i) => (
          <div
            key={item.id}
            className={`flex items-start gap-2.5 py-2 ${i < items.length - 1 ? "border-b border-[rgba(52,211,153,0.08)]" : ""}`}
          >
            <span className="text-[10px] text-canopy-sleeping min-w-[52px] mt-0.5 font-mono">
              {timeAgo(item.timestamp)}
            </span>
            <div className="flex-1">
              <span className="text-[11px] font-semibold text-canopy-accent">{item.agent_id || "System"}</span>
              <span className="text-[11px] text-canopy-text-muted/70"> — {item.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
