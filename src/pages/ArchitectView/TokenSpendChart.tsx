import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TokenRecord {
  id: string;
  agent_id: string;
  conversation_id?: string;
  timestamp: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

interface Props {
  agentId?: string; // If undefined, show global stats
}

export function TokenSpendChart({ agentId }: Props) {
  const [records, setRecords] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Filters
  const [days, setDays] = useState(30);
  const [providerFilter, setProviderFilter] = useState("all");

  useEffect(() => {
    let isMounted = true;
    const fetchUsage = async () => {
      setLoading(true);
      try {
        const res = await invoke<TokenRecord[]>("get_token_usage_history", { agentId: agentId || null, conversationId: null, days });
        if (isMounted) setRecords(res);
      } catch (e) {
        console.error("Failed to load token usage", e);
      }
      if (isMounted) setLoading(false);
    };
    fetchUsage();
    return () => { isMounted = false; };
  }, [agentId, days]);

  // Aggregate by day and provider
  const chartData = useMemo(() => {
    const filtered = records.filter(r => providerFilter === "all" || r.provider === providerFilter);
    
    // Group by day string YYYY-MM-DD
    const byDay: Record<string, number> = {};
    const totalByProvider: Record<string, number> = {};
    
    // Initialize last N days to 0 so we have continuous dates
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const k = d.toISOString().split("T")[0];
      byDay[k] = 0;
    }

    let totalCost = 0;
    for (const r of filtered) {
      const day = r.timestamp.split("T")[0];
      if (byDay[day] !== undefined) {
        byDay[day] += r.cost_usd;
      } else {
        byDay[day] = r.cost_usd;
      }
      totalByProvider[r.provider] = (totalByProvider[r.provider] || 0) + r.cost_usd;
      totalCost += r.cost_usd;
    }

    const sortedDays = Object.keys(byDay).sort();
    const values = sortedDays.map(d => byDay[d]);
    const maxVal = Math.max(...values, 0.01); // Prevent div by 0

    return { sortedDays, values, maxVal, totalCost, totalByProvider };
  }, [records, providerFilter, days]);

  const uniqueProviders = Array.from(new Set(records.map(r => r.provider)));

  if (loading) return <div style={{ padding: 20, fontSize: 13, color: "var(--text-sub)" }}>Loading token usage...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header & Filters */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Token Spend</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#4A9E96", background: "rgba(74,158,150,0.1)", padding: "2px 8px", borderRadius: 12 }}>
            ${chartData.totalCost.toFixed(2)} total
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <select 
            value={providerFilter} 
            onChange={e => setProviderFilter(e.target.value)}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", outline: "none" }}
          >
            <option value="all">All Providers</option>
            {uniqueProviders.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <select 
            value={days} 
            onChange={e => setDays(Number(e.target.value))}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", outline: "none" }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* Bar Chart */}
      <div style={{ height: 140, display: "flex", alignItems: "flex-end", gap: 2, paddingTop: 20, position: "relative" }}>
        {/* Y-axis labels */}
        <div style={{ position: "absolute", top: 0, left: 0, fontSize: 10, color: "var(--text-muted)" }}>${chartData.maxVal.toFixed(2)}</div>
        <div style={{ position: "absolute", bottom: 0, left: 0, fontSize: 10, color: "var(--text-muted)" }}>$0</div>
        
        {/* Bars */}
        <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: Math.max(1, 10 - chartData.values.length/4), marginLeft: 30, height: "100%" }}>
          {chartData.values.map((v, i) => {
            const hPct = (v / chartData.maxVal) * 100;
            return (
              <div 
                key={chartData.sortedDays[i]} 
                title={`${chartData.sortedDays[i]}: $${v.toFixed(3)}`}
                style={{
                  flex: 1,
                  background: v > 0 ? "#4A9E96" : "transparent",
                  opacity: 0.8,
                  height: `${hPct}%`,
                  minHeight: v > 0 ? 2 : 0,
                  borderRadius: "2px 2px 0 0",
                  transition: "height 0.3s ease"
                }} 
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
