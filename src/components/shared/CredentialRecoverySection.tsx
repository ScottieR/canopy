import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { KeyRound, RefreshCw } from "lucide-react";

/**
 * Shows Eddy's credential-recovery status for one agent — last failure time,
 * whether the Slack link is still pending / was completed / expired, and a
 * "Regenerate link" button. Renders nothing when the agent has no recovery
 * history, so it stays invisible on healthy agents' cards.
 *
 * Backed by `agent_health::get_credential_recovery_status` /
 * `agent_health::regenerate_credential_recovery_link` (Rust), driven by the
 * `credential_recovery_triggered` / `credential_recovery_resolved` events those
 * emit.
 */

type RecoveryStatus = {
    agentId: string;
    provider: string;
    status: "pending" | "completed" | "expired";
    url: string;
    triggeredAt: string;
    expiresAt: string;
};

const PROVIDER_LABELS: Record<string, string> = {
    anthropic: "Anthropic",
    gemini: "Google",
    openai: "OpenAI",
    grok: "xAI",
};

function relativeTime(iso: string): string {
    const deltaMs = Date.now() - new Date(iso).getTime();
    const minutes = Math.round(deltaMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function isRecoveryStatus(value: unknown): value is RecoveryStatus {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.status === "string" &&
        (v.status === "pending" || v.status === "completed" || v.status === "expired") &&
        typeof v.provider === "string" &&
        typeof v.triggeredAt === "string"
    );
}

const STATUS_STYLE: Record<RecoveryStatus["status"], { bg: string; fg: string; label: string }> = {
    pending: { bg: "#F5A62315", fg: "#F5A623", label: "Link sent — waiting" },
    completed: { bg: "#34D39915", fg: "#34D399", label: "Resolved" },
    expired: { bg: "#EF444415", fg: "#EF4444", label: "Link expired" },
};

export function CredentialRecoverySection({ agentId }: { agentId: string }) {
    const [status, setStatus] = useState<RecoveryStatus | null>(null);
    const [regenerating, setRegenerating] = useState(false);

    const refresh = useCallback(() => {
        invoke<RecoveryStatus | null>("get_credential_recovery_status", { agentId })
            .then((result) => setStatus(isRecoveryStatus(result) ? result : null))
            .catch(() => setStatus(null));
    }, [agentId]);

    useEffect(() => {
        refresh();
        let isMounted = true;
        let unlistenFns: Array<() => void> = [];

        (async () => {
            try {
                const onEvent = (e: { payload: { agentId: string } }) => {
                    if (e.payload.agentId === agentId) refresh();
                };
                const unlisteners = await Promise.all([
                    listen<{ agentId: string }>("credential_recovery_triggered", onEvent),
                    listen<{ agentId: string }>("credential_recovery_resolved", onEvent),
                ]);
                if (isMounted) {
                    unlistenFns = unlisteners;
                } else {
                    unlisteners.forEach((f) => {
                        try { f(); } catch { /* already gone */ }
                    });
                }
            } catch (e) {
                console.warn("Credential recovery listener setup failed", e);
            }
        })();

        return () => {
            isMounted = false;
            unlistenFns.forEach((f) => {
                try { f(); } catch { /* already gone */ }
            });
        };
    }, [agentId, refresh]);

    if (!status) return null;

    const style = STATUS_STYLE[status.status];
    const providerLabel = PROVIDER_LABELS[status.provider] || status.provider;

    const handleRegenerate = () => {
        setRegenerating(true);
        invoke<RecoveryStatus>("regenerate_credential_recovery_link", { agentId, provider: status.provider })
            .then((result) => {
                if (isRecoveryStatus(result)) setStatus(result);
            })
            .catch(() => {})
            .finally(() => setRegenerating(false));
    };

    return (
        <div style={{
            marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-subtle)",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-sub)", minWidth: 0 }}>
                <KeyRound size={13} style={{ flexShrink: 0, color: style.fg }} />
                <span style={{
                    padding: "2px 7px", borderRadius: 999, fontSize: 10, fontWeight: 600,
                    background: style.bg, color: style.fg, flexShrink: 0,
                }}>
                    {style.label}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {providerLabel} · {relativeTime(status.triggeredAt)}
                </span>
            </div>
            {status.status !== "completed" && (
                <button
                    onClick={handleRegenerate}
                    disabled={regenerating}
                    style={{
                        display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                        fontSize: 11, fontWeight: 600, padding: "4px 8px", borderRadius: 8,
                        border: "1px solid var(--border-subtle)", background: "transparent",
                        color: "var(--text-main)", cursor: regenerating ? "default" : "pointer",
                        opacity: regenerating ? 0.6 : 1,
                    }}
                >
                    <RefreshCw size={11} />
                    Regenerate link
                </button>
            )}
        </div>
    );
}
