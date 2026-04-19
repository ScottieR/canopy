import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function ProvidersVault() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [discoveredKeys, setDiscoveredKeys] = useState<Record<string, string> | null>(null);
  const [showDiscovery, setShowDiscovery] = useState(false);
  
  const providers = [
    { id: "openai", name: "OpenAI", url: "https://platform.openai.com/api-keys", color: "#10A37F", description: "Powers standard GPT-4 inference" },
    { id: "anthropic", name: "Anthropic", url: "https://console.anthropic.com/settings/keys", color: "#D97757", description: "Core provider for Canopy complex logic" },
    { id: "gemini", name: "Google Gemini", url: "https://aistudio.google.com/app/apikey", color: "#4285F4", description: "Used for 3D generation and aesthetic mapping" },
    { id: "grok", name: "xAI Grok", url: "https://console.x.ai", color: "#000000", description: "High-speed custom reasoning streams" }
  ];

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    let currentKeys: Record<string, string> = {};
    for (const p of providers) {
      try {
        const secret = await invoke<string>("get_secret_cmd", { key: `${p.id}_API_KEY`.toUpperCase() });
        if (secret) currentKeys[p.id] = secret;
      } catch (err) {
        // Not found, ignore
      }
    }
    setKeys(currentKeys);

    // If any core provider is missing, try auto discovery
    if (!currentKeys["openai"] || !currentKeys["anthropic"]) {
        try {
            const discovered = await invoke<Record<string, string>>("auto_discover_keys_cmd");
            
            // Filter only to those we DON'T currently have linked
            const newDiscovered: Record<string, string> = {};
            for (const [k, v] of Object.entries(discovered)) {
                if (!currentKeys[k]) newDiscovered[k] = v;
            }

            if (Object.keys(newDiscovered).length > 0) {
                setDiscoveredKeys(newDiscovered);
                setShowDiscovery(true);
            }
        } catch (e) {
            console.error("Auto discovery failed:", e);
        }
    }
  };

  const handleUpdateKey = async (providerId: string, value: string) => {
    const keyName = `${providerId}_API_KEY`.toUpperCase();
    try {
      if (value.trim() === "") {
         await invoke("delete_secret_cmd", { key: keyName });
      } else {
         await invoke("store_secret_cmd", { key: keyName, value });
      }
      setKeys(prev => ({ ...prev, [providerId]: value }));
    } catch (err) {
      console.error(`Failed to update ${keyName}:`, err);
    }
  };

  const linkDiscovered = async () => {
    if (!discoveredKeys) return;
    for (const [providerId, val] of Object.entries(discoveredKeys)) {
        await handleUpdateKey(providerId, val);
    }
    setShowDiscovery(false);
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px" }}>
      <div style={{ marginBottom: 40}}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Providers Vault</h1>
        <p style={{ fontSize: 16, color: "#636E72" }}>Manage the API connections that power your local agents. Keys are saved securely to your macOS Keychain.</p>
      </div>

      {showDiscovery && discoveredKeys && (
        <div style={{ 
          background: "linear-gradient(135deg, #3c6663, #b8e6e2)", padding: 24, borderRadius: 16, 
          marginBottom: 32, display: "flex", alignItems: "center", justifyContent: "space-between",
          boxShadow: "0 8px 24px rgba(60, 102, 99, 0.2)"
        }}>
          <div>
            <h3 style={{ color: "white", margin: "0 0 4px 0", fontSize: 18 }}>Magic Link Available</h3>
            <p style={{ color: "rgba(255,255,255,0.9)", margin: 0, fontSize: 14 }}>
              We found developer API keys for {Object.keys(discoveredKeys).map(k => providers.find(p => p.id === k)?.name).join(", ")} directly in your Terminal profile! Link them automatically?
            </p>
          </div>
          <div style={{ display: "flex", gap: 12, marginLeft: 24 }}>
            <button onClick={() => setShowDiscovery(false)} style={{ background: "transparent", color: "white", border: "1px solid rgba(255,255,255,0.4)", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>Dismiss</button>
            <button onClick={linkDiscovered} style={{ background: "white", color: "#3c6663", border: "none", padding: "10px 20px", borderRadius: 8, cursor: "pointer", fontWeight: 700 }}>Import Keys</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {providers.map(p => {
          const hasKey = !!keys[p.id];
          return (
            <div key={p.id} style={{ 
              background: "white", borderRadius: 16, padding: 24, 
              border: hasKey ? `2px solid ${p.color}40` : "1px solid rgba(0,0,0,0.06)",
              display: "flex", gap: 24, alignItems: "flex-start",
              boxShadow: "0 4px 16px rgba(0,0,0,0.02)"
            }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: `${p.color}15`, display: "flex", alignItems: "center", justifyContent: "center", color: p.color, fontWeight: 700, fontSize: 20 }}>
                {p.name.charAt(0)}
              </div>
              
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <h3 style={{ margin: "0 0 4px 0", color: "#303330", fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
                      {p.name}
                      {hasKey && <span style={{ fontSize: 10, background: `${p.color}20`, color: p.color, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", fontWeight: 800 }}>Linked</span>}
                    </h3>
                    <p style={{ margin: 0, color: "#636E72", fontSize: 13 }}>{p.description}</p>
                  </div>
                  
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: p.color, textDecoration: "none", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                    Get API Key ↗
                  </a>
                </div>

                <div style={{ position: "relative" }}>
                  <input 
                    type="password"
                    placeholder={`Paste your ${p.name} API Key here`}
                    value={keys[p.id] || ""}
                    onChange={(e) => handleUpdateKey(p.id, e.target.value)}
                    style={{ 
                      width: "100%", padding: "12px 16px", borderRadius: 8, 
                      border: "1px solid rgba(0,0,0,0.1)", background: "rgba(0,0,0,0.02)",
                      fontSize: 14, fontFamily: "monospace", outline: "none",
                      color: hasKey ? p.color : "#303330"
                    }}
                  />
                  {hasKey && (
                    <button onClick={() => handleUpdateKey(p.id, "")} style={{ position: "absolute", right: 12, top: 12, background: "transparent", border: "none", color: "#636E72", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                      Remove
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
