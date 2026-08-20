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
import type { GenerativeResult } from "../../types/generative";
import { GlobalAlertsFeed } from "../GlobalAlertsFeed";
import { DecisionQueuePanel } from "../DecisionQueue/DecisionQueuePanel";
import { useFlavor } from "../../hooks/useFlavor";

export // ═══════════════════════════════════════════════════════════════════════════════
// TOP NAVIGATION BAR
// ═══════════════════════════════════════════════════════════════════════════════

function TopNav() {
  const { activeView, setActiveView, setActiveForumId, theme, toggleTheme, agents, setSelectedAgent, pendingDecisions, securityAlerts, systemWarnings, setSecurityAlerts, setSystemWarnings } = useWorldStore();
  const flavor = useFlavor();
  const [searchQuery, setSearchQuery] = useState("");
  const [showAlertsFeed, setShowAlertsFeed] = useState(false);
  const hasUnreadAlerts = securityAlerts.length > 0 || systemWarnings.length > 0;
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showDecisionQueue, setShowDecisionQueue] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  const actionableDecisions = pendingDecisions.filter(d => d.type === "pre_auth" || d.type === "needs_input" || d.type === "error");
  const decisionCount = pendingDecisions.length;

  useEffect(() => {
      let isPolling = false;
      const checkAlertsAndWarnings = async () => {
          if (isPolling) return;
          isPolling = true;
          try {
              const [alerts, warnings] = await Promise.all([
                invoke<any[]>("get_network_security_alerts"),
                invoke<any[]>("get_system_warnings")
              ]);
              setSecurityAlerts(alerts);
              setSystemWarnings(warnings.filter((w: any) => !w.resolved));
          } catch (e) {
              console.error(e);
          } finally {
              isPolling = false;
          }
      };
      checkAlertsAndWarnings();
      const interval = setInterval(checkAlertsAndWarnings, 5000);
      return () => clearInterval(interval);
  }, [setSecurityAlerts, setSystemWarnings]);

  // Close profile menu on outside click
  useEffect(() => {
    if (!showProfileMenu) return;
    const handler = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProfileMenu]);

  const navItems = [
    { id: "canopy" as const, label: "Canopy" },
    { id: "architect" as const, label: "Agents" },
    { id: "forum" as const, label: "Forums" },
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
        {flavor?.is_dev && (
          <span title="Dev flavor — isolated containers, ports, keychain, and data dir. Prod agents are untouched." style={{
            padding: "2px 8px",
            borderRadius: 6,
            fontSize: 10.5, fontWeight: 800, letterSpacing: "0.08em",
            color: "#7a4d00",
            background: "rgba(255, 191, 71, 0.92)",
            border: "1px solid rgba(176, 108, 0, 0.45)",
            textTransform: "uppercase",
            pointerEvents: "none",
          }}>DEV</span>
        )}
      </div>

      {/* Center nav */}
      <div style={{ display: "flex", gap: activeView === "canopy" ? 8 : 4 }}>
        {navItems.filter(item => activeView !== "loading" && activeView !== "onboarding").map(item => (
          <button key={item.id} onClick={() => {
            // Clicking "Forums" always shows the list first — clear any selected forum
            if (item.id === "forum") setActiveForumId(null);
            setActiveView(item.id);
          }} style={{
            padding: "6px 16px",
            border: activeView === "canopy" ? "1px solid rgba(255,255,255,0.22)" : "none",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 12, fontWeight: activeView === item.id ? 700 : 400,
            letterSpacing: "0.04em", textTransform: "uppercase",
            color: activeView === item.id
              ? "var(--text-main)"
              : activeView === "canopy"
                ? "rgba(45, 57, 56, 0.88)"
                : "var(--text-sub)",
            background: activeView === "canopy"
              ? activeView === item.id
                ? "linear-gradient(135deg, rgba(255,255,255,0.34), rgba(244,248,247,0.16))"
                : "linear-gradient(135deg, rgba(255,255,255,0.22), rgba(255,255,255,0.08))"
              : "transparent",
            fontFamily: "inherit",
            backdropFilter: activeView === "canopy" ? "blur(16px) saturate(135%)" : "none",
            WebkitBackdropFilter: activeView === "canopy" ? "blur(16px) saturate(135%)" : "none",
            borderBottom: activeView === "canopy"
              ? "none"
              : activeView === item.id
                ? "2px solid #3c6663"
                : "2px solid transparent",
            boxShadow: activeView === "canopy"
              ? activeView === item.id
                ? "0 6px 16px rgba(26, 46, 43, 0.08), inset 0 -2px 0 #3c6663"
                : "0 4px 12px rgba(26, 46, 43, 0.05), inset 0 1px 0 rgba(255,255,255,0.16)"
              : "none",
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
            {/* Diagnostics wrench — front-and-center, with red badge when any agent is erroring */}
            <div
              onClick={() => setActiveView("diagnostics")}
              title="Diagnostics"
              style={{
                width: 32, height: 32, borderRadius: 8, background: activeView === "diagnostics" ? "rgba(60,102,99,0.15)" : "var(--border-subtle)",
                display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", position: "relative",
                color: activeView === "diagnostics" ? "#3c6663" : "var(--text-sub)",
                transition: "all 0.15s ease",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              {agents.some(a => a.status === "error" && !a.paused) && (
                <div style={{ position: "absolute", top: 5, right: 5, width: 7, height: 7, borderRadius: "50%", background: "#DC2626", border: "2px solid var(--surface-base)" }} />
              )}
            </div>
            {/* Unified Inbox — shows count badge for decisions and red dot for security alerts */}
            <div
              onClick={() => setShowDecisionQueue(v => !v)}
              title="Inbox & Alerts"
              style={{
                width: 32, height: 32, borderRadius: 8, position: "relative",
                background: showDecisionQueue ? "rgba(60,102,99,0.15)" : "var(--border-subtle)",
                display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
                color: showDecisionQueue ? "#3c6663" : hasUnreadAlerts ? "#DC2626" : actionableDecisions.length > 0 ? "#D4A04A" : "var(--text-sub)",
                transition: "all 0.15s ease",
              }}
            >
              {/* Inbox icon */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
                <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
              </svg>
              {/* Count badge */}
              {(decisionCount > 0 || hasUnreadAlerts) && (
                <div style={{
                  position: "absolute", top: -4, right: -4,
                  minWidth: 16, height: 16, borderRadius: 8, padding: "0 4px",
                  background: hasUnreadAlerts ? "#DC2626" : actionableDecisions.length > 0 ? "#D4A04A" : "#4A9E96",
                  border: "2px solid var(--surface-base)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 800, color: "#fff",
                }}>
                  {decisionCount + (hasUnreadAlerts ? 1 : 0) > 9 ? "9+" : decisionCount + (hasUnreadAlerts ? 1 : 0)}
                </div>
              )}
            </div>


            {/* Profile / settings dropdown */}
            <div ref={profileMenuRef} style={{ position: "relative" }}>
              <div
                onClick={() => setShowProfileMenu(p => !p)}
                style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: showProfileMenu ? "rgba(60,102,99,0.15)" : "var(--border-subtle)",
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
                  color: showProfileMenu ? "#3c6663" : "var(--text-sub)",
                  transition: "all 0.15s ease",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              </div>

              {showProfileMenu && (
                <div style={{
                  position: "absolute", top: "calc(100% + 8px)", right: 0,
                  background: "var(--surface-card, #fff)",
                  border: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
                  borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
                  minWidth: 160, zIndex: 100, overflow: "hidden",
                  padding: "4px 0",
                }}>
                  {[
                    { id: "profile" as const, label: "Profile", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg> },
                    { id: "dashboard" as const, label: "My Usage", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" /></svg> },
                    { id: "archive" as const, label: "Archive", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></svg> },
                    { id: "integrations" as const, label: "Integrations", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x="2" y="3" width="6" height="6" rx="1" /><rect x="16" y="3" width="6" height="6" rx="1" /><rect x="9" y="15" width="6" height="6" rx="1" /><path d="M5 9v3a1 1 0 001 1h12a1 1 0 001-1V9" /><path d="M12 13v2" /></svg> },
                    { id: "diagnostics" as const, label: "Diagnostics", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg> },
                  ].map((item, i, arr) => (
                    <div key={item.id}>
                      {/* Divider before Diagnostics */}
                      {item.id === "diagnostics" && (
                        <div style={{ height: 1, background: "var(--border-subtle, rgba(0,0,0,0.06))", margin: "4px 0" }} />
                      )}
                      <div
                        onClick={() => { setActiveView(item.id); setShowProfileMenu(false); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 9,
                          padding: "8px 14px", cursor: "pointer",
                          fontSize: 12, fontWeight: activeView === item.id ? 600 : 400,
                          color: activeView === item.id ? "#3c6663" : "var(--text-main, #303330)",
                          background: activeView === item.id ? "rgba(60,102,99,0.06)" : "transparent",
                          transition: "background 0.1s ease",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = activeView === item.id ? "rgba(60,102,99,0.08)" : "var(--surface-container-low, #f4f4f0)")}
                        onMouseLeave={e => (e.currentTarget.style.background = activeView === item.id ? "rgba(60,102,99,0.06)" : "transparent")}
                      >
                        <span style={{ opacity: 0.6, display: "flex" }}>{item.icon}</span>
                        {item.label}
                        {activeView === item.id && (
                          <svg style={{ marginLeft: "auto" }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#3c6663" strokeWidth={3} strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {showAlertsFeed && <GlobalAlertsFeed onClose={() => setShowAlertsFeed(false)} />}
      {showDecisionQueue && <DecisionQueuePanel onClose={() => setShowDecisionQueue(false)} />}
    </div>
  );
}
