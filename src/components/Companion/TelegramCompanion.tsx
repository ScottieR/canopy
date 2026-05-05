import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Send } from "lucide-react";
import { PasswordInput } from "../shared/PasswordInput";
import { open } from "@tauri-apps/plugin-shell";

export function TelegramCompanion() {
  const searchParams = new URLSearchParams(window.location.search);
  const agentName = searchParams.get("agentName") || "Shared";

  const [telegramToken, setTelegramToken] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    setTimeout(() => setIsVisible(true), 300);
    setTimeout(() => {
      open("https://t.me/botfather").catch(console.error);
    }, 500);
  }, []);

  const handleConnect = async () => {
    if (!telegramToken.trim()) return;
    setTestStatus("testing");
    setErrorMsg("");
    
    try {
      if (typeof invoke === "function") {
        await invoke("configure_telegram", { botToken: telegramToken.trim() });
        setTestStatus("success");
        window.dispatchEvent(new Event("refresh_integrations"));
        
        setTimeout(async () => {
           try {
              const { getCurrentWindow, getAllWindows } = await import('@tauri-apps/api/window');
              const mainWindow = (await getAllWindows()).find(w => w.label === 'main');
              if (mainWindow) await mainWindow.setFocus();
              await getCurrentWindow().close();
           } catch(e) {}
        }, 3000);
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
                const { getCurrentWindow, getAllWindows } = await import('@tauri-apps/api/window');
                const mainWindow = (await getAllWindows()).find(w => w.label === 'main');
                if (mainWindow) await mainWindow.setFocus();
                await getCurrentWindow().close();
             } catch (e) {}
         }}>✕</div>
      </div>

      <div style={{ padding: "0 24px 32px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
        
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
             <Send size={40} color="#2AABEE" />
          </div>
          <h2 style={{ margin: 0, fontSize: 20, color: "#303330", fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif" }}>Connect Telegram</h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#636E72", textAlign: "center", padding: "0 16px" }}>
            Create a dedicated bot user for {agentName} to use on Telegram.
          </p>
        </div>

        <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 1: Talk to BotFather</div>
          <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 16, lineHeight: 1.5 }}>
            <ol style={{ margin: "0 0 8px -5px", paddingLeft: "20px" }}>
              <li style={{ marginBottom: 8 }}>
                Open Telegram and start a chat with <a href="#" onClick={(e) => { e.preventDefault(); open("https://t.me/botfather"); }} style={{ color: "#3c6663", fontWeight: 600, textDecoration: "none" }}>@BotFather</a>.
              </li>
              <li style={{ marginBottom: 8 }}>Send the message <code>/newbot</code> and follow the prompts to name your bot.</li>
              <li>Once created, BotFather will give you an <strong>HTTP API Token</strong>.</li>
            </ol>
          </div>
        </div>

        <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 2: Save Token Securely</div>
          <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 12, lineHeight: 1.5 }}>
            Copy the long API token provided by BotFather and paste it below:
          </div>
          <PasswordInput 
            value={telegramToken} 
            onChange={e => setTelegramToken(e.target.value)} 
            placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ..." 
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

        <div style={{ fontSize: 11, color: "#636E72", opacity: 0.8, marginBottom: 12, textAlign: "center", lineHeight: 1.4, padding: "0 16px" }}>
          🔒 Note: macOS will ask for your password to securely lock this token in your system Keychain.
        </div>
        <button 
          onClick={handleConnect}
          disabled={!telegramToken.trim() || testStatus === "testing" || testStatus === "success"}
          style={{
            marginTop: "auto",
            width: "100%",
            padding: "16px", borderRadius: 12, border: "none", 
            background: telegramToken.trim() ? "#2AABEE" : "rgba(0,0,0,0.06)", 
            color: telegramToken.trim() ? "white" : "rgba(0,0,0,0.3)", 
            fontSize: 15, fontWeight: 700, 
            cursor: telegramToken.trim() ? "pointer" : "default",
            transition: "all 0.2s"
          }}
        >
          {testStatus === "testing" ? "Verifying..." : testStatus === "success" ? "Connected ✨" : "Securely Encrypt"}
        </button>

      </div>
    </div>
  );
}
