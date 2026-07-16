import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorldStore } from "../../store/worldStore";

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
}

const KIND_OPTIONS = [
  { value: "bug", label: "Bug" },
  { value: "feature_request", label: "Feature request" },
  { value: "ux_pain", label: "UX pain point" },
  { value: "other", label: "Other" },
];

export function FeedbackModal({ open, onClose }: FeedbackModalProps) {
  const { activeView, selectedAgent, agents } = useWorldStore();
  const [kind, setKind] = useState("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const selectableAgents = useMemo(
    () => agents.map((agent) => ({ id: agent.id, label: `${agent.name} (${agent.role})` })),
    [agents]
  );

  useEffect(() => {
    if (!open) return;
    setKind("bug");
    setTitle("");
    setDescription("");
    setAgentId(selectedAgent ?? "");
    setIncludeDiagnostics(true);
    setError("");
  }, [open, selectedAgent]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await invoke("submit_feedback_report", {
        submission: {
          kind,
          title,
          description,
          agentId: agentId || null,
          currentView: activeView,
          includeDiagnostics,
        },
      });
      window.dispatchEvent(new Event("feedback_reports_updated"));
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 5000,
        background: "rgba(0,0,0,0.48)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        style={{
          width: 640,
          maxWidth: "100%",
          background: "var(--surface-card)",
          borderRadius: 18,
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 24px 56px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-main)" }}>Send feedback</h2>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-sub)" }}>
                This creates an internal feedback report and can be routed to an engineer from Profile.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--text-sub)",
                fontSize: 20,
                cursor: submitting ? "default" : "pointer",
              }}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div style={{ padding: 24, display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Type</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "var(--surface-base)",
                  color: "var(--text-main)",
                  fontFamily: "inherit",
                }}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Related agent</span>
              <select
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "var(--surface-base)",
                  color: "var(--text-main)",
                  fontFamily: "inherit",
                }}
              >
                <option value="">No specific agent</option>
                {selectableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Short summary"
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.12)",
                background: "var(--surface-base)",
                color: "var(--text-main)",
                fontFamily: "inherit",
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Details</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What happened, what you expected, and what you want changed."
              rows={7}
              style={{
                padding: "12px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.12)",
                background: "var(--surface-base)",
                color: "var(--text-main)",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(event) => setIncludeDiagnostics(event.target.checked)}
            />
            <span style={{ fontSize: 13, color: "var(--text-main)" }}>
              Include app, view, and related-agent diagnostics
            </span>
          </label>

          {error && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                background: "rgba(220,38,38,0.08)",
                border: "1px solid rgba(220,38,38,0.2)",
                color: "#b91c1c",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "16px 24px 24px",
            display: "flex",
            justifyContent: "flex-end",
            gap: 12,
            borderTop: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "transparent",
              color: "var(--text-main)",
              fontWeight: 600,
              cursor: submitting ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              background: "#3c6663",
              color: "#fff",
              fontWeight: 700,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.75 : 1,
            }}
          >
            {submitting ? "Sending..." : "Send feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}
