import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { ProvidersVault } from "./ProvidersVault";
import { PasswordInput } from "./shared/PasswordInput";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServiceStatus {
  connected: boolean;
  label?: string; // e.g. workspace name, bot name, email address
}

type Section = "providers" | "services";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: connected ? "#22c55e" : "#d1d5db",
      flexShrink: 0,
    }} />
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-main)", margin: 0, fontFamily: "'Noto Serif', Georgia, serif" }}>{title}</h2>
      <p style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6, lineHeight: 1.5 }}>{subtitle}</p>
    </div>
  );
}

// ─── Service Card ─────────────────────────────────────────────────────────────

interface ServiceCardProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  status: ServiceStatus;
  agentCount?: number;
  onConnect: () => void;
  onDisconnect?: () => void;
  isLoading?: boolean;
  children?: React.ReactNode; // inline config shown when connected
}

function ServiceCard({ icon, name, description, status, agentCount, onConnect, onDisconnect, isLoading, children }: ServiceCardProps) {
  const [showConfig, setShowConfig] = useState(false);

  return (
    <div style={{
      background: "var(--surface-card)",
      border: "1px solid var(--border-subtle)",
      borderRadius: 12,
      padding: "18px 20px",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: "var(--border-subtle)",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          {icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>{name}</span>
            <StatusDot connected={status.connected} />
            {status.connected && status.label && (
              <span style={{ fontSize: 11, color: "var(--text-sub)", fontWeight: 400 }}>{status.label}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.4 }}>{description}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {status.connected && agentCount !== undefined && (
            <span style={{ fontSize: 11, color: "var(--text-sub)", background: "var(--border-subtle)", padding: "2px 8px", borderRadius: 20 }}>
              {agentCount} agent{agentCount !== 1 ? "s" : ""}
            </span>
          )}
          {status.connected ? (
            <>
              {children && (
                <button onClick={() => setShowConfig(v => !v)} style={{
                  padding: "6px 14px", border: "1px solid var(--border-subtle)", borderRadius: 7,
                  background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  color: "var(--text-sub)", fontFamily: "inherit",
                }}>
                  {showConfig ? "Done" : "Configure"}
                </button>
              )}
              {onDisconnect && (
                <button onClick={onDisconnect} style={{
                  padding: "6px 14px", border: "1px solid #fca5a5", borderRadius: 7,
                  background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  color: "#ef4444", fontFamily: "inherit",
                }}>
                  Disconnect
                </button>
              )}
            </>
          ) : (
            <button onClick={onConnect} disabled={isLoading} style={{
              padding: "7px 18px", background: "#3c6663", color: "#fff", border: "none",
              borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: isLoading ? "default" : "pointer",
              opacity: isLoading ? 0.6 : 1, fontFamily: "inherit",
            }}>
              {isLoading ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {/* Inline config (shown when connected + Configure clicked) */}
      {status.connected && showConfig && children && (
        <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Slack Setup Panel ────────────────────────────────────────────────────────

function SlackSetupPanel({ onConnected }: { onConnected: () => void }) {
  const [step, setStep] = useState<"bot" | "app" | "done">("bot");
  const [appToken, setAppToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleOAuth = async () => {
    setIsLoading(true);
    setError("");
    try {
      await invoke("start_slack_oauth");
      setStep("app");
    } catch (e: any) {
      setError(e?.toString() || "OAuth failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveAppToken = async () => {
    const tok = appToken.trim();
    if (!tok.startsWith("xapp-")) {
      setError("App token must start with xapp-");
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      await invoke("store_secret_cmd", { key: "slack-app-token", value: tok });
      await invoke("start_slack_listener");
      setStep("done");
      onConnected();
    } catch (e: any) {
      setError(e?.toString() || "Failed to activate Slack");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "4px 0" }}>
      {/* Step 1 */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{
          width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex",
          alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
          background: step === "bot" ? "#3c6663" : "#22c55e", color: "#fff",
        }}>
          {step === "bot" ? "1" : "✓"}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>
            Connect your Slack workspace
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8, lineHeight: 1.5 }}>
            Authorises Canopy as a bot in your workspace. You'll need a Slack app with scopes:
            <code style={{ background: "var(--border-subtle)", padding: "1px 5px", borderRadius: 3, fontSize: 11, marginLeft: 4 }}>
              channels:read, channels:history, chat:write, users:read
            </code>
          </div>
          {step === "bot" && (
            <button onClick={handleOAuth} disabled={isLoading} style={{
              padding: "7px 16px", background: "#4a154b", color: "#fff", border: "none",
              borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            }}>
              {isLoading ? "Opening browser…" : "Sign in with Slack"}
            </button>
          )}
        </div>
      </div>

      {/* Step 2 */}
      {(step === "app" || step === "done") && (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{
            width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex",
            alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
            background: step === "done" ? "#22c55e" : "#3c6663", color: "#fff",
          }}>
            {step === "done" ? "✓" : "2"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>
              Add App-Level Token (Socket Mode)
            </div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8, lineHeight: 1.5 }}>
              Go to <strong>api.slack.com → Your App → Settings → App-Level Tokens</strong>.
              Create a token with <code style={{ background: "var(--border-subtle)", padding: "1px 4px", borderRadius: 3, fontSize: 11 }}>connections:write</code> scope.
              Paste the <code style={{ background: "var(--border-subtle)", padding: "1px 4px", borderRadius: 3, fontSize: 11 }}>xapp-</code> token below.
            </div>
            {step === "app" && (
              <div style={{ display: "flex", gap: 8 }}>
                <PasswordInput
                  value={appToken}
                  onChange={e => setAppToken(e.target.value)}
                  placeholder="xapp-1-..."
                  style={{ flex: 1, padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)" }}
                />
                <button onClick={handleSaveAppToken} disabled={isLoading || !appToken.trim()} style={{
                  padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
                  borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                  opacity: !appToken.trim() ? 0.5 : 1,
                }}>
                  {isLoading ? "Activating…" : "Activate"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "#ef4444", background: "#fef2f2", padding: "8px 12px", borderRadius: 7 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Pairing Code Panel ───────────────────────────────────────────────────────

function PairingPanel() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState("");

  const handleApprove = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || trimmed.length < 4) return;
    setStatus("loading");
    setError("");
    try {
      await invoke("approve_slack_pairing", { code: trimmed });
      setStatus("success");
      setCode("");
    } catch (e: any) {
      setStatus("error");
      setError(e?.toString() || "Pairing failed");
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8, lineHeight: 1.5 }}>
        DM your Slack bot the word <code style={{ background: "var(--border-subtle)", padding: "1px 5px", borderRadius: 3 }}>pair</code> and paste the code it replies with here.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="XXXXXX"
          maxLength={12}
          style={{
            width: 120, padding: "7px 11px", border: "1px solid var(--border-subtle)",
            borderRadius: 7, fontSize: 14, fontFamily: "monospace", letterSpacing: "0.15em",
            background: "var(--surface-card)", color: "var(--text-main)", textTransform: "uppercase",
          }}
        />
        <button onClick={handleApprove} disabled={status === "loading" || !code.trim()} style={{
          padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
          borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        }}>
          {status === "loading" ? "Pairing…" : "Approve"}
        </button>
        {status === "success" && <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>✓ Paired</span>}
      </div>
      {status === "error" && <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─── Slack Config Panel ───────────────────────────────────────────────────────

function SlackConfigPanel() {
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    Promise.all([
      invoke<string>("get_secret_cmd", { key: "slack-app-token" }).catch(() => ""),
      invoke<string>("get_secret_cmd", { key: "slack-bot-token" }).catch(() => "")
    ]).then(([app, bot]) => {
      setAppToken(app);
      setBotToken(bot);
    });
  }, []);

  const handleUpdateTokens = async () => {
    setIsLoading(true);
    setError("");
    setSuccess(false);
    try {
      if (appToken) await invoke("store_secret_cmd", { key: "slack-app-token", value: appToken.trim() });
      if (botToken) await invoke("store_secret_cmd", { key: "slack-bot-token", value: botToken.trim() });
      await invoke("start_slack_listener");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      if (typeof window !== "undefined" && window.location) {
          // Trigger a global check status refresh if possible
          const event = new CustomEvent("slack-updated");
          window.dispatchEvent(event);
      }
    } catch (e: any) {
      setError(e?.toString() || "Failed to update tokens");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <PairingPanel />
      <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>
          Update Slack Tokens
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 4 }}>Bot Token (xoxb-...)</div>
            <PasswordInput
              value={botToken}
              onChange={e => setBotToken(e.target.value)}
              placeholder="xoxb-..."
              style={{ width: "100%", padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)", boxSizing: "border-box" }}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 4 }}>App Token (xapp-...)</div>
            <PasswordInput
              value={appToken}
              onChange={e => setAppToken(e.target.value)}
              placeholder="xapp-1-..."
              style={{ width: "100%", padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)", boxSizing: "border-box" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={handleUpdateTokens} disabled={isLoading} style={{
              padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
              borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit"
            }}>
              {isLoading ? "Updating..." : "Update Tokens & Restart"}
            </button>
            {success && <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>✓ Updated</span>}
          </div>
          {error && <div style={{ fontSize: 12, color: "#ef4444", marginTop: 4, lineHeight: 1.4 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Main IntegrationsView ────────────────────────────────────────────────────

export function IntegrationsView({ agents }: { agents: Array<{ id: string; name: string; integrations: string[] }> }) {
  const [section, setSection] = useState<Section>("services");

  // Gateway-level connection statuses
  const [slackStatus, setSlackStatus] = useState<ServiceStatus>({ connected: false });
  const [gmailStatus, setGmailStatus] = useState<ServiceStatus>({ connected: false });
  const [calendarStatus, setCalendarStatus] = useState<ServiceStatus>({ connected: false });
  const [iMessageStatus, setIMessageStatus] = useState<ServiceStatus>({ connected: false });
  const [telegramStatus, setTelegramStatus] = useState<ServiceStatus>({ connected: false });
  const [discordStatus, setDiscordStatus] = useState<ServiceStatus>({ connected: false });

  // UI states
  const [showSlackSetup, setShowSlackSetup] = useState(false);
  const [slackLoading, setSlackLoading] = useState(false);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [calLoading, setCalLoading] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [discordLoading, setDiscordLoading] = useState(false);
  const [showTelegramInput, setShowTelegramInput] = useState(false);
  const [showDiscordInput, setShowDiscordInput] = useState(false);

  const checkStatuses = useCallback(async () => {
    // Slack
    try {
      const s = await invoke<{ connected: boolean; workspace_name?: string; bot_name?: string }>("check_slack_connection");
      setSlackStatus({ connected: s.connected, label: s.workspace_name || s.bot_name });
    } catch { setSlackStatus({ connected: false }); }

    // Gmail — check if token is in keychain
    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "GMAIL_ACCESS_TOKEN" });
      const email = await invoke<string>("get_secret_cmd", { key: "GMAIL_USER_EMAIL" }).catch(() => "");
      setGmailStatus({ connected: !!tok, label: email || undefined });
    } catch { setGmailStatus({ connected: false }); }

    // Calendar
    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "GCAL_ACCESS_TOKEN" });
      setCalendarStatus({ connected: !!tok });
    } catch { setCalendarStatus({ connected: false }); }

    // iMessage
    try {
      const granted = await invoke<boolean>("check_full_disk_access");
      setIMessageStatus({ connected: granted });
    } catch { setIMessageStatus({ connected: false }); }

    // Telegram
    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "telegram-bot-token" });
      setTelegramStatus({ connected: !!tok });
    } catch { setTelegramStatus({ connected: false }); }

    // Discord
    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "discord-bot-token" });
      setDiscordStatus({ connected: !!tok });
    } catch { setDiscordStatus({ connected: false }); }
  }, []);

  useEffect(() => { 
    checkStatuses(); 
    const handleUpdate = () => checkStatuses();
    window.addEventListener("slack-updated", handleUpdate);
    return () => window.removeEventListener("slack-updated", handleUpdate);
  }, [checkStatuses]);

  // Agent counts per service
  const agentCount = (integration: string) =>
    agents.filter(a => a.integrations?.some(i => i.includes(integration))).length;

  // ── Gmail connect
  const connectGmail = async () => {
    setGmailLoading(true);
    try {
      const result = await invoke<{ access_token?: string }>("start_google_oauth", {
        scopes: ["email"],
        readOnly: true,
      });
      if (result.access_token) {
        await invoke("store_secret_cmd", { key: "GMAIL_ACCESS_TOKEN", value: result.access_token });
        setGmailStatus({ connected: true });
      }
    } catch (e) {
      console.error("Gmail connect failed:", e);
    } finally {
      setGmailLoading(false);
    }
  };

  // ── Calendar connect
  const connectCalendar = async () => {
    setCalLoading(true);
    try {
      const result = await invoke<{ access_token?: string }>("start_google_oauth", {
        scopes: ["calendar"],
        readOnly: true,
      });
      if (result.access_token) {
        await invoke("store_secret_cmd", { key: "GCAL_ACCESS_TOKEN", value: result.access_token });
        setCalendarStatus({ connected: true });
      }
    } catch (e) {
      console.error("Calendar connect failed:", e);
    } finally {
      setCalLoading(false);
    }
  };

  // ── iMessage — just prompts for Full Disk Access
  const connectIMessage = async () => {
    try {
      await invoke("start_imessage_watcher", { appHandle: null }).catch(() => {});
      const granted = await invoke<boolean>("check_full_disk_access");
      setIMessageStatus({ connected: granted });
      if (!granted) {
        // Open System Settings to the FDA pane
        await open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      }
    } catch (e) {
      console.error("iMessage setup error:", e);
    }
  };

  // ── Telegram connect
  const connectTelegram = async () => {
    if (!telegramToken.trim()) return;
    setTelegramLoading(true);
    try {
      await invoke("configure_telegram", { botToken: telegramToken.trim() });
      setTelegramStatus({ connected: true });
      setShowTelegramInput(false);
      setTelegramToken("");
    } catch (e) {
      console.error("Telegram connect failed:", e);
    } finally {
      setTelegramLoading(false);
    }
  };

  // ── Discord connect
  const connectDiscord = async () => {
    if (!discordToken.trim()) return;
    setDiscordLoading(true);
    try {
      await invoke("configure_discord", { botToken: discordToken.trim() });
      setDiscordStatus({ connected: true });
      setShowDiscordInput(false);
      setDiscordToken("");
    } catch (e) {
      console.error("Discord connect failed:", e);
    } finally {
      setDiscordLoading(false);
    }
  };

  // ── Disconnect helpers
  const disconnectSlack = async () => {
    setSlackLoading(true);
    try {
      await invoke("stop_slack_listener").catch(console.warn);
      await invoke("delete_secret_cmd", { key: "slack-bot-token" }).catch(console.warn);
      await invoke("delete_secret_cmd", { key: "slack-app-token" }).catch(console.warn);
      setSlackStatus({ connected: false });
      setShowSlackSetup(false);
      checkStatuses();
    } catch (e) { console.error(e); }
    finally { setSlackLoading(false); }
  };

  const disconnectGmail = async () => {
    try {
      await invoke("delete_secret_cmd", { key: "GMAIL_ACCESS_TOKEN" });
      setGmailStatus({ connected: false });
    } catch (e) { console.error(e); }
  };

  const disconnectCalendar = async () => {
    try {
      await invoke("delete_secret_cmd", { key: "GCAL_ACCESS_TOKEN" });
      setCalendarStatus({ connected: false });
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Page header */}
      <div style={{ padding: "32px 40px 0", flexShrink: 0 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: 0, fontFamily: "'Noto Serif', Georgia, serif" }}>
          Integrations
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-sub)", marginTop: 8, marginBottom: 24, lineHeight: 1.5 }}>
          Connect services here once — all your agents can use them. Per-agent channel access is configured in each agent's Connections tab.
        </p>

        {/* Section tabs */}
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border-subtle)" }}>
          {([
            { id: "services", label: "Services" },
            { id: "providers", label: "AI Providers" },
          ] as const).map(tab => (
            <button key={tab.id} onClick={() => setSection(tab.id)} style={{
              padding: "8px 18px", border: "none", background: "transparent", cursor: "pointer",
              fontSize: 13, fontWeight: section === tab.id ? 700 : 400,
              color: section === tab.id ? "var(--text-main)" : "var(--text-sub)",
              borderBottom: section === tab.id ? "2px solid #3c6663" : "2px solid transparent",
              marginBottom: -1, fontFamily: "inherit", transition: "all 0.15s",
            }}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "28px 40px 40px" }}>

        {/* ── AI Providers ── */}
        {section === "providers" && (
          <>
            <SectionHeader
              title="AI Providers"
              subtitle="Global API keys used by all agents. Individual agents can override with their own keys in their Overview tab."
            />
            <ProvidersVault />
          </>
        )}

        {/* ── Services ── */}
        {section === "services" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader
              title="Connected Services"
              subtitle="Set up each service once. Your agents share these connections — control which agents can use each service in their Connections tab."
            />

            {/* Slack */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#2EB67D"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#2EB67D"/><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/></svg>}
              name="Slack"
              description="Real-time messaging via Socket Mode. All shared agents use one workspace connection."
              status={slackStatus}
              agentCount={agentCount("slack")}
              onConnect={() => setShowSlackSetup(true)}
              onDisconnect={slackStatus.connected ? disconnectSlack : undefined}
              isLoading={slackLoading}
            >
              {/* Slack Config Panel (includes Pairing) */}
              <SlackConfigPanel />
            </ServiceCard>

            {/* Slack setup panel (shown below the card when not yet connected) */}
            {showSlackSetup && !slackStatus.connected && (
              <div style={{
                background: "var(--surface-card)", border: "1px solid #3c666330",
                borderRadius: 12, padding: "20px 22px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Connect Slack</span>
                  <button onClick={() => setShowSlackSetup(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", fontSize: 18 }}>×</button>
                </div>
                <SlackSetupPanel onConnected={() => { checkStatuses(); setShowSlackSetup(false); }} />
              </div>
            )}

            {/* Gmail */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2z" fill="#fff" stroke="#E8EAED" strokeWidth="1.5"/><path d="M2 6l10 7 10-7" stroke="#EA4335" strokeWidth="2" strokeLinecap="round"/><path d="M2 6l10 7" stroke="#FBBC05" strokeWidth="1.5"/><path d="M22 6l-10 7" stroke="#34A853" strokeWidth="1.5"/></svg>}
              name="Gmail"
              description="Read emails and send replies on behalf of your agents (using your Google account)."
              status={gmailStatus}
              agentCount={agentCount("email")}
              onConnect={connectGmail}
              onDisconnect={gmailStatus.connected ? disconnectGmail : undefined}
              isLoading={gmailLoading}
            />

            {/* Calendar */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4285F4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}
              name="Google Calendar"
              description="Read events and create calendar items for scheduling agents."
              status={calendarStatus}
              agentCount={agentCount("calendar")}
              onConnect={connectCalendar}
              onDisconnect={calendarStatus.connected ? disconnectCalendar : undefined}
              isLoading={calLoading}
            />

            {/* iMessage */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.02 2 11c0 2.64 1.15 5.02 3 6.71V22l4.29-2.13C10.12 20.28 11.04 20.5 12 20.5c5.52 0 10-3.58 10-8s-4.48-8-10-8z" fill="#34C759"/></svg>}
              name="iMessage"
              description="Read and reply to iMessage threads. Requires macOS Full Disk Access."
              status={iMessageStatus}
              agentCount={agentCount("imessage")}
              onConnect={connectIMessage}
            />

            {/* Telegram */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#2AABEE"/><path d="M18.6 6.8l-2.4 11.4c-.2.8-.7 1-1.3.6l-3.6-2.7-1.7 1.7c-.2.2-.4.3-.7.3l.3-3.8 6.5-5.9c.3-.3-.1-.4-.4-.2L6 14.2 2.5 13c-.8-.3-.8-.8.2-1.1l15.1-5.8c.6-.3 1.2.1 1 1.1-.1-.1-.2-.1-.2.6z" fill="#fff"/></svg>}
              name="Telegram"
              description="Connect a Telegram bot. One bot per gateway — shared across all agents."
              status={telegramStatus}
              agentCount={agentCount("telegram")}
              onConnect={() => setShowTelegramInput(true)}
            />
            {showTelegramInput && !telegramStatus.connected && (
              <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 10, lineHeight: 1.5 }}>
                  Create a bot via <strong>@BotFather</strong> in Telegram and paste the token below.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <PasswordInput
                    value={telegramToken}
                    onChange={e => setTelegramToken(e.target.value)}
                    placeholder="123456789:ABCdef..."
                    style={{ flex: 1, padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)" }}
                  />
                  <button onClick={connectTelegram} disabled={telegramLoading || !telegramToken.trim()} style={{
                    padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
                    borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                  }}>
                    {telegramLoading ? "Saving…" : "Connect"}
                  </button>
                  <button onClick={() => setShowTelegramInput(false)} style={{ padding: "7px 12px", border: "1px solid var(--border-subtle)", borderRadius: 7, background: "none", cursor: "pointer", color: "var(--text-sub)", fontFamily: "inherit" }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Discord */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.3 4.4A19.4 19.4 0 0015.1 3a.1.1 0 00-.1.1c-.2.4-.4.9-.6 1.3a17.9 17.9 0 00-5.3 0 13 13 0 00-.6-1.3.1.1 0 00-.1-.1A19.3 19.3 0 003.7 4.4a.1.1 0 000 .1C1 8.7.3 12.9.7 17.1a.1.1 0 00.1.1 19.5 19.5 0 005.7 2.9.1.1 0 00.1-.1c.4-.6.8-1.2 1.2-1.9a.1.1 0 000-.1 12.8 12.8 0 01-2-.9.1.1 0 010-.2l.4-.3a.1.1 0 01.1 0c4.2 1.9 8.7 1.9 12.8 0a.1.1 0 01.1 0l.4.3a.1.1 0 010 .2 12.8 12.8 0 01-2 .9.1.1 0 000 .1c.4.7.8 1.3 1.2 1.9a.1.1 0 00.1.1 19.4 19.4 0 005.7-2.9.1.1 0 00.1-.1c.4-4.8-.7-9-3-12.7a.1.1 0 00-.1 0zM8.5 14.5c-1.1 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3zm7 0c-1.1 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3z"/></svg>}
              name="Discord"
              description="Connect a Discord bot to respond in channels and DMs."
              status={discordStatus}
              agentCount={agentCount("discord")}
              onConnect={() => setShowDiscordInput(true)}
            />
            {showDiscordInput && !discordStatus.connected && (
              <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 13, color: "var(--text-sub)", marginBottom: 10, lineHeight: 1.5 }}>
                  Create a bot at <strong>discord.com/developers</strong> and paste the bot token below.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <PasswordInput
                    value={discordToken}
                    onChange={e => setDiscordToken(e.target.value)}
                    placeholder="Bot token..."
                    style={{ flex: 1, padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-subtle)", fontSize: 12, fontFamily: "monospace", background: "var(--surface-card)", color: "var(--text-main)" }}
                  />
                  <button onClick={connectDiscord} disabled={discordLoading || !discordToken.trim()} style={{
                    padding: "7px 16px", background: "#3c6663", color: "#fff", border: "none",
                    borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                  }}>
                    {discordLoading ? "Saving…" : "Connect"}
                  </button>
                  <button onClick={() => setShowDiscordInput(false)} style={{ padding: "7px 12px", border: "1px solid var(--border-subtle)", borderRadius: 7, background: "none", cursor: "pointer", color: "var(--text-sub)", fontFamily: "inherit" }}>Cancel</button>
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
}
