import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { PasswordInput } from "./shared/PasswordInput";

export function ProvidersVault({ embedded = false, filterProvider }: { embedded?: boolean, filterProvider?: string } = {}) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [discoveredKeys, setDiscoveredKeys] = useState<Record<string, string> | null>(null);
  const [showDiscovery, setShowDiscovery] = useState(false);
  
  const providers = [
    { id: "openai", name: "OpenAI", url: "https://platform.openai.com/api-keys", color: "#10A37F", description: "Powers standard GPT-4 inference" },
    { id: "anthropic", name: "Anthropic", url: "https://console.anthropic.com/settings/keys", color: "#D97757", description: "Core provider for Canopy complex logic" },
    { id: "gemini", name: "Google Gemini", url: "https://aistudio.google.com/app/apikey", color: "#4285F4", description: "Used for 3D generation and aesthetic mapping" },
    { id: "grok", name: "xAI Grok", url: "https://console.x.ai", color: "#000000", description: "High-speed custom reasoning streams" }
  ];

  // Map provider id → keychain key name. Grok uses XAI_API_KEY to match the Rust
  // keychain conventions used by boot_sync_agents and write_auth_profiles.
  const providerKeyName: Record<string, string> = {
    openai:    "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini:    "GEMINI_API_KEY",
    grok:      "XAI_API_KEY",   // stored as XAI_API_KEY — what boot_sync_agents expects
  };
  const getKeyName = (providerId: string) => providerKeyName[providerId] ?? `${providerId}_API_KEY`.toUpperCase();

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    let currentKeys: Record<string, string> = {};
    for (const p of providers) {
      try {
        const secret = await invoke<string>("get_secret_cmd", { key: getKeyName(p.id) });
        if (secret) currentKeys[p.id] = secret;
      } catch (err) {
        // Not found, ignore
      }
    }
    setKeys(currentKeys);
  };

  const handleScanForKeys = async () => {
    try {
      const discovered = await invoke<Record<string, string>>("auto_discover_keys_cmd");
      
      const newDiscovered: Record<string, string> = {};
      for (const [k, v] of Object.entries(discovered)) {
          if (!keys[k]) newDiscovered[k] = v;
      }

      if (Object.keys(newDiscovered).length > 0) {
          setDiscoveredKeys(newDiscovered);
          setShowDiscovery(true);
      } else {
          alert('No new API keys discovered in your system.');
      }
    } catch (e) {
      console.error("Auto discovery failed:", e);
      alert('Failed to scan for keys. Make sure Canopy has system permissions.');
    }
  };

  const handleUpdateKey = async (providerId: string, value: string) => {
    const keyName = getKeyName(providerId);
    try {
      if (value.trim() === "") {
         await invoke("delete_secret_cmd", { key: keyName });
         // Also remove the legacy GROK_API_KEY if it exists (migration from old name)
         if (providerId === "grok") {
           await invoke("delete_secret_cmd", { key: "GROK_API_KEY" }).catch(() => {});
         }
      } else {
         await invoke("store_secret_cmd", { key: keyName, value });
      }
      setKeys(prev => ({ ...prev, [providerId]: value }));

      // Propagate the change to OpenClaw — refresh auth-profiles.json for every agent
      // that DOESN'T have its own per-agent override for this provider. Agents with
      // their own per-agent key are intentionally left alone (the global change doesn't
      // apply to them). The Rust side handles the precedence via `get_creds_for_agent`.
      try {
        await invoke("sync_global_api_key", { provider: providerId });
      } catch (e) {
        // Non-fatal: keys are saved to keychain regardless. Next time any agent triggers
        // a credential sync (chat, boot, OAuth callback, etc.) it will pick up the new key.
        console.warn(`sync_global_api_key for ${providerId} failed (non-fatal):`, e);
      }
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
    <div style={{ maxWidth: 800, margin: "0 auto", padding: embedded ? "0px" : "40px 20px" }}>
      {!embedded && (
      <div style={{ marginBottom: 40, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "#303330", margin: "0 0 8px 0" }}>Providers Vault</h1>
          <p style={{ fontSize: 16, color: "#636E72" }}>Manage the API connections that power your local agents. Keys are saved securely to your macOS Keychain.</p>
        </div>
        <button onClick={handleScanForKeys} style={{ background: "#f4f4f0", color: "#303330", border: "1px solid rgba(0,0,0,0.1)", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
          Auto-Scan Keys
        </button>
      </div>
      )}

      {embedded && (
        <div style={{ marginBottom: 24, padding: 16, background: "rgba(33,131,128,0.05)", borderRadius: 12, border: "1px solid rgba(33,131,128,0.15)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 13, color: "#303330", lineHeight: 1.5, flex: 1, paddingRight: 24 }}>
            <strong>Save time:</strong> Canopy can securely scan your developer environment to auto-discover API keys. macOS will prompt for access permissions.
          </div>
          <button onClick={handleScanForKeys} style={{ background: "#3c6663", color: "white", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
            Scan Environment
          </button>
        </div>
      )}

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
        {providers.filter(p => !filterProvider || p.name === filterProvider || p.id === filterProvider).map(p => {
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
                  
                  <a href={p.url} onClick={async (e) => {
                    e.preventDefault();
                    await open(p.url);
                  }} style={{ fontSize: 12, color: p.color, textDecoration: "none", fontWeight: 600, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                    Get API Key ↗
                  </a>
                </div>

                <div style={{ position: "relative" }}>
                  <PasswordInput 
                    placeholder={`Paste your ${p.name} API Key here`}
                    value={keys[p.id] || ""}
                    onChange={(e) => handleUpdateKey(p.id, e.target.value)}
                    style={{ 
                      width: "100%", padding: "12px 16px", borderRadius: 8, 
                      border: "1px solid rgba(0,0,0,0.1)", background: "rgba(0,0,0,0.02)",
                      fontSize: 14, fontFamily: "monospace", outline: "none",
                      color: hasKey ? p.color : "#303330"
                    }}
                    rightAction={
                      hasKey ? (
                        <button onClick={() => handleUpdateKey(p.id, "")} style={{ background: "transparent", border: "none", color: "#636E72", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                          Remove
                        </button>
                      ) : undefined
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
