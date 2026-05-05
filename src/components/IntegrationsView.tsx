import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { ProvidersVault } from "./ProvidersVault";
import { WebVault } from "./WebVault";
import { PasswordInput } from "./shared/PasswordInput";
import { Link, Calendar, HardDrive, Github, MessageCircle, Cloud, Database } from "lucide-react";

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
  connectedAgents?: Array<{ id: string; name: string; mode?: string }>;
  onConnect?: () => void;
  onDisconnect?: () => void;
  isLoading?: boolean;
  children?: React.ReactNode; // inline config shown when connected
}

function ServiceCard({ icon, name, description, status, connectedAgents, onConnect, onDisconnect, isLoading, children }: ServiceCardProps) {
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
            {status.connected && <StatusDot connected={status.connected} />}
            {status.connected && status.label && (
              <span style={{ fontSize: 11, color: "var(--text-sub)", fontWeight: 400 }}>{status.label}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.4 }}>{description}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {status.connected && onDisconnect && (
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
              <button onClick={onDisconnect} style={{
                padding: "6px 14px", border: "1px solid #fca5a5", borderRadius: 7,
                background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer",
                color: "#ef4444", fontFamily: "inherit",
              }}>
                Disconnect
              </button>
            </>
          )}
          {!status.connected && onConnect && (
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

      {/* Connected Agents List */}
      {connectedAgents && connectedAgents.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px solid rgba(0,0,0,0.04)", paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-sub)", textTransform: "uppercase", marginBottom: 8, letterSpacing: "0.04em" }}>Connected Agents</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {connectedAgents.map(a => (
               <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: 16 }}>
                 <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4A9E96" }} />
                 <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>{a.name}</span>
                 {a.mode && (
                   <span style={{ fontSize: 10, background: "rgba(0,0,0,0.04)", color: "var(--text-sub)", padding: "2px 6px", borderRadius: 6, fontWeight: 600 }}>
                     {a.mode}
                   </span>
                 )}
               </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline config (shown when connected + Configure clicked) */}
      {status.connected && showConfig && children && (
        <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Main IntegrationsView ────────────────────────────────────────────────────

export function IntegrationsView({ agents }: { agents: Array<{ id: string; name: string; integrations: string[] }> }) {
  const [section, setSection] = useState<Section>("services");
  const [searchQuery, setSearchQuery] = useState("");

  const [gmailStatus, setGmailStatus] = useState<ServiceStatus>({ connected: false });
  const [calendarStatus, setCalendarStatus] = useState<ServiceStatus>({ connected: false });
  const [iMessageStatus, setIMessageStatus] = useState<ServiceStatus>({ connected: false });
  const [telegramStatus, setTelegramStatus] = useState<ServiceStatus>({ connected: false });
  const [discordStatus, setDiscordStatus] = useState<ServiceStatus>({ connected: false });
  const [githubStatus, setGithubStatus] = useState<ServiceStatus>({ connected: false });

  // UI states
  const [gmailLoading, setGmailLoading] = useState(false);
  const [calLoading, setCalLoading] = useState(false);


  const [connectors, setConnectors] = useState<any[]>([]);

  useEffect(() => {
    invoke<any[]>("get_connectors_config")
      .then(data => {
         if (Array.isArray(data)) setConnectors(data);
      })
      .catch(console.error);
  }, []);

  const checkStatuses = useCallback(async () => {
    // Slack is now per-agent, so no global status check needed here

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

    // Github
    try {
      const tok = await invoke<string>("get_secret_cmd", { key: "GITHUB_TOKEN" });
      setGithubStatus({ connected: !!tok });
    } catch { setGithubStatus({ connected: false }); }

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
    window.addEventListener("refresh_integrations", handleUpdate);
    return () => {
      window.removeEventListener("slack-updated", handleUpdate);
      window.removeEventListener("refresh_integrations", handleUpdate);
    };
  }, [checkStatuses]);

  const launchCompanion = async (id: string, name: string) => {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    new WebviewWindow('companion_' + id + '_' + Date.now(), {
      url: `/index.html?companion=${id}&agentName=Shared`,
      title: `Setup ${name}`,
      width: 420,
      height: 760,
      x: window.screen.availWidth - 440,
      y: 50,
      alwaysOnTop: true,
      decorations: true,
    });
  };

  // Agents connected to each service
  const getConnectedAgentsWithMode = (integration: string) =>
    agents.filter(a => a.integrations?.some(i => i.includes(integration))).map(a => {
      let mode = undefined;
      if (integration === "email") {
        if (a.integrations.includes("email_write")) mode = "Read/Write";
        else if (a.integrations.includes("email_read")) mode = "Read-Only";
        else if (a.integrations.includes("email_dedicated")) mode = "Dedicated";
      } else if (integration === "calendar") {
        if (a.integrations.includes("calendar_write") || a.integrations.includes("calendar")) mode = "Read/Write";
        else if (a.integrations.includes("calendar_read")) mode = "Read-Only";
      }
      return { id: a.id, name: a.name, mode };
    });

  // ── Gmail connect
  const connectGmail = async () => {
    setGmailLoading(true);
    try {
      const result = await invoke<{ access_token?: string }>("start_google_oauth", {
        scopes: ["email"],
        readOnly: false,
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
        readOnly: false,
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
              title="Suggested Services"
              subtitle="Set up each service once. Your agents share these connections — control which agents can use each service in their Connections tab."
            />
            
            <WebVault />

            {/* Slack */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="#E01E5A"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" fill="#2EB67D"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" fill="#2EB67D"/><path d="M14 9.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M14 3.5C14 2.67 14.67 2 15.5 2S17 2.67 17 3.5V5h-1.5c-.83 0-1.5-.67-1.5-1.5z" fill="#ECB22E"/><path d="M10 14.5c0 .83-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5S2.67 13 3.5 13h5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/><path d="M10 20.5c0 .83-.67 1.5-1.5 1.5S7 21.33 7 20.5V19h1.5c.83 0 1.5.67 1.5 1.5z" fill="#36C5F0"/></svg>}
              name="Slack"
              description="Real-time messaging via Socket Mode. Configured per-agent."
              status={{ connected: getConnectedAgentsWithMode("slack").length > 0 }}
              connectedAgents={getConnectedAgentsWithMode("slack")}
            />

            {/* Gmail */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2z" fill="#fff" stroke="#E8EAED" strokeWidth="1.5"/><path d="M2 6l10 7 10-7" stroke="#EA4335" strokeWidth="2" strokeLinecap="round"/><path d="M2 6l10 7" stroke="#FBBC05" strokeWidth="1.5"/><path d="M22 6l-10 7" stroke="#34A853" strokeWidth="1.5"/></svg>}
              name="Gmail"
              description="Read emails and send replies on behalf of your agents (using your Google account)."
              status={gmailStatus}
              connectedAgents={getConnectedAgentsWithMode("email")}
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
              connectedAgents={getConnectedAgentsWithMode("calendar")}
              onConnect={connectCalendar}
              onDisconnect={calendarStatus.connected ? disconnectCalendar : undefined}
              isLoading={calLoading}
            />

            {/* File System */}
            <ServiceCard
              icon={<HardDrive size={20} color="#3c6663" />}
              name="Local File System"
              description="Allow agents to read and write files on your local Mac."
              status={{ connected: agents.some(a => (a as any).permissions?.some((p: any) => (p.id === "file_read" || p.id === "file_write") && p.enabled)) }}
              connectedAgents={agents.filter(a => (a as any).permissions?.some((p: any) => (p.id === "file_read" || p.id === "file_write") && p.enabled)).map(a => {
                const read = (a as any).permissions?.find((p: any) => p.id === "file_read")?.enabled;
                const write = (a as any).permissions?.find((p: any) => p.id === "file_write")?.enabled;
                let mode = undefined;
                if (read && write) mode = "Read/Write";
                else if (read) mode = "Read-Only";
                else if (write) mode = "Write-Only";
                return { id: a.id, name: a.name, mode };
              })}
            />

            {/* iMessage */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.02 2 11c0 2.64 1.15 5.02 3 6.71V22l4.29-2.13C10.12 20.28 11.04 20.5 12 20.5c5.52 0 10-3.58 10-8s-4.48-8-10-8z" fill="#34C759"/></svg>}
              name="iMessage"
              description="Read and reply to iMessage threads. Requires macOS Full Disk Access."
              status={iMessageStatus}
              connectedAgents={getConnectedAgentsWithMode("imessage")}
              onConnect={connectIMessage}
            />

            {/* Telegram */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#2AABEE"/><path d="M18.6 6.8l-2.4 11.4c-.2.8-.7 1-1.3.6l-3.6-2.7-1.7 1.7c-.2.2-.4.3-.7.3l.3-3.8 6.5-5.9c.3-.3-.1-.4-.4-.2L6 14.2 2.5 13c-.8-.3-.8-.8.2-1.1l15.1-5.8c.6-.3 1.2.1 1 1.1-.1-.1-.2-.1-.2.6z" fill="#fff"/></svg>}
              name="Telegram"
              description="Connect a Telegram bot. One bot per gateway — shared across all agents."
              status={telegramStatus}
              connectedAgents={getConnectedAgentsWithMode("telegram")}
              onConnect={() => launchCompanion("telegram", "Telegram")}
            />

            {/* Discord */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.3 4.4A19.4 19.4 0 0015.1 3a.1.1 0 00-.1.1c-.2.4-.4.9-.6 1.3a17.9 17.9 0 00-5.3 0 13 13 0 00-.6-1.3.1.1 0 00-.1-.1A19.3 19.3 0 003.7 4.4a.1.1 0 000 .1C1 8.7.3 12.9.7 17.1a.1.1 0 00.1.1 19.5 19.5 0 005.7 2.9.1.1 0 00.1-.1c.4-.6.8-1.2 1.2-1.9a.1.1 0 000-.1 12.8 12.8 0 01-2-.9.1.1 0 010-.2l.4-.3a.1.1 0 01.1 0c4.2 1.9 8.7 1.9 12.8 0a.1.1 0 01.1 0l.4.3a.1.1 0 010 .2 12.8 12.8 0 01-2 .9.1.1 0 000 .1c.4.7.8 1.3 1.2 1.9a.1.1 0 00.1.1 19.4 19.4 0 005.7-2.9.1.1 0 00.1-.1c.4-4.8-.7-9-3-12.7a.1.1 0 00-.1 0zM8.5 14.5c-1.1 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3zm7 0c-1.1 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3z"/></svg>}
              name="Discord"
              description="Connect a Discord bot to respond in channels and DMs."
              status={discordStatus}
              connectedAgents={getConnectedAgentsWithMode("discord")}
              onConnect={() => launchCompanion("discord", "Discord")}
            />

            {/* Github */}
            <ServiceCard
              icon={<Github size={20} color="#3c6663" />}
              name="GitHub"
              description="Allow agent to read repositories, create PRs, and review code"
              status={githubStatus}
              connectedAgents={getConnectedAgentsWithMode("github")}
              onConnect={() => launchCompanion("github", "GitHub")}
            />

            {/* Dynamic Global Connectors from Admin */}
            {connectors.filter(c => c.isVisible && c.isGlobal && !c.isPlugin && !['slack', 'gmail', 'imessage', 'filesystem', 'telegram', 'discord', 'github'].includes(c.id)).map(c => {
              let IconComponent: any = Link;
              if (c.icon === 'calendar') IconComponent = Calendar;
              if (c.icon === 'hard-drive') IconComponent = HardDrive;
              if (c.icon === 'github') IconComponent = Github;
              if (c.icon === 'send' || c.icon === 'message-circle') IconComponent = MessageCircle;
              if (c.icon === 'cloud') IconComponent = Cloud;
              if (c.icon === 'database') IconComponent = Database;

              return (
                <ServiceCard
                  key={c.id}
                  icon={<IconComponent size={20} color="#3c6663" />}
                  name={c.name}
                  description={c.subtitle}
                  status={{ connected: getConnectedAgentsWithMode(c.id).length > 0 }} 
                  connectedAgents={getConnectedAgentsWithMode(c.id)}
                  onConnect={() => {
                     alert(`Global setup for ${c.name} is coming soon!`);
                  }}
                />
              );
            })}

            {/* ── Plugin Directory ── */}
            <div style={{ marginTop: 40 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                <SectionHeader
                  title="OpenClaw Plugin Directory"
                  subtitle="Explore and connect over 40+ native OpenClaw plugins."
                />
                <div style={{ position: "relative" }}>
                   <input 
                      type="text" 
                      placeholder="Search plugins..." 
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", color: "var(--text-main)", fontSize: 13, width: 220 }}
                   />
                </div>
              </div>
              
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {connectors
                   .filter(c => c.isPlugin)
                   .filter(c => !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.subtitle.toLowerCase().includes(searchQuery.toLowerCase()))
                   .map(c => (
                     <ServiceCard
                       key={c.id}
                       icon={<span style={{ fontSize: 22 }}>{c.emoji || "🔌"}</span>}
                       name={c.name}
                       description={c.subtitle}
                       status={{ connected: getConnectedAgentsWithMode(c.id).length > 0 }}
                       connectedAgents={getConnectedAgentsWithMode(c.id)}
                       onConnect={() => {
                          alert(`To install ${c.name}, follow the instructions in the OpenClaw documentation or run \`openclaw skills install ${c.name}\` in the terminal.`);
                       }}
                     />
                   ))}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
