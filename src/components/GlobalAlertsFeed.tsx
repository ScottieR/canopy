import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldAlert, X, AlertTriangle, Play } from "lucide-react";
import { useWorldStore } from "../store/worldStore";

interface SecurityAlert {
    id: string;
    agent_id: string;
    timestamp: string;
    severity: string;
    description: string;
    resolved: boolean;
}

export function GlobalAlertsFeed({ onClose }: { onClose: () => void }) {
    const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
    const { agents, setAgents } = useWorldStore();

    const loadAlerts = async () => {
        try {
            const data = await invoke<SecurityAlert[]>("get_network_security_alerts");
            setAlerts(data);
        } catch (e) {
            console.error(e);
        }
    };

    useEffect(() => {
        let isPolling = false;
        const safePoll = async () => {
            if (isPolling) return;
            isPolling = true;
            try { await loadAlerts(); } 
            finally { isPolling = false; }
        };
        safePoll();
        const interval = setInterval(safePoll, 5000);
        return () => clearInterval(interval);
    }, []);

    const handleResolve = async (id: string) => {
        await invoke("resolve_network_security_alert", { alertId: id });
        loadAlerts();
    };

    const handleUnpause = async (agentId: string) => {
        try {
            await invoke("set_agent_paused", { agentId, paused: false });
            setAgents(agents.map(a => a.id === agentId ? { ...a, paused: false } : a));
        } catch (e) {
            console.error("Failed to unpause agent:", e);
        }
    };

    return (
        <div style={{
            position: "fixed", top: 0, right: 0, bottom: 0, width: 400,
            background: "var(--surface-base)", borderLeft: "1px solid var(--border-subtle)",
            boxShadow: "-10px 0 30px rgba(0,0,0,0.1)", zIndex: 10000,
            display: "flex", flexDirection: "column"
        }}>
            <div style={{ padding: 20, borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ShieldAlert size={20} color="#DC2626" />
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: "var(--text-main)" }}>Security Alerts</h2>
                </div>
                <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                    <X size={20} />
                </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                {alerts.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                        <ShieldAlert size={40} style={{ opacity: 0.2, marginBottom: 12 }} />
                        <div style={{ fontSize: 14, fontWeight: 600 }}>No Active Alerts</div>
                        <div style={{ fontSize: 13 }}>Network egress is clean.</div>
                    </div>
                ) : alerts.map(alert => {
                    const agent = agents.find(a => a.id === alert.agent_id);
                    const isPaused = agent?.paused;
                    
                    return (
                        <div key={alert.id} style={{
                            background: "var(--surface-card)", border: "1px solid #FCA5A5", borderRadius: 12, overflow: "hidden"
                        }}>
                            <div style={{ background: "#FEF2F2", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #FCA5A5" }}>
                                <AlertTriangle size={18} color="#DC2626" />
                                <div style={{ fontSize: 13, fontWeight: 700, color: "#DC2626" }}>{alert.severity} Risk Detected</div>
                            </div>
                            <div style={{ padding: 16 }}>
                                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Agent: {agent?.name || alert.agent_id}</div>
                                <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.5, marginBottom: 16 }}>
                                    {alert.description}
                                </div>
                                
                                {isPaused && (
                                    <div style={{ marginBottom: 16, padding: "10px 12px", background: "rgba(220,38,38,0.1)", borderRadius: 8, fontSize: 12, color: "#B91C1C", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                                        Agent was automatically paused.
                                    </div>
                                )}

                                <div style={{ display: "flex", gap: 8 }}>
                                    <button 
                                        onClick={() => handleResolve(alert.id)}
                                        style={{ flex: 1, padding: "8px 0", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--text-main)" }}
                                    >
                                        Dismiss
                                    </button>
                                    {isPaused && (
                                        <button 
                                            onClick={() => handleUnpause(alert.agent_id)}
                                            style={{ flex: 1, padding: "8px 0", background: "#218380", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "white", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                                        >
                                            <Play size={14} /> Unpause Agent
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
