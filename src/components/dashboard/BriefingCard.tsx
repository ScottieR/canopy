import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function BriefingCard() {
  // TODO: Wire to real briefing data from agents
  const [items, setItems] = useState<Array<{ agent: string; color: string; text: string }>>([]);

  if (items.length === 0) {
    return (
      <div className="bg-canopy-surface border border-canopy-border rounded-xl p-[18px]">
        <div className="flex items-center gap-2 mb-3.5">
          <span className="text-sm">🌅</span>
          <span className="text-[13px] font-semibold text-canopy-accent">Morning Briefing</span>
        </div>
        <p className="text-[12px] text-canopy-text-muted/60">No briefings yet. Your agents will report here once they're active.</p>
      </div>
    );
  }

  return (
    <div className="bg-canopy-surface border border-canopy-border rounded-xl p-[18px]">
      <div className="flex items-center gap-2 mb-3.5">
        <span className="text-sm">🌅</span>
        <span className="text-[13px] font-semibold text-canopy-accent">Morning Briefing</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2.5">
            <div className="w-[3px] rounded-sm flex-shrink-0 mt-0.5" style={{ background: item.color, minHeight: 32 }} />
            <div>
              <span className="text-[11px] font-semibold" style={{ color: item.color }}>{item.agent}</span>
              <p className="text-[12px] text-canopy-text-muted/80 leading-relaxed mt-0.5">{item.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
