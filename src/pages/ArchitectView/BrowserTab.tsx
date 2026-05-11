import React, { useState, useEffect, useCallback } from "react";
import {
  Globe, Play, Square, Shield, Lock, AlertTriangle,
  ExternalLink, Eye, RefreshCw, Terminal, Monitor,
  Zap, Settings, Info, CheckCircle2, Activity, Plus, X as XIcon
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentData, useWorldStore, BrowserStatus } from "../../store/worldStore";
import { glass, Toggle } from "../../App";

// Archetypes for which a navigation allowlist is *suggested* (still optional).
// These tend to handle high-stakes context (financial, mental-health, education) where
// limiting the agent's web reach reduces the blast radius of prompt injection.
const SENSITIVE_ARCHETYPES = new Set(["accountant", "coach", "tutor", "property_manager"]);

function isSensitiveArchetype(role: string): boolean {
  const r = (role || "").toLowerCase().replace(/\s+/g, "_");
  return SENSITIVE_ARCHETYPES.has(r);
}

export function BrowserTab({ agent }: { agent: AgentData }) {
  const updateAgentBrowserStatus = useWorldStore(s => s.updateAgentBrowserStatus);
  const togglePermission = useWorldStore(s => s.togglePermission);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-agent web-navigation allowlist. Empty array = open web access (still subject to
  // SSRF block on private subnets). Non-empty = browser is constrained to these domains.
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [allowlistSaving, setAllowlistSaving] = useState(false);
  const allowlistActive = allowedDomains.length > 0;

  const browserStatus = agent.browser_status;
  const isRunning = browserStatus?.is_running || false;

  const refreshStatus = async () => {
    try {
      const status: BrowserStatus | null = await invoke("get_browser_status", { agentId: agent.id });
      updateAgentBrowserStatus(agent.id, status);

      // Auto-enable browser permission when browser becomes running
      if (status?.is_running) {
        const browserPerm = agent.permissions.find(p => p.id === "browser");
        if (browserPerm && !browserPerm.enabled) {
          togglePermission(agent.id, "browser");
        }
      }
    } catch (e) {
      console.error("Failed to get browser status:", e);
    }
  };

  useEffect(() => {
    refreshStatus();

    // Load the persisted per-agent allowlist from Rust on tab mount.
    invoke<string[]>("get_agent_allowed_domains", { agentId: agent.id })
      .then(d => setAllowedDomains(d || []))
      .catch(() => setAllowedDomains([]));
  }, [agent.id]);

  // Save the allowlist back to Rust. The Rust side restarts the agent's Chrome if it's
  // running so the new PAC script takes effect (you can't change PAC on a live Chrome).
  const persistAllowlist = useCallback(async (next: string[]) => {
    setAllowlistSaving(true);
    try {
      await invoke("update_agent_allowed_domains", { agentId: agent.id, domains: next });
      setAllowedDomains(next);
    } catch (e) {
      setError(`Failed to save allowlist: ${e}`);
    } finally {
      setAllowlistSaving(false);
    }
  }, [agent.id]);

  const addDomain = useCallback(() => {
    const candidate = allowlistDraft.trim().toLowerCase();
    if (!candidate) return;
    // Strip protocol + path if user pasted a full URL.
    const cleaned = candidate.replace(/^https?:\/\//, "").split("/")[0];
    if (!cleaned || allowedDomains.includes(cleaned)) {
      setAllowlistDraft("");
      return;
    }
    persistAllowlist([...allowedDomains, cleaned]);
    setAllowlistDraft("");
  }, [allowlistDraft, allowedDomains, persistAllowlist]);

  const removeDomain = useCallback((d: string) => {
    persistAllowlist(allowedDomains.filter(x => x !== d));
  }, [allowedDomains, persistAllowlist]);

  const handleShowBrowser = async () => {
    try {
      await invoke("show_browser", { agentId: agent.id });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleHideBrowser = async () => {
    try {
      await invoke("hide_browser", { agentId: agent.id });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header / Main Control */}
      <div style={{ ...glass(0.6), padding: 24, borderRadius: 20, border: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ 
              width: 48, height: 48, borderRadius: 12, 
              background: isRunning ? "rgba(60, 102, 99, 0.1)" : "var(--surface-base)", 
              display: "flex", alignItems: "center", justifyContent: "center",
              color: isRunning ? "#3c6663" : "var(--text-sub)"
            }}>
              <Monitor size={24} />
            </div>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--text-main)" }}>Machine Browser</h2>
              <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "4px 0 0 0" }}>
                Browser dynamically spawns off-screen only when the agent requests it.
              </p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {loading && <RefreshCw size={16} className="animate-spin" style={{ color: "var(--text-sub)" }} />}
            {isRunning ? (
              <>
                <button onClick={handleShowBrowser} style={{ padding: "6px 12px", borderRadius: 8, background: "#3c6663", color: "white", border: "none", fontWeight: 600, display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 }}>
                  Bring to Front
                </button>
                <button onClick={handleHideBrowser} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--surface-base)", color: "var(--text-main)", border: "1px solid var(--border-subtle)", fontWeight: 600, display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 }}>
                  Hide Off-Screen
                </button>
              </>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-sub)", fontWeight: 600, padding: "6px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
                JIT Proxy Idle
              </span>
            )}
          </div>
        </div>

        {error && (
          <div style={{ 
            background: "rgba(229, 115, 115, 0.1)", border: "1px solid rgba(229, 115, 115, 0.3)", 
            borderRadius: 12, padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center",
            color: "#c62828", fontSize: 13
          }}>
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div style={{ background: "var(--surface-base)", padding: 12, borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 4 }}>Status</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: isRunning ? "#3c6663" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              {isRunning ? <><CheckCircle2 size={14} /> Active</> : "Offline"}
            </div>
          </div>
          <div style={{ background: "var(--surface-base)", padding: 12, borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 4 }}>CDP Port</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>
              {browserStatus?.port || "—"}
            </div>
          </div>
          <div style={{ background: "var(--surface-base)", padding: 12, borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 4 }}>Type</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Host Bridge</div>
          </div>
        </div>
      </div>

      {/* Profile Info */}
      {isRunning && (
        <div style={{ ...glass(0.4), padding: 20, borderRadius: 16, border: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Shield size={16} style={{ color: "#3c6663" }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Sandbox Profile</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", background: "var(--surface-base)", padding: 10, borderRadius: 8, fontFamily: "monospace", overflowX: "auto" }}>
            {browserStatus?.profile_path}
          </div>
          <p style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 10, lineHeight: 1.4 }}>
            This agent is using a strictly isolated browser profile. It cannot see your primary Chrome tabs, history, or passwords.
          </p>
        </div>
      )}

      {/* File Exfiltration Edge-Case Warning */}
      {isRunning && agent.permissions?.find(p => p.id === "file_write")?.enabled && (
        <div style={{ padding: 16, background: "rgba(212, 160, 74, 0.1)", border: "1px solid rgba(212, 160, 74, 0.3)", borderRadius: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertTriangle size={20} color="#D4A04A" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#D4A04A", marginBottom: 4 }}>Security Warning: File Exfiltration Risk</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>
              This agent has <strong>File System Write</strong> permissions enabled. While its browser profile is isolated, it could theoretically download files from the web into its workspace and use its file-write tools to copy them elsewhere on your local disk. 
              Only use this combination if explicitly needed.
            </div>
          </div>
        </div>
      )}

      {/* Guardrails Section */}
      <div style={{ ...glass(0.4), padding: 20, borderRadius: 16, border: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Lock size={16} style={{ color: "#D4A04A" }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Active Guardrails</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* SSRF block — always on. */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Shield size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Local Network Block</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Denies localhost, 192.168.*, 10.*, 172.16.*, file://</div>
              </div>
            </div>
            <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
          </div>

          {/* Navigation Allowlist — dynamic. Reflects actual allowedDomains state. */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Globe size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Navigation Allowlist</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>
                  {allowlistActive
                    ? `Constrained to ${allowedDomains.length} domain${allowedDomains.length === 1 ? "" : "s"}`
                    : "Open web access — no allowlist set"}
                </div>
              </div>
            </div>
            <span style={{
              fontSize: 10,
              background: allowlistActive ? "#dcfce7" : "var(--border-subtle)",
              color: allowlistActive ? "#166534" : "var(--text-sub)",
              padding: "1px 6px",
              borderRadius: 10,
              fontWeight: 600,
            }}>
              {allowlistActive ? "Active" : "Off"}
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Eye size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Optical Monitoring</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Headed mode + 2 FPS visual stream</div>
              </div>
            </div>
            <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-base)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Zap size={14} style={{ color: "var(--text-sub)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Bot-Blocker Bypass</div>
                <div style={{ fontSize: 10, color: "var(--text-sub)" }}>Real Chrome on host (not headless Chromium)</div>
              </div>
            </div>
            <span style={{ fontSize: 10, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>Active</span>
          </div>
        </div>
      </div>

      {/* Navigation Allowlist editor */}
      <div style={{ ...glass(0.4), padding: 20, borderRadius: 16, border: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Globe size={16} style={{ color: "#3c6663" }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Site Access</span>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-sub)", margin: 0, lineHeight: 1.5, maxWidth: 540 }}>
              By default this agent has open web access. Add domains here to restrict it to ONLY those sites.
              Use <code>*.example.com</code> to allow all subdomains.
            </p>
          </div>
        </div>

        {isSensitiveArchetype(agent.role) && !allowlistActive && (
          <div style={{ padding: 10, background: "rgba(212, 160, 74, 0.1)", border: "1px solid rgba(212, 160, 74, 0.3)", borderRadius: 8, marginBottom: 12, fontSize: 12, color: "var(--text-main)" }}>
            <strong style={{ color: "#D4A04A" }}>Suggestion:</strong> {agent.name} handles sensitive context. Consider adding a navigation allowlist so they can only reach the sites needed for their role.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            value={allowlistDraft}
            onChange={e => setAllowlistDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addDomain(); } }}
            placeholder="example.com or *.example.com"
            style={{
              flex: 1, padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)",
              fontSize: 12, fontFamily: "monospace", background: "var(--surface-base)", color: "var(--text-main)",
            }}
          />
          <button
            onClick={addDomain}
            disabled={!allowlistDraft.trim() || allowlistSaving}
            style={{
              padding: "7px 14px", background: "#3c6663", color: "#fff", border: "none",
              borderRadius: 7, fontSize: 12, fontWeight: 600,
              cursor: allowlistDraft.trim() && !allowlistSaving ? "pointer" : "not-allowed",
              opacity: allowlistDraft.trim() && !allowlistSaving ? 1 : 0.5,
              display: "flex", alignItems: "center", gap: 4,
            }}
          >
            <Plus size={14} /> Allow
          </button>
        </div>

        {allowedDomains.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {allowedDomains.map(d => (
              <div key={d} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 6px 4px 10px", background: "var(--surface-base)",
                border: "1px solid var(--border-subtle)", borderRadius: 14,
                fontSize: 12, fontFamily: "monospace", color: "var(--text-main)",
              }}>
                {d}
                <button
                  onClick={() => removeDomain(d)}
                  disabled={allowlistSaving}
                  aria-label={`Remove ${d}`}
                  style={{
                    background: "transparent", border: "none", padding: 2,
                    color: "var(--text-sub)", cursor: "pointer", display: "flex",
                  }}
                >
                  <XIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-sub)", fontStyle: "italic" }}>
            No domains restricted — agent can navigate anywhere on the public internet (except local network, which is always blocked).
          </div>
        )}
      </div>

    </div>
  );
}
