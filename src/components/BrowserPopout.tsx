import React, { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Monitor } from "lucide-react";

export function BrowserPopout({ agentId }: { agentId: string }) {
  const [frameData, setFrameData] = useState<string | null>(null);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;

    async function setupBrowserStream() {
      if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
      try {
        const unlisten = await listen<any>("browser_stream_frame", (e) => {
          if (e.payload.agent_id === agentId) {
            setFrameData(e.payload.frame);
          }
        });

        if (isMounted) {
          unlistenFn = unlisten;
        } else {
          try { unlisten(); } catch (e) {}
        }
      } catch (e) {
        console.warn("Browser stream listener setup failed:", e);
      }
    }
    setupBrowserStream();

    return () => {
      isMounted = false;
      if (unlistenFn) {
        try { unlistenFn(); } catch (e) {}
        unlistenFn = undefined;
      }
    };
  }, [agentId]);

  return (
    <div style={{ 
      background: "#000", height: "100%", width: "100%", overflow: "hidden",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      color: "white",
      backgroundImage: frameData ? "none" : "linear-gradient(45deg, #000 25%, #111 25%, #111 50%, #000 50%, #000 75%, #111 75%, #111 100%)",
      backgroundSize: "20px 20px",
      position: "relative"
    }}>
      {frameData ? (
        <img 
          src={`data:image/jpeg;base64,${frameData}`} 
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }} 
          alt="Live Browser View" 
        />
      ) : (
        <>
          <Monitor size={48} opacity={0.5} style={{ marginBottom: 16 }} />
          <div style={{ fontSize: 16, fontWeight: 600 }}>Waiting for Browser Stream...</div>
        </>
      )}
      
      <div style={{ 
        position: "absolute", top: 12, right: 12, 
        display: "flex", gap: 8, alignItems: "center" 
      }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, background: frameData ? "#10b981" : "#f59e0b", boxShadow: "0 0 8px currentColor" }}></div>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", background: "rgba(0,0,0,0.6)", padding: "4px 8px", borderRadius: 6, backdropFilter: "blur(4px)" }}>
          {frameData ? "LIVE" : "WAITING"}
        </span>
      </div>
    </div>
  );
}
