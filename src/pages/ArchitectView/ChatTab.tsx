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

export // ─── Chat / Communion Component ──────────────────────────────────────────────

function ChatTab({ agent, compact = false }: { agent: AgentData; compact?: boolean }) {
  const { agents, setAgents, setArchitectTab } = useWorldStore();
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const [message, setMessage] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>(agent.chatLog);
  const [loading, setLoading] = useState(false);
  const [needsRepair, setNeedsRepair] = useState(false);
  const [isHealing, setIsHealing] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll to bottom whenever chatLog changes
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // Keep global state in sync so errors remain when switching tabs
    setAgents(agents.map(a => a.id === agent.id ? { ...a, chatLog } : a));
  }, [chatLog]);

  useEffect(() => {
    if (typeof invoke === 'function') {
      const fetchHistory = async () => {
        try {
          const resp: any = await invoke("get_conversation_history", { agentId: agent.id, limit: 100 });
          let localMessages: any[] = [];
          
          if (Array.isArray(resp) && resp.length > 0) {
            localMessages = resp.map(r => ({
              id: r.id,
              sender: r.role === "user" ? "user" : "agent",
              text: r.content,
              time: new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              ts: new Date(r.timestamp).getTime()
            }));
          }

          // Fetch external Slack messages
          let slackMessages: any[] = [];
          try {
            const allowedChannels: string[] = await invoke("get_allowed_slack_channels", { agentId: agent.id });
            for (const channelId of allowedChannels) {
               const msgs: any = await invoke("read_slack_messages", { agentId: agent.id, channelId, limit: 30 });
               if (Array.isArray(msgs)) {
                 const mapped = msgs.map(m => ({
                   id: `slack-${m.ts}`,
                   // Simple heuristic: if there's no user or it's empty, or if we had a way to check bot_id we would. For now assume user unless it has specific indicators, but really we just map everything as user for now or agent if we detect it's an assistant response.
                   sender: m.user ? "user" : "agent", 
                   text: `💬 *[Slack]* ${m.text}`,
                   time: new Date(parseFloat(m.ts) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                   ts: parseFloat(m.ts) * 1000
                 }));
                 slackMessages.push(...mapped);
               }
            }
          } catch (e) {
            console.error("Slack fetch error:", e);
          }

          // Merge, sort chronologically, and deduplicate simple overlap
          const allMessages = [...localMessages, ...slackMessages].sort((a, b) => a.ts - b.ts);
          
          // Retain any locally generated UI messages (like system errors) that aren't in the canonical backend
          const localOnly = agent.chatLog.filter(msg => !allMessages.some((m: any) => m.id === msg.id) && msg.text.includes("⚠️ **System"));
          
          if (allMessages.length > 0 || localOnly.length > 0) {
            setChatLog([...allMessages, ...localOnly]);
          }

        } catch (err) {
          console.error("Failed to fetch chat history:", err);
        }
      };
      
      fetchHistory();
    }
  }, [agent.id]);

  const handleSendMessage = async () => {
    if (!message.trim()) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      text: message,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setChatLog(prev => [...prev, userMsg]);
    setMessage("");
    setLoading(true);

    try {
      const response: any = await invoke("send_message", {
        agentId: agent.id,
        message: message,
      });

      const responseText = typeof response === 'object' ? response?.response || response?.content || JSON.stringify(response) : String(response);

      const agentMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "agent",
        text: responseText,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setChatLog(prev => [...prev, agentMsg]);
    } catch (error) {
      let friendlyError = String(error);
      if (friendlyError.includes("stopped container") || friendlyError.includes("OOM")) {
        // Only auto-heal on actual container-stopped / OOM errors — NOT on Gateway Timeout.
        // A Gateway Timeout means the agent is slow (container under load) — restarting
        // the OrbStack VM makes it worse, not better. Let the user retry manually.
        setIsHealing(true);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("hard_reset_infrastructure").catch(ex => console.error("Hard reset failed:", ex));
        await invoke("boot_sync_agents").catch(ex => console.warn("boot_sync after heal:", ex));
        setIsHealing(false);
        friendlyError = "The gateway was restarted and agents re-initialized. Please try sending your message again!";
      } else if (friendlyError.includes("taking a long time") || friendlyError.includes("Gateway Timeout")) {
        // Timeout — agent may not be registered yet (dir missing → agents add timed out on a previous boot).
        // Fire boot_sync_agents in the background so the NEXT send attempt succeeds.
        // We don't await it so the error message shows immediately. No VM restart — safe.
        const { invoke: inv } = await import('@tauri-apps/api/core');
        inv("boot_sync_agents").catch((e: any) => console.warn("background boot_sync after timeout:", e));
        friendlyError = "The agent is taking a while to respond. Registration is being refreshed — please try again in 30 seconds.";
      } else if (friendlyError.includes("No API key found for provider")) {
        const match = friendlyError.match(/No API key found for provider "([^"]+)"/);
        if (match) {
          friendlyError = `You have selected a **${match[1].toUpperCase()}** model, but no API key is configured. Please set your key in the Vault or run Diagnostics.`;
        } else {
          friendlyError = "Your API Key is missing for this model's provider. Please configure your integration.";
        }
      } else if (friendlyError.includes("Unknown model")) {
        const match = friendlyError.match(/Unknown model: ([^\s]+)/);
        if (match) {
          friendlyError = `The model **${match[1]}** is not recognized. Please check your spelling or select a valid model from the dropdown.`;
        } else {
          friendlyError = "The model you selected is unknown or unsupported.";
        }
      } else if (friendlyError.includes("access not configured") || friendlyError.includes("Re-Initialize Setup")) {
        setNeedsRepair(true);
        friendlyError = "This agent isn't configured with API keys yet and can't respond. Use the button below to finish setup.";
      }

      const errorMsg: ChatMessage = {
        id: "err-" + Date.now().toString(),
        sender: "agent",
        text: `⚠️ **System Error**: ${friendlyError}\n\n*(Raw Error: ${String(error).substring(0, 80)}...)*`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      
      setChatLog(prev => [...prev, errorMsg]);
      
      // Update global state using functional mapper to avoid stale 'agents' array
      useWorldStore.setState(state => ({
        agents: state.agents.map(a => a.id === agent.id ? { ...a, chatLog: [...a.chatLog, errorMsg] } : a)
      }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {!compact && (
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>Chat</h1>
          <p style={{ fontSize: 14, color: "var(--text-sub)" }}>Communicate directly with {agent.name}.</p>
        </div>
      )}

      {/* Chat log */}
      <div style={{
        flex: 1, ...glass(0.35), borderRadius: 16, padding: 20, overflow: "auto",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        {chatLog.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)" }}>
            Start a conversation...
          </div>
        ) : (
          chatLog.map(msg => (
            <div key={msg.id} style={{
              display: "flex", flexDirection: "column",
              alignItems: msg.sender === "user" ? "flex-end" : "flex-start",
            }}>
              <div style={{
                maxWidth: "70%", padding: "12px 16px", borderRadius: 14,
                background: msg.sender === "user"
                  ? "linear-gradient(135deg, #3c6663, #609995)"
                  : "var(--glass-light)",
                color: msg.sender === "user" ? "var(--surface-card)" : "var(--text-main)",
                fontSize: 13, lineHeight: 1.5,
                borderBottomRightRadius: msg.sender === "user" ? 4 : 14,
                borderBottomLeftRadius: msg.sender === "agent" ? 4 : 14,
              }}>
                {(() => {
                  const credentialRegex = /\[REQUEST_CREDENTIAL:\s*(.+?)\]/g;
                  if (!msg.text.includes("[REQUEST_CREDENTIAL:")) return msg.text;

                  const parts = msg.text.split(credentialRegex);
                  return (
                    <>
                      {parts.map((part, i) => {
                        // Every odd index is the captured group (domain)
                        if (i % 2 === 1) {
                          const domain = part.trim();
                          return (
                            <div key={i} style={{ marginTop: 8, marginBottom: 8, padding: 12, background: "var(--background)", border: "1px solid var(--border-subtle)", borderRadius: 8, color: "var(--text-main)" }}>
                              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                                <Lock size={14} /> Login Required
                              </div>
                              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                                {agent.name} is requesting credentials to access <strong>{domain}</strong>.
                              </div>
                              <button 
                                onClick={() => setArchitectTab("integrations")} 
                                style={{ padding: "6px 12px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", width: "100%" }}
                              >
                                Authorize in WebVault
                              </button>
                            </div>
                          );
                        }
                        return <span key={i} style={{ whiteSpace: "pre-wrap" }}>{part}</span>;
                      })}
                    </>
                  );
                })()}
              </div>
              <div style={{
                fontSize: 10, color: "var(--text-muted)", marginTop: 4,
                paddingLeft: msg.sender === "agent" ? 4 : 0,
                paddingRight: msg.sender === "user" ? 4 : 0,
              }}>
                {msg.sender === "agent" ? agent.name : "You"} · {msg.time}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 12, height: 12, borderRadius: "50%", background: "#3c6663",
              animation: "pulse 1.5s ease-in-out infinite",
            }} />
            <span style={{ fontSize: 13, color: "var(--text-sub)", fontStyle: "italic" }}>{agent.name} is thinking...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Repair banner — shown when agent returns "access not configured" */}
      {needsRepair && (
        <div style={{
          marginTop: 10, padding: "12px 16px",
          background: "linear-gradient(135deg, rgba(192,57,43,0.07), rgba(192,57,43,0.03))",
          border: "1px solid rgba(192,57,43,0.25)", borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div style={{ fontSize: 13, color: "#8b1a0e", lineHeight: 1.4 }}>
            <strong>Setup required.</strong> {agent.name} has no API key configured and can't respond yet.
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => setArchitectTab("overview")}
              style={{
                padding: "7px 14px", background: "#c0392b", color: "white",
                border: "none", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Re-Initialize Setup →
            </button>
            <button
              onClick={() => setNeedsRepair(false)}
              style={{ padding: "7px 10px", background: "transparent", color: "#8b1a0e", border: "1px solid rgba(192,57,43,0.3)", borderRadius: 8, fontSize: 12, cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && message.trim() && !loading && gatewayReady && !agent.paused) handleSendMessage(); }}
          placeholder={agent.paused ? "Agent is paused — resume it to chat..." : !gatewayReady ? "Agents are waking up..." : `Talk to ${agent.name}...`}
          disabled={loading || !gatewayReady || agent.paused}
          style={{
            flex: 1, padding: "14px 18px", borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.08)",
            background: "var(--glass-light)",
            fontSize: 13, fontFamily: "inherit", color: "var(--text-main)",
            outline: "none", opacity: (loading || !gatewayReady || agent.paused) ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleSendMessage}
          disabled={!message.trim() || loading || !gatewayReady || agent.paused}
          title={agent.paused ? "Resume the agent to send messages" : !gatewayReady ? "Agents are waking up, please wait..." : undefined}
          style={{
            padding: "14px 20px", borderRadius: 14, border: "none",
            background: (message.trim() && !loading && gatewayReady && !agent.paused) ? "#3c6663" : "var(--border-subtle)",
            color: (message.trim() && !loading && gatewayReady && !agent.paused) ? "var(--surface-card)" : "var(--text-muted)",
            fontSize: 13, fontWeight: 600, cursor: (message.trim() && !loading && gatewayReady && !agent.paused) ? "pointer" : "default",
            fontFamily: "inherit",
            transition: "all 0.15s ease",
          }}
        >{agent.paused ? "⏸" : !gatewayReady ? "⏳" : "Send"}</button>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}