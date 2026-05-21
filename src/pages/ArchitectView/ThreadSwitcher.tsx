// ThreadSwitcher — dropdown in the Home header that lets the user move between
// saved conversation threads with this agent, and start fresh ones.
//
// Frontend-only V1 caveat: threads are visual snapshots, not true context
// isolation. The agent's backend memory is still pooled. Switching threads
// changes what you see, but the agent's working memory still includes prior
// conversations. Real isolation requires per-conversation backend support —
// see the comment in worldStore.ts for the migration path.

import React, { useEffect, useRef, useState } from "react";
import { useWorldStore, AgentData, Conversation } from "../../store/worldStore";

// Pretty relative time for the dropdown rows (e.g. "2h ago", "yesterday").
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

export function ThreadSwitcher({ agent }: { agent: AgentData }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Search across thread titles AND message text. High-value case: the user
  // remembers the topic ("pricing strategy") but not the auto-generated title.
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click. We bind on capture so an internal handler doesn't
  // race the close (e.g. clicking a thread row should switch AND close).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setRenaming(null);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Auto-focus the search input on open. Slight delay so the dropdown is
  // mounted before we try to focus.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const saveCurrentThread = useWorldStore(s => s.saveCurrentThread);
  const switchConversation = useWorldStore(s => s.switchConversation);
  const renameConversation = useWorldStore(s => s.renameConversation);
  const deleteConversation = useWorldStore(s => s.deleteConversation);

  // Build the sorted list — newest activity first, plus an "Active draft"
  // marker for the in-progress chat that hasn't been saved yet.
  const sortedConversations: Conversation[] = [...(agent.conversations || [])]
    .filter(c => !c.id?.startsWith("_sys_")) // hide internal system sessions
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  // Filter by search query. We match on title AND message text — users often
  // remember what they discussed without remembering the auto-generated title.
  // Per-row we also surface a "matched in message N" hint so it's obvious
  // why a thread showed up.
  const q = query.trim().toLowerCase();
  type FilteredConv = { conv: Conversation; matchedMessage?: string };
  const filteredConversations: FilteredConv[] = !q
    ? sortedConversations.map(c => ({ conv: c }))
    : sortedConversations.flatMap(c => {
        const titleMatch = c.title.toLowerCase().includes(q);
        // Walk messages once, find the first that contains the query — we
        // surface that snippet so the user can see why this thread matched.
        const matchedMsg = c.messages.find(m => m.text.toLowerCase().includes(q));
        if (!titleMatch && !matchedMsg) return [];
        // Snippet around the match (max ~80 chars centered on the hit) so
        // the row stays scannable.
        let snippet: string | undefined;
        if (matchedMsg && !titleMatch) {
          const idx = matchedMsg.text.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 30);
          const end = Math.min(matchedMsg.text.length, idx + q.length + 40);
          snippet = (start > 0 ? "…" : "") + matchedMsg.text.slice(start, end) + (end < matchedMsg.text.length ? "…" : "");
        }
        return [{ conv: c, matchedMessage: snippet }];
      });

  // Label for the current thread: either the active conversation's title or
  // a synthetic "Current chat" / "New chat" depending on whether the chat
  // has any messages yet.
  const activeConv = agent.activeConversationId
    ? sortedConversations.find(c => c.id === agent.activeConversationId)
    : null;
  const currentLabel = activeConv
    ? activeConv.title
    : (agent.chatLog && agent.chatLog.length > 0 ? "Current chat" : "New chat");

  const handleNew = () => {
    saveCurrentThread(agent.id);  // Idempotent — no-op if nothing to save
    setOpen(false);
  };

  const handleSwitch = (convId: string) => {
    switchConversation(agent.id, convId);
    setOpen(false);
  };

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

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch between conversation threads"
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 10px", border: "1px solid var(--border-subtle)",
          borderRadius: 8, background: open ? "var(--surface-base)" : "transparent",
          color: "var(--text-sub)", fontSize: 11, fontWeight: 600,
          cursor: "pointer", fontFamily: "inherit", maxWidth: 200,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{currentLabel}</span>
        {sortedConversations.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500 }}>
            · {sortedConversations.length}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0,
          minWidth: 320, maxWidth: 380,
          background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
          borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.10)",
          zIndex: 100, overflow: "hidden",
        }}>
          {/* Search input — hidden when there are zero saved threads to keep
              first-run noise down. Matches title AND message content. */}
          {sortedConversations.length > 0 && (
            <div style={{
              padding: "8px 10px", borderBottom: "1px solid var(--border-subtle)",
              display: "flex", alignItems: "center", gap: 8,
              background: "var(--surface-base)",
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-sub)", flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                ref={searchInputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") {
                    if (query) setQuery(""); else { setOpen(false); }
                  }
                }}
                placeholder="Search threads…"
                style={{
                  flex: 1, border: "none", background: "transparent",
                  outline: "none", fontSize: 12, color: "var(--text-main)",
                  fontFamily: "inherit",
                }}
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  title="Clear search"
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              )}
            </div>
          )}

          {/* New thread row — always present at the top, but only shown when
              the user isn't actively searching (otherwise they're scanning
              results, not starting fresh). */}
          {!q && (
            <button
              onClick={handleNew}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "10px 14px", border: "none",
                background: "transparent", cursor: "pointer", textAlign: "left",
                fontFamily: "inherit", borderBottom: "1px solid var(--border-subtle)",
                color: "var(--text-main)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#3c6663" }}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Start a new thread</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 2 }}>
                  Save the current chat and reset
                </div>
              </div>
            </button>
          )}

          {/* Thread list. Each row: title (or rename input), age, hover-revealed
              rename + delete buttons. When searching, rows also show a snippet
              of the matched message text. */}
          {sortedConversations.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
              No saved threads yet. Threads appear here once you start new ones.
            </div>
          ) : filteredConversations.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
              No threads match "{query}". Try fewer words.
            </div>
          ) : (
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {filteredConversations.map(({ conv, matchedMessage }) => {
                const isActive = conv.id === agent.activeConversationId;
                const isRenaming = renaming === conv.id;
                return (
                  <div
                    key={conv.id}
                    onClick={() => !isRenaming && handleSwitch(conv.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "10px 14px", cursor: isRenaming ? "default" : "pointer",
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
                            width: "100%", padding: "4px 8px", border: "1px solid #3c6663",
                            borderRadius: 6, fontSize: 12, outline: "none",
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
                            {conv.messages.length} message{conv.messages.length === 1 ? "" : "s"} · {formatRelative(conv.lastActiveAt)}
                            {isActive && <span style={{ color: "#3c6663", fontWeight: 600, marginLeft: 6 }}>· active</span>}
                          </div>
                          {/* Match snippet — shown only when the row matched
                              via message content (not title). Gives the user a
                              visible reason this thread surfaced. */}
                          {matchedMessage && (
                            <div style={{
                              fontSize: 10, color: "var(--text-muted)", marginTop: 4,
                              padding: "4px 8px", background: "rgba(33,131,128,0.06)",
                              borderRadius: 4, fontStyle: "italic",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                              lineHeight: 1.4,
                            }}>{matchedMessage}</div>
                          )}
                        </>
                      )}
                    </div>
                    {!isRenaming && (
                      <div style={{ display: "flex", gap: 4, opacity: 0.7 }}>
                        <button
                          onClick={(e) => startRename(conv, e)}
                          title="Rename"
                          style={{
                            border: "none", background: "transparent", cursor: "pointer",
                            padding: 4, borderRadius: 4, display: "flex",
                            color: "var(--text-sub)",
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button
                          onClick={(e) => handleDelete(conv.id, e)}
                          title="Delete thread"
                          style={{
                            border: "none", background: "transparent", cursor: "pointer",
                            padding: 4, borderRadius: 4, display: "flex",
                            color: "var(--text-muted)",
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer — gentle reminder about the V1 caveat without alarm. */}
          <div style={{
            padding: "8px 14px", fontSize: 10, color: "var(--text-muted)",
            borderTop: "1px solid var(--border-subtle)", lineHeight: 1.5,
          }}>
            Threads are saved in your browser. {agent.name}'s memory of past chats stays the same across threads.
          </div>
        </div>
      )}
    </div>
  );
}
