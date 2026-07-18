import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, ChevronDown,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database, Paperclip,
  AlertTriangle
} from "lucide-react";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage, MiniApp, fireActivationEvent } from "../../store/worldStore";
import { GenUIRenderer } from "../../components/GenUI/GenUIRenderer";
import { useForumStore } from "../../store/forumStore";
import { GenerativeResult } from "../../components/GenerativeStudio";
import { Toggle, ServiceRow, glass } from "../../App";
import MDEditor from "@uiw/react-md-editor";
import { invoke } from "@tauri-apps/api/core";
import { PasswordInput } from "../../components/shared/PasswordInput";
import { isolateGeneratedHtml } from "../../security/generatedHtml";

// ─── Format-aware message parsing ────────────────────────────────────────────
// Agents can return ---FORMAT--- html/markdown/genui ---CONTENT--- blocks in both
// forum phases and individual chat. We detect these here and render accordingly.

type ParsedFormat = { format: "html" | "markdown" | "genui"; content: string } | null;

function parseFormatBlock(text: string): ParsedFormat {
  const m = text.match(/---FORMAT---\s*(html|markdown|genui)\s*---CONTENT---\s*([\s\S]*)/i);
  if (!m) return null;
  return { format: m[1].toLowerCase() as "html" | "markdown" | "genui", content: m[2].trim() };
}

// In-chat HTML app bubble — sandboxed iframe with Save and Download actions
function HtmlAppBubble({
  content,
  messageId,
  agentId,
  onSave,
}: {
  content: string;
  messageId: string;
  agentId: string;
  onSave: (html: string, msgId: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  const download = () => {
    const blob = new Blob([content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "canopy-app.html";
    a.click(); URL.revokeObjectURL(url);
  };

  const save = () => {
    onSave(content, messageId);
    setSaved(true);
  };

  return (
    <div style={{ marginTop: 6, border: "1px solid rgba(74,158,150,0.25)", borderRadius: 10, overflow: "hidden", background: "var(--surface-card, #fff)" }}>
      {/* Header bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "rgba(74,158,150,0.06)", borderBottom: expanded ? "1px solid rgba(74,158,150,0.12)" : "none" }}>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#4A9E96" strokeWidth={2} strokeLinecap="round">
          <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#4A9E96", flex: 1 }}>Interactive App</span>
        <button onClick={save} disabled={saved} style={{ fontSize: 10, fontWeight: 600, color: saved ? "#10b981" : "#4A9E96", background: "transparent", border: "none", cursor: saved ? "default" : "pointer" }}>
          {saved ? "✓ Saved" : "Save app"}
        </button>
        <button onClick={download} style={{ fontSize: 10, color: "var(--text-sub, #636E72)", background: "transparent", border: "none", cursor: "pointer" }}>
          ↓ Download
        </button>
        <button onClick={() => setExpanded(e => !e)} style={{ fontSize: 10, color: "var(--text-sub, #636E72)", background: "transparent", border: "none", cursor: "pointer" }}>
          {expanded ? "Collapse" : "Preview"}
        </button>
      </div>
      {/* Iframe — only mounted when expanded to avoid loading all inline */}
      {expanded && (
        <iframe
          srcDoc={isolateGeneratedHtml(content)}
          sandbox="allow-scripts"
          style={{ width: "100%", height: 400, border: "none", display: "block" }}
          title="Agent-generated app"
        />
      )}
    </div>
  );
}

// ─── Cap on per-agent in-memory chat history. Beyond this we drop the *oldest* messages.
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

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;
const HTML_EXTS  = /\.(html?|htm)$/i;

type BackendConversationSummary = {
  id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_user_message?: string | null;
  thread_status: "idle" | "queued" | "running" | "waiting_for_human" | "paused" | "completed" | "failed" | "cancelled";
  background_allowed: boolean;
  active_run_count: number;
  last_run_id?: string | null;
  last_run_status?: string | null;
  checkpoint_count: number;
  last_checkpoint_at?: string | null;
};

function toUnixMs(value?: string | number | null): number {
  if (typeof value === "number") return value;
  if (!value) return Date.now();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function deriveConversationTitle(rawTitle?: string | null, firstUserMessage?: string | null): string {
  const preferred = firstUserMessage?.trim() || rawTitle?.trim() || "Untitled conversation";
  const fallbackTitle = rawTitle?.trim();
  const titleSource =
    !fallbackTitle ||
    fallbackTitle === "New Conversation" ||
    fallbackTitle.startsWith("Conversation with ")
      ? preferred
      : fallbackTitle;

  return titleSource.length > 40 ? titleSource.slice(0, 40).trimEnd() + "…" : titleSource;
}

function inferConversationType(conversationId: string, existingType?: "dm" | "forum"): "dm" | "forum" {
  if (existingType) return existingType;
  return conversationId.startsWith("forum_") || conversationId.startsWith("proj_") ? "forum" : "dm";
}

function resolveForumIdFromConversationId(conversationId?: string | null): string | null {
  if (!conversationId) return null;
  const forum = useForumStore.getState().forums.find(
    f => f.id === conversationId || conversationId.startsWith(`${f.id}_`)
  );
  return forum?.id || null;
}

function sameMessages(a: ChatMessage[] = [], b: ChatMessage[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left.id !== right.id) return false;
    if (left.sender !== right.sender) return false;
    if (left.text !== right.text) return false;
    if ((left.attachments?.length || 0) !== (right.attachments?.length || 0)) return false;
  }
  return true;
}

function EmbedPreview({ agentId, refName, title, height, messageId }: { agentId: string; refName: string; title: string; height: string; messageId?: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isImage = IMAGE_EXTS.test(refName);

  useEffect(() => {
    if (isImage) {
      // Load image as base64 data URL for inline display
      invoke<string>("read_workspace_file_base64", { agentId, filename: refName })
        .then(url => setImageDataUrl(url))
        .catch(e => setError(String(e)));
    } else {
      // Load HTML / text file for iframe
      const filename = HTML_EXTS.test(refName) ? refName : `${refName}.html`;
      invoke<string>("read_workspace_file", { agentId, filename })
        .then(body => {
          setContent(body);
          if (body && body.trim() !== "") {
            useWorldStore.getState().addMiniApp(agentId, {
              name: title || refName,
              description: `Pinned from chat`,
              entrypoint: filename,
              sourceMessageId: messageId || refName,
            });
          }
        })
        .catch(e => setError(String(e)));
    }
  }, [agentId, refName, isImage, title]);

  return (
    <div style={{ margin: "12px 0", border: "1px solid var(--border-subtle)", borderRadius: 12, overflow: "hidden", background: "var(--surface-card)" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8, background: "rgba(0,0,0,0.02)" }}>
        <button
          title="Export HTML"
          onClick={() => {
            if (!content) return;
            const blob = new Blob([content], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = refName.endsWith(".html") ? refName : `${refName}.html`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }}
          style={{ background: "none", border: "none", padding: 0, cursor: content ? "pointer" : "default", opacity: content ? 1 : 0.4, display: "flex" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--primary)" }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{title}</span>
      </div>
      {error ? (
        <div style={{ padding: 16, fontSize: 12, color: "#E57373" }}>Failed to load: {error}</div>
      ) : isImage ? (
        imageDataUrl
          ? <img src={imageDataUrl} alt={title || refName} style={{ width: "100%", display: "block", maxHeight: height ? `${height}px` : "500px", objectFit: "contain" }} />
          : <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>Loading {refName}...</div>
      ) : content === null ? (
        <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>Loading {refName}...</div>
      ) : content.trim() === "" ? (
        <div style={{ padding: 32, fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", textAlign: "center", background: "rgba(0,0,0,0.02)" }}>
          File <strong>{refName}</strong> is empty or hasn't been saved to the workspace yet.
        </div>
      ) : (
        <iframe
          src={`canopy-workspace://${agentId}/${encodeURIComponent(HTML_EXTS.test(refName) ? refName : `${refName}.html`)}`}
          style={{ width: "100%", height: height ? `${height}px` : "400px", border: "none", background: "#fff" }}
          sandbox="allow-scripts"
          title={title}
        />
      )}
    </div>
  );
}

interface AttachmentThumbnailProps {
  agentId: string;
  attachment: { name: string; dataUrl: string };
}

function AttachmentThumbnail({ agentId, attachment }: AttachmentThumbnailProps) {
  const [dataUrl, setDataUrl] = useState<string>(attachment.dataUrl || "");
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(attachment.name);

  useEffect(() => {
    if (!attachment.dataUrl && isImage) {
      invoke<string>("read_workspace_file_base64", { agentId, filename: attachment.name })
        .then((url) => {
          if (url) {
            setDataUrl(url);
          }
        })
        .catch((err) => {
          console.warn("Failed to load dynamic attachment thumbnail:", err);
        });
    } else if (attachment.dataUrl) {
      setDataUrl(attachment.dataUrl);
    }
  }, [agentId, attachment.name, attachment.dataUrl, isImage]);

  if (isImage && dataUrl) {
    return (
      <img src={dataUrl} alt={attachment.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.1)", fontSize: 10, padding: 4, wordBreak: "break-all", textAlign: "center", lineHeight: 1.2 }}>
      {attachment.name}
    </div>
  );
}

export // ─── Chat / Communion Component ──────────────────────────────────────────────


function ChatTab({ agent, compact = false, hideHeader = false }: { agent: AgentData; compact?: boolean; hideHeader?: boolean }) {
  const { agents, setAgents, setArchitectTab } = useWorldStore();
  const addMiniApp = useWorldStore(s => s.addMiniApp);
  const gatewayReady = useWorldStore(s => s.gatewayReady);
  const [repairLog, setRepairLog] = useState<string | null>(null);
  const [repairSucceeded, setRepairSucceeded] = useState<boolean | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [hardResetting, setHardResetting] = useState(false);

  const handleResume = async () => {
    try {
      // Optimistically update local store state
      useWorldStore.setState(state => ({
        agents: state.agents.map(a => 
          a.id === agent.id ? { ...a, paused: false, status: "idle" as any } : a
        )
      }));
      if (typeof invoke === 'function') {
        await invoke("set_agent_paused", { agentId: agent.id, paused: false });
        // After resuming, run boot_sync_agents to ensure it is registered and running
        await invoke("boot_sync_agents").catch(e => console.warn("Failed to boot sync resumed agent:", e));
      }
    } catch (e) {
      console.error("Failed to resume agent:", e);
      // Revert local store state on error
      useWorldStore.setState(state => ({
        agents: state.agents.map(a => 
          a.id === agent.id ? { ...a, paused: true, status: "sleeping" as any } : a
        )
      }));
      alert("Failed to resume agent: " + e);
    }
  };

  const handleRepair = async () => {
    setIsRepairing(true);
    setRepairLog("Starting repair process...\n\nSynchronizing credentials and rebuilding agent gateway container.");
    setRepairSucceeded(null);
    try {
      if (typeof invoke === 'function') {
        // Retrieve credentials
        const agAnthropic = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_anthropic_key` }).catch(() => "") || "")
          || String(await invoke("get_secret_cmd", { key: "ANTHROPIC_API_KEY" }).catch(() => "") || "");
        const agOpenAI = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_openai_key` }).catch(() => "") || "")
          || String(await invoke("get_secret_cmd", { key: "OPENAI_API_KEY" }).catch(() => "") || "");
        const agGemini = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_gemini_key` }).catch(() => "") || "")
          || String(await invoke("get_secret_cmd", { key: "GEMINI_API_KEY" }).catch(() => "") || "");
        const agGrok = String(await invoke("get_secret_cmd", { key: `agent_${agent.id}_grok_key` }).catch(() => "") || "")
          || String(await invoke("get_secret_cmd", { key: "XAI_API_KEY" }).catch(() => "")
            || await invoke("get_secret_cmd", { key: "GROK_API_KEY" }).catch(() => "") || "");

        await invoke("sync_credentials", {
          agentId: agent.id, keys: {
            "ANTHROPIC_API_KEY": agAnthropic,
            "OPENAI_API_KEY": agOpenAI,
            "GEMINI_API_KEY": agGemini,
            "XAI_API_KEY": agGrok,
          }
        }).catch((err) => console.error("Sync credentials failed:", err));

        const res = await invoke("repair_gateway", { agentId: agent.id });
        setRepairLog(String(res));
        setRepairSucceeded(true);

        // Clear the error status — the agent is now registered and live.
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => a.id === agent.id
            ? { ...a, status: "active", currentAction: "idle" }
            : a)
        }));
      }
    } catch (e) {
      setRepairLog("✗ Repair failed:\n" + String(e));
      setRepairSucceeded(false);
      console.error("Openclaw repair failed:", e);
    } finally {
      setIsRepairing(false);
    }
  };

  const handleHardReset = async () => {
    setHardResetting(true);
    setRepairLog("Hard Reset in progress...\n\nRestarting OrbStack Linux VM and rebuilding the gateway container.\nThis takes 15–20 seconds.");
    setRepairSucceeded(null);
    try {
      if (typeof invoke === 'function') {
        await invoke("hard_reset_infrastructure");
        setRepairLog("✓ Hard Reset complete — OrbStack VM restarted. Re-registering agents...");
        try {
          await invoke("boot_sync_agents");
          setRepairLog("✓ Hard Reset complete — gateway restarted and agents re-initialized.");
          setRepairSucceeded(true);
        } catch (syncErr) {
          console.warn("boot_sync after hard reset:", syncErr);
          setRepairLog("✓ Hard Reset complete — gateway restarted.\n(Agent re-sync ran in background.)");
          setRepairSucceeded(true);
        }
      }
    } catch (e) {
      setRepairLog(`✗ Hard Reset failed:\n${String(e)}\n\nMake sure OrbStack is installed and try opening it manually.`);
      setRepairSucceeded(false);
    } finally {
      setHardResetting(false);
    }
  };

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
  const suppressThreadActivityTouchRef = useRef(false);
  // Throttle for background boot_sync re-registration after gateway timeouts
  // (used in handleSendMessage's error recovery; was referenced without being
  // declared — pre-existing compile error fixed June 9, 2026).
  const lastBootSync = useRef<number>(0);
  useEffect(() => {
    if (lastSeenConvIdRef.current !== agent.activeConversationId) {
      lastSeenConvIdRef.current = agent.activeConversationId;
      suppressThreadActivityTouchRef.current = true;
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

    // Starter-task handoff from onboarding (activation A2 — "Watch [Name] work",
    // spec-helper-agent-and-orchestrator.md Part 1C). The wizard queues the
    // agent's first task in localStorage after deploy succeeds and lands the
    // user here; we send it once, automatically, so the first thing the user
    // sees is their agent producing real work.
    let starterTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = localStorage.getItem("canopy_starter_task");
      if (raw) {
        const st = JSON.parse(raw);
        if (st && st.agentId === agent.id && typeof st.prompt === "string" && st.prompt.trim()) {
          localStorage.removeItem("canopy_starter_task");
          // Small delay so the freshly-mounted chat surface settles before the
          // send kicks off (mirrors the one-tick defer in onSendChat above).
          starterTimer = setTimeout(() => handleSendMessage(st.prompt, undefined, undefined, true), 800);
        }
      }
    } catch { /* malformed payload — drop it rather than block chat */ }

    return () => {
      window.removeEventListener("canopy:send-chat", onSendChat as EventListener);
      if (starterTimer) clearTimeout(starterTimer);
    };
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
  const [loadingSessionIds, setLoadingSessionIds] = useState<string[]>([]);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [likedMsgIds, setLikedMsgIds] = useState<Set<string>>(new Set());
  const [dislikedMsgIds, setDislikedMsgIds] = useState<Set<string>>(new Set());
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
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
  const stoppedSessionIdsRef = useRef<Set<string>>(new Set());

  // Message Queueing State
  const [queuedMessages, setQueuedMessages] = useState<{
    text: string;
    attachments: any[];
    threadMode: "same" | "new";
    sessionId: string | null;
  }[]>([]);

  const handleQueueMessage = (threadMode: "same" | "new" = "same") => {
    const baseText = message.trim();
    if (!baseText && attachments.length === 0) return;
    
    setQueuedMessages(prev => [...prev, {
      text: baseText,
      attachments: [...attachments],
      threadMode,
      sessionId: threadMode === "same" ? agentRef.current.activeConversationId || null : null,
    }]);
    
    setMessage("");
    setAttachments([]);
  };

  const isSessionLoading = useCallback(
    (sessionId?: string | null) => !!sessionId && loadingSessionIds.includes(sessionId),
    [loadingSessionIds]
  );

  const markSessionLoading = useCallback((sessionId: string) => {
    setLoadingSessionIds(prev => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
  }, []);

  const clearSessionLoading = useCallback((sessionId?: string | null) => {
    if (!sessionId) return;
    setLoadingSessionIds(prev => prev.filter(id => id !== sessionId));
  }, []);

  const markSessionStopped = useCallback((sessionId?: string | null) => {
    if (!sessionId) return;
    stoppedSessionIdsRef.current.add(sessionId);
    clearSessionLoading(sessionId);
  }, [clearSessionLoading]);

  const clearStoppedMarker = useCallback((sessionId?: string | null) => {
    if (!sessionId) return;
    stoppedSessionIdsRef.current.delete(sessionId);
  }, []);

  const wasSessionStopped = useCallback(
    (sessionId?: string | null) => !!sessionId && stoppedSessionIdsRef.current.has(sessionId),
    []
  );

  const upsertConversationSummary = useCallback((summary: BackendConversationSummary) => {
    const nextTitle = deriveConversationTitle(summary.title, summary.first_user_message);
    const createdAt = toUnixMs(summary.created_at);
    const lastActiveAt = toUnixMs(summary.updated_at);

    useWorldStore.setState(state => ({
      agents: state.agents.map(a => {
        if (a.id !== summary.agent_id) return a;

        const conversations = [...(a.conversations || [])];
        const existingIndex = conversations.findIndex(conv => conv.id === summary.id);
        const existingConversation = existingIndex >= 0 ? conversations[existingIndex] : null;
        const nextConversation = {
          id: summary.id,
          title: existingConversation
            ? deriveConversationTitle(existingConversation.title, summary.first_user_message) || nextTitle
            : nextTitle,
          messages: existingConversation?.messages || [],
          createdAt: existingConversation?.createdAt || createdAt,
          lastActiveAt: Math.max(existingConversation?.lastActiveAt || 0, lastActiveAt),
          type: inferConversationType(summary.id, existingConversation?.type),
          status: existingConversation?.status || "active",
          threadStatus: summary.thread_status,
          backgroundAllowed: summary.background_allowed,
          activeRunCount: summary.active_run_count,
          lastRunId: summary.last_run_id || null,
          lastRunStatus: summary.last_run_status || null,
          checkpointCount: summary.checkpoint_count,
          lastCheckpointAt: summary.last_checkpoint_at ? toUnixMs(summary.last_checkpoint_at) : null,
        };

        if (existingIndex >= 0) {
          conversations[existingIndex] = nextConversation;
        } else {
          conversations.push(nextConversation);
        }

        return { ...a, conversations };
      }),
    }));
  }, []);

  const refreshConversationSummary = useCallback(async (sessionId?: string | null) => {
    if (!sessionId) return;
    try {
      const summaries = await invoke<BackendConversationSummary[]>("list_agent_conversations", {
        agentId: agentRef.current.id,
        limit: 100,
      });
      const summary = summaries.find(item => item.id === sessionId);
      if (summary) {
        upsertConversationSummary(summary);
      }
    } catch (error) {
      console.warn("Failed to refresh conversation summary:", error);
    }
  }, [upsertConversationSummary]);

  const activeThreadLoading = isSessionLoading(agent.activeConversationId);

  // Process queued messages when loading finishes
  useEffect(() => {
    if (queuedMessages.length > 0) {
      const timer = setTimeout(() => {
        const nextMsg = queuedMessages[0];
        if (
          nextMsg.threadMode === "same" &&
          nextMsg.sessionId &&
          isSessionLoading(nextMsg.sessionId)
        ) {
          return;
        }
        setQueuedMessages(prev => prev.slice(1));
        
        if (nextMsg.threadMode === "new") {
           const newSessionId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
           useWorldStore.setState(state => ({
             agents: state.agents.map(a => {
               if (a.id !== agent.id) return a;
               return { ...a, activeConversationId: newSessionId, chatLog: [] };
             })
           }));
           setTimeout(() => {
             handleSendMessage(nextMsg.text, nextMsg.attachments, newSessionId);
           }, 100);
        } else {
           handleSendMessage(
             nextMsg.text,
             nextMsg.attachments,
             nextMsg.sessionId || undefined
           );
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [queuedMessages, agent.id, isSessionLoading]);

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

    // BREAK INFINITE LOOP: Check if an update is actually needed before calling setState
    const currentState = useWorldStore.getState();
    const currentAgent = currentState.agents.find(a => a.id === agent.id);
    if (!currentAgent) return;
    
    // Determine if we have actual new content
    const activeConv = currentAgent.conversations?.find(c => c.id === agent.activeConversationId);
    const isNewContent = !activeConv || !sameMessages(chatLog, activeConv.messages);
    
    // If local state perfectly matches the global store, bail out early to prevent an infinite render loop.
    if (sameMessages(currentAgent.chatLog || [], chatLog) && !isNewContent) {
      return; 
    }

    const preserveLastActiveAt = suppressThreadActivityTouchRef.current;
    suppressThreadActivityTouchRef.current = false;

    useWorldStore.setState(state => ({
      agents: state.agents.map(a => {
        if (a.id !== agent.id) return a;
        let conversations = a.conversations;
        if (a.activeConversationId && conversations) {
          conversations = conversations.map(c => {
            if (c.id !== a.activeConversationId) return c;
            
            return {
              ...c, 
              messages: chatLog, 
              lastActiveAt: isNewContent && !preserveLastActiveAt ? Date.now() : c.lastActiveAt 
            };
          });
        }
        return { ...a, chatLog, conversations };
      })
    }));
  }, [chatLog, agent.id]);

  // When switching threads externally, update the local chatLog immediately
  useEffect(() => {
    suppressThreadActivityTouchRef.current = true;
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
    let cancelled = false;

    const hydrateConversations = async () => {
      try {
        const summaries = await invoke<BackendConversationSummary[]>("list_agent_conversations", {
          agentId: agent.id,
          limit: 100,
        });
        if (cancelled || !Array.isArray(summaries) || summaries.length === 0) return;

        useWorldStore.setState(state => ({
          agents: state.agents.map(a => {
            if (a.id !== agent.id) return a;

            const merged = [...(a.conversations || [])];
            const existing = new Map(merged.map(conv => [conv.id, conv]));

            for (const summary of summaries) {
              const nextTitle = deriveConversationTitle(summary.title, summary.first_user_message);
              const createdAt = toUnixMs(summary.created_at);
              const lastActiveAt = toUnixMs(summary.updated_at);
              const existingConv = existing.get(summary.id);

              if (existingConv) {
                const nextExisting = {
                  ...existingConv,
                  title: deriveConversationTitle(existingConv.title, summary.first_user_message) || nextTitle,
                  createdAt: existingConv.createdAt || createdAt,
                  lastActiveAt: Math.max(existingConv.lastActiveAt || 0, lastActiveAt),
                  threadStatus: summary.thread_status,
                  backgroundAllowed: summary.background_allowed,
                  activeRunCount: summary.active_run_count,
                  lastRunId: summary.last_run_id || null,
                  lastRunStatus: summary.last_run_status || null,
                  checkpointCount: summary.checkpoint_count,
                  lastCheckpointAt: summary.last_checkpoint_at ? toUnixMs(summary.last_checkpoint_at) : null,
                };
                const index = merged.findIndex(conv => conv.id === summary.id);
                if (index >= 0) merged[index] = nextExisting;
                existing.set(summary.id, nextExisting);
                continue;
              }

              const hydrated = {
                id: summary.id,
                title: nextTitle,
                messages: [],
                createdAt,
                lastActiveAt,
                type: inferConversationType(summary.id) as const,
                status: "active" as const,
                threadStatus: summary.thread_status,
                backgroundAllowed: summary.background_allowed,
                activeRunCount: summary.active_run_count,
                lastRunId: summary.last_run_id || null,
                lastRunStatus: summary.last_run_status || null,
                checkpointCount: summary.checkpoint_count,
                lastCheckpointAt: summary.last_checkpoint_at ? toUnixMs(summary.last_checkpoint_at) : null,
              };
              existing.set(summary.id, hydrated);
              merged.push(hydrated);
            }

            const shouldRestoreLatest =
              !a.activeConversationId &&
              (!a.chatLog || a.chatLog.length === 0) &&
              summaries.length > 0;

            return {
              ...a,
              conversations: merged,
              activeConversationId: shouldRestoreLatest ? summaries[0].id : a.activeConversationId,
            };
          })
        }));
      } catch (err) {
        console.warn("Failed to hydrate conversation list:", err);
      }
    };

    hydrateConversations();
    const interval = setInterval(hydrateConversations, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agent.id]);

  useEffect(() => {
    if (typeof invoke === 'function') {
      let isActive = true;
      let isFetching = false;
      const fetchHistory = async () => {
        if (!isActive || isFetching) return;
        isFetching = true;
        try {
          const currentAgent = agentRef.current;
          const sessionIdAtFetch = currentAgent.activeConversationId;
          const resp: any = await invoke("get_conversation_history", { agentId: currentAgent.id, limit: 100, sessionId: sessionIdAtFetch || null });
          let localMessages: any[] = [];
          
          if (!isActive) return;
          // Prevent race condition: if the user switched threads while we were fetching, discard the result
          if (agentRef.current.activeConversationId !== sessionIdAtFetch) return;

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

          suppressThreadActivityTouchRef.current = true;
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
        } finally {
          isFetching = false;
        }
      };
      
      fetchHistory();
      const interval = setInterval(fetchHistory, 3000);
      return () => {
        isActive = false;
        clearInterval(interval);
      };
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
        ts: Date.now(),
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
        ts: Date.now(),
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

  const handleStop = async () => {
    const sessionId = agentRef.current.activeConversationId;
    setQueuedMessages([]); // Clear queue on stop
    if (!sessionId) return;

    try {
      const result = await invoke<{ signal_matched?: boolean; active_runs?: number }>("cancel_thread_run", {
        agentId: agentRef.current.id,
        sessionId,
      });
      if (result?.signal_matched || (result?.active_runs ?? 0) === 0) {
        markSessionStopped(sessionId);
        void refreshConversationSummary(sessionId);
      }
    } catch (e) {
      console.error("Failed to hard-cancel thread run:", e);
    }
  };

  const handleSendMessage = async (overrideText?: string, overrideAttachments?: any[], overrideSessionId?: string, isStarterTask?: boolean) => {
    const baseText = (overrideText ?? message).trim();
    const activeAttachments = overrideAttachments ?? attachments;
    if (!baseText && activeAttachments.length === 0) return;
    let activeSessionId = overrideSessionId || agentRef.current.activeConversationId;
    if (isSessionLoading(activeSessionId)) return;

    let finalMessage = baseText;
    if (activeAttachments.length > 0) {
      const fileNames = activeAttachments.map(a => a.name).join(", ");
      finalMessage += `\n\n[System Context: I have uploaded the following files to your workspace: ${fileNames}. Please analyze them if requested.]`;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      text: baseText,
      time: formatMessageTime(new Date()),
      ts: Date.now(),
      attachments: activeAttachments.length > 0 ? [...activeAttachments] : undefined,
    };

    setChatLog(prev => capLog([...prev, userMsg]));
    if (overrideText === undefined && overrideAttachments === undefined) {
      setMessage("");
      setAttachments([]);
    }

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

      const convExists = agentRef.current.conversations?.some(c => c.id === activeSessionId);
      
      if (!activeSessionId || !convExists) {
        activeSessionId = activeSessionId || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
                threadStatus: "idle",
                backgroundAllowed: false,
                activeRunCount: 0,
                checkpointCount: 0,
              }]
            };
          })
        }));
      }

      if (isSessionLoading(activeSessionId)) {
        return;
      }
      clearStoppedMarker(activeSessionId);
      markSessionLoading(activeSessionId);

      useWorldStore.setState(state => ({
        agents: state.agents.map(a => {
          if (a.id !== agent.id) return a;
          return {
            ...a,
            conversations: (a.conversations || []).map(c =>
              c.id === activeSessionId
                ? {
                    ...c,
                    threadStatus: "running",
                    activeRunCount: (c.activeRunCount || 0) + 1,
                    lastRunStatus: "running",
                    lastActiveAt: Date.now(),
                  }
                : c
            ),
          };
        }),
      }));

      const response: any = await invoke("send_message", {
        agentId: agent.id,
        message: finalMessage,
        sessionId: activeSessionId,
      });

      if (wasSessionStopped(activeSessionId)) {
        if (!overrideText) setMessage(baseText);
        setChatLog(prev => prev.filter(m => m.id !== userMsg.id));
        return;
      }

      // A1 activation: first agent reply seen. A2: first deliverable, specifically
      // the reply to the onboarding starter task ("watch [agent] work" — the
      // product's "aha moment"). Fire-once, see fireActivationEvent. Only the
      // milestone name is sent, never reply content.
      fireActivationEvent("activation_a1_first_reply");
      if (isStarterTask) {
        fireActivationEvent("activation_a2_first_deliverable");
      }

      let responseText = typeof response === 'object' ? response?.response || response?.content || JSON.stringify(response) : String(response);

      const authMatch = responseText.match(/\[request_auth:\s*([^\]]+)\]/);
      if (authMatch) {
         setAuthDomain(authMatch[1].trim());
         responseText = responseText.replace(authMatch[0], "").trim();
      }

      const agentMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "agent",
        text: responseText || "I've sent a credential request to your WebVault.",
        time: formatMessageTime(new Date()),
        ts: Date.now(),
      };

      useWorldStore.setState(state => ({
        agents: state.agents.map(a => {
          if (a.id !== agentRef.current.id) return a;
          return {
            ...a,
            conversations: (a.conversations || []).map(c =>
              c.id === activeSessionId
                  ? {
                      ...c,
                      threadStatus: response?.thread_status || ((response?.active_run_count ?? 0) > 0 ? "running" : "idle"),
                      activeRunCount: typeof response?.active_run_count === "number"
                        ? response.active_run_count
                        : Math.max(0, (c.activeRunCount || 1) - 1),
                      lastRunId: response?.last_run_id || response?.run_id || c.lastRunId || null,
                      lastRunStatus: response?.last_run_status || "completed",
                      checkpointCount: typeof response?.checkpoint_count === "number"
                        ? response.checkpoint_count
                        : c.checkpointCount,
                      lastCheckpointAt: response?.last_checkpoint_at
                        ? toUnixMs(response.last_checkpoint_at)
                        : c.lastCheckpointAt,
                      lastActiveAt: Date.now(),
                    }
                : c
            ),
          };
        }),
      }));

      if (agentRef.current.activeConversationId === activeSessionId) {
        setChatLog(prev => capLog([...prev, agentMsg]));
      } else {
        // User switched threads while agent was working.
        // Save the message to the background thread.
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => {
            if (a.id !== agentRef.current.id) return a;
            let conversations = a.conversations;
            if (conversations) {
              conversations = conversations.map(c => c.id === activeSessionId ? {
                ...c,
                messages: [...c.messages, agentMsg],
                lastActiveAt: Date.now()
              } : c);
            }
            return { ...a, conversations };
          })
        }));
      }
    } catch (error) {
      let friendlyError = String(error);
      const isCancelled = /Run cancelled by user/i.test(friendlyError);

      if (isCancelled) {
        useWorldStore.setState(state => ({
          agents: state.agents.map(a => {
            if (a.id !== agent.id) return a;
            return {
              ...a,
              conversations: (a.conversations || []).map(c =>
                c.id !== activeSessionId
                  ? c
                  : (() => {
                      const nextActiveRunCount = Math.max(0, (c.activeRunCount || 1) - 1);
                      return {
                        ...c,
                        threadStatus: nextActiveRunCount > 0 ? "running" : "cancelled",
                        activeRunCount: nextActiveRunCount,
                        lastRunStatus: "cancelled",
                        lastActiveAt: Date.now(),
                      };
                    })()
              ),
            };
          }),
        }));
        return;
      }

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
            sessionId: activeSessionId,
          });
          
          if (wasSessionStopped(activeSessionId)) {
            if (!overrideText) setMessage(baseText);
            setChatLog(prev => prev.filter(m => m.id !== userMsg.id));
            return;
          }

          const retryText = typeof retryResponse === 'object'
            ? retryResponse?.response || retryResponse?.content || JSON.stringify(retryResponse)
            : String(retryResponse);
          const retryAgentMsg: ChatMessage = {
            id: (Date.now() + 1).toString(),
            sender: "agent",
            text: retryText || "I've sent a credential request to your WebVault.",
            time: formatMessageTime(new Date()),
            ts: Date.now(),
          };

          useWorldStore.setState(state => ({
            agents: state.agents.map(a => {
              if (a.id !== agentRef.current.id) return a;
              return {
                ...a,
                conversations: (a.conversations || []).map(c =>
                  c.id === activeSessionId
                    ? {
                        ...c,
                        threadStatus: retryResponse?.thread_status || ((retryResponse?.active_run_count ?? 0) > 0 ? "running" : "idle"),
                        activeRunCount: typeof retryResponse?.active_run_count === "number"
                          ? retryResponse.active_run_count
                          : Math.max(0, (c.activeRunCount || 1) - 1),
                        lastRunId: retryResponse?.last_run_id || retryResponse?.run_id || c.lastRunId || null,
                        lastRunStatus: retryResponse?.last_run_status || "completed",
                        checkpointCount: typeof retryResponse?.checkpoint_count === "number"
                          ? retryResponse.checkpoint_count
                          : c.checkpointCount,
                        lastCheckpointAt: retryResponse?.last_checkpoint_at
                          ? toUnixMs(retryResponse.last_checkpoint_at)
                          : c.lastCheckpointAt,
                        lastActiveAt: Date.now(),
                      }
                    : c
                ),
              };
            }),
          }));

          if (agentRef.current.activeConversationId === activeSessionId) {
            setChatLog(prev => capLog([...prev, retryAgentMsg]));
          } else {
            useWorldStore.setState(state => ({
              agents: state.agents.map(a => {
                if (a.id !== agentRef.current.id) return a;
                let conversations = a.conversations;
                if (conversations) {
                  conversations = conversations.map(c => c.id === activeSessionId ? {
                    ...c,
                    messages: [...c.messages, retryAgentMsg],
                    lastActiveAt: Date.now()
                  } : c);
                }
                return { ...a, conversations };
              })
            }));
          }
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
        const now = Date.now();
        if (now - lastBootSync.current > 5 * 60 * 1000) {
          lastBootSync.current = now;
          inv("boot_sync_agents").catch((e: any) => console.warn("background boot_sync after timeout:", e));
        }
        friendlyError = "The agent is taking a while to respond. Registration is being refreshed — please try again in 30 seconds.";
      } else if (friendlyError.includes("429") || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(friendlyError)) {
        // Provider quota/rate-limit — the #1 cause of "my agent doesn't talk."
        // (Part 1D playbook class: rate-limited key.) Name the provider and
        // give the user a way out instead of surfacing the raw 429 blob.
        const provMatch = friendlyError.match(/google|gemini|openai|anthropic|claude|xai|grok/i);
        const provName = provMatch
          ? { google: "Google Gemini", gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic", claude: "Anthropic", xai: "xAI", grok: "xAI" }[provMatch[0].toLowerCase()] || "your AI provider"
          : "your AI provider";
        friendlyError =
          `**${agent.name} can't respond right now — your ${provName} key is out of quota.** ` +
          `The provider rejected the request (rate limit / billing cap), so nothing Canopy retries will help until it resets. ` +
          `Options: wait for the quota window to reset, upgrade the key's plan, or switch ${agent.name} to a different model under **Skills & Access → AI model**.`;
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
        ts: Date.now(),
      };

      useWorldStore.setState(state => ({
        agents: state.agents.map(a => {
          if (a.id !== agent.id) return a;
          return {
            ...a,
            chatLog: [...a.chatLog, errorMsg],
            conversations: (a.conversations || []).map(c =>
              c.id !== activeSessionId
                ? c
                : (() => {
                    const nextActiveRunCount = Math.max(0, (c.activeRunCount || 1) - 1);
                    return {
                      ...c,
                      threadStatus: nextActiveRunCount > 0 ? "running" : "failed",
                      activeRunCount: nextActiveRunCount,
                      lastRunStatus: "failed",
                      lastActiveAt: Date.now(),
                    };
                  })()
            ),
          };
        }),
      }));
      
      setChatLog(prev => capLog([...prev, errorMsg]));
    } finally {
      clearSessionLoading(activeSessionId);
      clearStoppedMarker(activeSessionId);
      void refreshConversationSummary(activeSessionId);
    }
  };

  const activeConv = agent.conversations?.find(c => c.id === agent.activeConversationId);
  const activeForumTargetId = activeConv?.type === "forum"
    ? resolveForumIdFromConversationId(activeConv.id)
    : null;
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}>
      {!compact && !hideHeader && (
        <div style={{ marginBottom: 12, padding: "0 10px", marginTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, color: "var(--text-sub)", margin: 0 }}>
            {topic ? (
              <>Chat with <strong>{agent.name}</strong> about <strong>{topic}</strong>{startedAt ? ` started ${formatStartedTime(startedAt)}` : ''}</>
            ) : (
              <>Chat with <strong>{agent.name}</strong></>
            )}
          </div>
          {activeConv?.type === "forum" && activeForumTargetId && (
            <button 
               onClick={() => {
                 useForumStore.getState().setActiveForumId(activeForumTargetId);
                 useWorldStore.getState().setActiveView("forum");
               }}
               style={{ 
                 padding: "4px 10px", background: "rgba(60,102,99,0.15)", color: "#3c6663", 
                 border: "1px solid rgba(60,102,99,0.3)", borderRadius: 6, fontSize: 12, 
                 fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4
               }}
            >
               <Users size={12} /> Open Forum
            </button>
          )}
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
          }).map(rawMsg => {
            // ── Tool-delivered agent messages mis-labeled as "user" ───────────────
            // When OpenClaw routes a message via its internal message tool
            // (action="send"), the reply arrives with sender:"user" even though
            // it came from the agent. Detect these by checking:
            // 1. Has image attachments (data: URL — works on fresh delivery)
            // 2. Has image attachments by filename extension (works after persistence
            //    strips the data URLs)
            // 3. Message text looks like an agent response, not a user message
            const looksLikeAgentDelivery = (
              rawMsg.sender === "user" &&
              rawMsg.attachments &&
              rawMsg.attachments.length > 0 &&
              rawMsg.attachments.some(a =>
                a.dataUrl?.startsWith("data:image") ||
                IMAGE_EXTS.test(a.name)
              )
            );
            const msg = looksLikeAgentDelivery
              ? { ...rawMsg, sender: "agent" as const }
              : rawMsg;

            return (
            <div
              key={msg.id}
              onMouseEnter={() => setHoveredMsgId(msg.id)}
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
                      <div
                        key={i}
                        style={{
                          width: 96,
                          borderRadius: 8,
                          overflow: "hidden",
                          border: "1px solid rgba(255,255,255,0.2)",
                          background: "rgba(255,255,255,0.08)",
                        }}
                      >
                        <div style={{ width: 96, height: 80 }}>
                          <AttachmentThumbnail agentId={agent.id} attachment={a} />
                        </div>
                        <div
                          title={a.name}
                          style={{
                            padding: "6px 8px",
                            fontSize: 10,
                            lineHeight: 1.3,
                            whiteSpace: "normal",
                            wordBreak: "break-word",
                            borderTop: "1px solid rgba(255,255,255,0.15)",
                          }}
                        >
                          {a.name}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {(() => {
                  const textTrimmed = msg.text.trim();

                  // ── OpenClaw inter-session routing messages — never user-visible ──────
                  // These contain <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> blocks and
                  // [Inter-session message] headers. They are internal tool routing
                  // used by OpenClaw's image/task pipeline and must be suppressed entirely.
                  if (
                    textTrimmed.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") ||
                    textTrimmed.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>") ||
                    textTrimmed.startsWith("[Inter-session message]") ||
                    textTrimmed.includes("[Internal task completion event]") ||
                    textTrimmed.startsWith("[Queued messages while agent was busy]")
                  ) {
                    return null;
                  }

                  if (msg.sender === "user") {
                    return (
                      <div
                        style={{
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {msg.text}
                      </div>
                    );
                  }

                  // ── Image attachments from tool-delivered messages ────────────────────
                  // When an agent uses OpenClaw's message tool with action="send" and
                  // attaches media, the reply may arrive with attachments. Render images
                  // inline rather than as a text bubble.
                  if (msg.attachments && msg.attachments.length > 0) {
                    const imageAtts = msg.attachments.filter(a =>
                      a.dataUrl?.startsWith("data:image") ||
                      /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(a.name)
                    );
                    if (imageAtts.length > 0) {
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {textTrimmed && (
                            <div className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                              <MDEditor.Markdown source={textTrimmed} style={{ background: "transparent", color: "inherit", fontSize: "inherit" }} />
                            </div>
                          )}
                          {imageAtts.map((att, i) => (
                            <div key={i} style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border-subtle)", maxWidth: 480 }}>
                              <img
                                src={att.dataUrl || att.name}
                                alt={att.name}
                                style={{ width: "100%", display: "block" }}
                                onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                              <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--text-sub)", background: "rgba(0,0,0,0.02)", borderTop: "1px solid var(--border-subtle)" }}>
                                {att.name}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    }
                  }

                  let isSystemDump = false;
                  let dumpTitle = "System Output";

                  if (msg.sender === "agent") {
                      // ── GenUI JSON payload detection — must happen before generic JSON dump ─
                      // If the payload has a "component" key it's a GenUI mini-app, not a dump.
                      if (textTrimmed.startsWith("{") && textTrimmed.includes('"component"')) {
                          try {
                              const payload = JSON.parse(textTrimmed);
                              if (payload.component) {
                                  return (
                                    <GenUIRenderer
                                      app={payload}
                                      onEvent={(evt) => {
                                        const t = `[GenUI Event] ${JSON.stringify(evt)}`;
                                        useWorldStore.setState(state => ({
                                          agents: state.agents.map(a => a.id !== agent.id ? a : {
                                            ...a,
                                            chatLog: [...a.chatLog, {
                                              id: `genui_${Date.now()}`, sender: "user",
                                              text: t, time: new Date().toLocaleTimeString(), ts: Date.now(),
                                            }]
                                          })
                                        }));
                                      }}
                                      attachments={msg.attachments}
                                    />
                                  );
                              }
                          } catch {}
                      }

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

                  // ── Format-aware block detection (HTML / GenUI from agent) ─────────
                  // Agents can return ---FORMAT--- html/markdown/genui ---CONTENT--- responses
                  // in individual chat, the same way forum orchestrator drafts work.
                  const formatBlock = parseFormatBlock(msg.text);

                  if (formatBlock && formatBlock.format === "html") {
                    return (
                      <HtmlAppBubble
                        content={formatBlock.content}
                        messageId={msg.id}
                        agentId={agent.id}
                        onSave={(html, msgId) => addMiniApp(agent.id, {
                          name: `App from ${msg.time}`,
                          description: `Generated in chat on ${msg.time}`,
                          htmlContent: html,
                          sourceMessageId: msgId,
                        })}
                      />
                    );
                  }

                  if (formatBlock && formatBlock.format === "genui") {
                    try {
                      const payload = JSON.parse(formatBlock.content);
                      if (payload.component) {
                        return (
                          <GenUIRenderer
                            app={payload}
                            onEvent={(evt) => {
                              const text = `[GenUI Event] ${JSON.stringify(evt)}`;
                              useWorldStore.setState(state => ({
                                agents: state.agents.map(a =>
                                  a.id !== agent.id ? a : {
                                    ...a,
                                    chatLog: [...a.chatLog, {
                                      id: `genui_${Date.now()}`, sender: "user",
                                      text, time: new Date().toLocaleTimeString(), ts: Date.now(),
                                    }]
                                  }
                                )
                              }));
                            }}
                            attachments={msg.attachments}
                          />
                        );
                      }
                    } catch {}
                  }

                  // format === "markdown" falls through to normal text rendering below
                  let text = (formatBlock?.format === "markdown" ? formatBlock.content : msg.text)
                    .replace(/<think>/gi, "[THOUGHT_PROCESS]").replace(/<\/think>/gi, "[/THOUGHT_PROCESS]");

                  text = text.replace(/(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*(?:[^:\n]+:\s*)?/gi, "");
                  text = text.replace(/(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\][^\.\n]+\.\s*/gi, "");
                  text = text.replace(/\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*/gi, "");

                  const elements: React.ReactNode[] = [];
                  const thoughtStartRegex = /\[THOUGHT_PROCESS\]/i;
                  const thoughtEndRegex = /\[\/THOUGHT_PROCESS\]/i;
                  
                  const chunks: { type: string; content?: string }[] = [];
                  let remainingText = text;
                  while (remainingText.length > 0) {
                      const startIndex = remainingText.search(thoughtStartRegex);
                      if (startIndex === -1) {
                          if (remainingText.trim()) chunks.push({ type: "text", content: remainingText });
                          break;
                      }
                      
                      const before = remainingText.substring(0, startIndex);
                      if (before.trim()) chunks.push({ type: "text", content: before });
                      
                      remainingText = remainingText.substring(startIndex + "[THOUGHT_PROCESS]".length);
                      const endIndex = remainingText.search(thoughtEndRegex);
                      if (endIndex === -1) {
                          chunks.push({ type: "thought", content: remainingText.trim() });
                          remainingText = "";
                      } else {
                          chunks.push({ type: "thought", content: remainingText.substring(0, endIndex).trim() });
                          remainingText = remainingText.substring(endIndex + "[/THOUGHT_PROCESS]".length);
                      }
                  }

                  chunks.forEach((chunk, i) => {
                      if (chunk.type === "thought") {
                          elements.push(
                              <details key={`thought-${i}`} style={{ margin: "8px 0", padding: "8px 12px", background: "rgba(0,0,0,0.05)", borderRadius: 8, fontSize: 12, color: "var(--text-sub)", border: "1px solid rgba(0,0,0,0.05)" }}>
                                <summary style={{ cursor: "pointer", fontWeight: 600, outline: "none", opacity: 0.8 }}>Thought Process</summary>
                                <div style={{ marginTop: 8, fontStyle: "italic", whiteSpace: "pre-wrap" }}>{chunk.content}</div>
                              </details>
                          );
                      } else if (chunk.type === "text" && chunk.content) {
                          const embedRegex = /\[embed\s+([^\]]+)\/\]/gi;
                          let textToProcess = chunk.content;
                          let match;
                          let lastIndex = 0;
                          
                          while ((match = embedRegex.exec(textToProcess)) !== null) {
                              if (match.index > lastIndex) {
                                  const beforeText = textToProcess.substring(lastIndex, match.index);
                                  if (beforeText.trim()) {
                                      elements.push(
                                          <div key={`text-${elements.length}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                                            <MDEditor.Markdown source={beforeText} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                                          </div>
                                      );
                                  }
                              }
                              
                              const attrsStr = match[1];
                              const refMatch = attrsStr.match(/ref="([^"]+)"/i);
                              const titleMatch = attrsStr.match(/title="([^"]+)"/i);
                              const heightMatch = attrsStr.match(/height="([^"]+)"/i);
                              
                              const refName = refMatch ? refMatch[1] : "unknown";
                              const title = titleMatch ? titleMatch[1] : "Embedded Content";
                              const height = heightMatch ? heightMatch[1] : "400";
                              
                              elements.push(
                                  <EmbedPreview
                                      key={`embed-${elements.length}`}
                                      agentId={agent.id}
                                      refName={refName}
                                      title={title}
                                      height={height}
                                      messageId={msg.ts?.toString()}
                                  />
                              );
                              lastIndex = embedRegex.lastIndex;
                          }
                          const afterText = textToProcess.substring(lastIndex);
                          if (afterText.trim()) {
                              elements.push(
                                  <div key={`text-${elements.length}`} className="markdown-chat" style={{ color: "inherit", fontSize: "inherit", background: "transparent" }}>
                                    <MDEditor.Markdown source={afterText} style={{ background: "transparent", color: "inherit", fontSize: "inherit", lineHeight: "inherit" }} />
                                  </div>
                              );
                          }
                      }
                  });
                  
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
                  const visible = hoveredMsgId === msg.id || likedMsgIds.has(msg.id) || dislikedMsgIds.has(msg.id) || copiedMsgId === msg.id;
                  const liked = likedMsgIds.has(msg.id);
                  const disliked = dislikedMsgIds.has(msg.id);
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
                          if (next.has(msg.id)) {
                            next.delete(msg.id);
                          } else {
                            next.add(msg.id);
                            setDislikedMsgIds(d => {
                              const nd = new Set(d);
                              nd.delete(msg.id);
                              return nd;
                            });
                          }
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
                        onClick={() => setDislikedMsgIds(prev => {
                          const next = new Set(prev);
                          if (next.has(msg.id)) {
                            next.delete(msg.id);
                          } else {
                            next.add(msg.id);
                            setLikedMsgIds(l => {
                              const nl = new Set(l);
                              nl.delete(msg.id);
                              return nl;
                            });
                          }
                          return next;
                        })}
                        title={disliked ? "Disliked" : "Mark as bad"}
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: "pointer", borderRadius: 4,
                          display: "flex", alignItems: "center",
                          color: disliked ? "#e05252" : "var(--text-muted)",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={disliked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2-2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(msg.text);
                          setCopiedMsgId(msg.id);
                          setTimeout(() => setCopiedMsgId(null), 1500);
                        }}
                        title={copiedMsgId === msg.id ? "Copied!" : "Copy message"}
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: "pointer", borderRadius: 4, display: "flex", alignItems: "center",
                          color: copiedMsgId === msg.id ? "#218380" : "var(--text-muted)",
                        }}
                      >
                        {copiedMsgId === msg.id ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  );
                })()}

                {msg.sender === "user" && (() => {
                  const visible = hoveredMsgId === msg.id || copiedMsgId === msg.id;
                  return (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 4,
                      opacity: visible ? 1 : 0,
                      pointerEvents: visible ? "auto" : "none",
                      transition: "opacity 0.15s ease",
                    }}>
                      <button
                        onClick={() => {
                          if (activeThreadLoading) return;
                          handleSendMessage(msg.text);
                        }}
                        disabled={activeThreadLoading}
                        title="Retry — send this message again"
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: activeThreadLoading ? "not-allowed" : "pointer",
                          borderRadius: 4, display: "flex", alignItems: "center",
                          color: "var(--text-muted)",
                          opacity: activeThreadLoading ? 0.4 : 1,
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          setMessage(msg.text);
                        }}
                        title="Rewrite — edit this prompt"
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: "pointer",
                          borderRadius: 4, display: "flex", alignItems: "center",
                          color: "var(--text-muted)",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(msg.text);
                          setCopiedMsgId(msg.id);
                          setTimeout(() => setCopiedMsgId(null), 1500);
                        }}
                        title={copiedMsgId === msg.id ? "Copied!" : "Copy message"}
                        style={{
                          padding: 3, border: "none", background: "transparent",
                          cursor: "pointer", borderRadius: 4, display: "flex", alignItems: "center",
                          color: copiedMsgId === msg.id ? "#218380" : "var(--text-muted)",
                        }}
                      >
                        {copiedMsgId === msg.id ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          );
          })
        )}

        {activeThreadLoading && (
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
                      ts: Date.now(),
                    };
                    setChatLog(prev => capLog([...prev, sysMsg]));
                    invoke("send_message", {
                      agentId: agent.id,
                      message: sysMsg.text,
                      sessionId: agent.activeConversationId || null,
                    }).catch(e => console.warn("Auto-reply failed:", e));
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

      {queuedMessages.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12, padding: "0 10px" }}>
           <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-sub)", display: "flex", alignItems: "center", gap: 6 }}>
              <List size={14} /> Queued Tasks ({queuedMessages.length})
           </div>
           {queuedMessages.map((msg, i) => (
              <div key={i} style={{ 
                background: "var(--surface-base)", border: "1px solid var(--border-subtle)", 
                padding: "8px 12px", borderRadius: 8, fontSize: 12, color: "var(--text-main)",
                display: "flex", justifyContent: "space-between", alignItems: "center"
              }}>
                 <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginRight: 12 }}>
                   {msg.threadMode === "new" && <span style={{ background: "var(--primary-light, rgba(60,102,99,0.2))", color: "#3c6663", padding: "2px 6px", borderRadius: 4, marginRight: 8, fontSize: 10, fontWeight: 700 }}>NEW THREAD</span>}
                   {msg.text || (msg.attachments.length > 0 ? `[${msg.attachments.length} attachment${msg.attachments.length > 1 ? 's' : ''}]` : "Empty Message")}
                 </div>
                 <button 
                   onClick={() => setQueuedMessages(prev => prev.filter((_, idx) => idx !== i))}
                   style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center" }}
                 >
                   <X size={14} />
                 </button>
              </div>
           ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: attachments.length > 0 ? 8 : 16, alignItems: "flex-end", padding: "0 10px 10px 10px" }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={activeThreadLoading || !gatewayReady || agent.paused}
          title="Attach File or Screenshot"
          style={{
            padding: "14px", borderRadius: 14, border: "1px solid rgba(0,0,0,0.08)",
            background: "var(--glass-light)",
            color: "var(--text-main)",
            cursor: (activeThreadLoading || !gatewayReady || agent.paused) ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: (activeThreadLoading || !gatewayReady || agent.paused) ? 0.6 : 1,
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
              if ((message.trim() || attachments.length > 0) && gatewayReady && !agent.paused) {
                 if (activeThreadLoading) handleQueueMessage("same");
                 else handleSendMessage();
              }
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
          placeholder={agent.paused ? "Agent is paused — resume it to chat..." : !gatewayReady ? "Agents are waking up..." : activeThreadLoading ? "Type here to queue another task..." : `Talk to ${agent.name}... (Shift+Enter for new line, Paste for screenshot)`}
          disabled={!gatewayReady || agent.paused}
          rows={1}
          style={{
            flex: 1, padding: "14px 18px", borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.08)",
            background: "var(--glass-light)",
            fontSize: 13, fontFamily: "inherit", color: "var(--text-main)",
            outline: "none", opacity: (!gatewayReady || agent.paused) ? 0.6 : 1,
            resize: "vertical", minHeight: "46px", maxHeight: "200px", boxSizing: "border-box"
          }}
        />
        <div style={{ display: "flex", gap: 8, flexDirection: "row" }}>
          {activeThreadLoading && (
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
          )}

          {!activeThreadLoading ? (
            <button
              onClick={() => handleSendMessage()}
              disabled={(!message.trim() && attachments.length === 0) || !gatewayReady || agent.paused}
              title={agent.paused ? "Resume the agent to send messages" : !gatewayReady ? "Agents are waking up, please wait..." : undefined}
              style={{
                padding: "14px 20px", borderRadius: 14, border: "none",
                background: ((message.trim() || attachments.length > 0) && gatewayReady && !agent.paused) ? "#3c6663" : "var(--border-subtle)",
                color: ((message.trim() || attachments.length > 0) && gatewayReady && !agent.paused) ? "var(--surface-card)" : "var(--text-muted)",
                fontSize: 13, fontWeight: 600, cursor: ((message.trim() || attachments.length > 0) && gatewayReady && !agent.paused) ? "pointer" : "default",
                fontFamily: "inherit",
                transition: "all 0.15s ease",
                height: "46px"
              }}
            >{agent.paused ? "⏸" : !gatewayReady ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
                <path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
              </svg>
            ) : "Send"}</button>
          ) : (
            <>
               <button
                 onClick={() => handleQueueMessage("same")}
                 disabled={!message.trim() && attachments.length === 0}
                 style={{
                   padding: "14px 16px", borderRadius: 14, border: "none",
                   background: ((message.trim() || attachments.length > 0)) ? "#3c6663" : "var(--border-subtle)",
                   color: ((message.trim() || attachments.length > 0)) ? "#fff" : "var(--text-muted)",
                   fontSize: 13, fontWeight: 600, cursor: ((message.trim() || attachments.length > 0)) ? "pointer" : "default",
                   fontFamily: "inherit",
                   height: "46px", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap"
                 }}
               >
                 <List size={16} /> Queue
               </button>
               <button
                 onClick={() => handleQueueMessage("new")}
                 disabled={!message.trim() && attachments.length === 0}
                 title="Queue in a New Topic/Thread"
                 style={{
                   padding: "14px 16px", borderRadius: 14,
                   background: ((message.trim() || attachments.length > 0)) ? "var(--glass-light)" : "var(--border-subtle)",
                   color: ((message.trim() || attachments.length > 0)) ? "var(--text-main)" : "var(--text-muted)",
                   fontSize: 13, fontWeight: 600, cursor: ((message.trim() || attachments.length > 0)) ? "pointer" : "default",
                   fontFamily: "inherit", border: "1px solid rgba(0,0,0,0.08)",
                   height: "46px", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap"
                 }}
               >
                 <Plus size={16} /> New Thread
               </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        /* temp pulse override just to be safe */ /* @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>

      {/* Paused Overlay */}
      {agent.paused && (
        <div style={{
          position: "absolute",
          inset: 0,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
          ...glass(0.75),
        }}>
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            maxWidth: 400,
            gap: 16,
          }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(60, 102, 99, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#3c6663",
            }}>
              <Pause size={32} />
            </div>
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: 18, fontWeight: 700, color: "var(--text-main)" }}>Agent is Paused</h3>
              <p style={{ margin: 0, fontSize: 14, color: "var(--text-sub)", lineHeight: 1.5 }}>
                {agent.name} is currently sleeping and won't respond to messages.
              </p>
            </div>
            <button
              onClick={handleResume}
              style={{
                marginTop: 8,
                padding: "12px 24px",
                borderRadius: 12,
                background: "linear-gradient(135deg, #3c6663, #609995)",
                color: "var(--surface-card)",
                fontSize: 14,
                fontWeight: 700,
                border: "none",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(60, 102, 99, 0.3)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                transition: "transform 0.15s ease",
              }}
              onMouseOver={e => e.currentTarget.style.transform = "scale(1.03)"}
              onMouseOut={e => e.currentTarget.style.transform = "scale(1)"}
            >
              <Play size={16} fill="currentColor" /> Resume Agent
            </button>
          </div>
        </div>
      )}

      {/* Offline Overlay */}
      {agent.status === "error" && !agent.paused && gatewayReady && (
        <div style={{
          position: "absolute",
          inset: 0,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
          ...glass(0.85),
        }}>
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            maxWidth: 500,
            gap: 16,
            width: "100%",
          }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(229, 115, 115, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#E57373",
            }}>
              <AlertTriangle size={32} />
            </div>
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: 18, fontWeight: 700, color: "var(--text-main)" }}>Agent is Offline</h3>
              <p style={{ margin: 0, fontSize: 14, color: "var(--text-sub)", lineHeight: 1.5 }}>
                {agent.name}'s workspace stopped unexpectedly. Try repairing the gateway, or perform a hard reset if it keeps failing.
              </p>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <button
                onClick={handleRepair}
                disabled={isRepairing || hardResetting}
                style={{
                  padding: "10px 20px",
                  borderRadius: 10,
                  background: "#3c6663",
                  color: "var(--surface-card)",
                  fontSize: 13,
                  fontWeight: 600,
                  border: "none",
                  cursor: (isRepairing || hardResetting) ? "not-allowed" : "pointer",
                  opacity: (isRepairing || hardResetting) ? 0.6 : 1,
                  transition: "all 0.2s ease",
                  whiteSpace: "nowrap"
                }}
              >
                {isRepairing ? "Repairing..." : "Repair Gateway"}
              </button>
              <button
                onClick={handleHardReset}
                disabled={isRepairing || hardResetting}
                style={{
                  padding: "10px 20px",
                  borderRadius: 10,
                  background: "transparent",
                  color: "#E57373",
                  fontSize: 13,
                  fontWeight: 600,
                  border: "1px solid #E57373",
                  cursor: (isRepairing || hardResetting) ? "not-allowed" : "pointer",
                  opacity: (isRepairing || hardResetting) ? 0.6 : 1,
                  transition: "all 0.2s ease",
                  whiteSpace: "nowrap"
                }}
              >
                {hardResetting ? "Resetting..." : "Hard Reset"}
              </button>
            </div>
            {repairLog && (
              <div style={{
                padding: 16,
                borderRadius: 12,
                background: repairSucceeded === true ? "rgba(52,211,153,0.07)" : repairSucceeded === false ? "rgba(229,115,115,0.08)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${repairSucceeded === true ? "rgba(52,211,153,0.25)" : repairSucceeded === false ? "rgba(229,115,115,0.3)" : "rgba(0,0,0,0.1)"}`,
                color: repairSucceeded === true ? "#1a6b52" : repairSucceeded === false ? "#c62828" : "var(--text-sub)",
                fontSize: 11,
                marginTop: 8,
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
                maxHeight: 180,
                width: "100%",
                overflowY: "auto",
                lineHeight: 1.5,
                textAlign: "left",
              }}>
                {repairLog}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Waking Up Overlay removed to prevent blocking user input. Status is visible in the header. */}
    </div>
  );
}
