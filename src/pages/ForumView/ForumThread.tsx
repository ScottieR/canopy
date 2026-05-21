import React, { useRef, useEffect, useState } from "react";
import { Forum, ForumArtifact, ForumMessage, useForumStore } from "../../store/forumStore";
import { resolveAnswer } from "./forumOrchestrator";
import { GenUIRenderer } from "../../components/GenUI/GenUIRenderer";

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
          {msg.miniApp && msg.miniApp.target === "inline" && (
            <GenUIRenderer 
              app={msg.miniApp} 
              onEvent={(evt) => {
                console.log("GenUI Event emitted:", evt);
                // In a real implementation, this would trigger an invoke("send_message", ...)
                // back to the specific agent that generated this UI.
                useForumStore.getState().addForumMessage(forum.id, {
                  kind: "chat",
                  sender: "user",
                  text: `[GenUI Event] User interacted with ${msg.miniApp?.component}: ${JSON.stringify(evt)}`
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function UserMessage({ msg }: { msg: ForumMessage }) {
  const [expandedImg, setExpandedImg] = useState<string | null>(null);
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
        {/* Attachments */}
        {msg.attachments && msg.attachments.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", marginBottom: 6 }}>
            {msg.attachments.map((att, i) => (
              att.mimeType.startsWith("image/") ? (
                <div key={i} style={{ position: "relative" }}>
                  <img
                    src={att.dataUrl}
                    alt={att.name}
                    title={att.name}
                    onClick={() => setExpandedImg(att.dataUrl)}
                    style={{
                      width: 80, height: 80, objectFit: "cover",
                      borderRadius: 8, cursor: "pointer",
                      border: "1.5px solid rgba(60,102,99,0.2)",
                    }}
                  />
                </div>
              ) : (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 9px", borderRadius: 8,
                  background: "rgba(60,102,99,0.08)",
                  border: "1px solid rgba(60,102,99,0.18)",
                  fontSize: 11, color: "var(--text-sub, #636E72)",
                }}>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                  {att.name}
                </div>
              )
            ))}
          </div>
        )}
        {msg.text && (
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
        )}
      </div>
      {/* Lightbox */}
      {expandedImg && (
        <div
          onClick={() => setExpandedImg(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
          }}
        >
          <img src={expandedImg} style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 12, boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }} />
        </div>
      )}
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
  // Only show deliverable artifacts — intermediate research/strategy notes are
  // already visible on the blackboard and don't need separate cards here.
  const allArtifacts = forum.artifacts ?? [];
  let deliverables = allArtifacts.filter(a => a.isDeliverable);

  // Backwards-compat: forums produced before the isDeliverable field was added
  // have no flagged deliverables. In that case, show only the last artifact
  // (the final output) rather than flooding the shelf with intermediate notes.
  if (deliverables.length === 0 && allArtifacts.length > 0) {
    deliverables = [allArtifacts[allArtifacts.length - 1]];
  }

  // Hide the shelf entirely when there's nothing to show.
  if (deliverables.length === 0) return null;

  return (
    <div style={{
      borderTop: "1px solid rgba(74,158,150,0.2)",
      background: "rgba(74,158,150,0.04)",
      flexShrink: 0,
      padding: "10px 14px 12px",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, marginBottom: 8,
      }}>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#4A9E96" strokeWidth={2.5} strokeLinecap="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.07em", color: "#4A9E96",
        }}>
          {deliverables.length === 1 ? "Deliverable" : `Deliverables · ${deliverables.length}`}
        </span>
      </div>

      {/* Cards — vertical stack in the thread column, not a horizontal scroll */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {deliverables.map(artifact => {
          const meta = ARTIFACT_META[artifact.type] ?? ARTIFACT_META.markdown;
          const isSelected = artifact.id === selectedArtifactId;
          const preview = artifact.preview ?? derivePreview(artifact.content, artifact.type);
          const agent = forum.agents.find(a => a.agentId === artifact.agentId);

          return (
            <button
              key={artifact.id}
              onClick={() => onArtifactClick(artifact.id)}
              style={{
                width: "100%",
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px",
                borderRadius: 10,
                background: isSelected ? `${meta.color}12` : "var(--surface-card, #fff)",
                border: isSelected
                  ? `1.5px solid ${meta.color}55`
                  : "1.5px solid rgba(74,158,150,0.18)",
                cursor: "pointer", textAlign: "left",
                fontFamily: "inherit",
                transition: "all 0.15s ease",
                boxShadow: isSelected ? `0 2px 10px ${meta.color}20` : "0 1px 3px rgba(0,0,0,0.04)",
              }}
              onMouseEnter={e => {
                if (!isSelected) (e.currentTarget as HTMLButtonElement).style.borderColor = `${meta.color}44`;
              }}
              onMouseLeave={e => {
                if (!isSelected) (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(74,158,150,0.18)";
              }}
            >
              {/* Type icon */}
              <div style={{
                width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                background: `${meta.color}15`,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: meta.color,
              }}>
                {meta.icon}
              </div>

              {/* Text */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 700,
                  color: "var(--text-main, #303330)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  marginBottom: 2,
                }}>
                  {artifact.title}
                </div>
                <div style={{
                  fontSize: 10.5, lineHeight: 1.4,
                  color: "var(--text-sub, #636E72)", opacity: 0.7,
                  overflow: "hidden", display: "-webkit-box",
                  WebkitLineClamp: 1, WebkitBoxOrient: "vertical",
                } as React.CSSProperties}>
                  {preview}
                </div>
              </div>

              {/* Selected indicator or open arrow */}
              <div style={{ flexShrink: 0, color: isSelected ? meta.color : "rgba(0,0,0,0.2)" }}>
                {isSelected ? (
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : (
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Made with Canopy watermark — subtle, single instance */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        marginTop: 8, opacity: 0.3,
      }}>
        <img src="/app-icon.png" alt="" style={{ width: 9, height: 9, objectFit: "contain" }} />
        <span style={{ fontSize: 9, color: "var(--text-sub, #636E72)", letterSpacing: "0.02em" }}>
          Made with Canopy
        </span>
      </div>
    </div>
  );
}

// ─── Input bar ────────────────────────────────────────────────────────────────

interface Attachment { name: string; dataUrl: string; mimeType: string }

function ThreadInput({ forumId }: { forumId: string }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMsg = useForumStore(s => s.addForumMessage);

  const canSend = text.trim().length > 0 || attachments.length > 0;

  const send = () => {
    if (!canSend) return;
    addMsg(forumId, {
      kind: "chat",
      sender: "user",
      text: text.trim(),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setAttachments([]);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target?.result as string;
        setAttachments(prev => [...prev, { name: file.name, dataUrl, mimeType: file.type || "application/octet-stream" }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = (i: number) => {
    setAttachments(prev => prev.filter((_, idx) => idx !== i));
  };

  return (
    <div style={{
      padding: "10px 12px 12px",
      borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
      background: "var(--surface-card, #fff)",
      flexShrink: 0,
    }}>
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {attachments.map((att, i) => (
            <div key={i} style={{ position: "relative" }}>
              {att.mimeType.startsWith("image/") ? (
                <img
                  src={att.dataUrl}
                  alt={att.name}
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 7, border: "1.5px solid rgba(60,102,99,0.2)" }}
                />
              ) : (
                <div style={{
                  width: 56, height: 56, borderRadius: 7,
                  background: "rgba(60,102,99,0.08)",
                  border: "1.5px solid rgba(60,102,99,0.18)",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                  padding: 4,
                }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#3c6663" strokeWidth={1.5} strokeLinecap="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                  <span style={{ fontSize: 8, color: "#636E72", textAlign: "center", wordBreak: "break-all", maxWidth: "100%", lineHeight: 1.2 }}>
                    {att.name.split(".").pop()?.toUpperCase()}
                  </span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(i)}
                style={{
                  position: "absolute", top: -5, right: -5,
                  width: 16, height: 16, borderRadius: "50%",
                  background: "#EF4444", border: "1.5px solid #fff",
                  color: "#fff", fontSize: 9, fontWeight: 700,
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  lineHeight: 1, padding: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div style={{ display: "flex", gap: 7, alignItems: "flex-end" }}>
        {/* Attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Attach file or image"
          style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))",
            background: "transparent",
            color: "var(--text-sub, #636E72)",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            opacity: 0.55, transition: "opacity 0.15s ease",
            alignSelf: "flex-end",
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "0.9")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "0.55")}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.csv,.json"
          style={{ display: "none" }}
          onChange={e => handleFiles(e.target.files)}
          onClick={e => ((e.target as HTMLInputElement).value = "")} // allow re-selecting same file
        />

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          onPaste={e => {
            // Support paste-from-clipboard images
            const items = Array.from(e.clipboardData?.items ?? []);
            const imageItem = items.find(it => it.type.startsWith("image/"));
            if (imageItem) {
              const file = imageItem.getAsFile();
              if (file) {
                const reader = new FileReader();
                reader.onload = ev => {
                  const dataUrl = ev.target?.result as string;
                  setAttachments(prev => [...prev, { name: `pasted-image-${Date.now()}.png`, dataUrl, mimeType: "image/png" }]);
                };
                reader.readAsDataURL(file);
                e.preventDefault();
              }
            }
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
          disabled={!canSend}
          style={{
            padding: "8px 14px", borderRadius: 9,
            background: canSend ? "var(--primary, #3c6663)" : "rgba(60,102,99,0.1)",
            color: canSend ? "#fff" : "rgba(60,102,99,0.4)",
            border: "none", fontSize: 12, fontWeight: 600,
            cursor: canSend ? "pointer" : "not-allowed",
            fontFamily: "inherit", transition: "all 0.15s ease",
            flexShrink: 0, alignSelf: "flex-end",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

const TYPING_ACTIONS = ["…"];

/**
 * Live "agent is working" bubble shown while an LLM call is in-flight.
 * Picks the first agent whose currentAction ends with "…" and shows:
 *   - Their avatar (pulsing ring)
 *   - Action label + elapsed seconds (once > 4s so fast phases feel snappy)
 *   - Three bouncing dots
 */
function TypingBubble({ forum }: { forum: Forum }) {
  const [elapsed, setElapsed] = useState(0);

  const activeAgent = forum.agents.find(a =>
    a.currentAction && TYPING_ACTIONS.some(suffix => a.currentAction!.endsWith(suffix))
  );

  const action = activeAgent?.currentAction ?? "Working…";
  const color = activeAgent?.robeColor || "#4A9E96";

  // Reset timer whenever the active agent or its action changes
  useEffect(() => {
    if (!activeAgent) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [activeAgent?.agentId, action]);

  if (!activeAgent || forum.status !== "active") return null;

  const elapsedLabel = elapsed >= 5 ? ` · ${elapsed}s` : "";

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {/* Avatar with breathing ring */}
      <div style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: rgba(color, 0.15),
        border: `1.5px solid ${rgba(color, 0.5)}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 700, color,
        marginTop: 2,
        animation: "typing-avatar-pulse 2s ease-in-out infinite",
      }}>
        {(activeAgent.name ?? "A").charAt(0).toUpperCase()}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Name + action label */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color }}>{activeAgent.name}</span>
          <span style={{ fontSize: 10, color: "var(--text-sub, #636E72)", opacity: 0.55, fontStyle: "italic" }}>
            {action}{elapsedLabel}
          </span>
        </div>

        {/* Bubble with bouncing dots */}
        <div style={{
          padding: "9px 14px",
          borderRadius: 12, borderTopLeftRadius: 4,
          background: "var(--surface-container-lowest, #fff)",
          border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
          {[0, 0.18, 0.36].map((delay, i) => (
            <span key={i} style={{
              width: 7, height: 7, borderRadius: "50%",
              background: color, opacity: 0.7, display: "inline-block",
              animation: `typing-dot 1.3s ease-in-out ${delay}s infinite`,
            }} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes typing-dot {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes typing-avatar-pulse {
          0%, 100% { box-shadow: 0 0 0 0 ${rgba(color, 0.0)}; }
          50% { box-shadow: 0 0 0 5px ${rgba(color, 0.12)}; }
        }
        @keyframes milestone-pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(74,158,150,0.12), 0 0 12px rgba(74,158,150,0.2); }
          50% { box-shadow: 0 0 0 6px rgba(74,158,150,0.08), 0 0 18px rgba(74,158,150,0.15); }
        }
      `}</style>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ForumThread({ forum, selectedArtifactId, onArtifactClick }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // The typing indicator is visible whenever any agent is working
  const isTyping = forum.status === "active" &&
    forum.agents.some(a => a.currentAction?.endsWith("…"));

  // Auto-scroll on new messages OR when typing indicator appears/disappears
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [forum.messages.length, isTyping]);

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

        {/* Live typing indicator — shown while any agent call is in-flight */}
        <TypingBubble forum={forum} />

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
