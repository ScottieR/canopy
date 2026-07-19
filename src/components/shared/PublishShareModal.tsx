// ─── Publish & Share modal (Workstream E) ────────────────────────────────────
// Explicit, per-artifact publishing of a self-contained HTML mini-app.
// Hard rules (persona review §8):
//   • Data-disclosure preview BEFORE first publish — the app embeds forum data.
//   • Static-only validation client-side; friendly rejection copy, never a dead end.
//   • Revocation always available for a published link.

import React, { useEffect, useMemo, useState } from "react";
import {
  describeShareViolations,
  publishShareArtifact,
  revokeShareArtifact,
  validateShareableHtml,
} from "../../utils/sharePublish";
import { fireActivationEvent } from "../../store/worldStore";

const SHARES_STORAGE_KEY = "canopy_published_shares";

type StoredShare = { id: string; url: string; title: string; publishedAt: number };

function loadStoredShares(): Record<string, StoredShare> {
  try {
    return JSON.parse(localStorage.getItem(SHARES_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStoredShare(key: string, share: StoredShare | null) {
  const all = loadStoredShares();
  if (share) all[key] = share;
  else delete all[key];
  try {
    localStorage.setItem(SHARES_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota — non-fatal */
  }
}

export function PublishShareModal({
  isOpen,
  onClose,
  html,
  title,
  agentName,
  shareKey,
}: {
  isOpen: boolean;
  onClose: () => void;
  html: string;
  title: string;
  agentName: string;
  /** Stable key for remembering the published link (e.g. `forum_{id}`). */
  shareKey: string;
}) {
  const [phase, setPhase] = useState<"review" | "publishing" | "published" | "error">("review");
  const [errorMsg, setErrorMsg] = useState("");
  const [share, setShare] = useState<StoredShare | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const validation = useMemo(() => validateShareableHtml(html), [html]);

  useEffect(() => {
    if (!isOpen) return;
    const existing = loadStoredShares()[shareKey] || null;
    setShare(existing);
    setPhase(existing ? "published" : "review");
    setErrorMsg("");
    setCopied(false);
  }, [isOpen, shareKey]);

  if (!isOpen) return null;

  const handlePublish = async () => {
    setPhase("publishing");
    setErrorMsg("");
    try {
      const result = await publishShareArtifact({ html, title, agentName });
      const stored: StoredShare = { ...result, title, publishedAt: Date.now() };
      saveStoredShare(shareKey, stored);
      setShare(stored);
      setPhase("published");
      fireActivationEvent("artifact_published", { shareKey });
    } catch (e) {
      setPhase("error");
      const raw = String(e);
      setErrorMsg(
        raw.includes("share_service_unconfigured")
          ? "Sharing isn't enabled in this build."
          : raw.includes("publish_rejected")
            ? "The share service declined this app. It may reference something non-static — ask the agents for a fully self-contained version."
            : "Couldn't reach the share service. Check your connection and try again."
      );
      fireActivationEvent("artifact_publish_failed", { shareKey });
    }
  };

  const handleRevoke = async () => {
    if (!share) return;
    setRevoking(true);
    try {
      await revokeShareArtifact(share.id);
      saveStoredShare(shareKey, null);
      setShare(null);
      setPhase("review");
      fireActivationEvent("artifact_share_revoked", { shareKey });
    } catch (e) {
      setErrorMsg("Couldn't revoke the link right now. Try again in a moment.");
    } finally {
      setRevoking(false);
    }
  };

  const card: React.CSSProperties = {
    background: "var(--surface-base, #fff)",
    padding: 28,
    borderRadius: 20,
    width: 480,
    maxWidth: "92vw",
    boxShadow: "0 20px 40px rgba(0,0,0,0.25)",
    textAlign: "left",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-main, #2D3436)" }}>Publish &amp; Share</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 20, color: "var(--text-sub, #636E72)" }}>&times;</button>
        </div>

        {phase === "review" && (
          <>
            {!validation.ok ? (
              <>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-main, #2D3436)", marginBottom: 16 }}>
                  {describeShareViolations(validation.violations)}
                </div>
                <button onClick={onClose} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.12)", background: "transparent", color: "var(--text-main, #2D3436)", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                  Got it
                </button>
              </>
            ) : (
              <>
                {/* Data disclosure — required before first publish. */}
                <div style={{ padding: 14, borderRadius: 12, background: "rgba(212,160,74,0.1)", border: "1px solid rgba(212,160,74,0.3)", fontSize: 13, lineHeight: 1.6, color: "var(--text-main, #2D3436)", marginBottom: 14 }}>
                  <strong>Anyone with the link can open this app</strong> — including all
                  the data inside it (numbers, names, research your agents put in).
                  The link is unlisted and unguessable, and you can revoke it anytime.
                  It runs fully offline for viewers: no tracking, no network.
                </div>
                <div style={{ fontSize: 13, color: "var(--text-sub, #636E72)", marginBottom: 6 }}>Publishing:</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main, #2D3436)", marginBottom: 18 }}>
                  {title || "Untitled deliverable"}
                  <span style={{ fontWeight: 400, color: "var(--text-sub, #636E72)" }}> · built by {agentName || "your agents"}</span>
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={onClose} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.12)", background: "transparent", color: "var(--text-main, #2D3436)", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                    Cancel
                  </button>
                  <button onClick={handlePublish} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "linear-gradient(135deg, #3c6663, #609995)", color: "#fff", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>
                    Publish link
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {phase === "publishing" && (
          <div style={{ textAlign: "center", padding: "18px 0" }}>
            <div style={{ margin: "0 auto 14px", width: 34, height: 34, border: "4px solid rgba(60,102,99,0.2)", borderTopColor: "#3c6663", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <div style={{ fontSize: 14, color: "var(--text-sub, #636E72)" }}>Publishing…</div>
          </div>
        )}

        {phase === "published" && share && (
          <>
            <div style={{ fontSize: 14, color: "var(--text-main, #2D3436)", marginBottom: 10 }}>
              Live — anyone with this link can use the app:
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                readOnly
                value={share.url}
                onFocus={e => e.target.select()}
                style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.15)", fontSize: 13, fontFamily: "monospace", color: "var(--text-main, #2D3436)", background: "rgba(0,0,0,0.03)" }}
              />
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(share.url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  } catch { /* clipboard denied */ }
                }}
                style={{ padding: "10px 16px", borderRadius: 10, border: "none", background: "linear-gradient(135deg, #3c6663, #609995)", color: "#fff", cursor: "pointer", fontWeight: 700, fontFamily: "inherit", minWidth: 84 }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            {errorMsg && <div style={{ fontSize: 13, color: "#B91C1C", marginBottom: 10 }}>{errorMsg}</div>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid rgba(185,28,28,0.35)", background: "transparent", color: "#B91C1C", cursor: revoking ? "default" : "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit", opacity: revoking ? 0.6 : 1 }}
              >
                {revoking ? "Revoking…" : "Revoke link"}
              </button>
              <button
                onClick={handlePublish}
                style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.12)", background: "transparent", color: "var(--text-main, #2D3436)", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit" }}
                title="Publish the current version to a fresh link"
              >
                Republish latest
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-main, #2D3436)", marginBottom: 16 }}>{errorMsg}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.12)", background: "transparent", color: "var(--text-main, #2D3436)", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                Close
              </button>
              <button onClick={handlePublish} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "linear-gradient(135deg, #3c6663, #609995)", color: "#fff", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
