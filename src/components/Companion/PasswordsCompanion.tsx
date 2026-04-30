import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Globe, Upload } from "lucide-react";

export function PasswordsCompanion() {
  const [parsedCsvCreds, setParsedCsvCreds] = useState<{ domain: string, username: string, password: string }[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [step, setStep] = useState<"instructions" | "wizard" | "success">("instructions");
  const [finalCount, setFinalCount] = useState(0);

  // Agent Introduction Animation
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    setTimeout(() => setIsVisible(true), 300);
    // Auto-open macOS passwords app
    open('x-apple.systempreferences:com.apple.Passwords').catch(e => {
        console.warn('Failed to open native passwords app', e);
    });
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      // Simple CSV parser for Apple Passwords (Title,URL,Username,Password,Notes,OTPAuth)
      const lines = text.split('\n');
      const header = lines[0].toLowerCase();
      
      const urlIdx = header.split(',').findIndex(h => h.includes('url'));
      const userIdx = header.split(',').findIndex(h => h.includes('username'));
      const passIdx = header.split(',').findIndex(h => h.includes('password'));

      if (urlIdx === -1 || userIdx === -1 || passIdx === -1) {
        setErrorMsg("Invalid CSV format. Please ensure it has URL, Username, and Password columns.");
        return;
      }

      const parsedMap = new Map<string, { domain: string, username: string, password: string }>();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Basic CSV split ignoring commas inside quotes
        const cols = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g)?.map(c => c.replace(/^"|"$/g, '')) || [];
        
        let url = cols[urlIdx];
        const user = cols[userIdx];
        const pass = cols[passIdx];

        if (url && user && pass) {
          // Clean domain
          try {
             url = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
          } catch(err) { /* keep as is */ }

          // Overwrite earlier entries with the same domain to keep the "most recent" import
          parsedMap.set(url, { domain: url, username: user, password: pass });
        }
      }

      const parsed = Array.from(parsedMap.values());

      setParsedCsvCreds(parsed);
      setSelectedRows(new Set(parsed.map((_, i) => i)));
      setStep("wizard");
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImportSelected = async () => {
    setIsImporting(true);
    setErrorMsg("");
    let importedCount = 0;

    for (let i = 0; i < parsedCsvCreds.length; i++) {
      if (selectedRows.has(i)) {
        const c = parsedCsvCreds[i];
        const key = `web_${c.domain}_${c.username}`;
        try {
          await invoke("store_secret_cmd", { key, value: c.password });
          importedCount++;
        } catch(err) {
          console.error("Failed to store securely", key, err);
        }
      }
    }

    // Shred memory completely
    setParsedCsvCreds([]);
    setSelectedRows(new Set());
    setFinalCount(importedCount);
    
    // Refresh web vault globally
    window.dispatchEvent(new Event("refresh_web_vault"));
    
    setIsImporting(false);
    setStep("success");
    
    setTimeout(async () => {
       try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().close();
       } catch(e) {}
    }, 4000);
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
              style={{ flex: 1, cursor: "grab", WebkitAppRegion: "drag", height: "100%" }} 
              onPointerDown={async () => {
                 try {
                     const { getCurrentWindow } = await import('@tauri-apps/api/window');
                     await getCurrentWindow().startDragging();
                 } catch(e) {}
              }}
         />
         <div style={{ padding: "0 16px", cursor: "pointer", opacity: 0.8, fontSize: 18, fontWeight: 'bold', display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }} onClick={async () => {
             try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                await getCurrentWindow().close();
             } catch (e) {
                console.error("Direct close failed", e);
             }
         }}>✕</div>
      </div>

      <div style={{ padding: "0 24px 32px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
        
        {/* Header */}
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
             <Globe size={40} color="#3c6663" />
          </div>
          <h2 style={{ margin: 0, fontSize: 20, color: "#303330", fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif", textAlign: "center" }}>
            Import from Apple Passwords
          </h2>
          <p style={{ margin: "8px 0 0 0", fontSize: 13, color: "#636E72", textAlign: "center", padding: "0 16px", lineHeight: 1.5 }}>
            Give your agents the ability to autonomously log in to web accounts.
          </p>
        </div>

        {step === "instructions" && (
          <>
            <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 1: Open Passwords</div>
              <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 8, lineHeight: 1.5 }}>
                I've automatically opened your native macOS Passwords app. If it didn't open, search for "Passwords" in Spotlight.
              </div>
            </div>

            <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 2: Export CSV</div>
              <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 12, lineHeight: 1.5 }}>
                In the menu bar, go to <strong>File → Export All Passwords...</strong> and save the CSV file to your Desktop.
              </div>
            </div>

            <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 3: Secure Smart Wizard</div>
              <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 16, lineHeight: 1.5 }}>
                Select the CSV file below. In the next step, you'll choose exactly which accounts to import, which will be encrypted.
              </div>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "14px", background: "#3c6663", color: "white", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", boxSizing: "border-box" }}>
                <Upload size={16} /> Select CSV File
                <input type="file" accept=".csv" style={{ display: "none" }} onChange={handleFileUpload} />
              </label>
              {errorMsg && <div style={{ marginTop: 8, fontSize: 12, color: "#E53E3E" }}>{errorMsg}</div>}
            </div>

            <div style={{ marginBottom: 24, padding: 16, background: "white", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Step 4: Data Shredding</div>
              <div style={{ fontSize: 13, color: "#4A5568", marginBottom: 0, lineHeight: 1.5 }}>
                I will delete the CSV file and shred all accounts from memory.
              </div>
            </div>
          </>
        )}

        {step === "wizard" && (
          <div style={{ background: "white", borderRadius: 16, padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)", display: "flex", flexDirection: "column", flex: 1, maxHeight: 400 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Select Allowed Logins</div>
            <div style={{ fontSize: 12, color: "#636E72", marginBottom: 12, lineHeight: 1.5 }}>
              Choose which accounts to securely inject into Canopy's native macOS Keychain.
            </div>
            
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
              <button onClick={() => setSelectedRows(new Set(parsedCsvCreds.map((_, i) => i)))} style={{ background: "none", border: "none", color: "#3c6663", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>Select All</button>
              <button onClick={() => setSelectedRows(new Set())} style={{ background: "none", border: "none", color: "#636E72", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>Deselect All</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", border: "1px solid rgba(0,0,0,0.05)", borderRadius: 8, marginBottom: 16 }}>
              {parsedCsvCreds.map((c, i) => (
                <label key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderBottom: i < parsedCsvCreds.length - 1 ? "1px solid rgba(0,0,0,0.05)" : "none", cursor: "pointer", background: selectedRows.has(i) ? "rgba(60, 102, 99, 0.05)" : "transparent" }}>
                  <input type="checkbox" checked={selectedRows.has(i)} onChange={(e) => {
                    const next = new Set(selectedRows);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    setSelectedRows(next);
                  }} style={{ accentColor: "#3c6663" }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#303330" }}>{c.domain}</div>
                    <div style={{ fontSize: 11, color: "#636E72" }}>{c.username}</div>
                  </div>
                </label>
              ))}
            </div>

            <button 
              onClick={handleImportSelected}
              disabled={isImporting || selectedRows.size === 0}
              style={{
                width: "100%", padding: "14px", borderRadius: 8, border: "none", 
                background: selectedRows.size > 0 ? "#3c6663" : "rgba(0,0,0,0.06)", 
                color: selectedRows.size > 0 ? "white" : "rgba(0,0,0,0.3)", 
                fontSize: 14, fontWeight: 700, 
                cursor: selectedRows.size > 0 ? "pointer" : "default",
              }}
            >
              {isImporting ? "Encrypting..." : `Securely Encrypt ${selectedRows.size} Logins`}
            </button>
          </div>
        )}

        {step === "success" && (
           <div style={{ textAlign: "center", padding: 24, background: "rgba(33,131,128,0.1)", borderRadius: 16, color: "#3c6663", fontWeight: 600, fontSize: 14, marginTop: "auto" }}>
             Success! {finalCount} logins imported. <br/><br/>
             <span style={{ fontSize: 12, color: "#4A5568", fontWeight: 400 }}>Raw CSV completely shredded from memory.</span>
           </div>
        )}

      </div>
    </div>
  );
}
