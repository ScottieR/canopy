import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu,
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, AlertTriangle
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import type { GenerativeResult } from "../../types/generative";
import { Toggle, ServiceRow, glass } from "../../App";

export // ─── Permissions Tab ─────────────────────────────────────────────────────────

function PermissionsTab({ agent }: { agent: AgentData }) {
  const toggle = useWorldStore(s => s.togglePermission);
  const OPENCLAW_PERMISSIONS_GUIDE: Record<string, { desc: string, recommended: string }> = {
    ext_network: { desc: "Allow outbound API calls and web access.", recommended: "On for agents needing web search or external APIs. Off for completely local/private agents." },
    int_network: { desc: "Communicate with other agents via data handoffs.", recommended: "On if you have multiple agents collaborating." },
    autonomous: { desc: "Run tasks without manual approval.", recommended: "Off by default. Turn on only for trusted agents with well-defined tasks." },
    scheduled: { desc: "Execute on cron schedules.", recommended: "On for background agents like cron jobs or recurring reminders." },
    memory_write: { desc: "Store long-term data and learnings.", recommended: "On for most agents so they can remember context over time." },
    file_read: { desc: "Read files in scoped directories.", recommended: "On if the agent needs to read your workspace documents." },
    file_write: { desc: "Create and modify files.", recommended: "On for coder or writer agents. Off for read-only assistants." },
    payments: { desc: "Request virtual cards for purchases.", recommended: "Off unless the agent specifically handles procurement." },
    spend_auto: { desc: "Auto-approve purchases under threshold.", recommended: "Off unless you explicitly trust the agent with real money." },
    imessage: { desc: "Read and reply to text messages.", recommended: "On for communication agents. Off for internal tools." },
    photos: { desc: "Access local photo library database.", recommended: "Off unless the agent is specifically for photo management." }
  };

  const PROFILES = {
    locked: {
      ext_network: false, int_network: false, autonomous: false,
      file_write: false, payments: false, spend_auto: false,
      imessage: false, browser: false, proxy: false
    },
    balanced: {
      ext_network: true, int_network: true, browser: true,
      vision: true, gog: true, coding: true, file_read: true,
      autonomous: false, file_write: false, payments: false,
      spend_auto: false
    },
    yolo: {
      ext_network: true, int_network: true, autonomous: true,
      file_write: true, file_read: true, payments: true,
      spend_auto: true, imessage: true, browser: true,
      proxy: true, vision: true, coding: true, gog: true
    }
  };

  const isProfileMatch = (profileMap: Record<string, boolean>) => {
    return Object.entries(profileMap).every(([key, value]) => {
      const perm = agent.permissions.find(p => p.id === key);
      return perm ? perm.enabled === value : true;
    });
  };

  const currentProfile = isProfileMatch(PROFILES.locked) ? 'locked' :
                         isProfileMatch(PROFILES.balanced) ? 'balanced' :
                         isProfileMatch(PROFILES.yolo) ? 'yolo' : 'custom';

  const applyProfile = async (profileId: 'locked' | 'balanced' | 'yolo') => {
    const map = PROFILES[profileId];
    const newPerms = [...agent.permissions];
    
    Object.entries(map).forEach(([key, desired]) => {
       const p = newPerms.find(x => x.id === key);
       if (p && p.enabled !== desired) {
          toggle(agent.id, key);
          p.enabled = desired;
       }
    });
    
    try {
      if (typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function') {
        const invoke = (window as any).__TAURI_INTERNALS__.invoke;
        const capabilitiesObj: any = {};
        newPerms.forEach(px => capabilitiesObj[px.id] = px.enabled);
        await invoke("update_agent_capabilities", {
          agentId: agent.id,
          capabilities: capabilitiesObj
        });
      }
    } catch (e) { console.error("Failed to update capabilities", e); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Permissions</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28 }}>
        Granular control over {agent.name}'s capabilities. Changes take effect immediately.
      </p>

      {/* Isolation badge */}
      <div style={{
        ...glass(0.5), padding: "14px 20px", borderRadius: 12, marginBottom: 20,
        display: "flex", alignItems: "center", gap: 12,
        borderLeft: "3px solid #6B6BAE",
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6B6BAE" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>Shared Container</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)" }}>This agent runs in the shared Gateway. Switch to isolated for OS-level sandboxing.</div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          id="isolate-btn"
          onClick={async () => {
            const btn = document.getElementById('isolate-btn');
            const wasIsolated = agent.isolated;
            if (btn) btn.innerText = "Rebooting...";
            try {
              if (typeof invoke === 'function') {
                await invoke("toggle_agent_isolation", {
                  agentId: agent.id,
                  isolated: !wasIsolated
                });
                useWorldStore.getState().toggleIsolation(agent.id);
              }
            } catch (e) {
              console.error("Failed isolation toggle", e);
            } finally {
              if (btn) btn.innerText = !wasIsolated ? "Join Shared" : "Isolate";
            }
          }}
          style={{
            padding: "6px 14px", borderRadius: 8, border: "1px solid #6B6BAE",
            background: agent.isolated ? "#6B6BAE" : "transparent", color: agent.isolated ? "var(--surface-card)" : "#6B6BAE", fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s"
          }}>{agent.isolated ? "Un-Isolate" : "Isolate"}</button>
      </div>

      {agent.permissions.find(p => p.id === "file_write")?.enabled && agent.permissions.find(p => p.id === "browser")?.enabled && (
        <div style={{ marginBottom: 24, padding: 16, background: "rgba(212, 160, 74, 0.1)", border: "1px solid rgba(212, 160, 74, 0.3)", borderRadius: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertTriangle size={20} color="#D4A04A" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#D4A04A", marginBottom: 4 }}>Security Edge-Case Warning</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
              This agent has both <strong>Web Browser</strong> and <strong>File System Write</strong> enabled. 
              It could theoretically download malicious files to its workspace and use its write permissions to copy them to mounted local directories. 
              Use this combination only if explicitly required.
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", marginBottom: 12 }}>Access Level</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {/* Guarded — formerly Locked Down. Hover-over explains which permissions stay off and why. */}
          <button
            type="button"
            onClick={() => applyProfile('locked')}
            title="Best for agents handling money, secrets, or sensitive data. They can think and reason but can't reach the web, browse, write files, or take autonomous actions."
            style={{
              padding: 16, borderRadius: 12, cursor: "pointer", transition: "all 0.2s",
              background: currentProfile === 'locked' ? "rgba(33,131,128,0.12)" : "var(--surface-card)",
              border: currentProfile === 'locked' ? "2px solid #218380" : "2px solid transparent",
              boxShadow: currentProfile === 'locked' ? "0 4px 12px rgba(33,131,128,0.1)" : "none",
              textAlign: "left", fontFamily: "inherit",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>Guarded</div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>Safest. Read and reason only — no web, no browser, no file writes.</div>
          </button>

          {/* Balanced — recommended default. */}
          <button
            type="button"
            onClick={() => applyProfile('balanced')}
            title="The right default for most agents. Web search, browsing, vision, and code execution are on; autonomous actions and traffic interception stay off."
            style={{
              padding: 16, borderRadius: 12, cursor: "pointer", transition: "all 0.2s",
              background: currentProfile === 'balanced' ? "rgba(60,102,99,0.12)" : "var(--surface-card)",
              border: currentProfile === 'balanced' ? "2px solid #3c6663" : "2px solid transparent",
              boxShadow: currentProfile === 'balanced' ? "0 4px 12px rgba(60,102,99,0.1)" : "none",
              textAlign: "left", fontFamily: "inherit",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
              Balanced <span style={{ fontSize: 9, background: "#3c6663", color: "white", padding: "2px 6px", borderRadius: 4, marginLeft: 4, fontWeight: 700, letterSpacing: "0.02em" }}>RECOMMENDED</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>Useful but safe. Web search, vision, code execution. No file writes, no autonomous actions.</div>
          </button>

          {/* Unrestricted — formerly YOLO. */}
          <button
            type="button"
            onClick={() => applyProfile('yolo')}
            title="Only for agents you've fully vetted. They can take autonomous actions on your behalf, intercept network traffic, write files, and request payments."
            style={{
              padding: 16, borderRadius: 12, cursor: "pointer", transition: "all 0.2s",
              background: currentProfile === 'yolo' ? "rgba(198,40,40,0.10)" : "var(--surface-card)",
              border: currentProfile === 'yolo' ? "2px solid #C62828" : "2px solid transparent",
              boxShadow: currentProfile === 'yolo' ? "0 4px 12px rgba(198,40,40,0.1)" : "none",
              textAlign: "left", fontFamily: "inherit",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
              Unrestricted <span style={{ fontSize: 9, background: "rgba(198,40,40,0.15)", color: "#C62828", padding: "2px 6px", borderRadius: 4, marginLeft: 4, fontWeight: 700, letterSpacing: "0.02em" }}>HIGH RISK</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>Full access. Autonomous file writes, payments, traffic interception, and messaging.</div>
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <div style={{
          padding: "12px 16px", background: "rgba(0,0,0,0.02)", borderTopLeftRadius: 14, borderTopRightRadius: 14,
          borderBottom: `2px solid var(--text-main)`, display: "flex", flexDirection: "column"
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-main)", marginBottom: 4 }}>Fine-tune individual capabilities</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Toggle each capability on or off. Changes take effect immediately.</div>
        </div>
        <div style={{ ...glass(0.5), borderBottomLeftRadius: 14, borderBottomRightRadius: 14, overflow: "hidden" }}>
          {agent.permissions.map((p, i, arr) => {
            const guide = OPENCLAW_PERMISSIONS_GUIDE[p.id] || { desc: p.description, recommended: "Use your best judgement." };
            return (
              <div key={p.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 20px",
                borderBottom: i < arr.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)" }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>{guide.desc}</div>
                  </div>
                  <div title={guide.recommended} style={{
                    width: 16, height: 16, borderRadius: "50%", background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.1)",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: "bold", color: "var(--text-sub)", cursor: "help"
                  }}>?</div>
                </div>
                <Toggle enabled={p.enabled} onChange={async () => {
                  toggle(agent.id, p.id);
                  try {
                    if (typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function') {
                      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
                      const newPerms = agent.permissions.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x);
                      const capabilitiesObj: any = {};
                      newPerms.forEach(px => capabilitiesObj[px.id] = px.enabled);
                      await invoke("update_agent_capabilities", {
                        agentId: agent.id,
                        capabilities: capabilitiesObj
                      });
                    }
                  } catch (e) { console.error("Failed to update capabilities", e); }
                }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
