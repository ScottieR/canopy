import React, { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Eye, AlertTriangle, X, KeyRound } from "lucide-react";

/**
 * Global listener + UI for agent → user signals:
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
 *   3. **Chrome control confirmations** (`agent_chrome_control_confirmation_requested`)
 *      Blocking modal, Tier 6 (Full Chrome Control) only. Unlike permission requests
 *      this is NOT a one-time capability grant — every single navigate/click/type/read
 *      action against the user's real, already-logged-in Chrome fires its own prompt,
 *      because a standing "always allow" would be a blank check against a browser that
 *      has no domain allowlist or blocklist of its own (beyond the fixed financial/
 *      medical block on click/type). The Tauri backend
 *      (`resolve_chrome_control_confirmation`) just unblocks the waiting Rust call;
 *      there's no persistence to manage here.
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

type ChromeControlPrompt = {
    request_id: string;
    agent_id: string;
    action_description: string;
};

type ConnectionPrompt = {
    agent_id: string;
    service: string;
    rationale: string;
};

type PaymentApproval = {
    approval: {
        id: string;
        agent_id: string;
        purchase_record_id: string;
        purchase_request: {
            description: string;
            merchant: string;
            amount_cents: number;
            category: string;
        };
        reason: string;
        flags: string[];
        status: "pending" | "approved" | "denied" | "expired";
    };
    agent_name: string;
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
    const [pendingChromeControl, setPendingChromeControl] = useState<ChromeControlPrompt | null>(null);
    const [pendingConnection, setPendingConnection] = useState<ConnectionPrompt | null>(null);
    const [pendingPaymentApproval, setPendingPaymentApproval] = useState<PaymentApproval | null>(null);

    const nameFor = useCallback((agentId: string) => {
        return agents?.find(a => a.id === agentId)?.name ?? agentId;
    }, [agents]);

    // Subscribe to attention-request events.
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;
        let isMounted = true;

        async function setup() {
            try {
                const { listen } = await import("@tauri-apps/api/event");
                if (!isMounted) return;
                
                const unlisten = await listen<AttentionToast>("agent_attention_requested", (event) => {
                    // Defensive: a malformed payload from the Rust side should not crash
                    // the React tree (we saw white-screen incidents while the app sat idle).
                    try {
                        const payload = event?.payload;
                        if (!payload || typeof payload.request_id !== "string" || typeof payload.agent_id !== "string") {
                            console.warn("agent_attention_requested: malformed payload, ignoring", payload);
                            return;
                        }
                        setAttentionToasts(prev => {
                            const filtered = prev.filter(t => t.agent_id !== payload.agent_id);
                            return [payload, ...filtered].slice(0, 3);
                        });
                        setTimeout(() => {
                            setAttentionToasts(prev => prev.filter(t => t.request_id !== payload.request_id));
                        }, TOAST_TIMEOUT_MS);
                    } catch (err) {
                        console.warn("agent_attention_requested handler error:", err);
                    }
                });

                if (isMounted) {
                    unlistenFn = unlisten;
                } else {
                    try { unlisten(); } catch (e) {}
                }
            } catch (e) {
                console.warn("Attention listener setup failed", e);
            }
        }
        setup();

        return () => {
            isMounted = false;
            if (unlistenFn) {
                try { unlistenFn(); } catch (e) {}
                unlistenFn = undefined;
            }
        };
    }, []);

    useEffect(() => {
        let unlistenFn: (() => void) | undefined;
        let isMounted = true;

        async function setup() {
            try {
                const { listen } = await import("@tauri-apps/api/event");
                if (!isMounted) return;

                const unlisten = await listen<PaymentApproval>("payment_approval_requested", (event) => {
                    try {
                        const payload = event?.payload;
                        if (!payload?.approval?.id || !payload?.approval?.agent_id) {
                            console.warn("payment_approval_requested: malformed payload, ignoring", payload);
                            return;
                        }
                        setPendingPaymentApproval(prev => prev ?? payload);
                    } catch (err) {
                        console.warn("payment_approval_requested handler error:", err);
                    }
                });

                if (isMounted) {
                    unlistenFn = unlisten;
                } else {
                    try { unlisten(); } catch (e) {}
                }
            } catch (e) {
                console.warn("Payment approval listener setup failed", e);
            }
        }
        setup();

        return () => {
            isMounted = false;
            if (unlistenFn) {
                try { unlistenFn(); } catch (e) {}
                unlistenFn = undefined;
            }
        };
    }, []);

    // Subscribe to permission-request events.
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;
        let isMounted = true;

        async function setup() {
            try {
                const { listen } = await import("@tauri-apps/api/event");
                if (!isMounted) return;
                
                const unlisten = await listen<PermissionPrompt>("agent_permission_requested", (event) => {
                    try {
                        const payload = event?.payload;
                        if (!payload || typeof payload.request_id !== "string" || typeof payload.agent_id !== "string" || typeof payload.permission_id !== "string") {
                            console.warn("agent_permission_requested: malformed payload, ignoring", payload);
                            return;
                        }
                        setPendingPermission(prev => prev ?? payload);
                    } catch (err) {
                        console.warn("agent_permission_requested handler error:", err);
                    }
                });

                if (isMounted) {
                    unlistenFn = unlisten;
                } else {
                    try { unlisten(); } catch (e) {}
                }
            } catch (e) {
                console.warn("Permission listener setup failed", e);
            }
        }
        setup();

        return () => {
            isMounted = false;
            if (unlistenFn) {
                try { unlistenFn(); } catch (e) {}
                unlistenFn = undefined;
            }
        };
    }, []);

    // Subscribe to Tier 6 (Full Chrome Control) per-action confirmation requests. A new
    // one can arrive while another is still pending (the agent could theoretically fire
    // several action calls back to back) — queue them rather than dropping any, since a
    // dropped confirmation request silently times out to "denied" on the Rust side after
    // 120s, which would be a confusing failure mode for the agent to debug.
    const [chromeControlQueue, setChromeControlQueue] = useState<ChromeControlPrompt[]>([]);
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;
        let isMounted = true;

        async function setup() {
            try {
                const { listen } = await import("@tauri-apps/api/event");
                if (!isMounted) return;

                const unlisten = await listen<ChromeControlPrompt>("agent_chrome_control_confirmation_requested", (event) => {
                    try {
                        const payload = event?.payload;
                        if (!payload || typeof payload.request_id !== "string" || typeof payload.agent_id !== "string" || typeof payload.action_description !== "string") {
                            console.warn("agent_chrome_control_confirmation_requested: malformed payload, ignoring", payload);
                            return;
                        }
                        setChromeControlQueue(prev => [...prev, payload]);
                    } catch (err) {
                        console.warn("agent_chrome_control_confirmation_requested handler error:", err);
                    }
                });

                if (isMounted) {
                    unlistenFn = unlisten;
                } else {
                    try { unlisten(); } catch (e) {}
                }
            } catch (e) {
                console.warn("Chrome control listener setup failed", e);
            }
        }
        setup();

        return () => {
            isMounted = false;
            if (unlistenFn) {
                try { unlistenFn(); } catch (e) {}
                unlistenFn = undefined;
            }
        };
    }, []);

    // Surface one Chrome-control prompt at a time from the queue.
    useEffect(() => {
        if (!pendingChromeControl && chromeControlQueue.length > 0) {
            setPendingChromeControl(chromeControlQueue[0]);
            setChromeControlQueue(prev => prev.slice(1));
        }
    }, [pendingChromeControl, chromeControlQueue]);

    // Subscribe to connection-request events.
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;
        let isMounted = true;

        async function setup() {
            try {
                const { listen } = await import("@tauri-apps/api/event");
                if (!isMounted) return;

                const unlisten = await listen<ConnectionPrompt>("RequestConnection", (event) => {
                    try {
                        const payload = event?.payload;
                        if (!payload || typeof payload.agent_id !== "string" || typeof payload.service !== "string") {
                            console.warn("RequestConnection: malformed payload, ignoring", payload);
                            return;
                        }
                        setPendingConnection(prev => prev ?? payload);
                    } catch (err) {
                        console.warn("RequestConnection handler error:", err);
                    }
                });

                if (isMounted) {
                    unlistenFn = unlisten;
                } else {
                    try { unlisten(); } catch (e) {}
                }
            } catch (e) {
                console.warn("Connection listener setup failed", e);
            }
        }
        setup();

        return () => {
            isMounted = false;
            if (unlistenFn) {
                try { unlistenFn(); } catch (e) {}
                unlistenFn = undefined;
            }
        };
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

    const handleChromeControlDecision = useCallback(async (approved: boolean) => {
        if (!pendingChromeControl) return;
        try {
            await invoke("resolve_chrome_control_confirmation", {
                requestId: pendingChromeControl.request_id,
                approved,
            });
        } catch (e) {
            console.error("resolve_chrome_control_confirmation failed:", e);
        }
        setPendingChromeControl(null);
    }, [pendingChromeControl]);

    const handleConnectionDecision = useCallback(async (decision: "connect" | "deny") => {
        if (!pendingConnection) return;
        if (decision === "connect") {
            try {
                const { useWorldStore } = await import("../../store/worldStore");
                useWorldStore.getState().setSelectedAgent(pendingConnection.agent_id);
                useWorldStore.getState().setActiveView("architect");
            } catch (e) {
                console.error("Failed to navigate to architect view", e);
            }
        }
        setPendingConnection(null);
    }, [pendingConnection]);

    const handlePaymentDecision = useCallback(async (decision: "approve" | "deny") => {
        if (!pendingPaymentApproval) return;
        try {
            if (decision === "approve") {
                await invoke("approve_purchase", {
                    approvalId: pendingPaymentApproval.approval.id,
                });
            } else {
                await invoke("deny_purchase", {
                    approvalId: pendingPaymentApproval.approval.id,
                });
            }
        } catch (e) {
            console.error("payment approval resolution failed:", e);
        }
        setPendingPaymentApproval(null);
    }, [pendingPaymentApproval]);

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

            {/* Modal for blocking connection requests. */}
            {pendingConnection && (
                <ConnectionModal
                    prompt={pendingConnection}
                    agentName={nameFor(pendingConnection.agent_id)}
                    onDecide={handleConnectionDecision}
                />
            )}

            {pendingPaymentApproval && (
                <PaymentApprovalModal
                    prompt={pendingPaymentApproval}
                    onDecide={handlePaymentDecision}
                />
            )}

            {/* Modal for blocking Tier 6 (Full Chrome Control) per-action confirmations. */}
            {pendingChromeControl && (
                <ChromeControlModal
                    prompt={pendingChromeControl}
                    agentName={nameFor(pendingChromeControl.agent_id)}
                    queueDepth={chromeControlQueue.length}
                    onDecide={handleChromeControlDecision}
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

function ChromeControlModal({
    prompt,
    agentName,
    queueDepth,
    onDecide,
}: {
    prompt: ChromeControlPrompt;
    agentName: string;
    queueDepth: number;
    onDecide: (approved: boolean) => void;
}) {
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
                        background: "#3a1a1a", borderRadius: "50%",
                        width: 36, height: 36, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                        <AlertTriangle size={18} color="#e07050" />
                    </div>
                    <div>
                        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
                            {agentName} wants to control your Chrome
                        </h2>
                        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#c8d0c8" }}>
                            This is your real, already-logged-in browser — every action happens immediately and for real.
                        </p>
                    </div>
                </div>

                <div style={{
                    background: "#0f130f", border: "1px solid #2a352a",
                    borderRadius: 8, padding: 12, marginBottom: 18,
                }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#8a9a8a", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                        Requested action
                    </div>
                    <div style={{ fontSize: 13, color: "#d0d8d0", lineHeight: 1.5, wordBreak: "break-word" }}>
                        {prompt.action_description}
                    </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <button onClick={() => onDecide(true)} style={btnStyle("#3c6663")}>
                        Allow this action
                    </button>
                    <button onClick={() => onDecide(false)} style={btnStyle("#5a3030")}>
                        Deny
                    </button>
                </div>

                <div style={{ fontSize: 11, color: "#8a9a8a", lineHeight: 1.4 }}>
                    This decision covers only this one action — {agentName} will ask again for the next step.
                    {queueDepth > 0 && ` ${queueDepth} more request${queueDepth === 1 ? " is" : "s are"} waiting behind this one.`}
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

function ConnectionModal({
    prompt,
    agentName,
    onDecide,
}: {
    prompt: ConnectionPrompt;
    agentName: string;
    onDecide: (decision: "connect" | "deny") => void;
}) {
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
                        <KeyRound size={18} color="#64C8C0" />
                    </div>
                    <div>
                        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
                            {agentName} requests connection to {prompt.service}
                        </h2>
                        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#c8d0c8" }}>
                            The agent needs this service to continue their work.
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
                        {prompt.rationale || "(no rationale provided)"}
                    </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <button onClick={() => onDecide("connect")} style={btnStyle("#3c6663")}>
                        Configure Connection securely
                    </button>
                    <button onClick={() => onDecide("deny")} style={btnStyle("#5a3030")}>
                        Deny
                    </button>
                </div>

                <div style={{ fontSize: 11, color: "#8a9a8a", lineHeight: 1.4, textAlign: "center", marginTop: 12 }}>
                    <strong>Secure Modal</strong>: The agent will not have access to any tokens you provide.
                </div>
            </div>
        </div>
    );
}

export function PaymentApprovalModal({
    prompt,
    onDecide,
}: {
    prompt: PaymentApproval;
    onDecide: (decision: "approve" | "deny") => void;
}) {
    const amount = (prompt.approval.purchase_request.amount_cents || 0) / 100;
    const flags = Array.isArray(prompt.approval.flags) ? prompt.approval.flags : [];

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
                padding: 24, width: 520, maxWidth: "calc(100vw - 32px)",
                boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
            }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                    <div style={{
                        background: "#3a2a1a", borderRadius: "50%",
                        width: 36, height: 36, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                        <AlertTriangle size={18} color="#f0a060" />
                    </div>
                    <div>
                        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
                            {prompt.agent_name} needs payment approval
                        </h2>
                        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#c8d0c8" }}>
                            Review this purchase request before the agent can continue.
                        </p>
                    </div>
                </div>

                <div style={{
                    background: "#0f130f", border: "1px solid #2a352a",
                    borderRadius: 8, padding: 12, marginBottom: 18,
                    display: "grid", gap: 8,
                }}>
                    <div style={{ fontSize: 13 }}><strong>Description:</strong> {prompt.approval.purchase_request.description}</div>
                    <div style={{ fontSize: 13 }}><strong>Merchant:</strong> {prompt.approval.purchase_request.merchant}</div>
                    <div style={{ fontSize: 13 }}><strong>Category:</strong> {prompt.approval.purchase_request.category}</div>
                    <div style={{ fontSize: 13 }}><strong>Amount:</strong> ${amount.toFixed(2)}</div>
                    <div style={{ fontSize: 13, color: "#d0d8d0", lineHeight: 1.5 }}>
                        <strong>Reason:</strong> {prompt.approval.reason}
                    </div>
                </div>

                {flags.length > 0 && (
                    <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {flags.map(flag => (
                            <span
                                key={flag}
                                style={{
                                    fontSize: 11,
                                    padding: "4px 8px",
                                    borderRadius: 999,
                                    background: "rgba(240,160,96,0.15)",
                                    color: "#f0a060",
                                    border: "1px solid rgba(240,160,96,0.25)",
                                }}
                            >
                                {flag}
                            </span>
                        ))}
                    </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <button onClick={() => onDecide("approve")} style={btnStyle("#3c6663")}>
                        Approve purchase
                    </button>
                    <button onClick={() => onDecide("deny")} style={btnStyle("#5a3030")}>
                        Deny purchase
                    </button>
                </div>
            </div>
        </div>
    );
}

export default AgentRequestNotifier;
