import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ActivityHeatmapEntry {
  date: string;
  interactions: number;
  tools: number;
  system: number;
  total: number;
}

export function AgentActivityHeatmap({ agentId }: { agentId: string }) {
  const [heatmapData, setHeatmapData] = useState<ActivityHeatmapEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHeatmap = async () => {
    try {
      const data: any = await invoke("get_agent_activity_heatmap", { agentId });
      setHeatmapData(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch agent activity heatmap", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHeatmap();
    // Refresh heatmap every 30 seconds
    const interval = setInterval(fetchHeatmap, 30000);
    return () => clearInterval(interval);
  }, [agentId]);

  const getColor = (count: number) => {
    if (count === 0) return "rgba(255, 255, 255, 0.05)";
    if (count <= 2) return "#4a7c59"; // light green
    if (count <= 5) return "#40c463"; // medium green
    if (count <= 10) return "#30a14e"; // green
    return "#216e39"; // dark green
  };

  if (loading) {
    return <div style={{ minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-sub)" }}>Loading activity...</div>;
  }

  // Ensure we show up to 90 days of history, mapped by 7 rows (weeks)
  const days = heatmapData.length > 0 ? heatmapData : [];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}>Less</div>
        <div style={{ width: 10, height: 10, borderRadius: 2, background: getColor(0) }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: getColor(2) }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: getColor(5) }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: getColor(10) }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: getColor(20) }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-sub)", fontWeight: 600 }}>More</div>
      </div>
      
      <div style={{ 
        display: "grid", 
        gridTemplateColumns: "repeat(auto-fit, minmax(10px, 1fr))", 
        gridAutoFlow: "column", 
        gridTemplateRows: "repeat(7, 10px)", 
        gap: 4, 
        overflowX: "auto",
        paddingBottom: 8
      }}>
        {days.map((val, i) => (
          <div 
            key={i} 
            title={`${val.date}: ${val.total} total events (${val.interactions} chats, ${val.tools} tools, ${val.system} system)`}
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: getColor(val.total),
              transition: "background 0.3s ease",
              cursor: "help"
            }} 
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>
        <span>90 Days Ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
