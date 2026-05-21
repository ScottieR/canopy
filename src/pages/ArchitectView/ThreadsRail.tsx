// ThreadsRail — left rail on the agent view showing this agent's conversation history.
// Two sections: Forums (multi-agent projects) and Messages (direct 1:1 chats).

import React, { useEffect, useRef, useState } from "react";
import { useWorldStore, AgentData, Conversation } from "../../store/worldStore";
import { MessageSquare, Archive, Search, X, ChevronRight, ChevronLeft, ChevronDown, Trash2, Edit2, Users } from "lucide-react";

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
  const [open, setOpen] = useState<boolean>(() => sessionStorage.getItem("canopy:threadsRail") !== "closed");
  useEffect(() => {
    sessionStorage.setItem("canopy:threadsRail", open ? "open" : "closed");
  }, [open]);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [forumsExpanded, setForumsExpanded] = useState(true);
  const [messagesExpanded, setMessagesExpanded] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const saveCurrentThread = useWorldStore(s => s.saveCurrentThread);
  const setActiveView = useWorldStore(s => s.setActiveView);
  const switchConversation = useWorldStore(s => s.switchConversation);
  const renameConversation = useWorldStore(s => s.renameConversation);
  const deleteConversation = useWorldStore(s => s.deleteConversation);

  const sortedConversations: Conversation[] = [...(agent.conversations || [])]
    .filter(c => c.status !== "archived")
    // Hide system-use sessions (prefixed _sys_) — these are internal app calls
    // like project assessment that should never appear in the user-facing history.
    .filter(c => !c.id?.startsWith("_sys_"))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

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

  const forums = filteredConversations.filter(c => c.conv.type === "project");
  const messages = filteredConversations.filter(c => !c.conv.type || c.conv.type === "dm");

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
    if (confirm("Delete this? It can't be recovered.")) {
      deleteConversation(agent.id, convId);
    }
  };

  const renderRow = ({ conv, matchedMessage }: FilteredConv) => {
    const isActive = conv.id === agent.activeConversationId;
    const isRenaming = renaming === conv.id;
    const isForum = conv.type === "project";

    return (
      <div
        key={conv.id}
        onClick={() => !isRenaming && switchConversation(agent.id, conv.id)}
        style={{
          display: "flex", alignItems: "flex-start", gap: 8,
          padding: "7px 12px", cursor: isRenaming ? "default" : "pointer",
          background: isActive ? "rgba(60,102,99,0.07)" : "transparent",
          borderLeft: isActive ? "2px solid #3c6663" : "2px solid transparent",
          transition: "all 0.1s",
        }}
        onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--surface-base)"; }}
        onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ paddingTop: 2, color: isActive ? "#3c6663" : "var(--text-muted)" }}>
          {isForum ? <Users size={13} /> : <MessageSquare size={13} />}
        </div>
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
                width: "100%", padding: "2px 4px", border: "1px solid #3c6663",
                borderRadius: 4, fontSize: 12, outline: "none",
                background: "var(--surface-card)", color: "var(--text-main)",
                fontFamily: "inherit",
              }}
            />
          ) : (
            <>
              <div style={{
                fontSize: 12, fontWeight: isActive ? 700 : 500,
                color: isActive ? "var(--text-main)" : "var(--text-sub)",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>{conv.title}</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>
                {formatRelative(conv.lastActiveAt)}
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
          <div className="row-actions" style={{ display: "flex", gap: 2, opacity: 0, flexShrink: 0, transition: "opacity 0.1s" }}>
            <button
              onClick={(e) => startRename(conv, e)}
              title="Rename"
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: 3, borderRadius: 4, display: "flex", color: "var(--text-sub)" }}
            >
              <Edit2 size={11} />
            </button>
            <button
              onClick={(e) => handleDelete(conv.id, e)}
              title="Delete"
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: 3, borderRadius: 4, display: "flex", color: "var(--text-muted)" }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
        <style>{`
          div:hover > .row-actions { opacity: 1 !important; }
        `}</style>
      </div>
    );
  };

  // ── Collapsed state ──────────────────────────────────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Show history"
        style={{
          width: 36, flexShrink: 0, border: "1px solid var(--border-subtle)",
          borderRadius: 12, background: "var(--surface-card)", cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
          padding: "12px 0", gap: 12, color: "var(--text-sub)", fontFamily: "inherit",
        }}
      >
        <ChevronRight size={16} />
        <MessageSquare size={14} />
        {sortedConversations.length > 0 && (
          <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text-sub)", writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            {sortedConversations.length}
          </div>
        )}
      </button>
    );
  }

  // ── Expanded state ───────────────────────────────────────────────────────────
  return (
    <div style={{
      width: 240, flexShrink: 0, display: "flex", flexDirection: "column",
      background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
      borderRadius: 14, overflow: "hidden", minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)",
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)" }}>History</span>
        <button
          onClick={() => setOpen(false)}
          title="Hide"
          style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-sub)", padding: 2 }}
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* Quick actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "16px 12px 12px" }}>
        <button
          onClick={() => saveCurrentThread(agent.id)}
          style={{
            padding: "8px", borderRadius: 8, border: "1px solid var(--border-subtle)",
            background: "transparent", color: "var(--text-sub)", fontSize: 12, fontWeight: 600,
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6
          }}
        >
          <MessageSquare size={11} /> + Message
        </button>
        <button
          onClick={() => setActiveView("forum")}
          style={{
            padding: "8px", borderRadius: 8, border: "1px solid var(--border-subtle)",
            background: "var(--surface-sunken)", color: "var(--text-sub)", fontSize: 12, fontWeight: 600,
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6
          }}
        >
          <Users size={11} /> + Project
        </button>
      </div>

      {/* Search */}
      {sortedConversations.length > 2 && (
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 6 }}>
          <Search size={12} color="var(--text-sub)" />
          <input
            ref={searchInputRef} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape" && query) setQuery(""); }}
            placeholder="Search…"
            style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontSize: 11, color: "var(--text-main)", fontFamily: "inherit", padding: "2px 0" }}
          />
          {query && (
            <button onClick={() => setQuery("")} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}>
              <X size={11} />
            </button>
          )}
        </div>
      )}

      {/* Lists */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {sortedConversations.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 8 }}><MessageSquare size={24} /></div>
            <span style={{ opacity: 0.7 }}>Start a message or project above.</span>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
            Nothing matches "{query}".
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>

            {/* Projects section */}
            {forums.length > 0 && (
              <div style={{ padding: "0 8px 16px" }}>
                <div
                  onClick={() => setForumsExpanded(!forumsExpanded)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", cursor: "pointer",
                    color: "var(--text-muted)", fontSize: 10, fontWeight: 700, letterSpacing: "0.05em"
                  }}
                >
                  {forumsExpanded
                    ? <ChevronDown size={12} style={{ marginLeft: -4 }} />
                    : <ChevronRight size={12} style={{ marginLeft: -4 }} />}
                  <span style={{ flex: 1 }}>
                    PROJECTS · {forums.length}
                  </span>
                </div>
                {forumsExpanded && forums.map(renderRow)}
              </div>
            )}

            {/* Messages section */}
            {messages.length > 0 && (
              <div>
                <button
                  onClick={() => setMessagesExpanded(!messagesExpanded)}
                  style={{
                    display: "flex", alignItems: "center", width: "100%", padding: "8px 12px 4px",
                    background: "none", border: "none", cursor: "pointer", gap: 5,
                  }}
                >
                  {messagesExpanded
                    ? <ChevronDown size={11} color="var(--text-muted)" />
                    : <ChevronRight size={11} color="var(--text-muted)" />}
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Messages · {messages.length}
                  </span>
                </button>
                {messagesExpanded && messages.map(renderRow)}
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
}
