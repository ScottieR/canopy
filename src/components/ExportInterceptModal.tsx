import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeBinaryFile } from '@tauri-apps/plugin-fs';
import { AlertTriangle, CheckCircle, ShieldAlert, X, Shield, FileText } from 'lucide-react';

export function ExportInterceptModal() {
    const [request, setRequest] = useState<any>(null);
    const [overrideText, setOverrideText] = useState("");

    useEffect(() => {
        const unlisten = listen('file_export_requested', (event) => {
            setRequest(event.payload);
            setOverrideText("");
        });
        return () => {
            unlisten.then(f => f());
        };
    }, []);

    if (!request) return null;

    const report = request.threat_report;
    const isHighRisk = report.risk_level === 'High' || report.risk_level === 'Critical';

    const handleAction = async (approved: boolean) => {
        if (!approved) {
            await invoke('resolve_export_request', { requestId: request.request_id, approved: false });
            setRequest(null);
            return;
        }

        try {
            const filePath = await save({
                defaultPath: request.filename,
                title: "Save Agent Export"
            });

            if (filePath) {
                // Determine if content is base64 or raw. 
                // We'll attempt base64 decode. If it fails, assume raw string.
                let byteArray: Uint8Array;
                try {
                    const byteString = atob(request.content);
                    byteArray = new Uint8Array(byteString.length);
                    for (let i = 0; i < byteString.length; i++) {
                        byteArray[i] = byteString.charCodeAt(i);
                    }
                } catch (e) {
                    const encoder = new TextEncoder();
                    byteArray = encoder.encode(request.content);
                }

                await writeBinaryFile(filePath, byteArray);
                await invoke('resolve_export_request', { requestId: request.request_id, approved: true });
            } else {
                await invoke('resolve_export_request', { requestId: request.request_id, approved: false });
            }
        } catch (e) {
            console.error("Failed to save file:", e);
            await invoke('resolve_export_request', { requestId: request.request_id, approved: false });
        }
        setRequest(null);
    };

    return (
        <div style={{
            position: "fixed", inset: 0, zIndex: 99999,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center"
        }}>
            <div style={{
                background: isHighRisk ? "#FEF2F2" : "var(--surface-card)",
                border: isHighRisk ? "2px solid #DC2626" : "1px solid var(--border-subtle)",
                borderRadius: 20, width: 480, overflow: "hidden",
                boxShadow: "0 24px 48px rgba(0,0,0,0.2)"
            }}>
                <div style={{ padding: "20px 24px", borderBottom: isHighRisk ? "1px solid #FCA5A5" : "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 12, background: isHighRisk ? "#DC2626" : "var(--surface-base)", color: isHighRisk ? "white" : "var(--text-main)" }}>
                    {isHighRisk ? <ShieldAlert size={24} /> : <Shield size={24} color="#218380" />}
                    <div>
                        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{isHighRisk ? "Malicious File Blocked" : "File Export Request"}</h2>
                        <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>
                            {isHighRisk ? "Threat scanner detected high-risk patterns." : "Agent wants to save a file to your host system."}
                        </div>
                    </div>
                </div>

                <div style={{ padding: 24 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: isHighRisk ? "white" : "var(--surface-base)", borderRadius: 12, border: "1px solid var(--border-subtle)", marginBottom: 20 }}>
                        <FileText size={24} color={isHighRisk ? "#DC2626" : "var(--text-sub)"} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>Filename</div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{request.filename}</div>
                        </div>
                    </div>

                    <div style={{ marginBottom: 24 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>Security Scan Results:</div>
                        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: isHighRisk ? "#B91C1C" : "var(--text-sub)", display: "flex", flexDirection: "column", gap: 6 }}>
                            {report.findings.map((finding: string, i: number) => (
                                <li key={i} style={{ fontWeight: isHighRisk ? 600 : 400 }}>{finding}</li>
                            ))}
                        </ul>
                    </div>

                    {isHighRisk && (
                        <div style={{ marginBottom: 24 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#B91C1C", marginBottom: 8 }}>To override and save this file, type "ALLOW":</div>
                            <input 
                                type="text" 
                                value={overrideText}
                                onChange={(e) => setOverrideText(e.target.value)}
                                placeholder="ALLOW"
                                style={{ width: "100%", padding: "10px 12px", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 14, background: "white", color: "#B91C1C", fontWeight: "bold", outline: "none" }}
                            />
                        </div>
                    )}

                    <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                        <button 
                            onClick={() => handleAction(false)}
                            style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: 8, color: "var(--text-main)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                        >
                            {isHighRisk ? "Keep Blocked (Recommended)" : "Reject"}
                        </button>
                        <button 
                            onClick={() => handleAction(true)}
                            disabled={isHighRisk && overrideText !== "ALLOW"}
                            style={{ 
                                padding: "10px 20px", 
                                background: isHighRisk ? "#DC2626" : "#218380", 
                                border: "none", borderRadius: 8, color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer",
                                opacity: (isHighRisk && overrideText !== "ALLOW") ? 0.5 : 1
                            }}
                        >
                            {isHighRisk ? "Save Anyway" : "Save As..."}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
