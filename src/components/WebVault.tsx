import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PasswordInput } from "./shared/PasswordInput";
import { Globe, Plus, Trash2, Upload, ChevronDown, ChevronUp } from "lucide-react";

export function WebVault() {
  const [credentials, setCredentials] = useState<{ domain: string, username: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadCredentials = async () => {
    try {
      const creds = await invoke<{ domain: string, username: string }[]>("get_web_credentials_cmd");
      setCredentials(creds);
    } catch (e) {
      console.error("Failed to load web vault credentials", e);
    }
    setLoading(false);
  };

  // Refresh listener
  useEffect(() => {
    window.addEventListener("refresh_web_vault", loadCredentials);
    return () => window.removeEventListener("refresh_web_vault", loadCredentials);
  }, []);

  useEffect(() => {
    loadCredentials();
  }, []);

  const handleSave = async () => {
    if (!domain.trim() || !username.trim() || !password.trim()) {
      setError("Please fill in all fields.");
      return;
    }

    try {
      // Store in keychain: key format: web_{domain}_{username}
      const key = `web_${domain.trim()}_${username.trim()}`;
      await invoke("store_secret_cmd", { key, value: password });
      
      await loadCredentials();
      
      setDomain("");
      setUsername("");
      setPassword("");
      setIsAdding(false);
      setError("");
      
      // Notify other components
      window.dispatchEvent(new Event("refresh_web_vault"));
    } catch (e: any) {
      setError(e?.toString() || "Failed to save credential securely.");
    }
  };

  const handleDelete = async (domain: string, username: string) => {
    try {
      const key = `web_${domain}_${username}`;
      await invoke("delete_secret_cmd", { key });
      await loadCredentials();
      window.dispatchEvent(new Event("refresh_web_vault"));
    } catch (e: any) {
      console.error(e);
    }
  };



  if (loading) return <div style={{ padding: 20 }}>Loading vault...</div>;



  return (
    <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setIsExpanded(!isExpanded)}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-main)" }}>
            <Globe size={18} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)", display: "flex", alignItems: "center", gap: 6 }}>
              Web Credentials
              {isExpanded ? <ChevronUp size={14} color="var(--text-sub)" /> : <ChevronDown size={14} color="var(--text-sub)" />}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Securely store website logins for your agents ({credentials.length} saved)</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={async () => {
            const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
            new WebviewWindow('companion_passwords_' + Date.now(), {
              url: `/index.html?companion=passwords`,
              title: `Bulk Import Web Accounts`,
              width: 500,
              height: 600,
              x: window.screen.availWidth - 520,
              y: 50,
              alwaysOnTop: true,
              decorations: true,
            });
          }} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: "1px solid var(--border-subtle)", borderRadius: 7,
            background: "var(--surface-base)", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--text-main)"
          }}>
            <Upload size={14} /> Bulk Import
          </button>
          <button onClick={() => setIsAdding(!isAdding)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: "1px solid var(--border-subtle)", borderRadius: 7,
            background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--text-main)"
          }}>
            <Plus size={14} /> Add Login
          </button>
        </div>
      </div>

      {isExpanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Search Bar */}
      {credentials.length > 0 && !isAdding && (
        <div style={{ marginBottom: 16 }}>
          <input 
            type="text" 
            placeholder="Search by domain or username..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-subtle)", fontSize: 13, background: "var(--surface-card)", color: "var(--text-main)", outline: "none" }}
          />
        </div>
      )}

      {isAdding && (
        <div style={{ background: "var(--background)", padding: 16, borderRadius: 8, marginBottom: 16, border: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <input 
              value={domain} onChange={e => setDomain(e.target.value)}
              placeholder="Domain (e.g. amazon.com)"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 13, color: "var(--text-main)", outline: "none" }}
            />
            <input 
              value={username} onChange={e => setUsername(e.target.value)}
              placeholder="Username / Email"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 13, color: "var(--text-main)", outline: "none" }}
            />
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <PasswordInput
              value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              style={{ flex: 2, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 13, color: "var(--text-main)" }}
            />
            <button onClick={handleSave} style={{
              flex: 1, padding: "8px 16px", background: "#3c6663", color: "#fff", border: "none",
              borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer"
            }}>
              Save Securely
            </button>
          </div>
          {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>{error}</div>}
        </div>
      )}

      {(() => {
        const filtered = credentials.filter(c => 
          c.domain.toLowerCase().includes(searchQuery.toLowerCase()) || 
          c.username.toLowerCase().includes(searchQuery.toLowerCase())
        );

        if (credentials.length === 0) {
          return <div style={{ fontSize: 13, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>No credentials stored. Add one manually or use Bulk Import.</div>;
        }

        if (filtered.length === 0) {
          return <div style={{ fontSize: 13, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>No credentials match your search.</div>;
        }

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "300px", overflowY: "auto", paddingRight: 4 }}>
            {filtered.map((cred, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "var(--background)", borderRadius: 8, border: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Globe size={16} color="var(--text-sub)" />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{cred.domain}</div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)" }}>{cred.username}</div>
                </div>
              </div>
              <button onClick={() => handleDelete(cred.domain, cred.username)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-sub)" }}>
                <Trash2 size={14} />
              </button>
            </div>
            ))}
          </div>
        );
      })()}
        </div>
      )}
    </div>
  );
}
