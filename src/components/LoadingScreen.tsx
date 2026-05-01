import React, { useEffect, useState, useRef } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
const invoke = async <T,>(cmd: string, args?: any): Promise<T> => {
  try {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      return await tauriInvoke(cmd, args);
    }
    return Promise.reject(new Error("Tauri API not available in browser"));
  } catch (e) {
    throw e;
  }
};
import { useWorldStore } from "../store/worldStore";

export function LoadingScreen({ status }: { status?: string }) {
  const [showLog, setShowLog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // Detect when we're in the slow ACPX init phase ("Starting agent runtime...")
  const isSlowPhase = status?.startsWith("Starting agent runtime");

  // Poll gateway log tail every 3s when the panel is open OR when in the slow phase
  useEffect(() => {
    if (!showLog && !isSlowPhase) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const tail = await invoke<string>("get_gateway_log_tail", { lines: 20 });
        if (!cancelled && tail) {
          setLogLines(tail.split("\n").filter(Boolean).slice(-20));
        }
      } catch { /* non-fatal */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [showLog, isSlowPhase]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "#faf9f6",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      flexDirection: "column", gap: 24,
    }}>
      <div style={{
        animation: "float 3s ease-in-out infinite",
        display: "flex", justifyContent: "center",
      }}>
        <img src="/app-icon.png" alt="Canopy Logo" style={{ width: 80, height: 80, objectFit: "contain" }} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "var(--text-main)" }}>
        Waking up the lobsters...
      </div>
      {status && (
        <div style={{
          fontSize: 13, color: "var(--text-sub)",
          maxWidth: 320, textAlign: "center",
          minHeight: 20,
          transition: "opacity 0.3s",
        }}>
          {status}
        </div>
      )}

      {/* Show log toggle when in slow ACPX init phase or when user opens it */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => setShowLog(v => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 12, color: "var(--text-sub)",
            opacity: 0.6, padding: "4px 8px",
            textDecoration: "underline", textUnderlineOffset: 3,
          }}
        >
          {showLog ? "hide details" : "show details"}
        </button>

        {showLog && (
          <div
            ref={logRef}
            style={{
              width: 540, maxHeight: 180,
              overflowY: "auto",
              background: "#1a1a1a",
              borderRadius: 8,
              padding: "10px 14px",
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: "#c8c8c0",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {logLines.length === 0
              ? <span style={{ opacity: 0.4 }}>Waiting for gateway logs...</span>
              : logLines.map((line, i) => {
                  // Colorize log levels
                  const isError = /error|ERR|ERRO/i.test(line);
                  const isWarn = /warn|WARN/i.test(line);
                  const isReady = /ready|responsive|ACPX/i.test(line);
                  const color = isError ? "#f87171" : isWarn ? "#fbbf24" : isReady ? "#4ade80" : "#c8c8c0";
                  return <div key={i} style={{ color }}>{line}</div>;
                })
            }
          </div>
        )}
      </div>

      <style>{`
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANION GUIDE
// ═══════════════════════════════════════════════════════════════════════════════
