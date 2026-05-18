import React, { useRef, useEffect, useState } from "react";
import { Forum, ForumArtifact, ForumMessage, useForumStore } from "../../store/forumStore";
import { resolveAnswer } from "./forumOrchestrator";

interface Props {
  forum: Forum;
  selectedArtifactId: string | null;
  onArtifactClick: (id: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function rgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Message renderers ────────────────────────────────────────────────────────

function SystemMessage({ msg }: { msg: ForumMessage }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
      <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.06)" }} />
      <span style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.5, whiteSpace: "nowrap" }}>
        {msg.text}
      </span>
      <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.06)" }} />
    </div>
  );
}

function HandoffChip({ msg, forum }: { msg: ForumMessage; forum: Forum }) {
  const fromAgent = forum.agents.find(a => a.agentId === msg.agentId);
  const toAgent = forum.agents.find(a => a.agentId === msg.toAgentId);
  const color = fromAgent?.robeColor || "#4A9E96";

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 0" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        background: rgba(color, 0.08),
        border: `1px solid ${rgba(color, 0.2)}`,
        borderRadius: 20, padding: "5px 12px",
        fontSize: 11, color: color,
      }}>
        {/* Flowing dot */}
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: color, opacity: 0.8,
          boxShadow: `0 0 6px ${rgba(color, 0.6)}`,
        }} />
        <span style={{ opacity: 0.8 }}>
          {fromAgent?.name ?? "Agent"} → {toAgent?.name ?? "Agent"}
          {msg.handoffLabel && <span style={{ opacity: 0.6 }}> · {msg.handoffLabel}</span>}
        </span>
      </div>
    </div>
  );
}

function VoteChip({ msg, forum }: { msg: ForumMessage; forum: Forum }) {
  const agent = forum.agents.find(a => a.agentId === msg.agentId);
  const color = agent?.robeColor || "#4A9E96";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3px 0" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        background: rgba(color, 0.06),
        border: `1px solid ${rgba(color, 0.18)}`,
        borderRadius: 20, padding: "4px 10px",
        fontSize: 11, color,
      }}>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span style={{ opacity: 0.8 }}>
          {agent?.name ?? "Agent"} approves · ready to deliver
        </span>
      </div>
    </div>
  );
}

function AgentMessage({ msg, forum }: { msg: ForumMessage; forum: Forum }) {
  const isHandoffType = msg.toAgentId != null;
  const agent = forum.agents.find(a => a.agentId === msg.agentId);
  const color = agent?.robeColor || "#4A9E96";
  const isAgentToAgent = isHandoffType;

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {/* Avatar pip */}
      <div style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: rgba(color, 0.15),
        border: `1.5px solid ${rgba(color, 0.4)}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 700, color: color,
        marginTop: 2,
      }}>
        {(agent?.name ?? "A").charAt(0).toUpperCase()}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Sender line */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: color }}>
            {agent?.name ?? msg.agentName ?? "Agent"}
          </span>
          {isAgentToAgent && (
            <>
              <span style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.4 }}>→</span>
              <span style={{ fontSize: 11, color: "var(--text-sub, #636E72)", opacity: 0.7 }}>
                {forum.agents.find(a => a.agentId === msg.toAgentId)?.name ?? "Agent"}
              </span>
            </>
          )}
          <span style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.35, marginLeft: "auto" }}>
            {formatTime(msg.timestamp)}
          </span>
        </div>

        {/* Bubble */}
        <div style={{
          padding: "9px 13px",
          borderRadius: 12,
          borderTopLeftRadius: 4,
          background: isAgentToAgent ? rgba(color, 0.06) : "var(--surface-container-lowest, #fff)",
          border: isAgentToAgent
            ? `1px dashed ${rgba(color, 0.25)}`
            : "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
          fontSize: 12,
          lineHeight: 1.6,
          color: isAgentToAgent ? "var(--text-sub, #636E72)" : "var(--text-main, #303330)",
        }}>
          {msg.text}
        </div>
      </div>
    </div>
  );
}

function UserMessage({ msg }: { msg: ForumMessage }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexDirection: "row-reverse" }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: "rgba(74,158,150,0.2)",
        border: "1.5px solid rgba(74,158,150,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 700, color: "#4A9E96",
        marginTop: 2,
      }}>
        U
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <div style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.4, marginBottom: 4 }}>
          {formatTime(msg.timestamp)}
        </div>
        <div style={{
          padding: "9px 13px",
          borderRadius: 12,
          borderTopRightRadius: 4,
          background: "rgba(60,102,99,0.1)",
          border: "1px solid rgba(60,102,99,0.18)",
          fontSize: 12, lineHeight: 1.6,
          color: "var(--text-main, #303330)",
          maxWidth: "80%",
        }}>
          {msg.text}
        </div>
      </div>
    </div>
  );
}

// ─── Question bubble (genUI interactive card) ─────────────────────────────────

function QuestionBubble({ msg, forum }: { msg: ForumMessage; forum: Forum }) {
  const [freeTextMode, setFreeTextMode] = useState(false);
  const [freeText, setFreeText] = useState("");
  const answerQuestion = useForumStore(s => s.answerForumQuestion);

  const agent = forum.agents.find(a => a.agentId === msg.agentId);
  const color = agent?.robeColor || "#4A9E96";
  const answered = msg.questionAnswered;

  const handleAnswer = (answer: string) => {
    if (answered || !answer.trim()) return;
    // Mark answered in store
    answerQuestion(forum.id, msg.id, answer);
    // Resolve the orchestrator's waiting Promise
    resolveAnswer(msg.id, answer);
    setFreeTextMode(false);
  };

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {/* Avatar pip */}
      <div style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: rgba(color, 0.15),
        border: `1.5px solid ${rgba(color, 0.4)}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 700, color,
        marginTop: 2,
      }}>
        {(agent?.name ?? "A").charAt(0).toUpperCase()}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Sender + timestamp */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color }}>{agent?.name ?? msg.agentName ?? "Agent"}</span>
          <span style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.35, marginLeft: "auto" }}>
            {formatTime(msg.timestamp)}
          </span>
        </div>

        {/* Question card */}
        <div style={{
          padding: "13px 15px",
          borderRadius: 12, borderTopLeftRadius: 4,
          background: answered ? rgba(color, 0.04) : rgba(color, 0.07),
          border: `1.5px solid ${rgba(color, answered ? 0.12 : 0.22)}`,
          transition: "all 0.2s ease",
        }}>
          {/* Question text */}
          <div style={{
            fontSize: 13, fontWeight: 600,
            color: "var(--text-main, #303330)",
            lineHeight: 1.4, marginBottom: 11,
          }}>
            {msg.text}
          </div>

          {/* Option buttons */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {(msg.questionOptions ?? []).map(opt => {
              const isSelected = answered && msg.questionAnswer === opt;
              const isDimmed = answered && msg.questionAnswer !== opt;
              return (
                <button
                  key={opt}
                  disabled={answered}
                  onClick={() => handleAnswer(opt)}
                  style={{
                    padding: "6px 13px",
                    borderRadius: 20,
                    border: `1.5px solid ${isSelected ? color : rgba(color, 0.45)}`,
                    background: isSelected ? color : "transparent",
                    color: isSelected ? "#fff" : color,
                    fontSize: 12, fontWeight: 500,
                    opacity: isDimmed ? 0.3 : 1,
                    cursor: answered ? "default" : "pointer",
                    transition: "all 0.15s ease",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={e => {
                    if (!answered) (e.currentTarget as HTMLButtonElement).style.background = rgba(color, 0.12);
                  }}
                  onMouseLeave={e => {
                    if (!answered) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                >
                  {isSelected && (
                    <span style={{ marginRight: 5, fontSize: 10 }}>✓</span>
                  )}
                  {opt}
                </button>
              );
            })}

            {/* "Something else…" free-text trigger */}
            {msg.questionAllowFreeText && !answered && !freeTextMode && (
              <button
                onClick={() => setFreeTextMode(true)}
                style={{
                  padding: "6px 13px", borderRadius: 20,
                  border: `1.5px dashed ${rgba(color, 0.3)}`,
                  background: "transparent",
                  color: "var(--text-sub, #636E72)",
                  fontSize: 12, cursor: "pointer",
                  opacity: 0.65, fontFamily: "inherit",
                }}
              >
                Something else…
              </button>
            )}
          </div>

          {/* Free-text input — expanded when "Something else…" is clicked */}
          {freeTextMode && !answered && (
            <div style={{ marginTop: 10, display: "flex", gap: 7, alignItems: "center" }}>
              <input
                value={freeText}
                onChange={e => setFreeText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && freeText.trim()) handleAnswer(freeText.trim());
                  if (e.key === "Escape") setFreeTextMode(false);
                }}
                placeholder="Type your answer…"
                autoFocus
                style={{
                  flex: 1, padding: "7px 11px",
                  borderRadius: 9,
                  border: `1.5px solid ${rgba(color, 0.35)}`,
                  background: "var(--surface-container-lowest, #fff)",
                  color: "var(--text-main, #303330)",
                  fontSize: 12, fontFamily: "inherit",
                  outline: "none",
                }}
                onFocus={e => (e.target.style.borderColor = rgba(color, 0.6))}
                onBlur={e => (e.target.style.borderColor = rgba(color, 0.35))}
              />
              <button
                onClick={() => freeText.trim() && handleAnswer(freeText.trim())}
                disabled={!freeText.trim()}
                style={{
                  padding: "7px 13px", borderRadius: 9,
                  background: freeText.trim() ? color : rgba(color, 0.15),
                  color: freeText.trim() ? "#fff" : rgba(color, 0.4),
                  border: "none", fontSize: 12, fontWeight: 600,
                  cursor: freeText.trim() ? "pointer" : "not-allowed",
                  fontFamily: "inherit", transition: "all 0.15s ease",
                }}
              >
                Send
              </button>
            </div>
          )}

          {/* Answered state footer */}
          {answered && (
            <div style={{
              marginTop: 9, paddingTop: 8,
              borderTop: `1px solid ${rgba(color, 0.12)}`,
              fontSize: 11, color: "var(--text-sub, #636E72)", opacity: 0.5,
              display: "flex", alignItems: "center", gap: 5,
            }}>
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Answered · team continues
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Artifact shelf ───────────────────────────────────────────────────────────

const ARTIFACT_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  markdown: {
    label: "Document",
    color: "#4A9E96",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    ),
  },
  html: {
    label: "App",
    color: "#F59E3F",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
    ),
  },
  deck: {
    label: "Deck",
    color: "#F59E3F",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    ),
  },
  image: {
    label: "Image",
    color: "#8B5CF6",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    ),
  },
  diagram: {
    label: "Diagram",
    color: "#10B981",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="5" height="5" rx="1"/>
        <rect x="16" y="3" width="5" height="5" rx="1"/>
        <rect x="3" y="16" width="5" height="5" rx="1"/>
        <rect x="16" y="16" width="5" height="5" rx="1"/>
        <line x1="8" y1="5.5" x2="16" y2="5.5"/>
        <line x1="5.5" y1="8" x2="5.5" y2="16"/>
        <line x1="18.5" y1="8" x2="18.5" y2="16"/>
        <line x1="8" y1="18.5" x2="16" y2="18.5"/>
      </svg>
    ),
  },
  data: {
    label: "Data",
    color: "#3B82F6",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="9" x2="9" y2="21"/>
      </svg>
    ),
  },
};

function derivePreview(content: string, type?: string): string {
  if (type === "html") {
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) return `Interactive app · ${titleMatch[1]}`;
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) return `Interactive app · ${h1Match[1]}`;
    return "Interactive HTML application";
  }
  return content
    .split("\n")
    .map(l => l.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim())
    .find(l => l.length > 20)
    ?.slice(0, 110) ?? content.slice(0, 110);
}

function ArtifactShelf({
  forum,
  selectedArtifactId,
  onArtifactClick,
}: {
  forum: Forum;
  selectedArtifactId: string | null;
  onArtifactClick: (id: string) => void;
}) {
  const artifacts = forum.artifacts ?? [];
  if (artifacts.length === 0) return null;

  return (
    <div style={{
      borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
      background: "var(--surface-container-low, #f4f4f0)",
      flexShrink: 0,
      padding: "12px 16px",
    }}>
      {/* Section header */}
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.08em", color: "var(--text-sub, #636E72)",
        opacity: 0.55, marginBottom: 10,
      }}>
        Outputs · {forum.artifacts.length}
      </div>

      {/* Scrollable card row */}
      <div style={{
        display: "flex", gap: 8,
        overflowX: "auto", paddingBottom: 4,
      }}>
        {artifacts.map(artifact => {
          const meta = ARTIFACT_META[artifact.type] ?? ARTIFACT_META.markdown;
          const isSelected = artifact.id === selectedArtifactId;
          const preview = artifact.preview ?? derivePreview(artifact.content, artifact.type);
          const agent = forum.agents.find(a => a.agentId === artifact.agentId);

          return (
            <button
              key={artifact.id}
              onClick={() => onArtifactClick(artifact.id)}
              style={{
                flexShrink: 0, width: 168,
                display: "flex", flexDirection: "column", gap: 6,
                padding: "11px 13px",
                borderRadius: 12,
                background: isSelected ? `${meta.color}10` : "var(--surface-card, #fff)",
                border: isSelected
                  ? `1.5px solid ${meta.color}55`
                  : "1.5px solid var(--border-subtle, rgba(0,0,0,0.08))",
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
                transition: "all 0.15s ease",
                boxShadow: isSelected ? `0 2px 12px ${meta.color}20` : "none",
              }}
              onMouseEnter={e => {
                if (!isSelected) {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = `${meta.color}40`;
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 2px 8px ${meta.color}15`;
                }
              }}
              onMouseLeave={e => {
                if (!isSelected) {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-subtle, rgba(0,0,0,0.08))";
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
                }
              }}
            >
              {/* Type icon + label row */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 7, flexShrink: 0,
                  background: `${meta.color}18`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: meta.color,
                }}>
                  {meta.icon}
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 600, color: meta.color,
                  textTransform: "uppercase", letterSpacing: "0.06em",
                }}>
                  {meta.label}
                </span>
                {isSelected && (
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={meta.color} strokeWidth={2.5} strokeLinecap="round" style={{ marginLeft: "auto" }}>
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </div>

              {/* Title */}
              <div style={{
                fontSize: 12, fontWeight: 700,
                color: "var(--text-main, #303330)",
                lineHeight: 1.3,
                overflow: "hidden", display: "-webkit-box",
                WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
              } as React.CSSProperties}>
                {artifact.title}
              </div>

              {/* Preview snippet */}
              <div style={{
                fontSize: 11, lineHeight: 1.5,
                color: "var(--text-sub, #636E72)", opacity: 0.7,
                overflow: "hidden", display: "-webkit-box",
                WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
              } as React.CSSProperties}>
                {preview}
              </div>

              {/* Agent attribution */}
              {(agent ?? artifact.agentName) && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 5,
                  marginTop: 2,
                }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: "50%",
                    background: `${agent?.robeColor ?? meta.color}25`,
                    border: `1px solid ${agent?.robeColor ?? meta.color}55`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 7, fontWeight: 700, color: agent?.robeColor ?? meta.color,
                    flexShrink: 0,
                  }}>
                    {(agent?.name ?? artifact.agentName ?? "A").charAt(0).toUpperCase()}
                  </div>
                  <span style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.5 }}>
                    {agent?.name ?? artifact.agentName}
                  </span>
                </div>
              )}
              {/* Made with Canopy watermark */}
              <div style={{
                display: "flex", alignItems: "center", gap: 4,
                marginTop: 6, paddingTop: 6,
                borderTop: `1px solid ${meta.color}18`,
                opacity: 0.35,
              }}>
                <img src="/app-icon.png" alt="" style={{ width: 10, height: 10, objectFit: "contain" }} />
                <span style={{ fontSize: 9, color: "var(--text-sub, #636E72)", letterSpacing: "0.02em" }}>
                  Made with Canopy
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Input bar ────────────────────────────────────────────────────────────────

function ThreadInput({ forumId }: { forumId: string }) {
  const [text, setText] = useState("");
  const addMsg = useForumStore(s => s.addForumMessage);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    addMsg(forumId, {
      kind: "chat",
      sender: "user",
      text: trimmed,
    });
    setText("");
  };

  return (
    <div style={{
      padding: "12px 16px",
      borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
      display: "flex", gap: 8, alignItems: "flex-end",
      background: "var(--surface-card, #fff)",
      flexShrink: 0,
    }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        }}
        placeholder="Direct the team, ask a question, or interject…"
        rows={2}
        style={{
          flex: 1, resize: "none",
          background: "var(--surface-container-low, #f4f4f0)",
          border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
          borderRadius: 10, padding: "8px 12px",
          color: "var(--text-main, #303330)", fontSize: 12,
          lineHeight: 1.5, fontFamily: "inherit", outline: "none",
          transition: "border-color 0.15s ease",
        }}
        onFocus={e => (e.target.style.borderColor = "rgba(60,102,99,0.4)")}
        onBlur={e => (e.target.style.borderColor = "var(--border-subtle, rgba(0,0,0,0.08))")}
      />
      <button
        onClick={send}
        disabled={!text.trim()}
        style={{
          padding: "8px 14px", borderRadius: 9,
          background: text.trim() ? "var(--primary, #3c6663)" : "rgba(60,102,99,0.1)",
          color: text.trim() ? "#fff" : "rgba(60,102,99,0.4)",
          border: "none", fontSize: 12, fontWeight: 600,
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontFamily: "inherit", transition: "all 0.15s ease",
          flexShrink: 0, alignSelf: "flex-end",
        }}
      >
        Send
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ForumThread({ forum, selectedArtifactId, onArtifactClick }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [forum.messages.length]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
        fontSize: 11, fontWeight: 600,
        color: "var(--text-sub, #636E72)", opacity: 0.6,
        textTransform: "uppercase", letterSpacing: "0.07em",
        flexShrink: 0,
      }}>
        Forum Thread
      </div>

      {/* Messages */}
      <div style={{
        flex: 1, overflowY: "auto", padding: "16px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {forum.messages.map(msg => {
          if (msg.kind === "system") return <SystemMessage key={msg.id} msg={msg} />;
          if (msg.kind === "handoff") return <HandoffChip key={msg.id} msg={msg} forum={forum} />;
          if (msg.kind === "vote") return <VoteChip key={msg.id} msg={msg} forum={forum} />;
          if (msg.kind === "question") return <QuestionBubble key={msg.id} msg={msg} forum={forum} />;
          if (msg.sender === "user") return <UserMessage key={msg.id} msg={msg} />;
          return <AgentMessage key={msg.id} msg={msg} forum={forum} />;
        })}
        <div ref={bottomRef} />
      </div>

      {/* Artifact shelf — appears when the forum has produced outputs */}
      <ArtifactShelf
        forum={forum}
        selectedArtifactId={selectedArtifactId}
        onArtifactClick={onArtifactClick}
      />

      {/* Input */}
      <ThreadInput forumId={forum.id} />
    </div>
  );
}
