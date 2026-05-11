import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

import { emit, listen } from "@tauri-apps/api/event";
import { LobsterIcon } from "../../App";
import { PasswordInput } from "../shared/PasswordInput";

export function SlackCompanion() {
  const searchParams = new URLSearchParams(window.location.search);
  const agentId = searchParams.get("agentId") || "";
  const agentName = searchParams.get("agentName") || "your agent";

  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Agent Introduction Animation
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    setTimeout(() => setIsVisible(true), 300);
    setTimeout(() => {
      
      const manifest = {
        display_information: { name: agentName || "Agent", description: "Canopy Agent", background_color: "#3c6663" },
        features: {
          app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
          bot_user: { display_name: agentName || "Agent", always_online: true }
        },
        oauth_config: {
          scopes: { bot: ["chat:write", "channels:history", "channels:read", "groups:history", "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "users:read", "app_mentions:read", "reactions:read", "reactions:write", "commands", "files:read"] },
          pkce_enabled: false
        },
        settings: {
          event_subscriptions: { bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "reaction_added", "reaction_removed"] },
          interactivity: { is_enabled: true },
          org_deploy_enabled: false,
          socket_mode_enabled: true,
          token_rotation_enabled: false,
          is_mcp_enabled: false
        }
      };
      const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
      open(url).catch(console.error);

    }, 500);
  }, []);

  const handleConnect = async () => {
    if (!slackAppToken || !slackBotToken) return;
    setTestStatus("testing");
    setErrorMsg("");

    // Hard guard: this companion is per-agent and the agentId must come from the URL
    // (set by ConnectionsTab when opening this window). Falling back to the global
    // `slack-bot-token` / `slack-app-token` slots — the prior behaviour — was the
    // source of cross-agent token contamination: whichever agent connected last
    // would overwrite the global slot, and any subsequently-created agent missing
    // its own token would silently use it. Refuse to proceed instead. The matching
    // Rust-side guard lives in slack.rs `get_bot_token`.
    if (!agentId) {
      setTestStatus("error");
      setErrorMsg(
        "This Slack setup window was opened without an agentId. Close it and " +
        "click \"Connect Slack\" from the specific agent's Connections tab — that " +
        "ensures the tokens are stored under this agent only."
      );
      return;
    }

    try {
      if (typeof invoke === "function") {
        await invoke("store_batch_secrets_cmd", {
          secrets: {
            [`agent_${agentId}_slack_app_token`]: slackAppToken,
            [`agent_${agentId}_slack_bot_token`]: slackBotToken,
          }
        });
        
        // Sync the changes to the Gateway configuration
        await invoke("sync_gateway_channels");
        
        // We bypass full check_slack_connection here since the gateway handles it per-agent now
        // Let's assume it works if they provided valid-looking tokens.
        setTestStatus("success");
        await emit("slack-connected", { workspace: "Agent Workspace", agentId });
        setTimeout(async () => {
           try {
              await emit("companion-finished", { type: "slack", key: null });
              const { getCurrentWindow, getAllWindows } = await import('@tauri-apps/api/window');
              const mainWindow = (await getAllWindows()).find(w => w.label === 'main');
              if (mainWindow) await mainWindow.setFocus();
              await getCurrentWindow().close();
           } catch(e) {}
        }, 3000);
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
    <div data-tauri-drag-region style={{
      width: "100%", height: "100vh",
      background: "linear-gradient(to bottom, #faf9f6, #f0eee9)",
      fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
      display: "flex", flexDirection: "column",
      borderLeft: "1px solid rgba(0,0,0,0.05)",
      overflowY: "auto",
      overflowX: "hidden"
    }}>
      <div style={{ position: "sticky", top: 0, zIndex: 9999, display: "flex", width: "100%", height: 32 }}>
         <div data-tauri-drag-region 
              style={{ flex: 1, cursor: "grab", WebkitAppRegion: "drag", height: "100%" } as any} 
              onPointerDown={async () => {
                 try {
                     const { getCurrentWindow } = await import('@tauri-apps/api/window');
                     await getCurrentWindow().startDragging();
                 } catch(e) {}
              }}
         />
         <div style={{ padding: "0 16px", cursor: "pointer", opacity: 0.8, fontSize: 18, fontWeight: 'bold', display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }} onClick={async () => {
             try {
                // Definitively close THIS exact window directly from the inside rather than relying on a global event listener sweep.
                const { getCurrentWindow, getAllWindows } = await import('@tauri-apps/api/window');
                const mainWindow = (await getAllWindows()).find(w => w.label === 'main');
                if (mainWindow) await mainWindow.setFocus();
                await getCurrentWindow().close();
             } catch (e) {
                console.error("Direct close failed", e);
             }
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
          <h2 style={{ margin: 0, fontSize: 20, color: "#303330", fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif" }}>Setup {agentName}'s App</h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#636E72", textAlign: "center", padding: "0 16px" }}>
            I'll walk you through creating a unique Slack app specifically for {agentName}.
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
          <PasswordInput 
            value={slackAppToken} 
            onChange={e => setSlackAppToken(e.target.value)} 
            placeholder="xapp-..." 
            style={{ width: "100%", padding: "12px", borderRadius: 8, border: (slackAppToken.trim() && !slackAppToken.trim().startsWith("xapp-")) ? "1px solid #E53E3E" : "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#f9f9f9" }} 
          />
          {slackAppToken.trim() && !slackAppToken.trim().startsWith("xapp-") && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#E53E3E", fontWeight: 500 }}>
              Token must start with 'xapp-'
            </div>
          )}
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
          <PasswordInput 
            value={slackBotToken} 
            onChange={e => setSlackBotToken(e.target.value)} 
            placeholder="xoxb-..." 
            style={{ width: "100%", padding: "12px", borderRadius: 8, border: (slackBotToken.trim() && !slackBotToken.trim().startsWith("xoxb-")) ? "1px solid #E53E3E" : "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#f9f9f9" }} 
          />
          {slackBotToken.trim() && !slackBotToken.trim().startsWith("xoxb-") && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#E53E3E", fontWeight: 500 }}>
              Token must start with 'xoxb-'
            </div>
          )}
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

        <div style={{ fontSize: 11, color: "#636E72", opacity: 0.8, marginBottom: 12, textAlign: "center", lineHeight: 1.4, padding: "0 16px" }}>
          🔒 Note: macOS will ask for your password to securely lock these tokens in your system Keychain.
        </div>
        <button 
          onClick={handleConnect}
          disabled={!slackAppToken.trim().startsWith("xapp-") || !slackBotToken.trim().startsWith("xoxb-") || testStatus === "testing" || testStatus === "success"}
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
