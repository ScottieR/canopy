import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, AlertTriangle
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
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
        <div style={{
          padding: "12px 16px", background: "rgba(0,0,0,0.02)", borderTopLeftRadius: 14, borderTopRightRadius: 14,
          borderBottom: `2px solid var(--text-main)`, display: "flex", flexDirection: "column"
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-main)", marginBottom: 4 }}>OpenClaw Permissions</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Configure the core capabilities of the OpenClaw agent.</div>
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