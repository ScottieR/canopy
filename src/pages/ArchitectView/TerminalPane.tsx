import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import type { GenerativeResult } from "../../types/generative";
import { Toggle, ServiceRow, glass } from "../../App";

export function TerminalPane({ agent, onClose, initialCommand = "" }: { agent: AgentData; onClose: () => void; initialCommand?: string }) {
  const [history, setHistory] = useState<{ command: string; output: string; timestamp: string }[]>([]);
  const [input, setInput] = useState(initialCommand);
  const [running, setRunning] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  useEffect(() => {
    const fetchAudit = async () => {
      try {
         const { invoke } = await import('@tauri-apps/api/core');
         const histText: any = await invoke('read_workspace_file', { agentId: agent.id, filename: '.terminal_history.json' }).catch(() => "[]");
         if (histText) {
             try {
                const parsed = JSON.parse(histText);
                if (Array.isArray(parsed)) setHistory(parsed);
             } catch (e) {}
         }
      } catch (e) { console.error(e); }
    };
    fetchAudit();
  }, [agent.id]);

  const saveHistory = async (newHist: any[]) => {
      try {
         const { invoke } = await import('@tauri-apps/api/core');
         await invoke('write_workspace_file', { agentId: agent.id, filename: '.terminal_history.json', content: JSON.stringify(newHist, null, 2) });
      } catch (e) {}
  };

  const executeCommand = async () => {
    if (!input.trim() || running) return;
    const cmd = input;
    setInput("");
    setRunning(true);
    
    let output = "";
    try {
       const { invoke } = await import('@tauri-apps/api/core');
       output = await invoke("run_agent_command", { agentId: agent.id, command: cmd });
    } catch (e: any) {
       output = String(e);
    }
    setRunning(false);

    try {
       const { invoke } = await import('@tauri-apps/api/core');
       const histText: any = await invoke('read_workspace_file', { agentId: agent.id, filename: '.terminal_history.json' }).catch(() => "[]");
       if (histText) {
           const parsed = JSON.parse(histText);
           if (Array.isArray(parsed)) setHistory(parsed);
       }
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", background: "#0a0a0a", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", margin: "0 40px 32px 40px", position: "relative" }}>
      <div style={{ padding: "12px 16px", background: "rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "white" }}>
          <Terminal size={16} />
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "monospace" }}>{agent.name} / Workspace Terminal</span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16, fontFamily: "'Geist Mono', monospace", fontSize: 12, color: "#d4d4d4", display: "flex", flexDirection: "column", gap: 16 }}>
        {history.length === 0 && (
          <div style={{ opacity: 0.5, fontStyle: "italic", textAlign: "center", marginTop: 20 }}>No terminal history found.</div>
        )}
        {history.map((h, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, color: "#4ade80" }}>
              <span style={{ userSelect: "none" }}>$</span>
              <span style={{ fontWeight: 600, color: "white" }}>{h.command}</span>
            </div>
            {h.output && (
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", background: "rgba(255,255,255,0.03)", padding: "8px 12px", borderRadius: 6, color: "#a3a3a3", border: "1px solid rgba(255,255,255,0.05)", overflowX: "auto" }}>
                {h.output.trim() || "(No output)"}
              </pre>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div style={{ padding: 16, background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ color: "#4ade80", fontFamily: "'Geist Mono', monospace", fontWeight: 600 }}>$</span>
          <input 
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') executeCommand();
              if (e.key === 'ArrowUp' && history.length > 0) setInput(history[history.length - 1].command);
            }}
            placeholder="Type a bash command to run in the agent's workspace..."
            style={{ flex: 1, background: "transparent", border: "none", color: "white", fontFamily: "'Geist Mono', monospace", fontSize: 13, outline: "none" }}
            disabled={running}
            autoFocus
          />
          <button 
            onClick={executeCommand}
            disabled={!input.trim() || running}
            style={{ padding: "6px 12px", background: running ? "rgba(255,255,255,0.1)" : "#218380", color: "white", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: input.trim() && !running ? "pointer" : "default", opacity: input.trim() || running ? 1 : 0.5 }}
          >
            {running ? "Running..." : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
