import { useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export function FigmaCompanion() {
  const searchParams = new URLSearchParams(window.location.search);
  const agentId = searchParams.get("agentId") || "global";
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle"|"testing"|"success"|"error">("idle");

  const handleConnect = async () => {
     setStatus("testing");
     try {
       await invoke("store_batch_secrets_cmd", {
         secrets: { [`agent_${agentId}_figma_token`]: token }
       });
       setStatus("success");
       setTimeout(async () => {
          await emit("companion-finished", { type: "figma" });
          const { getCurrentWindow, getAllWindows } = await import('@tauri-apps/api/window');
          const mainWindow = (await getAllWindows()).find(w => w.label === 'main');
          if (mainWindow) await mainWindow.setFocus();
          await getCurrentWindow().close();
       }, 2000);
     } catch (e) {
       setStatus("error");
     }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "var(--surface-card)", minHeight: "100vh", color: "var(--text-main)" }}>
      <h2 style={{marginTop: 0}}>Setup Figma</h2>
      <p style={{fontSize: 13, color: "var(--text-sub)", marginBottom: 24}}>A design agent can co-create and modify design files directly in Figma.</p>
      
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>API Token</label>
        <input 
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", boxSizing: "border-box" }}
        />
      </div>

      <button 
        onClick={handleConnect}
        disabled={!token || status === "testing" || status === "success"}
        style={{ width: "100%", padding: "10px", background: status === "success" ? "#34A853" : "#3c6663", color: "white", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer" }}
      >
        {status === "idle" ? "Connect" : status === "testing" ? "Connecting..." : status === "success" ? "Connected!" : "Failed - Try Again"}
      </button>
    </div>
  );
}
