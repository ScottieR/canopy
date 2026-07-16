import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";

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

export function TokenSpendChart({ agentId, timeframe: controlledTimeframe }: { agentId?: string; timeframe?: 7 | 30 | 90 }) {
  const [data, setData] = useState<TokenUsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // When `timeframe` is passed in (e.g. Dashboard.tsx's single dashboard-wide
  // date filter), it drives the query and the internal 7/30/90 toggle is
  // hidden so there's only one range control on screen. Uncontrolled callers
  // (e.g. the per-agent ActivityTab.tsx) keep managing their own timeframe.
  const [internalTimeframe, setInternalTimeframe] = useState<7 | 30 | 90>(7);
  const timeframe = controlledTimeframe ?? internalTimeframe;
  const [providerFilter, setProviderFilter] = useState<string>("All");

  const fetchData = async () => {
    setLoading(true);
    try {
      const records: TokenUsageRecord[] = await invoke("get_token_usage_history", {
        agentId: agentId || null,
        conversationId: null,
        days: timeframe
      });
      setData(records);
    } catch (e) {
      console.error("Failed to fetch token usage history", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [agentId, timeframe]);

  // Aggregate by day and by provider
  const { chartData, totalCost, totalTokens, providers } = useMemo(() => {
    const providerSet = new Set<string>();
    let totalC = 0;
    let totalT = 0;
    
    // Group by YYYY-MM-DD
    const aggregated: Record<string, { cost: number; tokensIn: number; tokensOut: number }> = {};
    
    // Initialize empty days based on timeframe
    for (let i = timeframe - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      aggregated[dateStr] = { cost: 0, tokensIn: 0, tokensOut: 0 };
    }

    data.forEach(record => {
      providerSet.add(record.provider);
      
      if (providerFilter !== "All" && record.provider !== providerFilter) return;

      totalC += record.cost_usd;
      totalT += record.tokens_in + record.tokens_out;

      const dateStr = record.timestamp.split('T')[0];
      if (aggregated[dateStr]) {
        aggregated[dateStr].cost += record.cost_usd;
        aggregated[dateStr].tokensIn += record.tokens_in;
        aggregated[dateStr].tokensOut += record.tokens_out;
      } else {
        // If it's older than our window but returned anyway, or timezones shift it
        aggregated[dateStr] = {
          cost: record.cost_usd,
          tokensIn: record.tokens_in,
          tokensOut: record.tokens_out,
        };
      }
    });

    const chartArray = Object.keys(aggregated).sort().map(date => ({
      date,
      cost: aggregated[date].cost,
      tokensIn: aggregated[date].tokensIn,
      tokensOut: aggregated[date].tokensOut,
    }));

    return {
      chartData: chartArray,
      totalCost: totalC,
      totalTokens: totalT,
      providers: Array.from(providerSet)
    };
  }, [data, timeframe, providerFilter]);

  const maxCost = Math.max(...chartData.map(d => d.cost), 0.01); // avoid / 0

  return (
    // Intentionally no `height: "100%"` here. This component is dropped into
    // wrapper divs across the app that only set `minHeight` (not `height`),
    // e.g. Dashboard.tsx and ActivityTab.tsx — a percentage height on this
    // root has no definite value to resolve against there, so it falls
    // through to whatever the nearest ancestor with a real height happens to
    // be. On at least one page that's effectively the full viewport, which
    // made the `flex: 1` chart area below balloon to fill hundreds of extra
    // pixels of empty space. Sizing purely from content (header + a fixed-
    // height chart area + footer) makes this component's height predictable
    // regardless of what ancestor it's mounted under.
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      {/* Header & Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-sub)", textTransform: "uppercase" }}>Token Spend</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: "var(--text-main)" }}>${totalCost.toFixed(3)}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{totalTokens.toLocaleString()} tokens</span>
          </div>
        </div>
        
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {providers.length > 0 && (
            <select 
              value={providerFilter} 
              onChange={e => setProviderFilter(e.target.value)}
              style={{
                background: "var(--surface-base)", border: "1px solid var(--border-subtle)",
                borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--text-sub)",
                outline: "none"
              }}
            >
              <option value="All">All Providers</option>
              {providers.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          
          {controlledTimeframe === undefined && (
            <div style={{ display: "flex", background: "var(--surface-base)", borderRadius: 6, border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
              {[7, 30, 90].map((t) => (
                <button
                  key={t}
                  onClick={() => setInternalTimeframe(t as any)}
                  style={{
                    padding: "4px 8px", fontSize: 11, fontWeight: timeframe === t ? 600 : 500,
                    color: timeframe === t ? "var(--text-main)" : "var(--text-muted)",
                    background: timeframe === t ? "rgba(255,255,255,0.1)" : "transparent",
                    border: "none", borderRight: t !== 90 ? "1px solid var(--border-subtle)" : "none",
                    cursor: "pointer"
                  }}
                >
                  {t}d
                </button>
              ))}
            </div>
          )}

          <button onClick={fetchData} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {/* SVG Bar Chart — fixed height (see note on the root div above) rather
          than flex: 1, so this component's total height is self-contained
          and doesn't depend on an ancestor having a definite height. */}
      <div style={{ height: 160, position: "relative" }}>
        {loading && chartData.length === 0 ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
            Loading spend data...
          </div>
        ) : chartData.length === 0 ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
            No token usage recorded in this period.
          </div>
        ) : (
          <svg width="100%" height="100%" viewBox={`0 0 100 100`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
            {/* Grid lines */}
            {[0, 0.5, 1].map(pct => (
              <line key={pct} x1="0" y1={100 - (pct * 100)} x2="100" y2={100 - (pct * 100)} stroke="var(--border-subtle)" strokeWidth="0.5" strokeDasharray="2,2" />
            ))}
            
            {/* Bars */}
            {chartData.map((d, i) => {
              const barWidth = 100 / chartData.length;
              const barSpacing = barWidth * 0.2;
              const actualWidth = barWidth - barSpacing;
              const x = (i * barWidth) + (barSpacing / 2);
              const height = (d.cost / maxCost) * 100;
              const y = 100 - height;
              
              return (
                <g key={d.date} className="bar-group">
                  <rect
                    x={x} y={y} width={actualWidth} height={Math.max(height, 0.5)}
                    fill="#D4A04A"
                    opacity={d.cost > 0 ? 0.8 : 0.2}
                    rx="1"
                  >
                    <title>{`${d.date}\nCost: $${d.cost.toFixed(4)}\nTokens: ${(d.tokensIn + d.tokensOut).toLocaleString()}`}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "var(--text-muted)" }}>
        <span>{chartData[0]?.date}</span>
        <span>{chartData[chartData.length - 1]?.date}</span>
      </div>
    </div>
  );
}
