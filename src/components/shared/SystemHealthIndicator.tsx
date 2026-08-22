import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ChevronDown, ChevronUp, X } from "lucide-react";

/**
 * Startup-subsystem health indicator.
 *
 * Backend startup tasks (JIT auth server, mobile dispatch relay, keychain,
 * Slack token lookup) report into the Rust `system_health` registry. This
 * component subscribes to the `system-health-changed` event (full snapshot
 * payload) plus an initial `get_system_health` fetch, and renders NOTHING
 * while everything is ok — the whole point is that historically these
 * failures were log-only and invisible.
 *
 * When something is degraded/failed it shows a small pill in the bottom-left
 * corner, expandable to a list of what's wrong and what the user can do
 * about it ("port 18802 in use — is another copy of Canopy running?").
 *
 * Mount once at the app root.
 */

export type ComponentHealth = {
    component: string;
    status: "ok" | "degraded" | "failed";
    reason?: string;
    remediation?: string;
};

/** Display names for known component ids; unknown ids fall back to the raw id. */
const COMPONENT_LABELS: Record<string, string> = {
    jit_server: "Agent authorization server",
    dispatch: "Mobile dispatch relay",
    keychain: "Keychain access",
    slack: "Slack connection",
};

export function SystemHealthIndicator() {
    const [components, setComponents] = useState<ComponentHealth[]>([]);
    const [expanded, setExpanded] = useState(false);
    // Dismissal is per-snapshot: a new problem (or a status change) resurfaces the pill.
    const [dismissedKey, setDismissedKey] = useState<string | null>(null);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        let gotEvent = false;
        const setup = async () => {
            const stop = await listen<ComponentHealth[]>("system-health-changed", (event) => {
                gotEvent = true;
                setComponents(event.payload ?? []);
            });
            if (cancelled) {
                stop();
                return;
            }
            unlisten = stop;
            try {
                // Catch-up fetch for reports that happened before this component
                // mounted. An event snapshot is always at least as fresh, so if
                // one already arrived, don't overwrite it.
                const snapshot = await invoke<ComponentHealth[]>("get_system_health");
                if (!cancelled && !gotEvent && Array.isArray(snapshot)) setComponents(snapshot);
            } catch (e) {
                console.warn("[system-health] initial snapshot fetch failed:", e);
            }
        };
        setup().catch((e) => console.error("[system-health] listener setup failed:", e));
        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, []);

    const problems = components.filter((c) => c.status !== "ok");
    if (problems.length === 0) return null;

    const snapshotKey = problems.map((p) => `${p.component}:${p.status}`).join("|");
    if (dismissedKey === snapshotKey) return null;

    const hasFailure = problems.some((p) => p.status === "failed");

    return (
        <div className="fixed bottom-4 left-4 z-[90] max-w-sm text-sm" role="status">
            {expanded && (
                <div className="mb-2 rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 shadow-xl backdrop-blur">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="font-medium text-zinc-100">System status</span>
                        <button
                            aria-label="Dismiss system status"
                            className="text-zinc-400 hover:text-zinc-100"
                            onClick={() => {
                                setExpanded(false);
                                setDismissedKey(snapshotKey);
                            }}
                        >
                            <X size={14} />
                        </button>
                    </div>
                    <ul className="space-y-3">
                        {problems.map((p) => (
                            <li key={p.component}>
                                <div className="flex items-center gap-2">
                                    <span
                                        className={`inline-block h-2 w-2 rounded-full ${
                                            p.status === "failed" ? "bg-red-400" : "bg-amber-400"
                                        }`}
                                    />
                                    <span className="font-medium text-zinc-100">
                                        {COMPONENT_LABELS[p.component] ?? p.component}
                                    </span>
                                </div>
                                {p.reason && <p className="mt-1 text-zinc-300">{p.reason}</p>}
                                {p.remediation && (
                                    <p className="mt-1 text-zinc-400">{p.remediation}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <button
                aria-label={`${problems.length} system ${problems.length === 1 ? "issue" : "issues"} detected`}
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-zinc-200 shadow-lg backdrop-blur hover:bg-zinc-800"
            >
                <AlertTriangle
                    size={14}
                    className={hasFailure ? "text-red-400" : "text-amber-400"}
                />
                <span>
                    {problems.length} system {problems.length === 1 ? "issue" : "issues"}
                </span>
                {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
        </div>
    );
}
