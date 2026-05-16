import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, ChevronDown,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, Paperclip
} from "lucide-react";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, glass } from "../../App";
import MDEditor from "@uiw/react-md-editor";
import { invoke } from "@tauri-apps/api/core";
import { PasswordInput } from "../../components/shared/PasswordInput";

// Cap on per-agent in-memory chat history. Beyond this we drop the *oldest* messages.
// Unbounded growth of `chatLog` was implicated in white-screen-while-idle crashes —
// the React tree would slow to a crawl and eventually OOM the webview on long sessions.
// The full conversation history still lives in the gateway DB; this only trims what
// the React component keeps in memory and re-renders.
const CHAT_LOG_CAP = 500;
function capLog(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.length > CHAT_LOG_CAP ? msgs.slice(-CHAT_LOG_CAP) : msgs;
}
const formatMessageTime = (dateInput: Date | string | number) => {
  const date = new Date(dateInput);
  const now = new Date();
  const isToday = date.getDate() === now.getDate() && 
                  date.getMonth() === now.getMonth() && 
                  date.getFullYear() === now.getFullYear();
                  
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + 
           date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
};

export // ─── Chat / Communion Component ──────────────────────────────────────────────

function ChatTab({ agent, compact = false }: { agent: AgentData; compact?: boolean }) {
  const { agents, setAgents, setArchitectTab } = useWorldStore();
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const [message, setMessage] = useState(agent.draftMessage || "");
  // chatLog is declared up here (rather than further down where it used to
  // live) so the thread-reseed and voice-playback useEffects below can
  // reference it. Order matters — those effects use chatLog/setChatLog in
  // their dep arrays and bodies, and a use-before-declare crashes the build.
  const [chatLog, setChatLog] = useState<ChatMessage[]>(capLog(agent.chatLog));

  // Load draft when switching agents
  useEffect(() => {
    setMessage(agent.draftMessage || "");
  }, [agent.id]);

  // Persist draft to global store (debounced to avoid re-rendering entire app on keystroke)
  useEffect(() => {
    const handler = setTimeout(() => {
      if (agent.draftMessage !== message) {
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === agent.id ? { ...a, draftMessage: message } : a)
        }));
      }
    }, 500);
    return () => clearTimeout(handler);
  }, [message, agent.id]);

  // Re-seed chatLog when the active conversation changes — the threads UI
  // mutates agent.chatLog in the store, and we need the local component
  // state to follow. Without this, switching threads in the rail would
  // leave the old conversation's messages on screen.
  // We use a ref of the last seen ID so we only re-seed on actual switches,
  // not on the routine setAgents calls that fire after every message.
  const lastSeenConvIdRef = useRef<string | null | undefined>(agent.activeConversationId);
  useEffect(() => {
    if (lastSeenConvIdRef.current !== agent.activeConversationId) {
      lastSeenConvIdRef.current = agent.activeConversationId;
      setChatLog(capLog(agent.chatLog || []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.activeConversationId, agent.chatLog]);

  // Hard chat reset — fired by saveCurrentThread (the "+ New chat" action).
  // The conv-id watcher above doesn't catch this case because activeConvId
  // can stay null on both sides of the reset, so we use a dedicated event.
  // (We don't bother nulling voice's `lastSpokenIdRef` here — an empty chatLog
  // has nothing to speak, and new message ids are timestamp-based so the next
  // reply won't collide with a stale id.)
  useEffect(() => {
    const onChatReset = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId: string }>).detail;
      if (!detail || detail.agentId !== agent.id) return;
      setChatLog([]);
      setMessage("");
    };
    window.addEventListener("canopy:chat-reset", onChatReset as EventListener);
    return () => window.removeEventListener("canopy:chat-reset", onChatReset as EventListener);
  }, [agent.id]);

  // Listen for cross-component send dispatches — used by Home's empty-state
  // suggestion pills and the "What can you do?" quick action so they can send
  // a message through this agent's ChatTab without needing an imperative ref.
  // Filters by agentId so a multi-agent app never cross-fires.
  useEffect(() => {
    const onSendChat = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId: string; text: string }>).detail;
      if (!detail || detail.agentId !== agent.id || !detail.text) return;
      // Defer one tick so any caller-side state updates (e.g. clearing the
      // empty state) have a chance to commit before send starts.
      setTimeout(() => handleSendMessage(detail.text), 0);
    };
    window.addEventListener("canopy:send-chat", onSendChat as EventListener);
    return () => window.removeEventListener("canopy:send-chat", onSendChat as EventListener);
    // Intentionally re-binding when agent.id changes so the closure over
    // handleSendMessage always sees the current agent's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // Voice playback — single-turn V1 using the browser Web Speech API. We track
  // the live preference in a ref so the most-recent-agent-message effect below
  // doesn't have to re-bind every time the toggle flips. State source of truth
  // is the same sessionStorage key the Home quick-actions button writes to.
  const voiceOnRef = useRef<boolean>(sessionStorage.getItem("canopy:voice-on") === "1");
  useEffect(() => {
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean }>).detail;
      voiceOnRef.current = !!detail?.enabled;
      // If the user just toggled OFF mid-utterance, cut speech immediately.
      if (!voiceOnRef.current && typeof window.speechSynthesis !== "undefined") {
        window.speechSynthesis.cancel();
      }
    };
    window.addEventListener("canopy:voice-toggle", onToggle as EventListener);
    return () => window.removeEventListener("canopy:voice-toggle", onToggle as EventListener);
  }, []);

  // When a new agent message lands and voice is on, speak it. We track the
  // last spoken message id so re-renders (scroll, draft updates, etc.) don't
  // re-speak the same reply.
  const lastSpokenIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!voiceOnRef.current) return;
    if (typeof window.speechSynthesis === "undefined") return;
    // Find the most recent agent message. Don't speak ones already spoken.
    const lastAgentMsg = [...chatLog].reverse().find(m => m.sender === "agent");
    if (!lastAgentMsg || lastAgentMsg.id === lastSpokenIdRef.current) return;
    // Filter out the noisy system pings/diagnostic replies the visual filter
    // already hides — speaking PONG is jarring.
    const t = lastAgentMsg.text.trim();
    if (!t || t === "PONG" || t === "PONG." || t.includes("CANOPY_DIAG_PING")) return;
    if (t.includes("HEARTBEAT_OK") || t.includes('"lastMorningQuote"')) return;

    lastSpokenIdRef.current = lastAgentMsg.id;
    try {
      // Strip markdown that would otherwise be read aloud literally (e.g.
      // "asterisk asterisk bold asterisk asterisk"). Cheap pass — keeps
      // sentence punctuation and contractions intact.
      const spoken = t
        .replace(/`{1,3}[\s\S]*?`{1,3}/g, " (code block) ")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\n+/g, ". ");
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(spoken);
      utter.rate = 1.05;
      utter.pitch = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) {
      console.warn("Voice playback failed:", e);
    }
  }, [chatLog]);

  // Stop speaking when the user navigates away from this agent or unmounts.
  useEffect(() => {
    return () => {
      if (typeof window.speechSynthesis !== "undefined") {
        window.speechSynthesis.cancel();
      }
    };
  }, [agent.id]);
  const [loading, setLoading] = useState(false);
  // Hover-revealed reaction shortcuts (👍 / retry / edit) on agent messages.
  // Tracking by ID rather than index keeps the reactions stable across re-renders.
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [likedMsgIds, setLikedMsgIds] = useState<Set<string>>(new Set());
  // Helper: find the user message that prompted a given agent message, so retry
  // and edit-prompt actions know what text to re-use.
  const findPriorUserMessage = useCallback((agentMsgId: string): ChatMessage | null => {
    const idx = chatLog.findIndex(m => m.id === agentMsgId);
    if (idx <= 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      if (chatLog[i].sender === "user") return chatLog[i];
    }
    return null;
  }, [chatLog]);
  const [needsRepair, setNeedsRepair] = useState(false);
  const [isHealing, setIsHealing] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<{name: string, dataUrl: string}[]>([]);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const abortRef = useRef(false);

  const handleScroll = useCallback(() => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      const atBottom = scrollHeight - scrollTop - clientHeight < 50;
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
  }, []);
  
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
    // Only scroll to bottom if the user hasn't scrolled up to read
    if (chatContainerRef.current && isAtBottomRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
    // Keep global state in sync so errors remain when switching tabs.
    // Also mirror chatLog into the active conversation (if any) so switching
    // threads in the dropdown doesn't lose messages added since the switch.
    useWorldStore.setState(state => ({
      agents: state.agents.map(a => {
        if (a.id !== agent.id) return a;
        let conversations = a.conversations;
        if (a.activeConversationId && conversations) {
          conversations = conversations.map(c => {
            if (c.id !== a.activeConversationId) return c;
            
            const isNewContent = chatLog.length !== c.messages.length || 
                                chatLog[chatLog.length - 1]?.id !== c.messages[c.messages.length - 1]?.id;
            
            return {
              ...c, 
              messages: chatLog, 
              lastActiveAt: isNewContent ? Date.now() : c.lastActiveAt 
            };
          });
        }
        return { ...a, chatLog, conversations };
      })
    }));
  }, [chatLog, agent.id]);

  // When switching threads externally, update the local chatLog immediately
  useEffect(() => {
    setChatLog(agent.chatLog || []);
    // Ensure we start at the bottom of the newly loaded thread
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, [agent.activeConversationId]);

  const agentRef = useRef(agent);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);

  useEffect(() => {
    if (typeof invoke === 'function') {
      const fetchHistory = async () => {
        try {
          const currentAgent = agentRef.current;
          const resp: any = await invoke("get_conversation_history", { agentId: currentAgent.id, limit: 100, sessionId: currentAgent.activeConversationId || null });
          let localMessages: any[] = [];
          
          if (Array.isArray(resp) && resp.length > 0) {
            localMessages = resp.map(r => ({
              id: r.id,
              sender: r.role === "user" ? "user" : "agent",
              text: r.content,
              time: formatMessageTime(r.timestamp),
              ts: new Date(r.timestamp).getTime()
            }));
          }

          // Sort chronologically (oldest to newest for chat layout)
          let allMessages = [...localMessages].sort((a, b) => a.ts - b.ts);
          if (currentAgent.chatClearedAt) {
            allMessages = allMessages.filter((m: any) => m.ts >= currentAgent.chatClearedAt!);
          }

          setChatLog(prev => {
            const nowMs = Date.now();
            const localOnly = prev.filter(msg => {
              if (allMessages.some((m: any) => m.id === msg.id)) return false;
              if (allMessages.some((m: any) => {
                if (m.sender !== msg.sender) return false;
                if (m.text === msg.text) return true;
                const tsRegex = /^(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*(?:[^:\n]+:\s*)?/;
                const strippedM = m.text.replace(tsRegex, '');
                const strippedMsg = msg.text.replace(tsRegex, '');
                return strippedM === strippedMsg || m.text.endsWith(msg.text);
              })) return false;
              return true;
            });
            
            const newLog = capLog([...allMessages, ...localOnly].sort((a, b) => (a.ts || 0) - (b.ts || 0)));
            const lastPrev = prev[prev.length - 1];
            const lastNew = newLog[newLog.length - 1];
            if (prev.length === newLog.length && lastPrev?.id === lastNew?.id) return prev;
            return newLog;
          });

        } catch (err) {
          console.error("Failed to fetch chat history:", err);
        }
      };
      
      fetchHistory();
      const interval = setInterval(fetchHistory, 3000);
      return () => clearInterval(interval);
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
        time: formatMessageTime(new Date()),
      };
      setChatLog(prev => capLog([...prev, sysMsg]));
      
      invoke("send_message", { agentId: agent.id, message: sysMsg.text, sessionId: agent.activeConversationId || null }).catch(e => console.warn("Auto-reply failed:", e));
      
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
        time: formatMessageTime(new Date()),
      };
      setChatLog(prev => capLog([...prev, sysMsg]));
      invoke("send_message", { agentId: agent.id, message: sysMsg.text, sessionId: agent.activeConversationId || null }).catch(e => console.warn("Auto-reply failed:", e));
      
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

  const handleStop = () => {
    abortRef.current = true;
    setLoading(false);
  };

  const handleSendMessage = async (overrideText?: string) => {
    if (loading) return;
    const baseText = (overrideText ?? message).trim();
    if (!baseText && attachments.length === 0) return;

    abortRef.current = false;

    let finalMessage = baseText;
    if (!overrideText && attachments.length > 0) {
      const fileNames = attachments.map(a => a.name).join(", ");
      finalMessage += `\n\n[System Context: I have uploaded the following files to your workspace: ${fileNames}. Please analyze them if requested.]`;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      text: baseText,
      time: formatMessageTime(new Date()),
      ts: Date.now(),
      attachments: !overrideText && attachments.length > 0 ? [...attachments] : undefined,
    };

    setChatLog(prev => capLog([...prev, userMsg]));
    if (!overrideText) {
      setMessage("");
      setAttachments([]);
    }
    setLoading(true);

    try {
      if (userMsg.attachments) {
        for (const file of userMsg.attachments) {
           if (file.dataUrl.startsWith("data:")) {
               await invoke("upload_workspace_file", { agentId: agent.id, filename: file.name, base64Data: file.dataUrl });
           } else {
               await invoke("copy_file_to_workspace", { agentId: agent.id, sourcePath: file.dataUrl, targetFilename: file.name });
           }
        }
      }

      let activeSessionId = agent.activeConversationId;
      if (!activeSessionId) {
        activeSessionId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => {
            if (a.id !== agent.id) return a;
            return {
              ...a,
              activeConversationId: activeSessionId,
              conversations: [...(a.conversations || []), {
                id: activeSessionId!,
                title: userMsg.text.length > 40 ? userMsg.text.slice(0, 40).trimEnd() + "…" : userMsg.text,
                messages: [userMsg],
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
              }]
            };
          })
        }));
      }

      const response: any = await invoke("send_message", {
        agentId: agent.id,
        message: finalMessage,
        sessionId: activeSessionId,
      });

      if (abortRef.current) {
        if (!overrideText) setMessage(baseText);
        setChatLog(prev => prev.filter(m => m.id !== userMsg.id));
        return;
      }

      const responseText = typeof response === 'object' ? response?.response || response?.content || JSON.stringify(response) : String(response);

      const agentMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "agent",
        text: responseText,
        time: formatMessageTime(new Date()),
      };

      setChatLog(prev => capLog([...prev, agentMsg]));
    } catch (error) {
      let friendlyError = String(error);

      const isGatewayRestart =
        friendlyError.includes("1012") ||
        friendlyError.includes("service restart") ||
        friendlyError.includes("gateway closed") ||
        friendlyError.includes("Gateway agent failed");

      if (isGatewayRestart) {
        try {
          await new Promise(r => setTimeout(r, 6000));
          const retryResponse: any = await invoke("send_message", {
            agentId: agent.id,
            message: finalMessage,
            sessionId: agent.activeConversationId || null,
          });
          
          if (abortRef.current) {
            if (!overrideText) setMessage(baseText);
            setChatLog(prev => prev.filter(m => m.id !== userMsg.id));
            return;
          }

          const retryText = typeof retryResponse === 'object'
            ? retryResponse?.response || retryResponse?.content || JSON.stringify(retryResponse)
            : String(retryResponse);
          const retryMsg: ChatMessage = {
            id: (Date.now() + 1).toString(),
            sender: "agent",
            text: retryText,
            time: formatMessageTime(new Date()),
          };
          setChatLog(prev => capLog([...prev, retryMsg]));
          return;
        } catch (retryErr) {
          friendlyError =
            "The gateway briefly restarted (likely to apply a settings change) and the retry didn't go through either. " +
            "Try sending your message again — the gateway should be back up now. " +
            "If this keeps happening, run the Diagnostics tab.";
        }
      } else if (friendlyError.includes("stopped container") || friendlyError.includes("OOM")) {
        setIsHealing(true);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("hard_reset_infrastructure").catch(ex => console.error("Hard reset failed:", ex));
        await invoke("boot_sync_agents").catch(ex => console.warn("boot_sync after heal:", ex));
        setIsHealing(false);
        friendlyError = "The gateway was restarted and agents re-initialized. Please try sending your message again!";
      } else if (friendlyError.includes("taking a long time") || friendlyError.includes("Gateway Timeout")) {
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
        time: formatMessageTime(new Date()),
      };
      
      setChatLog(prev => capLog([...prev, errorMsg]));
      
      useWorldStore.setState(state => ({
        agents: state.agents.map(a => a.id === agent.id ? { ...a, chatLog: [...a.chatLog, errorMsg] } : a)
      }));
    } finally {
      setLoading(false);
    }
  };

  const activeConv = agent.conversations?.find(c => c.id === agent.activeConversationId);
  const firstUserMsg = chatLog.find(m => m.sender === "user");

  let topic = activeConv?.title;
  let startedAt = activeConv?.createdAt;

  if (!topic && firstUserMsg) {
    const rawTitle = firstUserMsg.text.trim();
    topic = rawTitle.length > 40 ? rawTitle.slice(0, 40).trimEnd() + "…" : rawTitle;
    startedAt = firstUserMsg.ts || Date.now();
  }

  const formatStartedTime = (ms: number) => {
    if (!ms) return "";
    const delta = Math.floor((Date.now() - ms) / 1000);
    if (delta < 60) return "just now";
    if (delta < 3600) return `${Math.floor(delta / 60)} minutes ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)} hours ago`;
    if (delta < 86400 * 2) return "yesterday";
    if (delta < 86400 * 7) return `${Math.floor(delta / 86400)} days ago`;
    return new Date(ms).toLocaleDateString();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {!compact && (
        <div style={{ marginBottom: 12, padding: "0 10px", marginTop: 4 }}>
          <div style={{ fontSize: 15, color: "var(--text-sub)", margin: 0 }}>
            {topic ? (
              <>Chat with <strong>{agent.name}</strong> about <strong>{topic}</strong>{startedAt ? ` started ${formatStartedTime(startedAt)}` : ''}</>
            ) : (
              <>Chat with <strong>{agent.name}</strong></>
            )}
          </div>
        </div>
      )}

      {/* Chat log */}
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div ref={chatContainerRef} onScroll={handleScroll} style={{
          flex: 1, ...glass(0.35), borderRadius: 16, padding: 20, overflow: "auto",
          display: "flex", flexDirection: "column", gap: 12,
        }}>
        {chatLog.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)" }}>
            Start a conversation...
          </div>
        ) : (
          chatLog.filter(msg => {
             const t = msg.text.trim();
             if (t.includes("Read HEARTBEAT.md if it exists")) return false;
             if (t === "HEARTBEAT_OK" || t === "HEARTBEAT OK") return false;
             if (t.includes('"lastMorningQuote"')) return false;
             if (t.includes("CANOPY_DIAG_PING")) return false;
             if (t.includes("System diagnostic ping. Please reply")) return false;
             if (t === "PONG" || t === "PONG.") return false;
             return true;
          }).map(msg => (
            <div
              key={msg.id}
              onMouseEnter={() => msg.sender === "agent" && setHoveredMsgId(msg.id)}
              onMouseLeave={() => setHoveredMsgId(prev => prev === msg.id ? null : prev)}
              style={{
                display: "flex", flexDirection: "column",
                alignItems: msg.sender === "user" ? "flex-end" : "flex-start",
              }}
            >
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
                {msg.attachments && msg.attachments.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {msg.attachments.map((a, i) => (
                      <div key={i} style={{ width: 80, height: 80, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.2)" }}>
                        {a.dataUrl.startsWith("data:image") ? (
                           <img src={a.dataUrl} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                           <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.1)", fontSize: 10, padding: 4, wordBreak: "break-all", textAlign: "center", lineHeight: 1.2 }}>
                              {a.name}
                           </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {(() => {
                  const textTrimmed = msg.text.trim();
                  let isSystemDump = false;
                  let dumpTitle = "System Output";

                  if (msg.sender === "agent") {
                      if ((textTrimmed.startsWith("{") && textTrimmed.endsWith("}")) || (textTrimmed.startsWith("[") && textTrimmed.endsWith("]"))) {
                          try {
                              JSON.parse(textTrimmed);
                              isSystemDump = true;
                              dumpTitle = "JSON Payload";
                          } catch(e) {
                              if (textTrimmed.includes('":"') && (textTrimmed.includes('","') || textTrimmed.includes('"}'))) {
                                   isSystemDump = true;
                                   dumpTitle = "Raw Data Payload";
                              }
                          }
                      } else if (textTrimmed.includes("Traceback (most recent call") || textTrimmed.includes("(Command exited with code")) {
                          isSystemDump = true;
                          dumpTitle = "Command Error";
                      }
                  }

                  if (isSystemDump) {
                      return (
                          <details style={{ margin: "4px 0", fontSize: 12, color: "inherit", opacity: 0.9 }}>
                            <summary style={{ cursor: "pointer", fontWeight: 600, outline: "none" }}>{dumpTitle}</summary>
                            <div style={{ marginTop: 8, fontFamily: "monospace", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 11 }}>{msg.text}</div>
                          </details>
                      );
                  }

                  let text = msg.text.replace(/<think>/gi, "[THOUGHT_PROCESS]").replace(/<\/think>/gi, "[/THOUGHT_PROCESS]");

                  text = text.replace(/(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*(?:[^:\n]+:\s*)?/gi, "");
                  text = text.replace(/(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\][^\.\n]+\.\s*/gi, "");
                  text = text.replace(/\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*/gi, "");

                  if (msg.sender === "user") {
                      text = text.replace(/\[Queued messages while agent was busy\][\s\S]*?---\n?/i, "");
                      text = text.replace(/Queued #\d+\s*\(from[^)]+\)\s*/gi, "");

                      const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b);
                      const deduped = blocks.filter((item, pos, arr) => pos === 0 || item !== arr[pos - 1]);
                      text = deduped.join("\n\n");
                      if (!text) text = "[System Event]";
                  }

                  const elements: React.ReactNode[] = [];
                  const thoughtStartRegex = /\[THOUGHT_PROCESS\]/i;
                  const thoughtEndRegex = /\[\/THOUGHT_PROCESS\]/i;
                  
                  let remainingText = text;
                  while (remainingText.length > 0) {
                      const startIndex = remainingText.search(thoughtStartRegex);
                      if (startIndex === -1) {
                          if (remainingText.trim()) {
                              elements.push(
                                <div key={`text-${elements.length}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                                  <MDEditor.Markdown source={remainingText} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                                </div>
                              );
                          }
                          break;
                      }
                      
                      const before = remainingText.substring(0, startIndex);
                      if (before.trim()) {
                          elements.push(
                            <div key={`text-${elements.length}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                              <MDEditor.Markdown source={before} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                            </div>
                          );
                      }
                      
                      remainingText = remainingText.substring(startIndex + "[THOUGHT_PROCESS]".length);
                      const endIndex = remainingText.search(thoughtEndRegex);
                      let thoughtText = "";
                      if (endIndex === -1) {
                          thoughtText = remainingText.trim();
                          remainingText = "";
                      } else {
                          thoughtText = remainingText.substring(0, endIndex).trim();
                          remainingText = remainingText.substring(endIndex + "[/THOUGHT_PROCESS]".length);
                      }
                      
                      if (thoughtText) {
                          elements.push(
                              <details key={`thought-${elements.length}`} style={{ margin: "8px 0", padding: "8px 12px", background: "rgba(0,0,0,0.05)", borderRadius: 8, fontSize: 12, color: "var(--text-sub)", border: "1px solid rgba(0,0,0,0.05)" }}>
                                <summary style={{ cursor: "pointer", fontWeight: 600, outline: "none", opacity: 0.8 }}>Thought Process</summary>
                                <div style={{ marginTop: 8, fontStyle: "italic", whiteSpace: "pre-wrap" }}>{thoughtText}</div>
                              </details>
                          );
                      }
                  }
                  
                  return <>{elements}</>;
                })()}
              </div>
              <div style={{
                fontSize: 10, color: "var(--text-muted)", marginTop: 4,
                paddingLeft: msg.sender === "agent" ? 4 : 0,
                paddingRight: msg.sender === "user" ? 4 : 0,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span>{msg.sender === "agent" ? agent.name : "You"} · {msg.time}</span>

                {msg.sender === "agent" && (() => {
                  const visible = hoveredMsgId === msg.id || likedMsgIds.has(msg.id);
                  const liked = likedMsgIds.has(msg.id);
                  const priorUser = findPriorUserMessage(msg.id);
                  return (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 4,
                      opacity: visible ? 1 : 0,
                      pointerEvents: visible ? "auto" : "none",
                      transition: "opacity 0.15s ease",
                    }}>
                      <button
                        onClick={() => setLikedMsgIds(prev => {
                          const next = new Set(prev);
                          if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                          return next;
                        })}
                        title={liked ? "Liked" : "Mark as good"}
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: "pointer", borderRadius: 4,
                          display: "flex", alignItems: "center",
                          color: liked ? "#218380" : "var(--text-muted)",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          if (!priorUser || loading) return;
                          handleSendMessage(priorUser.text);
                        }}
                        disabled={!priorUser || loading}
                        title={priorUser ? "Retry — send the same prompt again for a fresh reply" : "Nothing to retry"}
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: !priorUser || loading ? "not-allowed" : "pointer",
                          borderRadius: 4, display: "flex", alignItems: "center",
                          color: "var(--text-muted)",
                          opacity: !priorUser || loading ? 0.4 : 1,
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          if (!priorUser) return;
                          setMessage(priorUser.text);
                        }}
                        disabled={!priorUser}
                        title={priorUser ? "Edit my prompt and re-send" : "No prompt to edit"}
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: !priorUser ? "not-allowed" : "pointer",
                          borderRadius: 4, display: "flex", alignItems: "center",
                          color: "var(--text-muted)",
                          opacity: !priorUser ? 0.4 : 1,
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                    </div>
                  );
                })()}
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
        </div>

        {!isAtBottom && (
          <button
            onClick={() => {
              if (chatContainerRef.current) {
                chatContainerRef.current.scrollTo({
                  top: chatContainerRef.current.scrollHeight,
                  behavior: "smooth"
                });
                isAtBottomRef.current = true;
                setIsAtBottom(true);
              }
            }}
            style={{
              position: "absolute",
              bottom: 20,
              right: 20,
              background: "#3c6663",
              color: "#fff",
              border: "none",
              borderRadius: "50%",
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              zIndex: 10,
              transition: "transform 0.15s ease",
            }}
            onMouseOver={(e) => e.currentTarget.style.transform = "scale(1.05)"}
            onMouseOut={(e) => e.currentTarget.style.transform = "scale(1)"}
          >
            <ChevronDown size={20} />
          </button>
        )}
      </div>

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
                      time: formatMessageTime(new Date()),
                    };
                    setChatLog(prev => capLog([...prev, sysMsg]));
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

      {attachments.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, overflowX: "auto", paddingBottom: 4, paddingLeft: 10, paddingRight: 10 }}>
          {attachments.map((file, i) => (
            <div key={i} style={{ position: "relative", width: 60, height: 60, borderRadius: 8, border: "1px solid var(--border-subtle)", overflow: "hidden", flexShrink: 0 }}>
              {file.dataUrl.startsWith("data:image") ? (
                <img src={file.dataUrl} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-base)", fontSize: 10, color: "var(--text-sub)", wordBreak: "break-all", padding: 4, textAlign: "center" }}>
                  {file.name}
                </div>
              )}
              <button 
                onClick={() => setAttachments(prev => prev.filter((_, index) => index !== i))}
                style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.6)", color: "white", border: "none", borderRadius: "50%", width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: attachments.length > 0 ? 8 : 16, alignItems: "flex-end", padding: "0 10px 10px 10px" }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || !gatewayReady || agent.paused}
          title="Attach File or Screenshot"
          style={{
            padding: "14px", borderRadius: 14, border: "1px solid rgba(0,0,0,0.08)",
            background: "var(--glass-light)",
            color: "var(--text-main)",
            cursor: (loading || !gatewayReady || agent.paused) ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: (loading || !gatewayReady || agent.paused) ? 0.6 : 1,
            height: "46px"
          }}
        >
          <Paperclip size={18} />
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          style={{ display: "none" }} 
          multiple
          onChange={e => {
            const files = Array.from(e.target.files || []);
            files.forEach(file => {
              const reader = new FileReader();
              reader.onload = (event) => {
                 setAttachments(prev => [...prev, { name: file.name, dataUrl: event.target?.result as string }]);
              };
              reader.readAsDataURL(file);
            });
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { 
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if ((message.trim() || attachments.length > 0) && !loading && gatewayReady && !agent.paused) handleSendMessage(); 
            }
          }}
          onPaste={e => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
              if (items[i].type.indexOf("image") !== -1) {
                const file = items[i].getAsFile();
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (event) => {
                     setAttachments(prev => [...prev, { name: `screenshot-${Date.now()}.png`, dataUrl: event.target?.result as string }]);
                  };
                  reader.readAsDataURL(file);
                }
              }
            }
          }}
          placeholder={agent.paused ? "Agent is paused — resume it to chat..." : !gatewayReady ? "Agents are waking up..." : `Talk to ${agent.name}... (Shift+Enter for new line, Paste for screenshot)`}
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
        <div style={{ display: "flex", gap: 8 }}>
          {loading ? (
            <button
              onClick={handleStop}
              style={{
                padding: "14px 20px", borderRadius: 14, border: "none",
                background: "var(--error-color, #e05252)",
                color: "#fff",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
                fontFamily: "inherit",
                transition: "all 0.15s ease",
                height: "46px"
              }}
            >Stop</button>
          ) : (
            <button
              onClick={() => handleSendMessage()}
              disabled={(!message.trim() && attachments.length === 0) || loading || !gatewayReady || agent.paused}
              title={agent.paused ? "Resume the agent to send messages" : !gatewayReady ? "Agents are waking up, please wait..." : undefined}
              style={{
                padding: "14px 20px", borderRadius: 14, border: "none",
                background: ((message.trim() || attachments.length > 0) && !loading && gatewayReady && !agent.paused) ? "#3c6663" : "var(--border-subtle)",
                color: ((message.trim() || attachments.length > 0) && !loading && gatewayReady && !agent.paused) ? "var(--surface-card)" : "var(--text-muted)",
                fontSize: 13, fontWeight: 600, cursor: ((message.trim() || attachments.length > 0) && !loading && gatewayReady && !agent.paused) ? "pointer" : "default",
                fontFamily: "inherit",
                transition: "all 0.15s ease",
                height: "46px"
              }}
            >{agent.paused ? "⏸" : !gatewayReady ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
                <path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
              </svg>
            ) : "Send"}</button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}