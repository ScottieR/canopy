import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ProvidersVault } from "./ProvidersVault";
import { WebVault } from "./WebVault";
import { ConfirmDisconnectModal } from "./shared/ConfirmDisconnectModal";
import { Link, Calendar, HardDrive, Github, MessageCircle, Cloud, Database } from "lucide-react";
import { getCustomOAuthProvidersFromScope, type CustomOAuthProvider } from "../utils/customOAuth";

// ─── Disconnect modal config (per integration) ────────────────────────────────
//
// One central definition makes it easy to add new integrations and keeps the modal
// copy consistent. Each entry describes: which Tauri command to invoke, which
// keychain tokens we'll be wiping (shown in the modal), and any extra warning copy.
type DisconnectIntegrationKey = "telegram" | "discord" | "slack-global";

const DISCONNECT_CONFIG: Record<DisconnectIntegrationKey, {
  displayName: string;
  command: string;
  tokens: string[];
  extraNote?: string;
}> = {
  telegram: {
    displayName: "Telegram",
    command: "disconnect_telegram",
    tokens: ["Telegram Bot Token"],
  },
  discord: {
    displayName: "Discord",
    command: "disconnect_discord",
    tokens: ["Discord Bot Token", "Discord Guild ID (if set)"],
  },
  "slack-global": {
    displayName: "Slack",
    command: "disconnect_slack_global",
    tokens: ["Slack Bot Token", "Slack App Token"],
    extraNote: "This is the legacy single-workspace Slack connection. Per-agent Slack connections are managed in each agent's Connections tab.",
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServiceStatus {
  connected: boolean;
  label?: string; // e.g. workspace name, bot name, email address
}

type BridgeRecord = {
  bridge_type?: string;
  bridgeType?: string;
  config?: {
    scope?: unknown;
  };
};

type Section = "providers" | "services";

const PER_AGENT_BRIDGE_CONNECTOR_IDS = [
  "figma",
  "apple_health",
  "live_location",
  "shortcuts",
  "vision",
  "notifications",
  "homekit",
  "bluetooth",
];

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
  // Deep links (e.g. the provider auth-failure modal) ask for a specific section
  // via sessionStorage before navigating here — read-and-clear it so a later
  // manual visit starts on the normal default again.
  const [section, setSection] = useState<Section>(() => {
    try {
      const requested = sessionStorage.getItem("canopy:integrations-open-section");
      if (requested === "providers" || requested === "services") {
        sessionStorage.removeItem("canopy:integrations-open-section");
        return requested;
      }
    } catch (e) { /* sessionStorage unavailable — fall through */ }
    return "services";
  });
  const [searchQuery, setSearchQuery] = useState("");

  // Same deep link while this view is already mounted.
  useEffect(() => {
    const onOpenSection = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "providers" || detail === "services") {
        try { sessionStorage.removeItem("canopy:integrations-open-section"); } catch (err) {}
        setSection(detail);
      }
    };
    window.addEventListener("canopy:integrations-open-section", onOpenSection);
    return () => window.removeEventListener("canopy:integrations-open-section", onOpenSection);
  }, []);
  const [slackChannelsMap, setSlackChannelsMap] = useState<Record<string, string[]>>({});

  const [gmailStatus, setGmailStatus] = useState<ServiceStatus>({ connected: false });
  const [calendarStatus, setCalendarStatus] = useState<ServiceStatus>({ connected: false });
  const [iMessageStatus, setIMessageStatus] = useState<ServiceStatus>({ connected: false });

  // UI states
  const [gmailLoading, setGmailLoading] = useState(false);
  const [calLoading, setCalLoading] = useState(false);

  // Disconnect-confirmation modal state. We track which integration the user is about
  // to disconnect, plus a `busy` flag so we can disable the buttons while the Tauri
  // call is in flight (the disconnect involves a `docker restart` and can take a few
  // seconds). The actual `handleConfirmDisconnect` callback is declared further down,
  // after `checkStatuses` is in scope (so it can re-check statuses on completion).
  const [disconnectTarget, setDisconnectTarget] = useState<DisconnectIntegrationKey | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);

  const [connectors, setConnectors] = useState<any[]>([]);
  const [customOAuthProvidersByAgent, setCustomOAuthProvidersByAgent] = useState<Record<string, CustomOAuthProvider[]>>({});

  const loadCustomOAuthProviders = useCallback(async () => {
    const entries = await Promise.all(
      agents.map(async agent => {
        try {
          const bridges = await invoke<BridgeRecord[]>("list_bridges", { agentId: agent.id });
          const customBridge = bridges.find(bridge => {
            const bridgeType =
              typeof bridge.bridge_type === "string"
                ? bridge.bridge_type
                : typeof bridge.bridgeType === "string"
                  ? bridge.bridgeType
                  : "";
            return bridgeType.toLowerCase().includes("custom");
          });
          return [agent.id, getCustomOAuthProvidersFromScope(customBridge?.config?.scope)] as const;
        } catch (error) {
          console.error(`Failed to load custom OAuth bridges for ${agent.id}`, error);
          return [agent.id, []] as const;
        }
      }),
    );

    setCustomOAuthProvidersByAgent(Object.fromEntries(entries));
  }, [agents]);

  useEffect(() => {
    invoke<any[]>("get_connectors_config")
      .then(data => {
         if (Array.isArray(data)) setConnectors(data);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    // Fetch Slack channels for connected agents
    const fetchSlackChannels = async () => {
      const slackAgents = agents.filter(a => a.integrations?.includes("slack"));
      const newMap: Record<string, string[]> = {};
      for (const a of slackAgents) {
        try {
          const channelIds = await invoke<string[]>("get_allowed_slack_channels", { agentId: a.id });
          
          // Also try to get names if possible, but fallback to IDs
          const chs = await invoke<any[]>("list_slack_channels", { agentId: a.id }).catch(() => []);
          const idToName = Object.fromEntries(chs.map((c: any) => [c.id, c.name]));
          
          newMap[a.id] = channelIds.map(id => idToName[id] ? `#${idToName[id]}` : id);
        } catch (e) {
          console.error(`Failed to get slack channels for ${a.id}`, e);
        }
      }
      setSlackChannelsMap(newMap);
    };
    fetchSlackChannels();
  }, [agents]);

  const checkStatuses = useCallback(async () => {
    // Gmail & Calendar are now per-agent, so no global status check needed here

    // iMessage
    try {
      const granted = await invoke<boolean>("check_full_disk_access");
      setIMessageStatus({ connected: granted });
    } catch { setIMessageStatus({ connected: false }); }

  }, []);

  // Disconnect handler — declared here (after `checkStatuses`) so we can re-check
  // statuses immediately after the disconnect completes and the UI reflects the
  // new disconnected state without requiring the user to refresh.
  const handleConfirmDisconnect = useCallback(async () => {
    if (!disconnectTarget) return;
    const cfg = DISCONNECT_CONFIG[disconnectTarget];
    setDisconnectBusy(true);
    try {
      await invoke(cfg.command);
    } catch (e) {
      console.error(`${cfg.displayName} disconnect failed:`, e);
    } finally {
      setDisconnectBusy(false);
      setDisconnectTarget(null);
      checkStatuses();
    }
  }, [disconnectTarget, checkStatuses]);

  useEffect(() => { 
    checkStatuses(); 
    void loadCustomOAuthProviders();
    const handleUpdate = () => {
      checkStatuses();
      void loadCustomOAuthProviders();
    };
    window.addEventListener("slack-updated", handleUpdate);
    window.addEventListener("refresh_integrations", handleUpdate);
    return () => {
      window.removeEventListener("slack-updated", handleUpdate);
      window.removeEventListener("refresh_integrations", handleUpdate);
    };
  }, [checkStatuses, loadCustomOAuthProviders]);

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
      } else if (integration === "slack") {
        if (slackChannelsMap[a.id] && slackChannelsMap[a.id].length > 0) {
          mode = slackChannelsMap[a.id].join(", ");
        } else {
          mode = "All Channels";
        }
      } else if (integration === "github") {
        const repos = a.integrations.filter(i => i.startsWith("github_repo_")).map(i => i.replace("github_repo_", ""));
        if (repos.length > 0) {
          mode = repos.join(", ");
        } else {
          mode = "All Repositories";
        }
      } else if (integration === "custom_oauth") {
        const providers = customOAuthProvidersByAgent[a.id] || [];
        if (providers.length > 0) {
          mode = providers.map(provider => provider.providerName).join(", ");
        }
      }
      return { id: a.id, name: a.name, mode };
    });

  const customOAuthAgents = agents
    .filter(agent => (customOAuthProvidersByAgent[agent.id] || []).length > 0)
    .map(agent => ({
      id: agent.id,
      name: agent.name,
      mode: (customOAuthProvidersByAgent[agent.id] || [])
        .map(provider => provider.providerName)
        .join(", "),
    }));
  const totalCustomOAuthProviders = Object.values(customOAuthProvidersByAgent).reduce(
    (count, providers) => count + providers.length,
    0,
  );

  // ── Global connect for Gmail and Calendar has been removed in favor of strict per-agent isolation ──

  // ── iMessage — just prompts for Full Disk Access
  const connectIMessage = async () => {
    try {
      await invoke("start_imessage_watcher", { appHandle: null }).catch(() => {});
      const granted = await invoke<boolean>("check_full_disk_access");
      setIMessageStatus({ connected: granted });
      if (!granted) {
        await invoke("open_full_disk_access_settings");
      }
    } catch (e) {
      console.error("iMessage setup error:", e);
    }
  };
  // ── Global disconnect for Gmail and Calendar has been removed ──

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Page header */}
      <div style={{ padding: "32px 40px 0", flexShrink: 0 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: 0, fontFamily: "'Noto Serif', Georgia, serif" }}>
          Integrations
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-sub)", marginTop: 8, marginBottom: 24, lineHeight: 1.5 }}>
          AI providers live here; most runtime connections are configured per-agent from each agent's Skills & Access page.
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
              subtitle="Legacy provider vault. Keys here are not assigned automatically; connect or provision a dedicated key from each agent's Skills & Access tab."
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
              description="Read emails and send replies. Configured per-agent."
              status={{ connected: getConnectedAgentsWithMode("email").length > 0 }}
              connectedAgents={getConnectedAgentsWithMode("email")}
            />

            {/* Calendar */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4285F4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}
              name="Google Calendar"
              description="View and schedule events. Configured per-agent."
              status={{ connected: getConnectedAgentsWithMode("calendar").length > 0 }}
              connectedAgents={getConnectedAgentsWithMode("calendar")}
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
              description="Connect a Telegram bot from the specific agent that should own it."
              status={{ connected: getConnectedAgentsWithMode("telegram").length > 0 }}
              connectedAgents={getConnectedAgentsWithMode("telegram")}
            />

            {/* Discord */}
            <ServiceCard
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.3 4.4A19.4 19.4 0 0015.1 3a.1.1 0 00-.1.1c-.2.4-.4.9-.6 1.3a17.9 17.9 0 00-5.3 0 13 13 0 00-.6-1.3.1.1 0 00-.1-.1A19.3 19.3 0 003.7 4.4a.1.1 0 000 .1C1 8.7.3 12.9.7 17.1a.1.1 0 00.1.1 19.5 19.5 0 005.7 2.9.1.1 0 00.1-.1c.4-.6.8-1.2 1.2-1.9a.1.1 0 000-.1 12.8 12.8 0 01-2-.9.1.1 0 010-.2l.4-.3a.1.1 0 01.1 0c4.2 1.9 8.7 1.9 12.8 0a.1.1 0 01.1 0l.4.3a.1.1 0 010 .2 12.8 12.8 0 01-2 .9.1.1 0 000 .1c.4.7.8 1.3 1.2 1.9a.1.1 0 00.1.1 19.4 19.4 0 005.7-2.9.1.1 0 00.1-.1c.4-4.8-.7-9-3-12.7a.1.1 0 00-.1 0zM8.5 14.5c-1.1 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3zm7 0c-1.1 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.1 1 2.1 2.3-.9 2.3-2.1 2.3z"/></svg>}
              name="Discord"
              description="Connect a Discord bot from the specific agent that should own it."
              status={{ connected: getConnectedAgentsWithMode("discord").length > 0 }}
              connectedAgents={getConnectedAgentsWithMode("discord")}
            />

            {/* Github */}
            <ServiceCard
              icon={<Github size={20} color="#3c6663" />}
              name="GitHub"
              description="Connect GitHub from the specific agent that should own the token and repo bindings."
              status={{ connected: getConnectedAgentsWithMode("github").length > 0 }}
              connectedAgents={getConnectedAgentsWithMode("github")}
            />

            <ServiceCard
              icon={<Link size={20} color="#3c6663" />}
              name="Custom OAuth"
              description="Register agent-specific OAuth providers for services Canopy does not natively support yet."
              status={{
                connected: customOAuthAgents.length > 0,
                label:
                  totalCustomOAuthProviders > 0
                    ? `${totalCustomOAuthProviders} provider${totalCustomOAuthProviders === 1 ? "" : "s"} configured`
                    : undefined,
              }}
              connectedAgents={customOAuthAgents}
            />

            {connectors
              .filter(c => c.isVisible && PER_AGENT_BRIDGE_CONNECTOR_IDS.includes(c.id))
              .map(c => {
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
                    description={`Connect ${c.name} from the specific agent that should own this bridge token.`}
                    status={{ connected: getConnectedAgentsWithMode(c.id).length > 0 }}
                    connectedAgents={getConnectedAgentsWithMode(c.id)}
                  />
                );
              })}

            {/* Dynamic Global Connectors from Admin */}
            {connectors.filter(c => c.isVisible && c.isGlobal && !c.isPlugin && !['slack', 'gmail', 'calendar', 'imessage', 'filesystem', 'telegram', 'discord', 'github', ...PER_AGENT_BRIDGE_CONNECTOR_IDS].includes(c.id)).map(c => {
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

      {/* Disconnect-confirmation modal — rendered for any integration that supports
          a hosted disconnect command. Per-agent disconnects (Slack, GitHub) are
          handled in each agent's Connections tab, not here. */}
      <ConfirmDisconnectModal
        open={disconnectTarget !== null}
        integrationName={disconnectTarget ? DISCONNECT_CONFIG[disconnectTarget].displayName : ""}
        tokens={disconnectTarget ? DISCONNECT_CONFIG[disconnectTarget].tokens : []}
        boundAgents={
          disconnectTarget
            ? getConnectedAgentsWithMode(
                disconnectTarget === "slack-global" ? "slack" : disconnectTarget
              ).map(a => a.name)
            : []
        }
        extraNote={disconnectTarget ? DISCONNECT_CONFIG[disconnectTarget].extraNote : undefined}
        busy={disconnectBusy}
        onCancel={() => { if (!disconnectBusy) setDisconnectTarget(null); }}
        onConfirm={handleConfirmDisconnect}
      />
    </div>
  );
}
