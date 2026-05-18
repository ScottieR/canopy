import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useForumStore, Milestone, Forum, ForumBlock } from "../../store/forumStore";
import { useWorldStore } from "../../store/worldStore";
import { ForumStage } from "./ForumStage";
import { ForumThread } from "./ForumThread";
import { createForumOrchestrator } from "./forumOrchestrator";
import { ForumBriefModal } from "./ForumBriefModal";

// ─── Progress Spine ───────────────────────────────────────────────────────────

function ProgressSpine({ milestones }: { milestones: Milestone[] }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))", flexShrink: 0 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.07em", color: "var(--text-sub, #636E72)",
        opacity: 0.6, marginBottom: 10,
      }}>
        Progress
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {milestones.map((ms, i) => (
          <div key={ms.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", paddingBottom: i < milestones.length - 1 ? 12 : 0, position: "relative" }}>
            {/* Connector line */}
            {i < milestones.length - 1 && (
              <div style={{
                position: "absolute", left: 9, top: 20, bottom: -1, width: 1,
                background: ms.status === "done" ? "#4A9E96" : "var(--border-subtle, rgba(0,0,0,0.1))",
                transition: "background 0.4s ease",
              }} />
            )}

            {/* Dot */}
            <div style={{
              width: 18, height: 18, borderRadius: "50%", flexShrink: 0, marginTop: 1,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: ms.status === "done" ? "#4A9E96" : "transparent",
              border: ms.status === "done"
                ? "2px solid #4A9E96"
                : ms.status === "active"
                  ? "2px solid #4A9E96"
                  : "2px solid var(--border-strong, rgba(0,0,0,0.15))",
              boxShadow: ms.status === "active"
                ? "0 0 0 4px rgba(74,158,150,0.12), 0 0 12px rgba(74,158,150,0.2)"
                : "none",
              transition: "all 0.3s ease",
              animation: ms.status === "active" ? "milestone-pulse 2s ease-in-out infinite" : "none",
            }}>
              {ms.status === "done" && (
                <svg width={9} height={9} viewBox="0 0 9 9" fill="none">
                  <polyline points="1.5,4.5 3.5,6.5 7.5,2.5" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {ms.status === "active" && (
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4A9E96" }} />
              )}
            </div>

            {/* Label */}
            <div style={{
              fontSize: 12, lineHeight: 1.4, paddingTop: 1,
              color: ms.status === "done"
                ? "var(--text-sub, #636E72)"
                : ms.status === "active"
                  ? "var(--text-main, #303330)"
                  : "var(--text-sub, #636E72)",
              opacity: ms.status === "pending" ? 0.4 : ms.status === "done" ? 0.65 : 1,
              transition: "all 0.3s ease",
            }}>
              {ms.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Team Roster ──────────────────────────────────────────────────────────────

function TeamRoster({ forum }: { forum: ReturnType<typeof useForumStore.getState>["forums"][0] }) {
  const isActive = (action?: string) =>
    action && !action.includes("✓") && action !== "Reading brief…" && forum.status === "active";

  return (
    <div style={{ padding: "14px 16px", flexShrink: 0 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.07em", color: "var(--text-sub, #636E72)",
        opacity: 0.6, marginBottom: 10,
      }}>
        Team
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {forum.agents.map(agent => {
          const color = agent.robeColor || "#4A9E96";
          const busy = isActive(agent.currentAction);
          const done = agent.currentAction?.includes("✓");
          const statusText = agent.currentAction || agent.forumRole;

          return (
            <div key={agent.agentId} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "7px 10px",
              borderRadius: 10,
              background: busy ? `${color}12` : "rgba(0,0,0,0.02)",
              border: busy ? `1px solid ${color}40` : "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
              transition: "all 0.4s ease",
            }}>
              {/* Avatar with live pulse ring */}
              <div style={{ position: "relative", flexShrink: 0 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: `${color}22`,
                  border: `1.5px solid ${color}${busy ? "88" : "44"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 700, color,
                  transition: "border-color 0.3s ease",
                }}>
                  {agent.name.charAt(0).toUpperCase()}
                </div>
                {/* Status dot */}
                <div style={{
                  position: "absolute", bottom: -1, right: -1,
                  width: 8, height: 8, borderRadius: "50%",
                  background: busy ? color : done ? "#4A9E96" : "rgba(0,0,0,0.12)",
                  border: "1.5px solid var(--surface-container-low, #f4f4f0)",
                  animation: busy ? "milestone-pulse 1.8s ease-in-out infinite" : "none",
                  transition: "background 0.3s ease",
                }} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main, #303330)" }}>
                  {agent.name}
                </div>
                <div style={{
                  fontSize: 10, marginTop: 1,
                  color: busy ? color : "var(--text-sub, #636E72)",
                  opacity: busy ? 0.85 : 0.55,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  transition: "color 0.3s ease",
                }}>
                  {statusText}
                </div>
              </div>

              {/* Confidence bar */}
              <div style={{ flexShrink: 0, width: 28 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color, textAlign: "right" }}>
                  {agent.confidence}%
                </div>
                <div style={{ height: 2, borderRadius: 2, marginTop: 2, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 2, background: color, width: `${agent.confidence}%`, transition: "width 0.5s ease" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Forum Actions (archive / delete) ────────────────────────────────────────

function ForumActions({
  forum,
  onArchive,
  onDelete,
}: {
  forum: Forum;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => { setOpen(o => !o); setConfirmDelete(false); }}
        title="Forum options"
        style={{
          width: 28, height: 28, borderRadius: 8, border: "1px solid var(--border-subtle, rgba(0,0,0,0.09))",
          background: open ? "var(--border-subtle, rgba(0,0,0,0.06))" : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", color: "var(--text-sub, #636E72)", transition: "all 0.15s ease",
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0,
          background: "var(--surface-card, #fff)",
          border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
          borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
          minWidth: 160, zIndex: 50, overflow: "hidden", padding: "4px 0",
        }}>
          {/* Archive */}
          {forum.status !== "archived" && (
            <button
              onClick={() => { onArchive(); setOpen(false); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 9,
                padding: "9px 14px", border: "none", background: "transparent",
                cursor: "pointer", fontSize: 12, color: "var(--text-main, #303330)",
                fontFamily: "inherit", textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-container-low, #f4f4f0)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/>
                <line x1="10" y1="12" x2="14" y2="12"/>
              </svg>
              Archive forum
            </button>
          )}

          {/* Divider */}
          <div style={{ height: 1, background: "var(--border-subtle, rgba(0,0,0,0.06))", margin: "4px 0" }} />

          {/* Delete / Confirm */}
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 9,
                padding: "9px 14px", border: "none", background: "transparent",
                cursor: "pointer", fontSize: 12, color: "#EF4444",
                fontFamily: "inherit", textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(239,68,68,0.06)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4h6v2"/>
              </svg>
              Delete forum
            </button>
          ) : (
            <div style={{ padding: "8px 14px" }}>
              <div style={{ fontSize: 11, color: "var(--text-sub, #636E72)", marginBottom: 8 }}>
                Delete permanently?
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => { onDelete(); setOpen(false); }}
                  style={{
                    flex: 1, padding: "5px 0", borderRadius: 7, fontSize: 11, fontWeight: 600,
                    background: "#EF4444", color: "#fff", border: "none", cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{
                    flex: 1, padding: "5px 0", borderRadius: 7, fontSize: 11,
                    background: "var(--border-subtle, rgba(0,0,0,0.06))", color: "var(--text-sub, #636E72)",
                    border: "none", cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inline Tag Editor ────────────────────────────────────────────────────────

function InlineTagEditor({
  tags,
  onUpdate,
}: {
  tags: string[];
  onUpdate: (tags: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed || tags.includes(trimmed)) { setDraft(""); return; }
    onUpdate([...tags, trimmed]);
    setDraft("");
  };

  const removeTag = (tag: string) => onUpdate(tags.filter(t => t !== tag));

  useEffect(() => {
    if (editing) setTimeout(() => inputRef.current?.focus(), 60);
  }, [editing]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      {tags.slice(0, 4).map(tag => (
        <div
          key={tag}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            fontSize: 10, padding: "2px 8px", borderRadius: 12,
            background: "rgba(74,158,150,0.1)",
            border: "1px solid rgba(74,158,150,0.2)",
            color: "#4A9E96",
          }}
        >
          {tag}
          <button
            onClick={() => removeTag(tag)}
            title="Remove tag"
            style={{
              background: "none", border: "none", padding: 0, cursor: "pointer",
              color: "#4A9E96", opacity: 0.5, lineHeight: 1, fontSize: 11,
              display: "flex", alignItems: "center",
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "0.5")}
          >
            ×
          </button>
        </div>
      ))}

      {/* Add tag input */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(draft); }
            if (e.key === "Escape") { setEditing(false); setDraft(""); }
          }}
          onBlur={() => { if (draft.trim()) addTag(draft); setEditing(false); }}
          placeholder="Add tag…"
          style={{
            width: 80, fontSize: 10, padding: "2px 7px",
            borderRadius: 12, border: "1px solid rgba(74,158,150,0.4)",
            background: "transparent", color: "#4A9E96",
            outline: "none", fontFamily: "inherit",
          }}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          title="Add tag"
          style={{
            fontSize: 10, padding: "2px 6px", borderRadius: 12,
            border: "1px dashed rgba(74,158,150,0.3)",
            background: "transparent", color: "rgba(74,158,150,0.55)",
            cursor: "pointer", fontFamily: "inherit",
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "")}
        >
          + tag
        </button>
      )}
    </div>
  );
}

// ─── Add-Agent Picker ─────────────────────────────────────────────────────────

function AddAgentPicker({
  forum,
  onClose,
}: {
  forum: Forum;
  onClose: () => void;
}) {
  const allAgents = useWorldStore(s => s.agents);
  const addAgentToForum = useForumStore(s => s.addAgentToForum);
  const ref = useRef<HTMLDivElement>(null);

  // Agents not already in the forum
  const existingIds = new Set(forum.agents.map(a => a.agentId));
  const available = allAgents.filter(a => !existingIds.has(a.id));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  if (available.length === 0) {
    return (
      <div ref={ref} style={{
        position: "absolute", top: "calc(100% + 8px)", right: 0,
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
        borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
        padding: "14px 16px", zIndex: 50, minWidth: 200,
        fontSize: 12, color: "var(--text-sub, #636E72)",
      }}>
        All agents are already in this forum.
      </div>
    );
  }

  return (
    <div ref={ref} style={{
      position: "absolute", top: "calc(100% + 8px)", right: 0,
      background: "var(--surface-card, #fff)",
      border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
      borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
      zIndex: 50, minWidth: 220, overflow: "hidden",
      padding: "6px 0",
    }}>
      <div style={{
        padding: "8px 14px 6px",
        fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.07em", color: "var(--text-sub, #636E72)", opacity: 0.5,
      }}>
        Add to forum
      </div>
      {available.map(agent => {
        const color = agent.robeColor || "#4A9E96";
        return (
          <button
            key={agent.id}
            onClick={() => {
              addAgentToForum(forum.id, {
                agentId: agent.id,
                name: agent.name,
                role: agent.role,
                robeColor: agent.robeColor,
                accentColor: agent.accentColor,
                image: agent.image ?? null,
                confidence: 50,
                forumRole: "Added to forum",
                currentAction: "Joining forum…",
              });
              onClose();
            }}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", border: "none", background: "transparent",
              cursor: "pointer", fontFamily: "inherit", textAlign: "left",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-container-low, #f4f4f0)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{
              width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
              background: `${color}22`, border: `1.5px solid ${color}66`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, color,
            }}>
              {agent.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main, #303330)" }}>
                {agent.name}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.6 }}>
                {agent.role}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Blackboard (artifact area) ───────────────────────────────────────────────

// Shared markdown component styles
const mdComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-main, #1a1f1e)", margin: "0 0 10px", lineHeight: 1.3 }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main, #1a1f1e)", margin: "24px 0 8px", paddingBottom: 6, borderBottom: "1px solid rgba(0,0,0,0.07)", lineHeight: 1.3 }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main, #1a1f1e)", margin: "18px 0 6px", lineHeight: 1.4 }}>{children}</h3>
  ),
  p: ({ children }) => (
    <p style={{ fontSize: 13, lineHeight: 1.75, color: "var(--text-main, #303330)", margin: "0 0 12px" }}>{children}</p>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 12px", paddingLeft: 20, listStyleType: "disc" }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 12px", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-main, #303330)", marginBottom: 3 }}>{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{
      margin: "0 0 12px", padding: "8px 14px",
      borderLeft: "3px solid rgba(74,158,150,0.5)",
      background: "rgba(74,158,150,0.05)", borderRadius: "0 6px 6px 0",
      color: "var(--text-sub, #636E72)", fontStyle: "italic",
    }}>{children}</blockquote>
  ),
  code: ({ inline, children, ...props }: { inline?: boolean; children?: React.ReactNode }) =>
    inline ? (
      <code style={{
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 11.5, padding: "2px 5px",
        background: "rgba(0,0,0,0.06)", borderRadius: 4,
        color: "var(--text-main, #303330)",
      }} {...props}>{children}</code>
    ) : (
      <code style={{
        display: "block", fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontSize: 11.5, padding: "12px 14px", margin: "0 0 12px",
        background: "rgba(0,0,0,0.04)", borderRadius: 8,
        border: "1px solid rgba(0,0,0,0.06)",
        color: "var(--text-main, #303330)",
        overflowX: "auto", whiteSpace: "pre",
      }} {...props}>{children}</code>
    ),
  pre: ({ children }) => <>{children}</>,
  hr: () => (
    <hr style={{ border: "none", borderTop: "1px solid rgba(0,0,0,0.08)", margin: "20px 0" }} />
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 700, color: "var(--text-main, #1a1f1e)" }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ fontStyle: "italic" }}>{children}</em>
  ),
  a: ({ children, href }) => (
    <a href={href} style={{ color: "#4A9E96", textDecoration: "underline", textUnderlineOffset: 2 }}>{children}</a>
  ),
  table: ({ children }) => (
    <table style={{ borderCollapse: "collapse", width: "100%", margin: "0 0 12px", fontSize: 12 }}>{children}</table>
  ),
  th: ({ children }) => (
    <th style={{ padding: "7px 12px", textAlign: "left", fontWeight: 600, borderBottom: "2px solid rgba(0,0,0,0.1)", color: "var(--text-main, #303330)" }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{ padding: "6px 12px", borderBottom: "1px solid rgba(0,0,0,0.06)", color: "var(--text-main, #303330)" }}>{children}</td>
  ),
};

function ForumBlackboard({
  forum,
  selectedArtifactId,
  onClearArtifact,
}: {
  forum: ReturnType<typeof useForumStore.getState>["forums"][0];
  selectedArtifactId: string | null;
  onClearArtifact: () => void;
}) {
  const updateBlackboard = useForumStore(s => s.updateBlackboard);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null); // null = live
  const [locked, setLocked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasCompleted = useRef(false);

  // Backwards-compat: blackboardBlock may be missing on forums persisted before this field was added
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blackboardBlock: ForumBlock | null = ((forum as any).blackboardBlock as ForumBlock | null | undefined) ?? null;

  // When an artifact is selected, show it instead of the live blackboard
  const selectedArtifact = selectedArtifactId
    ? (forum.artifacts ?? []).find(a => a.id === selectedArtifactId) ?? null
    : null;

  // Determine if we're in HTML rendering mode
  const isHtmlMode: boolean = selectedArtifact
    ? selectedArtifact.type === "html"
    : blackboardBlock?.type === "html";

  const htmlContent: string | null = isHtmlMode
    ? (selectedArtifact?.content ?? blackboardBlock?.content ?? null)
    : null;

  // Reset to preview when switching between html/markdown modes
  useEffect(() => {
    setViewMode("rendered");
  }, [isHtmlMode, selectedArtifactId]);

  const displayContent = selectedArtifact
    ? selectedArtifact.content
    : historyIdx !== null
      ? forum.blackboardHistory[historyIdx]?.content ?? forum.blackboardContent
      : isHtmlMode
        ? (blackboardBlock?.content ?? "")
        : forum.blackboardContent;

  const isLive = !selectedArtifact && historyIdx === null;
  const isComplete = forum.status === "completed";
  const isRendered = viewMode === "rendered";

  // When forum first completes, auto-scroll to bottom so deliverable is visible
  useEffect(() => {
    if (isComplete && !wasCompleted.current) {
      wasCompleted.current = true;
      setTimeout(() => {
        const el = isRendered ? scrollRef.current : textareaRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, 400);
    }
  }, [isComplete, isRendered]);

  const copyToClipboard = () => {
    const textToCopy = isHtmlMode ? (htmlContent ?? displayContent) : forum.blackboardContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    });
  };

  const scrollToDeliverable = () => {
    const el = isRendered ? scrollRef.current : textareaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const toolbarBtn = (
    onClick: () => void,
    active: boolean,
    activeColor: string,
    children: React.ReactNode,
    title?: string
  ) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
        borderRadius: 7,
        border: active ? `1px solid ${activeColor}60` : "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
        background: active ? `${activeColor}12` : "transparent",
        color: active ? activeColor : "var(--text-sub, #636E72)",
        fontSize: 11, cursor: "pointer", fontFamily: "inherit",
        transition: "all 0.15s ease",
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Blackboard toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "8px 16px",
        borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          {selectedArtifact && (
            <button
              onClick={onClearArtifact}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "3px 8px",
                borderRadius: 6, border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))",
                background: "transparent", color: "var(--text-sub, #636E72)",
                fontSize: 11, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
              }}
            >
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Board
            </button>
          )}
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-sub, #636E72)", opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
            {selectedArtifact
              ? selectedArtifact.title
              : isComplete ? "Your Deliverable" : "The Blackboard"}
            {isHtmlMode && isRendered && !selectedArtifact && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                background: "rgba(245,158,63,0.12)", color: "#F59E3F",
                border: "1px solid rgba(245,158,63,0.25)",
                textTransform: "uppercase", letterSpacing: "0.06em",
              }}>
                Interactive
              </span>
            )}
            {!selectedArtifact && !isLive && !isHtmlMode && (
              <span style={{ marginLeft: 8, fontSize: 10, color: "#F59E3F", fontWeight: 400 }}>
                · Viewing history
              </span>
            )}
          </div>
        </div>

        {/* Preview / Source toggle */}
        <div style={{ display: "flex", borderRadius: 7, border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))", overflow: "hidden" }}>
          {(["rendered", "source"] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: "4px 10px", border: "none",
                background: viewMode === mode ? "rgba(74,158,150,0.1)" : "transparent",
                color: viewMode === mode ? "#4A9E96" : "var(--text-sub, #636E72)",
                fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                fontWeight: viewMode === mode ? 600 : 400,
                transition: "all 0.12s ease",
              }}
            >
              {mode === "rendered"
                ? (isHtmlMode ? "Preview" : "Rendered")
                : "Source"}
            </button>
          ))}
        </div>

        {/* Jump to deliverable — not needed in HTML mode */}
        {!isHtmlMode && forum.blackboardContent.length > 200 && toolbarBtn(
          scrollToDeliverable, false, "#4A9E96",
          <>
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            Jump to result
          </>,
          "Scroll to the final deliverable"
        )}

        {/* Copy */}
        {(isHtmlMode ? !!htmlContent : forum.blackboardContent.length > 0) && toolbarBtn(
          copyToClipboard, copied, "#4A9E96",
          <>
            {copied
              ? <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              : <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            }
            {copied ? "Copied!" : "Copy"}
          </>
        )}

        {/* Director's Lock */}
        {toolbarBtn(
          () => setLocked(l => !l), locked, "#EF4444",
          <>
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              {locked
                ? <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>
                : <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>
              }
            </svg>
            {locked ? "Locked" : "Lock"}
          </>,
          locked ? "Unlock — agents can edit" : "Lock — agents cannot edit this content"
        )}

        {/* Time Machine — hidden when viewing a pinned artifact or HTML block */}
        {!selectedArtifact && !isHtmlMode && forum.blackboardHistory.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-sub, #636E72)" strokeWidth={2} strokeLinecap="round" style={{ opacity: 0.5 }}>
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <input
              type="range"
              min={0}
              max={forum.blackboardHistory.length}
              value={historyIdx === null ? forum.blackboardHistory.length : historyIdx}
              onChange={e => {
                const v = parseInt(e.target.value);
                setHistoryIdx(v >= forum.blackboardHistory.length ? null : v);
              }}
              style={{ width: 70, accentColor: "#4A9E96", cursor: "pointer" }}
              title="Time Machine — scrub back through edits"
            />
            {!isLive && (
              <button
                onClick={() => setHistoryIdx(null)}
                style={{
                  fontSize: 10, color: "#4A9E96", background: "rgba(74,158,150,0.1)",
                  border: "1px solid rgba(74,158,150,0.3)", borderRadius: 6,
                  padding: "2px 7px", cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Live ↑
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {locked && isLive && (
          <div style={{
            position: "absolute", top: 8, right: 12, zIndex: 2,
            fontSize: 10, color: "#EF4444", background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6,
            padding: "3px 8px",
          }}>
            Director's Lock · agents cannot edit
          </div>
        )}

        {/* ── HTML preview (iframe) ── */}
        {isHtmlMode && isRendered && htmlContent && (
          <iframe
            key={htmlContent.slice(0, 80)} // remount when content changes
            srcDoc={htmlContent}
            sandbox="allow-scripts"
            style={{
              width: "100%", height: "100%",
              border: "none",
            }}
            title="Interactive deliverable"
          />
        )}

        {/* ── HTML placeholder when no content yet ── */}
        {isHtmlMode && isRendered && !htmlContent && (
          <div style={{
            height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--text-sub, #636E72)", opacity: 0.35, fontSize: 13, fontStyle: "italic",
          }}>
            Waiting for the team…
          </div>
        )}

        {/* ── Rendered markdown view ── */}
        {!isHtmlMode && isRendered && (
          <div
            ref={scrollRef}
            style={{
              width: "100%", height: "100%", overflowY: "auto",
              padding: "20px 28px",
              opacity: isLive ? 1 : 0.7,
            }}
          >
            {displayContent.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {displayContent}
              </ReactMarkdown>
            ) : (
              <div style={{
                height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--text-sub, #636E72)", opacity: 0.35, fontSize: 13, fontStyle: "italic",
              }}>
                Waiting for the team…
              </div>
            )}
          </div>
        )}

        {/* ── Source / edit view (works for both markdown and HTML source) ── */}
        {!isRendered && (
          <textarea
            ref={textareaRef}
            value={displayContent}
            onChange={e => {
              if (!locked && isLive && !isHtmlMode) updateBlackboard(forum.id, e.target.value);
            }}
            readOnly={!isLive || locked || isHtmlMode}
            style={{
              width: "100%", height: "100%",
              background: "transparent", border: "none", outline: "none",
              padding: "16px 20px",
              color: "var(--text-main, #303330)",
              fontSize: 12.5, lineHeight: 1.8,
              fontFamily: "'SF Mono', 'Fira Code', monospace",
              resize: "none",
              opacity: isLive ? 1 : 0.7,
              boxSizing: "border-box",
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Status badge helper ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Forum["status"] }) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    active:    { label: "Active",    color: "#3c6663", bg: "rgba(60,102,99,0.1)"  },
    completed: { label: "Done",      color: "#4A9E96", bg: "rgba(74,158,150,0.1)" },
    paused:    { label: "Paused",    color: "#F59E3F", bg: "rgba(245,158,63,0.1)" },
    drafting:  { label: "Drafting",  color: "#636E72", bg: "rgba(0,0,0,0.05)"     },
    archived:  { label: "Archived",  color: "#636E72", bg: "rgba(0,0,0,0.05)"     },
  };
  const { label, color, bg } = map[status] ?? map.drafting;
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
      background: bg, color,
    }}>{label}</div>
  );
}

// ─── Forums list ──────────────────────────────────────────────────────────────

function ForumsList({ onNewForum }: { onNewForum: () => void }) {
  const forums = useForumStore(s => s.forums);
  const archiveForum = useForumStore(s => s.archiveForum);
  const deleteForum = useForumStore(s => s.deleteForum);
  const unarchiveForum = useForumStore(s => s.unarchiveForum);
  const { setActiveForumId } = useWorldStore();
  const [archiveExpanded, setArchiveExpanded] = useState(false);

  const active = [...forums]
    .filter(f => f.status !== "archived")
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const archived = [...forums]
    .filter(f => f.status === "archived")
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  const sorted = active; // keep variable for existing code below

  function formatDate(ts: number) {
    const d = new Date(ts);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - ts) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: "var(--surface, #faf9f6)", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 24px",
        borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
        background: "var(--surface-container-low, #f4f4f0)",
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main, #303330)" }}>Projects</div>
          <div style={{ fontSize: 11, color: "var(--text-sub, #636E72)", marginTop: 2 }}>
            {active.length} project{active.length !== 1 ? "s" : ""}
            {archived.length > 0 && ` · ${archived.length} archived`}
          </div>
        </div>
        <button
          onClick={onNewForum}
          style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "8px 16px", borderRadius: 9,
            background: "var(--primary, #3c6663)", color: "#fff",
            border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Project
        </button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.length === 0 && archived.length === 0 ? (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 12, color: "var(--text-sub, #636E72)", opacity: 0.5, paddingTop: 80,
          }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <div style={{ fontSize: 14, fontWeight: 600 }}>No projects yet</div>
            <div style={{ fontSize: 12, textAlign: "center" }}>
              Start a project to assemble your agents<br/>around a goal or task.
            </div>
            <button
              onClick={onNewForum}
              style={{
                marginTop: 4, padding: "8px 18px", borderRadius: 9,
                background: "rgba(60,102,99,0.08)", border: "1px solid rgba(60,102,99,0.25)",
                color: "var(--primary, #3c6663)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Start your first project →
            </button>
          </div>
        ) : sorted.map(f => (
          <ForumCard
            key={f.id}
            forum={f}
            onClick={() => setActiveForumId(f.id)}
            onArchive={() => archiveForum(f.id)}
            onDelete={() => deleteForum(f.id)}
            formatDate={formatDate}
          />
        ))}

        {/* ── Archived section ── */}
        {archived.length > 0 && (
          <div style={{ marginTop: sorted.length > 0 ? 8 : 0 }}>
            <button
              onClick={() => setArchiveExpanded(x => !x)}
              style={{
                display: "flex", alignItems: "center", gap: 7, width: "100%",
                padding: "8px 4px", border: "none", background: "transparent",
                cursor: "pointer", fontFamily: "inherit",
                color: "var(--text-sub, #636E72)", fontSize: 11,
              }}
            >
              <svg
                width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"
                style={{ transition: "transform 0.2s ease", transform: archiveExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
              >
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                Archived · {archived.length}
              </span>
            </button>

            {archiveExpanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                {archived.map(f => (
                  <div
                    key={f.id}
                    style={{
                      display: "flex", flexDirection: "column", gap: 8,
                      padding: "12px 14px", borderRadius: 12,
                      background: "var(--surface-card, #fff)",
                      border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
                      opacity: 0.7,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{
                        flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600,
                        color: "var(--text-main, #303330)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {f.title}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.5, flexShrink: 0 }}>
                        {formatDate(f.lastActiveAt)}
                      </div>
                      {/* Unarchive */}
                      <button
                        onClick={() => unarchiveForum(f.id)}
                        title="Restore from archive"
                        style={{
                          padding: "3px 9px", borderRadius: 6, border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))",
                          background: "transparent", color: "var(--text-sub, #636E72)", fontSize: 10,
                          cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(60,102,99,0.4)")}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border-subtle, rgba(0,0,0,0.1))")}
                      >
                        Restore
                      </button>
                      {/* Delete */}
                      <button
                        onClick={() => deleteForum(f.id)}
                        title="Delete permanently"
                        style={{
                          width: 24, height: 24, borderRadius: 6, border: "none",
                          background: "transparent", color: "var(--text-sub, #636E72)", fontSize: 10,
                          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                          flexShrink: 0,
                        }}
                        onMouseEnter={e => { (e.currentTarget.style.color = "#EF4444"); (e.currentTarget.style.background = "rgba(239,68,68,0.08)"); }}
                        onMouseLeave={e => { (e.currentTarget.style.color = "var(--text-sub, #636E72)"); (e.currentTarget.style.background = "transparent"); }}
                      >
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                          <path d="M9 6V4h6v2"/>
                        </svg>
                      </button>
                    </div>
                    <div style={{
                      fontSize: 11, color: "var(--text-sub, #636E72)", lineHeight: 1.4,
                      overflow: "hidden", display: "-webkit-box",
                      WebkitLineClamp: 1, WebkitBoxOrient: "vertical",
                    } as React.CSSProperties}>
                      {f.brief}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Forum card (shared between list and grid views) ─────────────────────────

function ForumCard({
  forum: f,
  onClick,
  onArchive,
  onDelete,
  formatDate,
}: {
  forum: Forum;
  onClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
  formatDate: (ts: number) => string;
}) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 10,
        padding: "14px 16px", borderRadius: 14,
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
        cursor: "pointer", transition: "all 0.15s ease",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 16px rgba(60,102,99,0.08)";
        (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(60,102,99,0.2)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = "";
        (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border-subtle, rgba(0,0,0,0.07))";
      }}
    >
      {/* Top row: title + status + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }} onClick={onClick}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: "var(--text-main, #303330)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {f.title}
          </div>
        </div>
        <StatusBadge status={f.status} />
        <div style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.5, flexShrink: 0 }}>
          {formatDate(f.lastActiveAt)}
        </div>
        {/* Stop click-through on the actions dropdown */}
        <div onClick={e => e.stopPropagation()}>
          <ForumActions
            forum={f}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        </div>
      </div>

      {/* Brief excerpt — clicking opens forum */}
      <div onClick={onClick} style={{
        fontSize: 12, color: "var(--text-sub, #636E72)", lineHeight: 1.5,
        overflow: "hidden", display: "-webkit-box",
        WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      } as React.CSSProperties}>
        {f.brief}
      </div>

      {/* Bottom row: agent pips + tags + message count */}
      <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex" }}>
          {f.agents.slice(0, 4).map((a, i) => (
            <div key={a.agentId} style={{
              width: 22, height: 22, borderRadius: "50%",
              background: `${a.robeColor || "#4A9E96"}28`,
              border: `1.5px solid ${a.robeColor || "#4A9E96"}66`,
              marginLeft: i > 0 ? -6 : 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, fontWeight: 700, color: a.robeColor || "#4A9E96",
              flexShrink: 0,
            }} title={a.name}>
              {a.name.charAt(0)}
            </div>
          ))}
          {f.agents.length > 4 && (
            <div style={{
              width: 22, height: 22, borderRadius: "50%",
              background: "rgba(0,0,0,0.05)", marginLeft: -6,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, color: "var(--text-sub, #636E72)",
            }}>+{f.agents.length - 4}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flex: 1, flexWrap: "wrap" }}>
          {f.tags.slice(0, 3).map(tag => (
            <div key={tag} style={{
              fontSize: 9, padding: "2px 7px", borderRadius: 20,
              background: "rgba(74,158,150,0.08)", color: "#4A9E96",
              border: "1px solid rgba(74,158,150,0.15)",
            }}>{tag}</div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.5, flexShrink: 0 }}>
          {f.messages.filter(m => m.sender === "agent").length} messages
        </div>
      </div>
    </div>
  );
}

// ─── Forum View (main shell) ──────────────────────────────────────────────────

export function ForumView() {
  const forums = useForumStore(s => s.forums);
  const retryForum = useForumStore(s => s.retryForum);
  const archiveForum = useForumStore(s => s.archiveForum);
  const deleteForum = useForumStore(s => s.deleteForum);
  const updateForumTags = useForumStore(s => s.updateForumTags);
  const { activeForumId, setActiveForumId } = useWorldStore();
  const engineRef = useRef<{ stop: () => void } | null>(null);
  const [briefModalOpen, setBriefModalOpen] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  // activeForumId === null → show list; !== null → show that forum (or list if not found)
  const forum = activeForumId ? (forums.find(f => f.id === activeForumId) ?? null) : null;

  // Collaborative work explainer — shown once per project, dismissable
  const eduKey = forum ? `canopy_forum_edu_dismissed_${forum.id}` : null;
  const [eduDismissed, setEduDismissed] = useState(() =>
    eduKey ? !!localStorage.getItem(eduKey) : true
  );
  useEffect(() => {
    if (!eduKey) return;
    setEduDismissed(!!localStorage.getItem(eduKey));
  }, [eduKey]);
  const dismissEdu = () => {
    if (eduKey) localStorage.setItem(eduKey, "1");
    setEduDismissed(true);
  };

  // Inject keyframes once
  useEffect(() => {
    const id = "forum-view-keyframes";
    if (document.getElementById(id)) return;
    const el = document.createElement("style");
    el.id = id;
    el.textContent = `@keyframes forum-fade-in { from { opacity: 0 } to { opacity: 1 } }`;
    document.head.appendChild(el);
  }, []);

  // Auto-start the real LLM orchestrator when a fresh (or retried) forum opens.
  //
  // INVARIANT: the orchestrator is always started with the correct forum.id
  // and reads all brief/agent data from the store — never from another forum.
  //
  // The orchestrator drives real OpenClaw agent calls sequentially through
  // Kickoff → Research → Strategy → Draft → Review phases.
  // On failure it pauses the forum with a diagnostic message — NO simulation fallback.
  // Reset artifact selection when switching forums
  useEffect(() => { setSelectedArtifactId(null); }, [forum?.id]);

  useEffect(() => {
    if (!forum) return;
    if (forum.status !== "active") return;
    if (forum.messages.some(m => m.sender === "agent")) return; // already ran / retried

    // Small delay so the view has time to render before the first agent call
    const startId = setTimeout(() => {
      engineRef.current = createForumOrchestrator(forum.id);
    }, 1200);

    return () => {
      clearTimeout(startId);
      engineRef.current?.stop();
    };
  }, [forum?.id, forum?.status]); // re-run when forum ID changes or status flips back to "active" on retry

  /** Reset forum state and restart the orchestrator. */
  const handleRetry = useCallback(() => {
    if (!forum) return;
    engineRef.current?.stop();
    engineRef.current = null;
    // retryForum resets messages/blackboard/milestones and sets status → "active",
    // which will trigger the useEffect above to start a fresh orchestrator run.
    retryForum(forum.id);
  }, [forum, retryForum]);

  // ── No active forum → show list ────────────────────────────────────────────
  if (!forum) {
    return (
      <>
        {briefModalOpen && <ForumBriefModal onClose={() => setBriefModalOpen(false)} />}
        <ForumsList onNewForum={() => setBriefModalOpen(true)} />
      </>
    );
  }

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: "var(--surface, #faf9f6)",
      overflow: "hidden",
      minHeight: 0,
    }}>
      {/* ── Top bar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 20px",
        borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
        background: "var(--surface-container-low, #f4f4f0)",
        flexShrink: 0,
      }}>
        {/* Back to list */}
        <button
          onClick={() => setActiveForumId(null)}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "5px 10px", borderRadius: 8, cursor: "pointer",
            background: "transparent", border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
            color: "var(--text-sub, #636E72)", fontSize: 12, fontFamily: "inherit",
            opacity: 0.7, transition: "opacity 0.15s ease",
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "0.6")}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          All Forums
        </button>

        {/* Title */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: "var(--text-main, #303330)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {forum.title}
          </div>
        </div>

        {/* Tags — editable */}
        <div style={{ flexShrink: 0 }}>
          <InlineTagEditor
            tags={forum.tags}
            onUpdate={tags => updateForumTags(forum.id, tags)}
          />
        </div>

        {/* Agent pips + add agent */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
          <div style={{ display: "flex" }}>
            {forum.agents.map((a, i) => (
              <div key={a.agentId} style={{
                width: 24, height: 24, borderRadius: "50%",
                background: `${a.robeColor || "#4A9E96"}33`,
                border: `2px solid ${a.robeColor || "#4A9E96"}88`,
                marginLeft: i > 0 ? -6 : 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 700, color: a.robeColor || "#4A9E96",
                zIndex: forum.agents.length - i,
              }}
              title={a.name}
              >
                {a.name.charAt(0)}
              </div>
            ))}
          </div>
          {/* Add agent button */}
          <button
            onClick={() => setAddAgentOpen(o => !o)}
            title="Add agent to forum"
            style={{
              width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
              border: "1.5px dashed rgba(74,158,150,0.5)",
              background: addAgentOpen ? "rgba(74,158,150,0.12)" : "transparent",
              color: "#4A9E96", fontSize: 13, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              lineHeight: 1,
            }}
          >
            +
          </button>
          {addAgentOpen && (
            <AddAgentPicker forum={forum} onClose={() => setAddAgentOpen(false)} />
          )}
        </div>

        {/* Forum actions (archive / delete) */}
        <div style={{ flexShrink: 0, marginLeft: "auto" }}>
          <ForumActions
            forum={forum}
            onArchive={() => archiveForum(forum.id)}
            onDelete={() => deleteForum(forum.id)}
          />
        </div>
      </div>

      {/* ── Completion banner ── */}
      {forum.status === "completed" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "9px 20px",
          background: "rgba(74,158,150,0.07)",
          borderBottom: "1px solid rgba(74,158,150,0.18)",
          flexShrink: 0,
          animation: "forum-fade-in 0.4s ease",
        }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#4A9E96" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <span style={{ fontSize: 12, color: "#4A9E96", fontWeight: 600 }}>
            Your deliverable is ready
          </span>
          <span style={{ fontSize: 11, color: "#4A9E96", opacity: 0.6 }}>
            · The result is in the panel below — use "Jump to result" to scroll straight to it, or "Copy" to take it with you
          </span>
        </div>
      )}

      {/* ── Error / paused banner ── */}
      {forum.status === "paused" && (() => {
        // Find the most recent error system message
        const errorMsg = [...forum.messages]
          .reverse()
          .find(m => m.kind === "system" && m.text.startsWith("⚠"));
        // Parse out the Fix line if present
        const lines = errorMsg?.text.split("\n") ?? [];
        const titleLine = lines[0]?.replace(/^⚠\s*/, "") ?? "Forum paused";
        const fixLine = lines.find(l => l.startsWith("Fix:"))?.replace("Fix:", "").trim();
        const detailLine = lines.find(l => l.startsWith("Error:"))?.replace("Error:", "").trim();

        return (
          <div style={{
            padding: "10px 20px",
            background: "rgba(239,68,68,0.06)",
            borderBottom: "1px solid rgba(239,68,68,0.18)",
            flexShrink: 0,
            animation: "forum-fade-in 0.4s ease",
          }}>
            {/* Top row: title + retry */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth={2.5} strokeLinecap="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span style={{ fontSize: 12, color: "#EF4444", fontWeight: 600, flex: 1 }}>
                {titleLine}
              </span>
              <button
                onClick={handleRetry}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 12px", borderRadius: 8,
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  color: "#EF4444", fontSize: 12, fontWeight: 600,
                  cursor: "pointer", fontFamily: "inherit",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(239,68,68,0.18)")}
                onMouseLeave={e => (e.currentTarget.style.background = "rgba(239,68,68,0.1)")}
              >
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                Retry
              </button>
            </div>
            {/* Detail + fix */}
            {(detailLine || fixLine) && (
              <div style={{ marginTop: 6, paddingLeft: 24, display: "flex", flexDirection: "column", gap: 2 }}>
                {detailLine && (
                  <div style={{
                    fontSize: 10, color: "#EF4444", opacity: 0.65,
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {detailLine}
                  </div>
                )}
                {fixLine && (
                  <div style={{ fontSize: 11, color: "var(--text-sub, #636E72)", opacity: 0.8 }}>
                    → {fixLine}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Main content ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── Left: Stage + Blackboard ── */}
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          borderRight: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
          overflow: "hidden", minWidth: 0,
        }}>
          {/* Collaborative work explainer — shown once per project, dismissable */}
          {!eduDismissed && (
            <div style={{
              margin: "12px 16px 0", padding: "10px 14px 10px 16px",
              background: "rgba(74,158,150,0.08)", border: "1px solid rgba(74,158,150,0.2)",
              borderRadius: 10, display: "flex", alignItems: "flex-start", gap: 10,
              flexShrink: 0,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A9E96" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div style={{ flex: 1, fontSize: 12, color: "var(--text-sub, #636E72)", lineHeight: 1.5 }}>
                Your agents work through a <strong>shared blackboard</strong> — each one reads what others have contributed and builds on it, like a team around a whiteboard. No group chat, no coordination overhead.
              </div>
              <button onClick={dismissEdu} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-sub, #636E72)", padding: 2, flexShrink: 0, opacity: 0.5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          )}

          {/* Stage */}
          <div style={{
            flexShrink: 0,
            borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
            position: "relative",
          }}>
            <ForumStage agents={forum.agents} height={200} />
            {/* Stage label */}
            <div style={{
              position: "absolute", top: 10, left: 14,
              fontSize: 10, color: "var(--primary, #3c6663)", opacity: 0.45,
              textTransform: "uppercase", letterSpacing: "0.08em",
            }}>
              Mission Stage
            </div>
          </div>

          {/* Blackboard */}
          <ForumBlackboard
            forum={forum}
            selectedArtifactId={selectedArtifactId}
            onClearArtifact={() => setSelectedArtifactId(null)}
          />
        </div>

        {/* ── Right: Thread + Progress + Team ── */}
        <div style={{
          width: 320, flexShrink: 0,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          background: "var(--surface-container-low, #f4f4f0)",
          borderLeft: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
        }}>
          {/* Progress spine */}
          <ProgressSpine milestones={forum.milestones} />

          {/* Team roster */}
          <TeamRoster forum={forum} />

          {/* Thread */}
          <div style={{
            flex: 1, borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
            overflow: "hidden", display: "flex", flexDirection: "column",
          }}>
            <ForumThread
              forum={forum}
              selectedArtifactId={selectedArtifactId}
              onArtifactClick={id => setSelectedArtifactId(prev => prev === id ? null : id)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
