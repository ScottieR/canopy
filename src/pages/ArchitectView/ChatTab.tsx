import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, glass } from "../../App";
import MDEditor from "@uiw/react-md-editor";
import { invoke } from "@tauri-apps/api/core";
import { PasswordInput } from "../../components/shared/PasswordInput";

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
  
  // Inline Auth Modal State
  const [authDomain, setAuthDomain] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [existingCreds, setExistingCreds] = useState<{domain: string; username: string}[]>([]);
  const [selectedCreds, setSelectedCreds] = useState<string[]>([]);
  const [forceNewCred, setForceNewCred] = useState(false);

  useEffect(() => {
    if (authDomain) {
      invoke<{domain: string; username: string}[]>("get_web_credentials_cmd")
        .then(creds => {
           const matches = creds.filter(c => c.domain.toLowerCase() === authDomain.toLowerCase());
           setExistingCreds(matches);
           setSelectedCreds(matches.map(c => `${c.domain}_${c.username}`));
        })
        .catch(() => { setExistingCreds([]); setSelectedCreds([]); });
      setForceNewCred(false);
    }
  }, [authDomain]);

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

          // Sort chronologically (oldest to newest for chat layout)
          const allMessages = [...localMessages].sort((a, b) => a.ts - b.ts);
          
          // Retain any locally generated UI messages (like system errors) that aren't in the canonical backend
          const localOnly = agent.chatLog.filter(msg => !allMessages.some((m: any) => m.id === msg.id) && msg.text.includes("⚠️ **System"));
          
          if (allMessages.length > 0 || localOnly.length > 0) {
            setChatLog([...allMessages, ...localOnly].sort((a, b) => a.ts - b.ts));
          }

        } catch (err) {
          console.error("Failed to fetch chat history:", err);
        }
      };
      
      fetchHistory();
    }
  }, [agent.id]);

  const handleAuthorize = async () => {
    if (!authDomain || !authUsername.trim() || !authPassword.trim()) {
      setAuthError("Please fill in all fields.");
      return;
    }
    
    setIsAuthorizing(true);
    setAuthError("");
    
    try {
      const key = `web_${authDomain}_${authUsername.trim()}`;
      await invoke("store_secret_cmd", { key, value: authPassword });
      
      let newIntegrations = [...agent.integrations];
      if (!newIntegrations.includes(key)) {
        newIntegrations.push(key);
        await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
        useWorldStore.getState().setAgents(
          useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
        );
      }

      // Map keys for sync_credentials
      const mappedKeys: any = {};
      newIntegrations.forEach(i => {
         if (i.startsWith("web_")) {
            mappedKeys[i] = "true";
         }
      });
      await invoke("sync_credentials", { agentId: agent.id, keys: mappedKeys }).catch(e => console.warn("Failed to sync creds to agent gateway", e));
      
      window.dispatchEvent(new Event("refresh_web_vault"));
      
      // Auto-reply to agent
      const sysMsg: ChatMessage = {
        id: Date.now().toString(),
        sender: "user",
        text: `I have securely added the credentials for ${authDomain} to your WebVault. Please try your task again.`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setChatLog(prev => [...prev, sysMsg]);
      
      invoke("send_message", { agentId: agent.id, message: sysMsg.text }).catch(e => console.warn("Auto-reply failed:", e));
      
      setAuthDomain(null);
      setAuthUsername("");
      setAuthPassword("");
    } catch (e: any) {
      setAuthError(e?.toString() || "Failed to save credential.");
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleGrantAccess = async () => {
    if (selectedCreds.length === 0) {
      setAuthError("Please select at least one credential.");
      return;
    }
    setIsAuthorizing(true);
    setAuthError("");
    try {
      let newIntegrations = [...agent.integrations];
      let updated = false;
      
      selectedCreds.forEach(credStr => {
        const key = `web_${credStr}`;
        if (!newIntegrations.includes(key)) {
          newIntegrations.push(key);
          updated = true;
        }
      });
      
      if (updated) {
        await invoke("update_agent_integrations", { agentId: agent.id, integrations: newIntegrations });
        useWorldStore.getState().setAgents(
          useWorldStore.getState().agents.map(a => a.id === agent.id ? { ...a, integrations: newIntegrations } as AgentData : a)
        );
      }
      
      const mappedKeys: any = {};
      newIntegrations.forEach(i => {
         if (i.startsWith("web_")) {
            mappedKeys[i] = "true";
         }
      });
      await invoke("sync_credentials", { agentId: agent.id, keys: mappedKeys }).catch(e => console.warn("Failed to sync creds to agent gateway", e));
      
      const sysMsg: ChatMessage = {
        id: Date.now().toString(),
        sender: "user",
        text: `I have granted you access to the existing credentials for ${authDomain}. Please try your task again.`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setChatLog(prev => [...prev, sysMsg]);
      invoke("send_message", { agentId: agent.id, message: sysMsg.text }).catch(e => console.warn("Auto-reply failed:", e));
      
      setAuthDomain(null);
      setAuthUsername("");
      setAuthPassword("");
      setForceNewCred(false);
      setSelectedCreds([]);
    } catch (e: any) {
      setAuthError(e?.toString() || "Failed to grant access.");
    } finally {
      setIsAuthorizing(false);
    }
  };

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
                  let text = msg.text;
                  const elements: React.ReactNode[] = [];

                  // Extract thoughts
                  const thoughtRegex = /\[THOUGHT_PROCESS\]([\s\S]*?)\[\/THOUGHT_PROCESS\]/g;
                  let lastIndex = 0;
                  let match;

                  while ((match = thoughtRegex.exec(text)) !== null) {
                    if (match.index > lastIndex) {
                       const before = text.substring(lastIndex, match.index);
                       if (before.trim()) elements.push(
                         <div key={`text-${lastIndex}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                           <MDEditor.Markdown source={before} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                         </div>
                       );
                    }
                    
                    const thoughtText = match[1].trim();
                    elements.push(
                      <details key={`thought-${match.index}`} style={{ margin: "8px 0", padding: "8px 12px", background: "rgba(0,0,0,0.05)", borderRadius: 8, fontSize: 12, color: "var(--text-sub)", border: "1px solid rgba(0,0,0,0.05)" }}>
                        <summary style={{ cursor: "pointer", fontWeight: 600, outline: "none", opacity: 0.8 }}>Thought Process</summary>
                        <div style={{ marginTop: 8, fontStyle: "italic", whiteSpace: "pre-wrap" }}>{thoughtText}</div>
                      </details>
                    );
                    
                    lastIndex = thoughtRegex.lastIndex;
                  }

                  if (lastIndex < text.length) {
                     const remaining = text.substring(lastIndex);
                     if (remaining.trim()) {
                        const credentialRegex = /\[REQUEST_CREDENTIAL:\s*(.+?)\]/g;
                        const interventionRegex = /\[REQUEST_BROWSER_INTERVENTION:\s*(.+?)\]/g;

                        if (!remaining.includes("[REQUEST_CREDENTIAL:") && !remaining.includes("[REQUEST_BROWSER_INTERVENTION:")) {
                           elements.push(
                             <div key={`text-${lastIndex}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                               <MDEditor.Markdown source={remaining} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                             </div>
                           );
                        } else {
                           let fragments = [{ type: 'text', content: remaining }];
                           
                           // First pass: Credentials
                           let temp1: any[] = [];
                           fragments.forEach(f => {
                               if (f.type !== 'text') { temp1.push(f); return; }
                               const parts = f.content.split(credentialRegex);
                               parts.forEach((p, i) => {
                                   if (i % 2 === 1) temp1.push({ type: 'cred', content: p.trim() });
                                   else if (p) temp1.push({ type: 'text', content: p });
                               });
                           });
                           
                           // Second pass: Interventions
                           let temp2: any[] = [];
                           temp1.forEach(f => {
                               if (f.type !== 'text') { temp2.push(f); return; }
                               const parts = f.content.split(interventionRegex);
                               parts.forEach((p, i) => {
                                   if (i % 2 === 1) temp2.push({ type: 'interv', content: p.trim() });
                                   else if (p) temp2.push({ type: 'text', content: p });
                               });
                           });
                           
                           // Render
                           temp2.forEach((f, i) => {
                               if (f.type === 'text') {
                                   elements.push(
                                       <div key={`frag-${i}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                                           <MDEditor.Markdown source={f.content} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                                       </div>
                                   );
                               } else if (f.type === 'cred') {
                                   const domain = f.content;
                                   elements.push(
                                      <div key={`cred-${i}`} style={{ marginTop: 8, marginBottom: 8, padding: 12, background: "var(--background)", border: "1px solid var(--border-subtle)", borderRadius: 8, color: "var(--text-main)" }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                                          <Lock size={14} /> Login Required
                                        </div>
                                        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                                          {agent.name} is requesting credentials to access <strong>{domain}</strong>.
                                        </div>
                                        <button 
                                          onClick={() => setAuthDomain(domain)} 
                                          style={{ padding: "6px 12px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", width: "100%" }}
                                        >
                                          Authorize in WebVault
                                        </button>
                                      </div>
                                   );
                               } else if (f.type === 'interv') {
                                   const reason = f.content;
                                   elements.push(
                                       <div key={`interv-${i}`} style={{ marginTop: 8, marginBottom: 8, padding: 12, background: "rgba(212, 160, 74, 0.1)", border: "1px solid rgba(212, 160, 74, 0.3)", borderRadius: 8, color: "#D4A04A" }}>
                                           <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                                               ⚠️ Agent Needs Help!
                                           </div>
                                           <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 10, color: "var(--text-main)" }}>
                                               {agent.name} is stuck: <strong>{reason}</strong>
                                           </div>
                                           <div style={{ display: "flex", gap: 8 }}>
                                               <button 
                                                   onClick={async () => {
                                                       try {
                                                           await invoke("show_browser", { agentId: agent.id });
                                                       } catch (e) {
                                                           console.error(e);
                                                       }
                                                   }}
                                                   style={{ padding: "6px 12px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", flex: 1 }}
                                               >
                                                   Bring Browser to Front
                                               </button>
                                               <button 
                                                   onClick={async () => {
                                                       try {
                                                           await invoke("hide_browser", { agentId: agent.id });
                                                           const sysMsg: ChatMessage = {
                                                               id: Date.now().toString(),
                                                               sender: "user",
                                                               text: `I have completed the manual intervention in the browser. You may proceed.`,
                                                               time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                                                           };
                                                           setChatLog(prev => [...prev, sysMsg]);
                                                           invoke("send_message", { agentId: agent.id, message: sysMsg.text });
                                                       } catch (e) {
                                                           console.error(e);
                                                       }
                                                   }}
                                                   style={{ padding: "6px 12px", background: "transparent", color: "var(--text-main)", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                                               >
                                                   Hide & Proceed
                                               </button>
                                           </div>
                                       </div>
                                   );
                               }
                           });
                        }
                     }
                  }
                  
                  return <>{elements}</>;
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

      {authDomain && (() => {
        const showExisting = existingCreds.length > 0 && !forceNewCred;

        return (
          <div style={{
            position: "absolute", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center"
          }}>
            <div style={{
              background: "var(--surface-card)", padding: 24, borderRadius: 16, width: "100%", maxWidth: 360,
              boxShadow: "0 12px 32px rgba(0,0,0,0.15)", border: "1px solid var(--border-subtle)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <Lock size={18} color="var(--text-main)" />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text-main)" }}>Authorize {authDomain}</h3>
              </div>
              
              {showExisting ? (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 12, lineHeight: 1.5 }}>
                    Existing credentials for <strong>{authDomain}</strong> were found in your vault.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, maxHeight: 150, overflowY: "auto", paddingRight: 4 }}>
                    {existingCreds.map(c => {
                      const id = `${c.domain}_${c.username}`;
                      const isSelected = selectedCreds.includes(id);
                      return (
                        <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-base)", padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border-subtle)" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {c.username}
                          </div>
                          <div style={{ flexShrink: 0 }}>
                            <Toggle enabled={isSelected} onChange={() => {
                              setSelectedCreds(prev => isSelected ? prev.filter(x => x !== id) : [...prev, id]);
                            }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button 
                      onClick={() => setForceNewCred(true)}
                      style={{ background: "none", border: "none", color: "#3c6663", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}
                    >
                      + Add a different account
                    </button>
                  </div>
                  {authError && <div style={{ color: "#e53e3e", fontSize: 12, marginTop: 8 }}>{authError}</div>}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
                  {existingCreds.length > 0 && (
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -4 }}>
                      <button 
                        onClick={() => setForceNewCred(false)}
                        style={{ background: "none", border: "none", color: "#3c6663", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}
                      >
                        Back to existing accounts
                      </button>
                    </div>
                  )}
                  <input 
                    value={authUsername} onChange={e => setAuthUsername(e.target.value)}
                    placeholder="Username / Email"
                    style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", fontSize: 13, color: "var(--text-main)", outline: "none" }}
                  />
                  <PasswordInput
                    value={authPassword} onChange={e => setAuthPassword(e.target.value)}
                    placeholder="Password"
                    style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", fontSize: 13, color: "var(--text-main)", outline: "none" }}
                  />
                  {authError && <div style={{ color: "#e53e3e", fontSize: 12 }}>{authError}</div>}
                </div>
              )}
              
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button 
                  onClick={() => { setAuthDomain(null); setAuthError(""); setForceNewCred(false); setSelectedCreds([]); }}
                  style={{ padding: "8px 14px", background: "transparent", color: "var(--text-sub)", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    const sysMsg: ChatMessage = {
                      id: Date.now().toString(),
                      sender: "user",
                      text: `I am denying the request for credentials to ${authDomain}. Please try to find a different approach or skip this step.`,
                      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                    };
                    setChatLog(prev => [...prev, sysMsg]);
                    invoke("send_message", { agentId: agent.id, message: sysMsg.text }).catch(e => console.warn("Auto-reply failed:", e));
                    setAuthDomain(null); setAuthError(""); setForceNewCred(false); setSelectedCreds([]);
                  }}
                  style={{ padding: "8px 14px", background: "transparent", color: "#c0392b", border: "1px solid rgba(192,57,43,0.3)", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  Deny Request
                </button>
                {showExisting ? (
                  <button 
                    onClick={handleGrantAccess} disabled={isAuthorizing || selectedCreds.length === 0}
                    style={{ padding: "8px 14px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: (isAuthorizing || selectedCreds.length === 0) ? "not-allowed" : "pointer", opacity: (isAuthorizing || selectedCreds.length === 0) ? 0.7 : 1 }}
                  >
                    {isAuthorizing ? "Saving..." : "Grant Access"}
                  </button>
                ) : (
                  <button 
                    onClick={handleAuthorize} disabled={isAuthorizing}
                    style={{ padding: "8px 14px", background: "#3c6663", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: isAuthorizing ? "not-allowed" : "pointer", opacity: isAuthorizing ? 0.7 : 1 }}
                  >
                    {isAuthorizing ? "Saving..." : "Save & Authorize"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Input */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { 
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (message.trim() && !loading && gatewayReady && !agent.paused) handleSendMessage(); 
            }
          }}
          placeholder={agent.paused ? "Agent is paused — resume it to chat..." : !gatewayReady ? "Agents are waking up..." : `Talk to ${agent.name}... (Shift+Enter for new line)`}
          disabled={loading || !gatewayReady || agent.paused}
          rows={1}
          style={{
            flex: 1, padding: "14px 18px", borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.08)",
            background: "var(--glass-light)",
            fontSize: 13, fontFamily: "inherit", color: "var(--text-main)",
            outline: "none", opacity: (loading || !gatewayReady || agent.paused) ? 0.6 : 1,
            resize: "vertical", minHeight: "46px", maxHeight: "200px", boxSizing: "border-box"
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