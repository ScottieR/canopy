import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, X } from "lucide-react";
import { AuthErrorDialog } from "../AuthErrorDialog";
import {
    getAgentProviderSecretSlot,
    openClawProviderIdToLabel,
    syncAgentProviderCredentials,
    type OpenClawProviderId,
} from "../../security/providerCredentials";

/**
 * Always-visible, in-app fallback for fixing a dead LLM credential — the path
 * that doesn't depend on Slack being reachable (unlike Eddy's remote recovery
 * link in `CredentialRecoverySection`) and covers every provider, including
 * OpenAI/xAI which Eddy's flow doesn't handle at all.
 *
 * Listens for the same `agent_provider_auth_failed` event that already drives
 * `AgentRequestNotifier`'s global modal, filtered to this agent, and offers an
 * inline "Re-enter credentials" action (reusing `AuthErrorDialog`) so fixing
 * it never requires navigating into Skills & Access, let alone a terminal.
 */

type AuthFailurePayload = {
    agent_id: string | null;
    provider: OpenClawProviderId;
    detail: string;
};

const PROVIDER_DISPLAY: Record<OpenClawProviderId, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    gemini: "Google Gemini",
    grok: "xAI Grok",
};

function isAuthFailurePayload(value: unknown): value is AuthFailurePayload {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return (
        (v.agent_id === null || typeof v.agent_id === "string") &&
        typeof v.provider === "string" &&
        v.provider in PROVIDER_DISPLAY
    );
}

// AuthErrorDialog's provider prop uses "xai"; the event payload and
// PROVIDER_DISPLAY above use "grok" (OpenClaw's canonical id) — everywhere
// else in this file/the backend agrees, only this one dialog differs.
function toAuthDialogProvider(id: OpenClawProviderId): "anthropic" | "openai" | "gemini" | "xai" {
    return id === "grok" ? "xai" : id;
}

export function MissingCredentialBanner({ agentId }: { agentId: string }) {
    const [failure, setFailure] = useState<AuthFailurePayload | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    useEffect(() => {
        let isMounted = true;
        let unlistenFns: Array<() => void> = [];

        (async () => {
            try {
                const unlisteners = await Promise.all([
                    listen<AuthFailurePayload>("agent_provider_auth_failed", (e) => {
                        if (isAuthFailurePayload(e.payload) && e.payload.agent_id === agentId) {
                            setFailure(e.payload);
                        }
                    }),
                    // Eddy's Slack-based recovery fixing the same credential should
                    // clear this banner too, not just its own status pill.
                    listen<{ agentId: string }>("credential_recovery_resolved", (e) => {
                        if (e.payload.agentId === agentId) setFailure(null);
                    }),
                ]);
                if (isMounted) {
                    unlistenFns = unlisteners;
                } else {
                    unlisteners.forEach((f) => {
                        try { f(); } catch { /* already gone */ }
                    });
                }
            } catch (e) {
                console.warn("Missing-credential banner listener setup failed", e);
            }
        })();

        return () => {
            isMounted = false;
            unlistenFns.forEach((f) => {
                try { f(); } catch { /* already gone */ }
            });
        };
    }, [agentId]);

    if (!failure) return null;

    const providerLabel = PROVIDER_DISPLAY[failure.provider] || failure.provider;

    return (
        <>
            <div style={{
                marginTop: 10, padding: "10px 12px", borderRadius: 10,
                background: "rgba(198,40,40,0.06)", border: "1px solid rgba(198,40,40,0.22)",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, color: "#C62828" }} />
                    <span style={{
                        fontSize: 12, color: "var(--text-main)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                        <strong>{providerLabel}</strong> credentials need attention
                    </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <button
                        onClick={() => setDialogOpen(true)}
                        style={{
                            fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 8,
                            border: "none", background: "#C62828", color: "white", cursor: "pointer",
                        }}
                    >
                        Re-enter credentials
                    </button>
                    <button
                        onClick={() => setFailure(null)}
                        title="Dismiss (if you already fixed this elsewhere)"
                        style={{
                            display: "flex", background: "transparent", border: "none",
                            color: "var(--text-sub)", cursor: "pointer", padding: 2,
                        }}
                    >
                        <X size={13} />
                    </button>
                </div>
            </div>
            {dialogOpen && (
                <AuthErrorDialog
                    error={failure.detail || `Your ${providerLabel} credentials are missing or expired.`}
                    provider={toAuthDialogProvider(failure.provider)}
                    onCancel={() => setDialogOpen(false)}
                    onRetry={async (apiKey) => {
                        const slot = getAgentProviderSecretSlot(agentId, openClawProviderIdToLabel(failure.provider));
                        await invoke("store_secret_cmd", { key: slot, value: apiKey });
                        await syncAgentProviderCredentials(invoke, agentId);
                        setFailure(null);
                        setDialogOpen(false);
                    }}
                />
            )}
        </>
    );
}
