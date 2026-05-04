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

export // ─── Memory Tab ──────────────────────────────────────────────────────────────

function MemoryTab({ agent, isEmbedded }: { agent: AgentData; isEmbedded?: boolean }) {
  const memories = agent.memories || [];
  const { setAgents } = useWorldStore();
  const [newMemoryText, setNewMemoryText] = useState("");
  const [newMemoryType, setNewMemoryType] = useState("learned");
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const typeColors: Record<string, string> = { learned: "#4A9E96", experience: "#5B88A6", preference: "#8B6AAE", context: "#D4A04A" };

  const handleCreateMemory = async () => {
    if (!newMemoryText.trim()) return;
    setSaveStatus("loading");
    try {
      const newMem = {
        id: Math.random().toString(36).substring(7),
        type: newMemoryType,
        text: newMemoryText.trim(),
        when: new Date().toISOString(),
        confidence: 1.0
      };

      const updatedMemories = [newMem, ...memories];
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("update_agent_memories", { agentId: agent.id, memories: updatedMemories });

      setAgents(useWorldStore.getState().agents.map(a =>
        a.id === agent.id ? { ...a, memories: updatedMemories } as AgentData : a
      ));

      setNewMemoryText("");
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      console.error(err);
      setSaveStatus("error");
    }
  };

  const handleDeleteMemory = async (memId: string) => {
    try {
      const updatedMemories = memories.filter((m: any) => m.id !== memId);
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("update_agent_memories", { agentId: agent.id, memories: updatedMemories });

      setAgents(useWorldStore.getState().agents.map(a =>
        a.id === agent.id ? { ...a, memories: updatedMemories } as AgentData : a
      ));
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{ height: isEmbedded ? "100%" : "auto" }}>
      {!isEmbedded && (
        <>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Memory</h1>
          <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28 }}>
            What {agent.name} has learned and remembers. Memories are versioned and can be pruned.
          </p>
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["All", "Learned", "Experience", "Preference"].map(f => (
          <button key={f} style={{
            padding: "6px 14px", borderRadius: 20, border: "1px solid rgba(0,0,0,0.08)",
            background: f === "All" ? "#3c6663" : "var(--glass-light)",
            color: f === "All" ? "var(--surface-card)" : "var(--text-sub)",
            fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
          }}>{f}</button>
        ))}
      </div>

      <div style={{ ...glass(0.5), padding: 20, borderRadius: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 12 }}>Inject Manual Core Memory</div>
        <div style={{ display: "flex", gap: 12 }}>
          <select value={newMemoryType} onChange={e => setNewMemoryType(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", outline: "none" }}>
            <option value="learned">Learned Fact</option>
            <option value="experience">Experience</option>
            <option value="preference">Preference</option>
            <option value="context">Context</option>
          </select>
          <input
            value={newMemoryText}
            onChange={e => setNewMemoryText(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreateMemory()}
            placeholder="e.g. Only use the main branch for deployment."
            style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", outline: "none", fontSize: 13 }}
          />
          <button onClick={handleCreateMemory} disabled={saveStatus === "loading" || !newMemoryText.trim()} style={{
            padding: "10px 20px", borderRadius: 8, border: "none", background: !newMemoryText.trim() ? "var(--border-subtle)" : "#3c6663",
            color: !newMemoryText.trim() ? "#A0A0A0" : "var(--surface-card)", fontWeight: 600, cursor: !newMemoryText.trim() ? "not-allowed" : "pointer"
          }}>
            {saveStatus === "loading" ? "Saving..." : saveStatus === "success" ? "Saved!" : "Inject"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {memories.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-sub)", fontSize: 14 }}>
            {agent.name} doesn't have any memories yet.<br />Memories are formed asynchronously as the agent works.
          </div>
        ) : (
          memories.map((m: any, i: number) => (
            <div key={m.id || i} style={{ ...glass(0.5), padding: "16px 20px", borderRadius: 14, borderLeft: `3px solid ${typeColors[m.type] || typeColors["learned"]}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em",
                      color: typeColors[m.type], background: `${typeColors[m.type]}15`, padding: "2px 8px", borderRadius: 4,
                    }}>{m.type}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{m.when}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.5 }}>{m.text}</div>
                </div>
                <div style={{ textAlign: "right", marginLeft: 16 }}>
                  <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Confidence</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>{Math.round((m.confidence || 1.0) * 100)}%</div>
                  <button onClick={() => handleDeleteMemory(m.id)} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5 }}>🗑️</button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}