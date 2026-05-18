/**
 * DecisionCard.tsx
 *
 * A single card in the decision queue. Displayed both in the full
 * DecisionQueuePanel and (condensed) inside the ActivityTab pending section.
 *
 * Types:
 *   pre_auth  — agent wants approval before acting ("Send now / Schedule / Cancel")
 *   needs_input — agent is blocked, needs a specific answer
 *   completed — FYI: agent took autonomous action ("Great, got it / View details")
 *   error     — something broke that needs attention
 */

import React, { useState } from "react";
import { PendingDecision, useWorldStore } from "../../store/worldStore";

// ─── Icons (inline SVG — no extra dependency) ────────────────────────────────

function IconQuestion() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_META: Record<PendingDecision["type"], {
  icon: React.ReactNode;
  color: string;
  bg: string;
  label: string;
}> = {
  pre_auth:    { icon: <IconQuestion />, color: "#D4A04A", bg: "rgba(212,160,74,0.1)",  label: "Awaiting approval" },
  needs_input: { icon: <IconQuestion />, color: "#8B6AAE", bg: "rgba(139,106,174,0.1)", label: "Needs your input" },
  completed:   { icon: <IconCheck />,    color: "#4A9E96", bg: "rgba(74,158,150,0.1)",  label: "Completed" },
  error:       { icon: <IconAlert />,    color: "#E57373", bg: "rgba(229,115,115,0.1)", label: "Needs attention" },
};

const URGENCY_DOT: Record<string, string> = {
  high:   "#E57373",
  medium: "#D4A04A",
  low:    "#4A9E96",
};

// ─── Relative time helper ─────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  decision: PendingDecision;
  compact?: boolean; // condensed mode for ActivityTab banner
}

export function DecisionCard({ decision, compact = false }: Props) {
  const { resolveDecision, dismissDecision } = useWorldStore();
  const [resolved, setResolved] = useState(false);
  const [pickedValue, setPickedValue] = useState<string | null>(null);

  const meta = TYPE_META[decision.type];

  const handleOption = (value: string) => {
    setPickedValue(value);
    setResolved(true);
    // Brief visual confirmation before removing from queue
    setTimeout(() => resolveDecision(decision.id, value), 400);
  };

  const handleDismiss = () => {
    setResolved(true);
    setTimeout(() => dismissDecision(decision.id), 200);
  };

  return (
    <div
      style={{
        background: "var(--surface-card)",
        border: `1px solid ${meta.color}30`,
        borderRadius: 14,
        padding: compact ? "12px 14px" : "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: compact ? 8 : 12,
        opacity: resolved ? 0 : 1,
        transform: resolved ? "scale(0.97)" : "scale(1)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
        position: "relative",
      }}
    >
      {/* ── Header row: agent + type badge + time + dismiss ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Agent avatar */}
        <div style={{
          width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
          background: decision.agentRobeColor || "var(--border-subtle)",
          overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {decision.agentImage
            ? <img src={decision.agentImage} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{decision.agentName[0]}</span>
          }
        </div>

        {/* Agent name */}
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", flex: 1 }}>
          {decision.agentName}
        </span>

        {/* Urgency dot */}
        {decision.urgency && decision.urgency !== "low" && (
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: URGENCY_DOT[decision.urgency],
            boxShadow: `0 0 6px ${URGENCY_DOT[decision.urgency]}80`,
          }} />
        )}

        {/* Type badge */}
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20,
          background: meta.bg, color: meta.color,
          display: "flex", alignItems: "center", gap: 4,
        }}>
          {meta.icon}
          {meta.label}
        </span>

        {/* Time */}
        <span style={{ fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          {relativeTime(decision.createdAt)}
        </span>

        {/* Dismiss */}
        <button
          onClick={handleDismiss}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", padding: 2, borderRadius: 4,
            display: "flex", alignItems: "center",
          }}
          title="Dismiss"
        >
          <IconClose />
        </button>
      </div>

      {/* ── Context (what the agent was doing) ── */}
      {!compact && decision.context && (
        <div style={{
          fontSize: 11, color: "var(--text-sub)", fontStyle: "italic",
          padding: "4px 8px", background: "var(--surface-base)",
          borderRadius: 6, borderLeft: `2px solid ${meta.color}40`,
        }}>
          {decision.context}
        </div>
      )}

      {/* ── Question / headline ── */}
      <div style={{ fontSize: compact ? 13 : 14, fontWeight: 600, color: "var(--text-main)", lineHeight: 1.4 }}>
        {decision.question}
      </div>

      {/* ── Detail ── */}
      {!compact && decision.detail && (
        <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
          {decision.detail}
        </div>
      )}

      {/* ── Action buttons ── */}
      {decision.options.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {decision.options.map((opt) => {
            const isPrimary = opt.style === "primary";
            const isDanger  = opt.style === "danger";
            const isPicked  = pickedValue === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handleOption(opt.value)}
                style={{
                  padding: compact ? "5px 12px" : "7px 16px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: isPrimary
                    ? "none"
                    : isDanger
                      ? `1px solid ${isPicked ? "#E57373" : "rgba(229,115,115,0.4)"}`
                      : "1px solid var(--border-subtle)",
                  background: isPrimary
                    ? (isPicked ? "#2d7a77" : "#3c6663")
                    : isDanger
                      ? (isPicked ? "rgba(229,115,115,0.15)" : "transparent")
                      : (isPicked ? "var(--border-subtle)" : "transparent"),
                  color: isPrimary
                    ? "#fff"
                    : isDanger
                      ? "#E57373"
                      : "var(--text-main)",
                  transition: "all 0.15s ease",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Dismiss-only case: single "Got it" */}
      {decision.options.length === 0 && (
        <button
          onClick={handleDismiss}
          style={{
            padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
            border: "1px solid var(--border-subtle)", background: "transparent",
            color: "var(--text-sub)", cursor: "pointer", alignSelf: "flex-start",
          }}
        >
          Got it
        </button>
      )}
    </div>
  );
}
