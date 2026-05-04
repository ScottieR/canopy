import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, glass } from "../../App";

export // ─── Spend Tab ───────────────────────────────────────────────────────────────

function SpendTab({ agent }: { agent: AgentData }) {
  const [budget, setBudget] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const budgetRes = await invoke('get_agent_budget', { agentId: agent.id });
        setBudget(budgetRes);
        const historyRes: any = await invoke('get_purchase_history', { agentId: agent.id });
        setHistory(Array.isArray(historyRes) ? historyRes : []);
      } catch (e) {
        console.error("Failed to load spend data", e);
      }
      setLoading(false);
    };
    fetchData();
  }, [agent.id]);

  if (loading) return <div style={{ color: "var(--text-sub)", fontSize: 14 }}>Loading financial data...</div>;
  if (!budget) return <div style={{ color: "var(--text-sub)", fontSize: 14 }}>Failed to map budget pipeline...</div>;

  const filteredHistory = history.filter(record => {
    const matchesSearch = record.merchant?.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          record.category?.toLowerCase().includes(searchQuery.toLowerCase());
    
    let isApproved = record.decision === "Approved" || record.decision === "approved" || record.decision?.Approved === null;
    let isDenied = record.decision === "Denied" || record.decision === "denied" || record.decision?.Denied;
    
    let matchesStatus = true;
    if (statusFilter === "Approved") matchesStatus = isApproved;
    if (statusFilter === "Denied") matchesStatus = isDenied;

    return matchesSearch && matchesStatus;
  });

  return (
    <div style={{ paddingBottom: 64 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Purchase Execution Log</h1>
          <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
            History of {agent.name}'s simulated and executed real-world transactions.
          </p>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", background: "var(--glass-light)", padding: "8px 16px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.05)" }}>
          Daily Spend: ${(budget.daily_spent_cents / 100).toFixed(2)} / Monthly: ${(budget.monthly_spent_cents / 100).toFixed(2)}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <input 
          type="text" 
          placeholder="Search merchant or category..." 
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 13, outline: "none" }}
        />
        <select 
          value={statusFilter} 
          onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 13, outline: "none", cursor: "pointer" }}
        >
          <option value="All">All Statuses</option>
          <option value="Approved">Approved</option>
          <option value="Denied">Denied</option>
        </select>
      </div>

      {filteredHistory.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-sub)", fontSize: 14, ...glass(0.4), borderRadius: 16 }}>
          {history.length === 0 ? "There are no recent agent transactions on record." : "No transactions match your filters."}
        </div>
      ) : (
        <div style={{ ...glass(0.6), borderRadius: 16, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--border-subtle)", textAlign: "left" }}>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Date/Time</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Merchant</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Category</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)" }}>Status</th>
                <th style={{ padding: "12px 20px", fontSize: 12, fontWeight: 600, color: "var(--text-sub)", textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((record, i) => (
                <tr key={record.id || i} style={{ borderTop: "1px solid rgba(0,0,0,0.04)" }}>
                  <td style={{ padding: "14px 20px", fontSize: 13, color: "var(--text-main)" }}>{new Date(record.timestamp || Date.now()).toLocaleString()}</td>
                  <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{record.merchant}</td>
                  <td style={{ padding: "14px 20px", fontSize: 13, color: "var(--text-sub)" }}>{record.category}</td>
                  <td style={{ padding: "14px 20px", fontSize: 13 }}>
                    {record.decision === "Approved" || record.decision === "approved" || record.decision?.Approved === null
                      ? <span style={{ color: "#4A9E96", background: "#4A9E9615", padding: "4px 8px", borderRadius: 4, fontWeight: 600, fontSize: 11 }}>APPROVED</span>
                      : record.decision === "Denied" || record.decision === "denied" || record.decision?.Denied
                        ? <span style={{ color: "#E57373", background: "#E5737315", padding: "4px 8px", borderRadius: 4, fontWeight: 600, fontSize: 11 }}>DENIED</span>
                        : <span style={{ color: "#D4A04A", background: "#D4A04A15", padding: "4px 8px", borderRadius: 4, fontWeight: 600, fontSize: 11 }}>REQUIRES APPROVAL</span>
                    }
                  </td>
                  <td style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: "var(--text-main)", textAlign: "right" }}>
                    ${((record.amount_cents || 0) / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}