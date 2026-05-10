import React, { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Eye, AlertTriangle, X, KeyRound } from "lucide-react";

/**
 * Global listener + UI for two agent → user signals:
 *
 *   1. **Attention requests** (`agent_attention_requested`)
 *      Fire-and-forget toasts. The agent says "please look at my browser" and the user
 *      can either click "Show browser" (which calls `show_browser` for that agent) or
 *      dismiss. Used for CAPTCHA, 2FA, "is this the right page?" moments.
 *
 *   2. **Permission requests** (`agent_permission_requested`)
 *      Blocking modal. The agent asks for a capability/integration/domain it doesn't
 *      have. The user picks one of: Once / This Session / Forever / Deny. The Tauri
 *      backend (`resolve_permission_request`) handles the persistence semantics.
 *
 * Mount this component once at the app root. It manages its own state.
 */

type AttentionToast = {
    request_id: string;
    agent_id: string;
    reason: string;
    requested_at: string;
};

type PermissionPrompt = {
    request_id: string;
    agent_id: string;
    permission_id: string;
    justification: string;
};

const TOAST_TIMEOUT_MS = 25_000;

export function AgentRequestNotifier({
    agents,
}: {
    /**
     * Optional roster of {id, name} so the notifier can show "Sloane wants…" instead
     * of the raw agent ID. If omitted, the agent ID is shown.
     */
    agents?: Array<{ id: string; name: string }>;
}) {
    const [attentionToasts, setAttentionToasts] = useState<AttentionToast[]>([]);
    const [pendingPermission, setPendingPermission] = useState<PermissionPrompt | null>(null);

    const nameFor = useCallback((agentId: string) => {
        return agents?.find(a => a.id === agentId)?.name ?? agentId;
    }, [agents]);

    // Subscribe to attention-request events.
    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen<AttentionToast>("agent_attention_requested", (event) => {
            const payload = event.payload;
            setAttentionToasts(prev => {
                // Coalesce — if this agent already has an outstanding toast, replace
                // it with the latest reason rather than stacking duplicates.
                const filtered = prev.filter(t => t.agent_id !== payload.agent_id);
                return [payload, ...filtered].slice(0, 3); // cap at 3 visible toasts
            });
            // Auto-expire after a generous window so a missed notification doesn't sit forever.
            setTimeout(() => {
                setAttentionToasts(prev => prev.filter(t => t.request_id !== payload.request_id));
            }, TOAST_TIMEOUT_MS);
        }).then(f => { unlisten = f; });
        return () => { if (unlisten) unlisten(); };
    }, []);

    // Subscribe to permission-request events.
    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen<PermissionPrompt>("agent_permission_requested", (event) => {
            // We only show one permission modal at a time. If another fires while one is
            // open, the second one is dropped — the agent will time out and re-request
            // when the first is resolved. Stacking modals would be confusing.
            setPendingPermission(prev => prev ?? event.payload);
        }).then(f => { unlisten = f; });
        return () => { if (unlisten) unlisten(); };
    }, []);

    const handleShowBrowser = useCallback(async (toast: AttentionToast) => {
        try {
            await invoke("show_browser", { agentId: toast.agent_id });
        } catch (e) {
            console.error("show_browser failed:", e);
        }
        setAttentionToasts(prev => prev.filter(t => t.request_id !== toast.request_id));
    }, []);

    const handleDismissToast = useCallback((toast: AttentionToast) => {
        setAttentionToasts(prev => prev.filter(t => t.request_id !== toast.request_id));
    }, []);

    const handlePermissionDecision = useCallback(async (decision: "once" | "session" | "forever" | "deny") => {
        if (!pendingPermission) return;
        try {
            await invoke("resolve_permission_request", {
                requestId: pendingPermission.request_id,
                decision,
                agentId: pendingPermission.agent_id,
                permissionId: pendingPermission.permission_id,
            });
        } catch (e) {
            console.error("resolve_permission_request failed:", e);
        }
        setPendingPermission(null);
    }, [pendingPermission]);

    return (
        <>
            {/* Stack of attention toasts in the bottom-right corner. */}
            <div
                style={{
                    position: "fixed",
                    bottom: 24,
                    right: 24,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    zIndex: 9000,
                    maxWidth: 360,
                }}
            >
                {attentionToasts.map(toast => (
                    <div
                        key={toast.request_id}
                        role="alert"
                        style={{
                            background: "#1a1f1a",
                            color: "#e8efe8",
                            border: "1px solid #2d3a2d",
                            borderRadius: 12,
                            padding: 14,
                            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                            display: "flex",
                            gap: 10,
                            alignItems: "flex-start",
                        }}
                    >
                        <div style={{
                            background: "#2a3a2a", borderRadius: "50%",
                            width: 32, height: 32, flexShrink: 0,
                            display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                            <Eye size={16} color="#7fc4a0" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                                {nameFor(toast.agent_id)} needs you to look
                            </div>
                            <div style={{ fontSize: 12, color: "#c8d0c8", marginBottom: 10, lineHeight: 1.4, wordWrap: "break-word" }}>
                                {toast.reason || "Visual confirmation needed."}
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                                <button
                                    onClick={() => handleShowBrowser(toast)}
                                    style={{
                                        background: "#3c6663", color: "#fff", border: "none",
                                        borderRadius: 6, padding: "6px 12px", fontSize: 12,
                                        fontWeight: 600, cursor: "pointer",
                                    }}
                                >
                                    Show browser
                                </button>
                                <button
                                    onClick={() => handleDismissToast(toast)}
                                    style={{
                                        background: "transparent", color: "#8a9a8a",
                                        border: "1px solid #2d3a2d", borderRadius: 6,
                                        padding: "6px 12px", fontSize: 12, fontWeight: 600,
                                        cursor: "pointer",
                                    }}
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                        <button
                            onClick={() => handleDismissToast(toast)}
                            aria-label="Close"
                            style={{
                                background: "transparent", border: "none", color: "#8a9a8a",
                                cursor: "pointer", padding: 2, display: "flex",
                            }}
                        >
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>

            {/* Modal for blocking permission requests. */}
            {pendingPermission && (
                <PermissionModal
                    prompt={pendingPermission}
                    agentName={nameFor(pendingPermission.agent_id)}
                    onDecide={handlePermissionDecision}
                />
            )}
        </>
    );
}

function PermissionModal({
    prompt,
    agentName,
    onDecide,
}: {
    prompt: PermissionPrompt;
    agentName: string;
    onDecide: (decision: "once" | "session" | "forever" | "deny") => void;
}) {
    const isDomain = prompt.permission_id.startsWith("domain:");
    const displayPermission = isDomain
        ? prompt.permission_id.slice("domain:".length)
        : prompt.permission_id;
    const verb = isDomain ? "navigate to" : "use";

    return (
        <div
            role="dialog"
            aria-modal="true"
            style={{
                position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
                display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 9500,
            }}
        >
            <div style={{
                background: "#1a1f1a", color: "#e8efe8",
                border: "1px solid #2d3a2d", borderRadius: 12,
                padding: 24, width: 480, maxWidth: "calc(100vw - 32px)",
                boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
            }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                    <div style={{
                        background: "#3a2a1a", borderRadius: "50%",
                        width: 36, height: 36, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                        <KeyRound size={18} color="#f0a060" />
                    </div>
                    <div>
                        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
                            {agentName} is requesting permission
                        </h2>
                        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#c8d0c8" }}>
                            They want to {verb} <strong style={{ fontFamily: "monospace" }}>{displayPermission}</strong>.
                        </p>
                    </div>
                </div>

                <div style={{
                    background: "#0f130f", border: "1px solid #2a352a",
                    borderRadius: 8, padding: 12, marginBottom: 18,
                }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#8a9a8a", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                        Their reason
                    </div>
                    <div style={{ fontSize: 13, color: "#d0d8d0", lineHeight: 1.5 }}>
                        {prompt.justification || "(no justification provided)"}
                    </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <button onClick={() => onDecide("once")} style={btnStyle("#2a3a2a")}>
                        Allow once
                    </button>
                    <button onClick={() => onDecide("session")} style={btnStyle("#2a3a2a")}>
                        Allow this session
                    </button>
                    <button onClick={() => onDecide("forever")} style={btnStyle("#3c6663")}>
                        Allow forever
                    </button>
                    <button onClick={() => onDecide("deny")} style={btnStyle("#5a3030")}>
                        Deny
                    </button>
                </div>

                <div style={{ fontSize: 11, color: "#8a9a8a", lineHeight: 1.4 }}>
                    <strong>Allow once</strong> grants a single use. <strong>This session</strong> until the gateway restarts.
                    <strong> Forever</strong> persists to {agentName}'s permissions.
                </div>
            </div>
        </div>
    );
}

function btnStyle(bg: string): React.CSSProperties {
    return {
        background: bg,
        color: "#fff",
        border: "none",
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
    };
}

export default AgentRequestNotifier;
