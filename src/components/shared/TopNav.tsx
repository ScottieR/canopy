import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, Bell
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO } from "../../store/worldStore";
import { Toggle, ServiceRow, glass } from "../../App";
import { GenerativeResult } from "../GenerativeStudio";
import { GlobalAlertsFeed } from "../GlobalAlertsFeed";

export // ═══════════════════════════════════════════════════════════════════════════════
// TOP NAVIGATION BAR
// ═══════════════════════════════════════════════════════════════════════════════

function TopNav() {
  const { activeView, setActiveView, theme, toggleTheme, agents, setSelectedAgent } = useWorldStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [showAlertsFeed, setShowAlertsFeed] = useState(false);
  const [hasUnreadAlerts, setHasUnreadAlerts] = useState(false);

  useEffect(() => {
      const checkAlerts = async () => {
          try {
              const data = await invoke<any[]>("get_network_security_alerts");
              setHasUnreadAlerts(data.length > 0);
          } catch (e) {
              console.error(e);
          }
      };
      checkAlerts();
      const interval = setInterval(checkAlerts, 5000);
      return () => clearInterval(interval);
  }, []);

  const navItems = [
    { id: "canopy" as const, label: "Canopy" },
    { id: "architect" as const, label: "Agents" },
    { id: "archive" as const, label: "Archive" },
    { id: "integrations" as const, label: "Integrations" },
  ];

  const filteredAgents = searchQuery ? agents.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()) || a.role.toLowerCase().includes(searchQuery.toLowerCase())) : [];

  return (
    <div style={{
      position: activeView === "canopy" ? "absolute" : "relative",
      top: 0, left: 0, right: 0, zIndex: 20,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 24px 12px 80px",
      background: activeView === "canopy" ? "transparent" : "var(--glass-light)",
      borderBottom: activeView === "canopy" ? "none" : "1px solid rgba(0,0,0,0.06)",
      backdropFilter: activeView === "canopy" ? "none" : "blur(24px)",
      WebkitAppRegion: "drag",
    } as any} data-tauri-drag-region onPointerDown={async (e) => {
      if (e.target === e.currentTarget) {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().startDragging();
        } catch(err) {}
      }
    }}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setActiveView("canopy")}>
        <img src="/app-icon.png" alt="Canopy Logo" style={{ width: 28, height: 28, objectFit: "contain", pointerEvents: "none" }} />
        <span style={{
          fontSize: 17, fontWeight: 700, color: "var(--text-main)", letterSpacing: "-0.02em",
          fontFamily: "'Satoshi', 'Manrope', system-ui, sans-serif",
          fontStyle: "italic",
        }}>The Canopy</span>
      </div>

      {/* Center nav */}
      <div style={{ display: "flex", gap: 4 }}>
        {navItems.filter(item => activeView !== "loading" && activeView !== "onboarding").map(item => (
          <button key={item.id} onClick={() => setActiveView(item.id)} style={{
            padding: "6px 16px", border: "none", borderRadius: 6, cursor: "pointer",
            fontSize: 12, fontWeight: activeView === item.id ? 700 : 400,
            letterSpacing: "0.04em", textTransform: "uppercase",
            color: activeView === item.id ? "var(--text-main)" : "var(--text-sub)",
            background: "transparent", fontFamily: "inherit",
            borderBottom: activeView === item.id ? "2px solid #3c6663" : "2px solid transparent",
            transition: "all 0.15s ease",
          }}>
            {item.label}
          </button>
        ))}
      </div>

      {/* Right actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {activeView !== "canopy" && activeView !== "loading" && activeView !== "onboarding" && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => setActiveView("onboarding")}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 14px", borderRadius: 8, background: "#3c6663", color: "var(--surface-card)", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", transition: "0.2s all"
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              New Agent
            </button>

            <div style={{ position: "relative" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 14px",
                borderRadius: 8, background: "var(--border-subtle)", color: "var(--text-sub)",
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
                <input
                  placeholder="Search agents..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{ border: "none", outline: "none", background: "transparent", width: 120, fontSize: 12, fontFamily: "inherit", color: "var(--text-main)" }}
                />
              </div>
              {searchQuery && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--surface-card)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", border: "1px solid rgba(0,0,0,0.05)", zIndex: 50, maxHeight: 300, overflow: "auto" }}>
                  {filteredAgents.length === 0 ? (
                    <div style={{ padding: "12px", fontSize: 12, color: "var(--text-sub)" }}>No agents found.</div>
                  ) : (
                    filteredAgents.map(a => (
                      <div key={a.id} onClick={() => { setSelectedAgent(a.id); setActiveView("architect"); setSearchQuery(""); }} style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid rgba(0,0,0,0.03)" }}>
                        <div style={{ width: 16, height: 16, borderRadius: "50%", background: `${a.robeColor}20`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <div style={{ width: 6, height: 6, borderRadius: "50%", background: a.status === "active" ? "#4A9E96" : "#E57373" }} />
                        </div>
                        <div style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-main)", fontWeight: 600 }}>{a.name}</div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {(activeView !== "loading" && activeView !== "onboarding") && (
          <>
            <button onClick={toggleTheme} style={{
              width: 32, height: 32, borderRadius: 8, border: "none", cursor: "pointer",
              background: "var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center",
              color: theme === "dark" ? "#F5E6D8" : "var(--text-sub)",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
            </button>
            <div onClick={() => setShowAlertsFeed(true)} style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--border-subtle)", position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              color: hasUnreadAlerts ? "#DC2626" : "var(--text-sub)",
            }}>
              <Bell size={16} />
              {hasUnreadAlerts && <div style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: "50%", background: "#DC2626", border: "2px solid var(--surface-base)" }} />}
            </div>
            <div onClick={() => setActiveView("profile")} style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--border-subtle)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              color: "var(--text-sub)",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            </div>
            <div onClick={() => setActiveView("diagnostics")} style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--border-subtle)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              color: "var(--text-sub)",
            }} title="System Diagnostics">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
            </div>
          </>
        )}
      </div>
      {showAlertsFeed && <GlobalAlertsFeed onClose={() => setShowAlertsFeed(false)} />}
    </div>
  );
}