// ThreadsRail — left rail on Home showing the agent's saved chat threads.
//
// Replaces both the old workspace-files left rail and the ThreadSwitcher
// header dropdown — threads are now first-class on Home, not a side concern.
// "+ New chat" lives at the top of the rail; search filters by title and
// message content; click to switch; hover for rename/delete.
//
// Frontend-only V1 caveat (same as before): threads partition the visible
// chat, but the agent's underlying SQLite memory is still pooled across
// threads. True isolation requires per-conversation backend support.

import React, { useEffect, useRef, useState } from "react";
import { useWorldStore, AgentData, Conversation } from "../../store/worldStore";

function formatRelative(unixMs: number): string {
  if (!unixMs) return "";
  const delta = Math.floor((Date.now() - unixMs) / 1000);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 2) return "yesterday";
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(unixMs).toLocaleDateString();
}

export function ThreadsRail({ agent }: { agent: AgentData }) {
  // Open/closed preference persists across agent switches in this session.
  // Default to OPEN — threads are now the primary side surface and need
  // visibility on first load.
  const [open, setOpen] = useState<boolean>(() => sessionStorage.getItem("canopy:threadsRail") !== "closed");
  useEffect(() => {
    sessionStorage.setItem("canopy:threadsRail", open ? "open" : "closed");
  }, [open]);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const saveCurrentThread = useWorldStore(s => s.saveCurrentThread);
  const switchConversation = useWorldStore(s => s.switchConversation);
  const renameConversation = useWorldStore(s => s.renameConversation);
  const deleteConversation = useWorldStore(s => s.deleteConversation);

  // Sort newest activity first.
  const sortedConversations: Conversation[] = [...(agent.conversations || [])]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  // Search across title AND message content. Surface a match snippet so the
  // user sees why a thread surfaced when it doesn't match by title.
  const q = query.trim().toLowerCase();
  type FilteredConv = { conv: Conversation; matchedMessage?: string };
  const filteredConversations: FilteredConv[] = !q
    ? sortedConversations.map(c => ({ conv: c }))
    : sortedConversations.flatMap(c => {
        const titleMatch = c.title.toLowerCase().includes(q);
        const matchedMsg = c.messages.find(m => m.text.toLowerCase().includes(q));
        if (!titleMatch && !matchedMsg) return [];
        let snippet: string | undefined;
        if (matchedMsg && !titleMatch) {
          const idx = matchedMsg.text.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 30);
          const end = Math.min(matchedMsg.text.length, idx + q.length + 40);
          snippet = (start > 0 ? "…" : "") + matchedMsg.text.slice(start, end) + (end < matchedMsg.text.length ? "…" : "");
        }
        return [{ conv: c, matchedMessage: snippet }];
      });

  const startRename = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenaming(conv.id);
    setRenameValue(conv.title);
  };
  const commitRename = () => {
    if (renaming && renameValue.trim()) {
      renameConversation(agent.id, renaming, renameValue.trim());
    }
    setRenaming(null);
  };
  const handleDelete = (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this thread? It can't be recovered.")) {
      deleteConversation(agent.id, convId);
    }
  };

  // Collapsed state — slim vertical strip with an expand chevron + thread count.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Show chat threads"
        style={{
          width: 36, flexShrink: 0, border: "1px solid var(--border-subtle)",
          borderRadius: 12, background: "var(--surface-card)", cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
          padding: "12px 0", gap: 12, color: "var(--text-sub)", fontFamily: "inherit",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        {sortedConversations.length > 0 && (
          <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text-sub)", writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            {sortedConversations.length} thread{sortedConversations.length === 1 ? "" : "s"}
          </div>
        )}
      </button>
    );
  }

  return (
    <div style={{
      width: 260, flexShrink: 0, display: "flex", flexDirection: "column",
      background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
      borderRadius: 14, overflow: "hidden", minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-sub)" }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)" }}>Chats</span>
          {sortedConversations.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500 }}>
              {sortedConversations.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setOpen(false)}
          title="Hide"
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            color: "var(--text-sub)", display: "flex", alignItems: "center", padding: 2,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>

      {/* + New chat button — always pinned at the top, prominent. Clicking
          this saves the current chat as a new thread (or flushes the active
          thread) and resets the chat. The same store action the old "New
          conversation" quick-action pill used. */}
      <button
        onClick={() => saveCurrentThread(agent.id)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "10px 12px", border: "none",
          background: "rgba(60,102,99,0.06)", cursor: "pointer", textAlign: "left",
          fontFamily: "inherit", borderBottom: "1px solid var(--border-subtle)",
          color: "#218380", fontSize: 12, fontWeight: 700,
        }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(60,102,99,0.12)"}
        onMouseLeave={e => e.currentTarget.style.background = "rgba(60,102,99,0.06)"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New chat
      </button>

      {/* Search — only when there's something to search through. */}
      {sortedConversations.length > 0 && (
        <div style={{
          padding: "6px 10px", borderBottom: "1px solid var(--border-subtle)",
          display: "flex", alignItems: "center", gap: 6, background: "var(--surface-base)",
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-sub)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={searchInputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape" && query) setQuery(""); }}
            placeholder="Search chats…"
            style={{
              flex: 1, border: "none", background: "transparent",
              outline: "none", fontSize: 11, color: "var(--text-main)",
              fontFamily: "inherit", padding: "2px 0",
            }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear search"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      )}

      {/* Thread list. Each row: title (or rename input), age, hover-revealed
          rename + delete buttons. When searching, rows also show a snippet
          of the matched message text. */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {sortedConversations.length === 0 ? (
          <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--text-sub)" }}>No saved chats yet.</strong> Click <strong>New chat</strong> above
            to save your current conversation and start fresh.
          </div>
        ) : filteredConversations.length === 0 ? (
          <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
            No chats match "{query}". Try fewer words.
          </div>
        ) : (
          filteredConversations.map(({ conv, matchedMessage }) => {
            const isActive = conv.id === agent.activeConversationId;
            const isRenaming = renaming === conv.id;
            return (
              <div
                key={conv.id}
                onClick={() => !isRenaming && switchConversation(agent.id, conv.id)}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 6,
                  padding: "10px 12px", cursor: isRenaming ? "default" : "pointer",
                  background: isActive ? "rgba(60,102,99,0.07)" : "transparent",
                  borderBottom: "1px solid rgba(0,0,0,0.03)",
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--surface-base)"; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      style={{
                        width: "100%", padding: "3px 6px", border: "1px solid #3c6663",
                        borderRadius: 5, fontSize: 12, outline: "none",
                        background: "var(--surface-card)", color: "var(--text-main)",
                        fontFamily: "inherit",
                      }}
                    />
                  ) : (
                    <>
                      <div style={{
                        fontSize: 12, fontWeight: isActive ? 700 : 600,
                        color: "var(--text-main)", whiteSpace: "nowrap",
                        overflow: "hidden", textOverflow: "ellipsis",
                      }}>{conv.title}</div>
                      <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 2 }}>
                        {conv.messages.length} msg{conv.messages.length === 1 ? "" : "s"} · {formatRelative(conv.lastActiveAt)}
                        {isActive && <span style={{ color: "#3c6663", fontWeight: 600, marginLeft: 4 }}>· active</span>}
                      </div>
                      {matchedMessage && (
                        <div style={{
                          fontSize: 10, color: "var(--text-muted)", marginTop: 4,
                          padding: "3px 6px", background: "rgba(33,131,128,0.06)",
                          borderRadius: 4, fontStyle: "italic",
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          lineHeight: 1.4,
                        }}>{matchedMessage}</div>
                      )}
                    </>
                  )}
                </div>
                {!isRenaming && (
                  <div style={{ display: "flex", gap: 2, opacity: 0.7, flexShrink: 0 }}>
                    <button
                      onClick={(e) => startRename(conv, e)}
                      title="Rename"
                      style={{ border: "none", background: "transparent", cursor: "pointer", padding: 3, borderRadius: 4, display: "flex", color: "var(--text-sub)" }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button
                      onClick={(e) => handleDelete(conv.id, e)}
                      title="Delete thread"
                      style={{ border: "none", background: "transparent", cursor: "pointer", padding: 3, borderRadius: 4, display: "flex", color: "var(--text-muted)" }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer caveat — gentle reminder that thread memory is local-only,
          not a true backend reset. */}
      <div style={{
        padding: "8px 12px", fontSize: 10, color: "var(--text-muted)",
        borderTop: "1px solid var(--border-subtle)", lineHeight: 1.5,
      }}>
        Threads are saved in your browser. {agent.name}'s memory of past chats stays the same across threads.
      </div>
    </div>
  );
}
