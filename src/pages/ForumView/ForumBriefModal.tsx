import React, { useState, useEffect, useRef } from "react";
import { useWorldStore } from "../../store/worldStore";
import { useForumStore, ForumAgent } from "../../store/forumStore";
import { assessForum, AgentScoreWithIsolation } from "./forumCoordinator";
type AgentScore = AgentScoreWithIsolation;
import { LobsterIcon } from "../../components/World/LobsterIcon";

// ─── Styles ───────────────────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(8, 13, 10, 0.85)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  animation: "forum-fade-in 0.25s ease",
};

const card: React.CSSProperties = {
  background: "var(--surface-card, #0F1A15)",
  border: "1px solid rgba(74,158,150,0.25)",
  borderRadius: 20,
  width: "min(680px, 92vw)",
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 32px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(74,158,150,0.1)",
  animation: "forum-slide-up 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

type Step = "brief" | "analyzing" | "volunteers";

// ─── Keyframes injected once ──────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes forum-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes forum-slide-up {
  from { opacity: 0; transform: translateY(24px) scale(0.97) }
  to   { opacity: 1; transform: translateY(0)   scale(1)    }
}
@keyframes volunteer-in {
  from { opacity: 0; transform: translateY(12px) }
  to   { opacity: 1; transform: translateY(0) }
}
@keyframes lobby-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(74,158,150,0.3) }
  50%       { box-shadow: 0 0 0 6px rgba(74,158,150,0) }
}
@keyframes forum-spin {
  from { transform: rotate(0deg) }
  to   { transform: rotate(360deg) }
}
`;

let keyframesInjected = false;
function injectKeyframes() {
  if (keyframesInjected) return;
  const style = document.createElement("style");
  style.textContent = KEYFRAMES;
  document.head.appendChild(style);
  keyframesInjected = true;
}

// ─── Confidence Arc SVG ───────────────────────────────────────────────────────

function ConfidenceArc({ pct, color }: { pct: number; color: string }) {
  const r = 20;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={48} height={48} viewBox="0 0 48 48" style={{ position: "absolute", inset: 0 }}>
      <circle cx={24} cy={24} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3} />
      <circle
        cx={24} cy={24} r={r} fill="none"
        stroke={color} strokeWidth={3}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 24 24)"
        style={{ transition: "stroke-dasharray 0.6s cubic-bezier(0.34,1.56,0.64,1)" }}
      />
    </svg>
  );
}

// ─── Agent Volunteer Card ─────────────────────────────────────────────────────

function AgentVolunteerCard({
  score,
  selected,
  onToggle,
  delay,
}: {
  score: AgentScore;
  selected: boolean;
  onToggle: () => void;
  delay: number;
}) {
  const color = score.robeColor || "#4A9E96";
  const volunteering = score.volunteers;

  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 16px",
        borderRadius: 14,
        cursor: "pointer",
        border: selected
          ? `1.5px solid ${color}`
          : "1.5px solid rgba(255,255,255,0.06)",
        background: selected
          ? `${color}18`
          : volunteering
            ? "rgba(255,255,255,0.03)"
            : "transparent",
        opacity: volunteering ? 1 : 0.55,
        transition: "all 0.2s ease",
        animation: `volunteer-in 0.35s ease both`,
        animationDelay: `${delay}ms`,
        position: "relative",
      }}
      title={volunteering ? undefined : `${score.name} didn't auto-volunteer — you can still add them`}
    >
      {/* Lobster avatar with confidence arc */}
      <div style={{ position: "relative", width: 48, height: 48, flexShrink: 0 }}>
        <ConfidenceArc pct={score.confidence} color={color} />
        <div style={{
          position: "absolute", inset: 4, borderRadius: "50%",
          background: `${color}22`,
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: selected && volunteering ? "lobby-pulse 2s ease-in-out infinite" : "none",
        }}>
          <LobsterIcon size={28} role={score.role} agentImage={score.image} shellColor={color} />
        </div>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main, #F0FDF4)", lineHeight: 1.2 }}>
          {score.name}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-sub, #86EFAC)", opacity: 0.7, marginTop: 2 }}>
          {volunteering ? score.forumRole : "Not auto-matched — tap to add"}
        </div>
        {volunteering && (score as any).rationale && (
          <div style={{ fontSize: 10, color: "var(--text-sub, #86EFAC)", opacity: 0.5, marginTop: 3, fontStyle: "italic", lineHeight: 1.4 }}>
            {(score as any).rationale}
          </div>
        )}
      </div>

      {/* Confidence badge */}
      {volunteering && (
        <div style={{
          fontSize: 12, fontWeight: 700, color: color,
          background: `${color}18`, borderRadius: 8,
          padding: "3px 8px", flexShrink: 0,
          minWidth: 42, textAlign: "center",
        }}>
          {score.confidence}%
        </div>
      )}

      {/* Check indicator */}
      <div style={{
        width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
        background: selected ? color : "transparent",
        border: selected ? `2px solid ${color}` : "2px solid rgba(255,255,255,0.15)",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.15s ease",
      }}>
        {selected && (
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
            <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="#0A0F0D" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function ForumBriefModal({ onClose }: Props) {
  injectKeyframes();

  const agents = useWorldStore(s => s.agents);
  const { setActiveView, setActiveForumId } = useWorldStore();
  const createForum = useForumStore(s => s.createForum);

  const [step, setStep] = useState<Step>("brief");
  const [brief, setBrief] = useState("");
  const [scores, setScores] = useState<AgentScore[]>([]);
  const [isolatedScores, setIsolatedScores] = useState<AgentScore[]>([]);
  const [aiTags, setAiTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isolatedWarningAck, setIsolatedWarningAck] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on open
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 80);
  }, []);

  const handleAnalyze = async () => {
    if (brief.trim().length < 10) return;

    // Show loading state while the coordinator agent reads the brief
    setStep("analyzing");

    try {
      const result = await assessForum(brief, agents);
      setScores(result.scores);
      setIsolatedScores(result.isolatedScores);
      setAiTags(result.tags);
      setIsolatedWarningAck(false);
      // Auto-select top non-isolated volunteers (confidence >= 55) up to 4
      const autoSelect = new Set(
        result.scores.filter(a => !a.isolated && a.volunteers && a.confidence >= 55).slice(0, 4).map(a => a.agentId)
      );
      setSelected(autoSelect);
      setStep("volunteers");
    } catch {
      // assessForum already falls back internally — this shouldn't happen,
      // but if it does, just go back to brief step
      setStep("brief");
    }
  };

  const toggleAgent = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLaunch = () => {
    if (selected.size === 0) return;
    // Use AI-generated tags from coordinator (already set in aiTags)
    const tags = aiTags;
    const allScores = [...scores, ...isolatedScores];
    const forumAgents: ForumAgent[] = allScores
      .filter(s => selected.has(s.agentId))
      .map(s => ({
        agentId: s.agentId,
        name: s.name,
        role: s.role,
        robeColor: s.robeColor,
        accentColor: s.accentColor,
        image: s.image,
        confidence: s.confidence,
        forumRole: s.forumRole,
        isolated: s.isolated,
        currentAction: "Joining project…",
      }));

    const forumId = createForum(brief, forumAgents, tags);
    setActiveForumId(forumId);
    setActiveView("forum");
    onClose();
  };

  const volunteers = scores.filter(s => s.volunteers);
  const bystanders = scores.filter(s => !s.volunteers);
  const hasIsolated = isolatedScores.length > 0;
  const selectedIsolated = isolatedScores.filter(s => selected.has(s.agentId));
  const canLaunch = selected.size >= 1;
  const isAnalyzing = step === "analyzing";

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>

        {/* ── Header ── */}
        <div style={{
          padding: "22px 24px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex", alignItems: "flex-start", gap: 14,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12,
            background: "rgba(74,158,150,0.15)",
            border: "1px solid rgba(74,158,150,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, color: "#4A9E96",
          }}>
            {step === "brief"
              ? <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              : <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            }
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main, #F0FDF4)", lineHeight: 1.2 }}>
              {step === "brief"
                ? "What should your team work on?"
                : step === "analyzing"
                  ? "Assembling your team…"
                  : "Who wants in?"
              }
            </div>
            <div style={{ fontSize: 12, color: "var(--text-sub, #86EFAC)", opacity: 0.6, marginTop: 3 }}>
              {step === "brief"
                ? "Describe a goal. Your lobsters will read the brief and volunteer."
                : step === "analyzing"
                  ? "Your coordinator agent is reading the brief and assessing the team."
                  : `${volunteers.length} agent${volunteers.length !== 1 ? "s" : ""} are ready for this brief — pick your team.`
              }
            </div>
          </div>
          {/* Step indicator — 3 dots */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4A9E96" }} />
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: step === "analyzing" || step === "volunteers" ? "#4A9E96" : "rgba(255,255,255,0.12)" }} />
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: step === "volunteers" ? "#4A9E96" : "rgba(255,255,255,0.12)" }} />
          </div>
        </div>

        {/* ── Step 1: Brief entry ── */}
        {step === "brief" && (
          <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <textarea
              ref={textareaRef}
              value={brief}
              onChange={e => setBrief(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAnalyze();
              }}
              placeholder="e.g. Research the top 3 cloud providers and write a board-ready competitive memo. We're a Series B moving upmarket."
              rows={5}
              style={{
                width: "100%", resize: "none",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12, padding: "14px 16px",
                color: "var(--text-main, #F0FDF4)",
                fontSize: 14, lineHeight: 1.6,
                fontFamily: "inherit", outline: "none",
                transition: "border-color 0.15s ease",
              }}
              onFocus={e => (e.target.style.borderColor = "rgba(74,158,150,0.5)")}
              onBlur={e => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
            />

            {/* Example prompts */}
            <div>
              <div style={{ fontSize: 10, color: "var(--text-sub, #86EFAC)", opacity: 0.4, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Quick starts
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[
                  "Research and summarize our top 3 competitors",
                  "Draft a memo on our Q3 strategy",
                  "Build a landing page for our new feature",
                  "Prepare for the board meeting next Thursday",
                ].map(ex => (
                  <button
                    key={ex}
                    onClick={() => setBrief(ex)}
                    style={{
                      padding: "5px 10px", borderRadius: 8, fontSize: 11,
                      background: "transparent", cursor: "pointer",
                      border: "1px solid rgba(255,255,255,0.1)",
                      color: "var(--text-sub, #86EFAC)", opacity: 0.7,
                      transition: "all 0.15s ease",
                    }}
                    onMouseEnter={e => { (e.target as HTMLButtonElement).style.opacity = "1"; (e.target as HTMLButtonElement).style.borderColor = "rgba(74,158,150,0.4)"; }}
                    onMouseLeave={e => { (e.target as HTMLButtonElement).style.opacity = "0.7"; (e.target as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.1)"; }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-sub, #86EFAC)", opacity: 0.4 }}>
                {brief.length > 0 ? `${brief.trim().split(/\s+/).length} words · ⌘↵ to continue` : "Be descriptive — more context = better matching"}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={onClose}
                  style={{
                    padding: "8px 16px", borderRadius: 10, fontSize: 13, cursor: "pointer",
                    background: "transparent", color: "var(--text-sub, #86EFAC)",
                    border: "1px solid rgba(255,255,255,0.1)", fontFamily: "inherit",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleAnalyze}
                  disabled={brief.trim().length < 10 || isAnalyzing}
                  style={{
                    padding: "8px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                    cursor: (brief.trim().length < 10 || isAnalyzing) ? "not-allowed" : "pointer",
                    background: (brief.trim().length >= 10 && !isAnalyzing) ? "#4A9E96" : "rgba(74,158,150,0.2)",
                    color: (brief.trim().length >= 10 && !isAnalyzing) ? "#fff" : "rgba(255,255,255,0.3)",
                    border: "none", fontFamily: "inherit",
                    transition: "all 0.2s ease",
                    boxShadow: (brief.trim().length >= 10 && !isAnalyzing) ? "0 4px 16px rgba(74,158,150,0.3)" : "none",
                  }}
                >
                  Assemble Team →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 1.5: Analyzing / coordinator is reading the brief ── */}
        {step === "analyzing" && (
          <div style={{ padding: "40px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
            {/* Spinner */}
            <div style={{ position: "relative", width: 56, height: 56 }}>
              <svg viewBox="0 0 56 56" width={56} height={56} style={{ animation: "forum-spin 1.2s linear infinite", transformOrigin: "center" }}>
                <circle cx={28} cy={28} r={22} fill="none" stroke="rgba(74,158,150,0.15)" strokeWidth={3} />
                <circle cx={28} cy={28} r={22} fill="none" stroke="#4A9E96" strokeWidth={3}
                  strokeDasharray="40 98" strokeLinecap="round"
                  transform="rotate(-90 28 28)"
                />
              </svg>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-main, #F0FDF4)", marginBottom: 8 }}>
                Your team is reading the brief…
              </div>
              <div style={{ fontSize: 12, color: "var(--text-sub, #86EFAC)", opacity: 0.55, lineHeight: 1.6 }}>
                Your coordinator agent is assessing which team members<br />
                are best suited to this brief. This takes a moment.
              </div>
            </div>
            {/* Brief recap */}
            <div style={{
              background: "rgba(74,158,150,0.07)", border: "1px solid rgba(74,158,150,0.15)",
              borderRadius: 10, padding: "10px 14px",
              fontSize: 12, color: "var(--text-sub, #86EFAC)", lineHeight: 1.5,
              maxWidth: 420, textAlign: "left",
              display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
            } as React.CSSProperties}>
              <span style={{ opacity: 0.45, marginRight: 6 }}>Brief:</span>{brief}
            </div>
          </div>
        )}

        {/* ── Step 2: Volunteer / bidding screen ── */}
        {step === "volunteers" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

            {/* Brief recap pill */}
            <div style={{ padding: "12px 24px 0" }}>
              <div style={{
                background: "rgba(74,158,150,0.08)", border: "1px solid rgba(74,158,150,0.2)",
                borderRadius: 10, padding: "8px 14px",
                fontSize: 12, color: "var(--text-sub, #86EFAC)",
                lineHeight: 1.5,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>
                <span style={{ opacity: 0.5, marginRight: 6 }}>Brief:</span>{brief}
              </div>
            </div>

            {/* Agent list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 24px", display: "flex", flexDirection: "column", gap: 6 }}>
              {volunteers.length > 0 && (
                <>
                  <div style={{ fontSize: 10, color: "#4A9E96", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4, opacity: 0.7 }}>
                    Volunteering · {volunteers.length}
                  </div>
                  {volunteers.map((s, i) => (
                    <AgentVolunteerCard
                      key={s.agentId}
                      score={s}
                      selected={selected.has(s.agentId)}
                      onToggle={() => toggleAgent(s.agentId)}
                      delay={i * 50}
                    />
                  ))}
                </>
              )}

              {bystanders.length > 0 && (
                <>
                  <div style={{ fontSize: 10, color: "var(--text-sub, #86EFAC)", textTransform: "uppercase", letterSpacing: "0.07em", marginTop: 8, marginBottom: 4, opacity: 0.35 }}>
                    Also available · {bystanders.length}
                  </div>
                  {bystanders.map((s, i) => (
                    <AgentVolunteerCard
                      key={s.agentId}
                      score={s}
                      selected={selected.has(s.agentId)}
                      onToggle={() => toggleAgent(s.agentId)}
                      delay={volunteers.length * 50 + i * 40}
                    />
                  ))}
                </>
              )}

              {/* ── Isolated agents — restricted section ── */}
              {hasIsolated && (
                <div style={{ marginTop: 12 }}>
                  {/* Warning banner */}
                  <div style={{
                    marginBottom: 8,
                    padding: "10px 13px",
                    borderRadius: 10,
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.2)",
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth={2.5} strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#EF4444", marginBottom: 3 }}>
                          Isolated agents — data exposure risk
                        </div>
                        <div style={{ fontSize: 11, color: "rgba(239,68,68,0.8)", lineHeight: 1.5 }}>
                          These agents have access to sensitive integrations (e.g. financial accounts, property data).
                          In a project, their responses are shared with other agents — your private data could appear in the shared workspace.
                          Only include them if you understand and accept this risk.
                        </div>
                      </div>
                    </div>
                    {/* Acknowledgement checkbox */}
                    <label style={{
                      display: "flex", alignItems: "center", gap: 8,
                      marginTop: 10, cursor: "pointer",
                      fontSize: 11, color: "rgba(239,68,68,0.8)",
                    }}>
                      <input
                        type="checkbox"
                        checked={isolatedWarningAck}
                        onChange={e => {
                          setIsolatedWarningAck(e.target.checked);
                          // Deselect isolated agents if unchecking
                          if (!e.target.checked) {
                            setSelected(prev => {
                              const next = new Set(prev);
                              isolatedScores.forEach(s => next.delete(s.agentId));
                              return next;
                            });
                          }
                        }}
                        style={{ accentColor: "#EF4444", width: 13, height: 13, cursor: "pointer" }}
                      />
                      I understand that this agent's sensitive data may appear in the shared project context
                    </label>
                  </div>

                  <div style={{
                    fontSize: 10, color: "#EF4444", textTransform: "uppercase",
                    letterSpacing: "0.07em", marginBottom: 4, opacity: 0.7,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    Restricted · {isolatedScores.length}
                  </div>

                  {isolatedScores.map((s, i) => (
                    <div key={s.agentId} style={{ opacity: isolatedWarningAck ? 1 : 0.4, transition: "opacity 0.2s ease" }}>
                      <AgentVolunteerCard
                        score={s}
                        selected={selected.has(s.agentId)}
                        onToggle={() => {
                          if (!isolatedWarningAck) return; // blocked until ack
                          toggleAgent(s.agentId);
                        }}
                        delay={volunteers.length * 50 + bystanders.length * 40 + i * 40}
                      />
                    </div>
                  ))}
                </div>
              )}

              {agents.length === 0 && (
                <div style={{ textAlign: "center", padding: "40px 0", color: "var(--text-sub, #86EFAC)", opacity: 0.4 }}>
                  No agents yet. Create some lobsters first.
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{
              padding: "14px 24px",
              borderTop: "1px solid rgba(255,255,255,0.06)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <button
                onClick={() => setStep("brief")}
                style={{
                  padding: "8px 14px", borderRadius: 10, fontSize: 13, cursor: "pointer",
                  background: "transparent", color: "var(--text-sub, #86EFAC)",
                  border: "1px solid rgba(255,255,255,0.1)", fontFamily: "inherit",
                }}
              >
                ← Edit brief
              </button>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {selected.size > 0 && (
                  <span style={{ fontSize: 12, color: "#4A9E96", opacity: 0.8 }}>
                    {selected.size} agent{selected.size !== 1 ? "s" : ""} selected
                  </span>
                )}
                <button
                  onClick={handleLaunch}
                  disabled={!canLaunch}
                  style={{
                    padding: "8px 22px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                    cursor: canLaunch ? "pointer" : "not-allowed",
                    background: canLaunch ? "#4A9E96" : "rgba(74,158,150,0.2)",
                    color: canLaunch ? "#fff" : "rgba(255,255,255,0.3)",
                    border: "none", fontFamily: "inherit",
                    transition: "all 0.2s ease",
                    boxShadow: canLaunch ? "0 4px 16px rgba(74,158,150,0.35)" : "none",
                  }}
                >
                  Open Project →
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
