import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { LobsterIcon } from "../../App";

export function SlackCompanion() {
  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Agent Introduction Animation
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    setTimeout(() => setIsVisible(true), 300);
  }, []);

  const handleConnect = async () => {
    if (!slackAppToken || !slackBotToken) return;
    setTestStatus("testing");
    setErrorMsg("");
    
    try {
      if (typeof invoke === "function") {
        await invoke("store_secret_cmd", { key: "slack-app-token", value: slackAppToken });
        await invoke("store_secret_cmd", { key: "slack-bot-token", value: slackBotToken });
        const res: any = await invoke("check_slack_connection");
        
        if (res.connected) {
          setTestStatus("success");
          // Tell the main window we succeeded!
          await emit("slack-connected", { workspace: res.workspace_name });
          
          // Auto close this window after a short delay
          setTimeout(async () => {
             const { getCurrentWindow } = await import("@tauri-apps/api/window");
             await getCurrentWindow().close();
          }, 3000);
        } else {
          setTestStatus("error");
          setErrorMsg("Could not connect. Double check tokens.");
        }
      } else {
        // Mock fallback
        setTimeout(async () => {
          setTestStatus("success");
          await emit("slack-connected", { workspace: "Mock Workspace" });
        }, 1500);
      }
    } catch (e: any) {
      console.error(e);
      setTestStatus("error");
      setErrorMsg(e.toString());
    }
  };

  return (
    <div style={{
      width: "100%", height: "100vh",
      background: "linear-gradient(to bottom, #faf9f6, #f0eee9)",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      display: "flex", flexDirection: "column",
      borderLeft: "1px solid rgba(0,0,0,0.05)",
      overflowY: "auto",
      overflowX: "hidden"
    }}>
      {/* Title Bar Drag Area (Allows moving the frameless window if we enable it) */}
      <div data-tauri-drag-region style={{ height: 40, width: "100%", background: "transparent", WebkitAppRegion: "drag", position: "sticky", top: 0, zIndex: 10 } as any}>
        <div style={{ position: "absolute", right: 16, top: 12, cursor: "pointer", opacity: 0.5, fontSize: 16, zIndex: 20 }} onClick={async () => {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().close();
        }}>✕</div>
      </div>

      <div style={{ padding: "0 24px 32px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
        
        {/* Agent Header */}
        <div style={{ 
          display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 32,
          opacity: isVisible ? 1 : 0, transform: isVisible ? "translateY(0)" : "translateY(10px)",
          transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)"
        }}>
          <div style={{
             width: 80, height: 80, borderRadius: 40, background: "white",
             boxShadow: "0 8px 24px rgba(48,51,48,0.08)",
             display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16
          }}>
             <LobsterIcon size={56} shellColor="#3c6663" accentColor="#81DCD5" />
          </div>
          <h2 style={{ margin: 0, fontSize: 20, color: "#303330", fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif" }}>Setup Guide</h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#636E72", textAlign: "center" }}>
            I'll walk you through creating your Slack app.
          </p>
        </div>

        {/* Step 1 */}
        <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 1: The App Manifest</div>
          <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 16, lineHeight: 1.5 }}>
            In the browser window that just opened, complete these steps:
            <ol style={{ margin: "8px 0 0 -5px", paddingLeft: "20px" }}>
              <li style={{ marginBottom: 4 }}>Select a workspace from the dropdown.</li>
              <li style={{ marginBottom: 4 }}>Click <strong>Next</strong> to review the pre-filled manifest.</li>
              <li>Click <strong>Create</strong> to generate the app.</li>
            </ol>
          </div>
        </div>

        {/* Step 2 */}
        <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 2: App-Level Token</div>
          <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 12, lineHeight: 1.5 }}>
            <ol style={{ margin: "0 0 8px -5px", paddingLeft: "20px" }}>
               <li style={{ marginBottom: 4 }}>Scroll down to <strong>App-Level Tokens</strong> and click <strong>Generate Token and Scopes</strong>.</li>
               <li style={{ marginBottom: 4 }}>Name it <em>Canopy</em> and add the <code>connections:write</code> scope.</li>
               <li>Click Generate and copy the token starting with <code>xapp-</code> here:</li>
            </ol>
          </div>
          <input 
            type="password" 
            value={slackAppToken} 
            onChange={e => setSlackAppToken(e.target.value)} 
            placeholder="xapp-..." 
            style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#f9f9f9" }} 
          />
        </div>

        {/* Step 3 */}
        <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 3: Bot Token</div>
          <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 12, lineHeight: 1.5 }}>
            <ol style={{ margin: "0 0 8px -5px", paddingLeft: "20px" }}>
              <li style={{ marginBottom: 4 }}>Click <strong>Install App</strong> on the left sidebar and install it to your workspace.</li>
              <li>Copy the "Bot User OAuth Token" (starts with <code>xoxb-</code>) and paste it here:</li>
            </ol>
          </div>
          <input 
            type="password" 
            value={slackBotToken} 
            onChange={e => setSlackBotToken(e.target.value)} 
            placeholder="xoxb-..." 
            style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#f9f9f9" }} 
          />
        </div>

        {errorMsg && (
          <div style={{ fontSize: 12, color: "#E53E3E", marginBottom: 16, padding: "8px 12px", background: "rgba(229,62,62,0.05)", borderRadius: 8 }}>
            {errorMsg}
          </div>
        )}

        {testStatus === "success" && (
           <div style={{ textAlign: "center", padding: 16, background: "rgba(33,131,128,0.1)", borderRadius: 12, color: "#3c6663", fontWeight: 600, fontSize: 14, marginBottom: 16 }}>
             Success! You can close this window now.
           </div>
        )}

        <button 
          onClick={handleConnect}
          disabled={!slackAppToken || !slackBotToken || testStatus === "testing" || testStatus === "success"}
          style={{
            marginTop: "auto",
            width: "100%",
            padding: "16px", borderRadius: 12, border: "none", 
            background: (slackAppToken && slackBotToken) ? "#3c6663" : "rgba(0,0,0,0.06)", 
            color: (slackAppToken && slackBotToken) ? "white" : "rgba(0,0,0,0.3)", 
            fontSize: 15, fontWeight: 700, 
            cursor: (slackAppToken && slackBotToken) ? "pointer" : "default",
            transition: "all 0.2s"
          }}
        >
          {testStatus === "testing" ? "Verifying..." : testStatus === "success" ? "Connected ✨" : "Complete Setup"}
        </button>

      </div>
    </div>
  );
}
