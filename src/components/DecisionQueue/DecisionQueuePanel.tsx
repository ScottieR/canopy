/**
 * DecisionQueuePanel.tsx
 *
 * Slide-in panel showing all pending decisions across all agents.
 * Opened by clicking the inbox badge in TopNav.
 *
 * Sections:
 *   1. Needs action (pre_auth, needs_input) — sorted by urgency then recency
 *   2. FYI / completed — autonomous actions taken while you were away
 *   3. Errors — things that need attention but differently
 */

import React, { useMemo } from "react";
import { useWorldStore, PendingDecision } from "../../store/worldStore";
import { DecisionCard } from "./DecisionCard";

function IconInbox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 12, padding: 40, textAlign: "center" }}>
      <div style={{ width: 48, height: 48, borderRadius: "50%", background: "rgba(74,158,150,0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "#4A9E96" }}>
        <IconInbox />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-main)" }}>All clear</div>
      <div style={{ fontSize: 13, color: "var(--text-sub)", maxWidth: 220, lineHeight: 1.5 }}>
        Your agents are working autonomously. You'll be notified here when they need something.
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  decisions: PendingDecision[];
  color?: string;
}

function Section({ title, decisions, color }: SectionProps) {
  if (decisions.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
        textTransform: "uppercase", color: color || "var(--text-muted)",
        paddingBottom: 4, borderBottom: "1px solid var(--border-subtle)",
      }}>
        {title} · {decisions.length}
      </div>
      {decisions.map(d => <DecisionCard key={d.id} decision={d} />)}
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function DecisionQueuePanel({ onClose }: Props) {
  const { pendingDecisions, clearDecisions } = useWorldStore();

  const { actionable, completed, errors } = useMemo(() => {
    const urgencyOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const byUrgencyThenRecency = (a: PendingDecision, b: PendingDecision) => {
      const ua = urgencyOrder[a.urgency || "low"];
      const ub = urgencyOrder[b.urgency || "low"];
      if (ua !== ub) return ua - ub;
      return b.createdAt - a.createdAt;
    };

    return {
      actionable: pendingDecisions.filter(d => d.type === "pre_auth" || d.type === "needs_input").sort(byUrgencyThenRecency),
      completed:  pendingDecisions.filter(d => d.type === "completed").sort((a, b) => b.createdAt - a.createdAt),
      errors:     pendingDecisions.filter(d => d.type === "error").sort((a, b) => b.createdAt - a.createdAt),
    };
  }, [pendingDecisions]);

  const hasAny = pendingDecisions.length > 0;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 800,
          background: "rgba(0,0,0,0.15)", backdropFilter: "blur(2px)",
        }}
      />

      {/* Panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 801,
        width: 420, background: "var(--surface-card)",
        borderLeft: "1px solid var(--border-subtle)",
        display: "flex", flexDirection: "column",
        boxShadow: "-16px 0 48px rgba(0,0,0,0.12)",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 20px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex", alignItems: "center", gap: 10,
          flexShrink: 0,
        }}>
          <div style={{ color: "#4A9E96" }}><IconInbox /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>
              Decision Queue
            </div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 1 }}>
              {hasAny
                ? `${pendingDecisions.length} item${pendingDecisions.length !== 1 ? "s" : ""} · ${actionable.length} need${actionable.length !== 1 ? "" : "s"} action`
                : "Nothing pending"}
            </div>
          </div>
          {hasAny && (
            <button
              onClick={() => clearDecisions()}
              style={{
                fontSize: 11, color: "var(--text-muted)", background: "none",
                border: "none", cursor: "pointer", padding: "4px 8px",
                borderRadius: 6, fontWeight: 600,
              }}
            >
              Clear all
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              background: "var(--surface-base)", border: "1px solid var(--border-subtle)",
              borderRadius: 8, width: 30, height: 30, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "var(--text-sub)", fontSize: 16, fontWeight: 300,
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          {!hasAny
            ? <EmptyState />
            : (
              <>
                <Section title="Needs your action" decisions={actionable} color="#D4A04A" />
                <Section title="Errors" decisions={errors} color="#E57373" />
                <Section title="Completed while away" decisions={completed} color="#4A9E96" />
              </>
            )
          }
        </div>
      </div>
    </>
  );
}
