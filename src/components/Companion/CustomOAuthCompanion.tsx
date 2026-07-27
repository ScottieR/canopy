import { useEffect, useMemo, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Link2, ShieldCheck } from "lucide-react";
import { PasswordInput } from "../shared/PasswordInput";
import { useWorldStore } from "../../store/worldStore";
import {
  getCustomOAuthProvidersFromScope,
  parseCustomOAuthScopes,
  slugifyCustomOAuthProvider,
  upsertCustomOAuthProviderInScope,
  type CustomOAuthAccessMode,
  type CustomOAuthProvider,
} from "../../utils/customOAuth";

type BridgeRecord = {
  id: string;
  bridge_type?: string;
  bridgeType?: string;
  config?: {
    scope?: unknown;
    expires_at?: string | null;
    push_enabled?: boolean;
  };
  permissions?: {
    read: boolean;
    write: boolean;
    delete: boolean;
  };
};

const DEFAULT_PERMISSIONS = {
  read: true,
  write: false,
  delete: false,
};

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isCustomBridge(bridge: BridgeRecord): boolean {
  const rawType =
    typeof bridge.bridge_type === "string"
      ? bridge.bridge_type
      : typeof bridge.bridgeType === "string"
        ? bridge.bridgeType
        : "";
  return rawType.toLowerCase().includes("custom");
}

export function CustomOAuthCompanion() {
  const searchParams = new URLSearchParams(window.location.search);
  const agentId = searchParams.get("agentId") || "";
  const agentName = searchParams.get("agentName") || "your agent";
  const requestedVia = searchParams.get("requestedVia") || searchParams.get("source") || "companion";

  const [providerName, setProviderName] = useState(searchParams.get("providerName") || "");
  const [authUrl, setAuthUrl] = useState(searchParams.get("authUrl") || "");
  const [tokenUrl, setTokenUrl] = useState(searchParams.get("tokenUrl") || "");
  const [clientId, setClientId] = useState(searchParams.get("clientId") || "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopesInput, setScopesInput] = useState(searchParams.get("scopes") || "");
  const [notes, setNotes] = useState(searchParams.get("notes") || "");
  const [accessMode, setAccessMode] = useState<CustomOAuthAccessMode>(
    searchParams.get("accessMode") === "write" ? "write" : "read",
  );
  const [isVisible, setIsVisible] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "success" | "error">("loading");
  const [error, setError] = useState("");
  const [existingProviders, setExistingProviders] = useState<CustomOAuthProvider[]>([]);

  const parsedScopes = useMemo(() => parseCustomOAuthScopes(scopesInput), [scopesInput]);

  useEffect(() => {
    setTimeout(() => setIsVisible(true), 250);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadExistingProviders() {
      if (!agentId) {
        setStatus("idle");
        setError("This setup window needs an agentId so the connection stays isolated to one agent.");
        return;
      }

      try {
        const bridges = await invoke<BridgeRecord[]>("list_bridges", { agentId });
        if (cancelled) return;
        const customBridge = bridges.find(isCustomBridge);
        setExistingProviders(getCustomOAuthProvidersFromScope(customBridge?.config?.scope));
        setStatus("idle");
      } catch (loadError) {
        console.error(loadError);
        if (cancelled) return;
        setExistingProviders([]);
        setStatus("idle");
      }
    }

    void loadExistingProviders();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const loadProviderIntoForm = (provider: CustomOAuthProvider) => {
    setProviderName(provider.providerName);
    setAuthUrl(provider.authUrl);
    setTokenUrl(provider.tokenUrl);
    setClientId(provider.clientId);
    setClientSecret("");
    setScopesInput(provider.scopes.join(", "));
    setNotes(provider.notes || "");
    setAccessMode(provider.accessMode);
    setError("");
  };

  const closeWindow = async () => {
    try {
      const { getAllWindows, getCurrentWindow } = await import("@tauri-apps/api/window");
      const mainWindow = (await getAllWindows()).find(windowHandle => windowHandle.label === "main");
      if (mainWindow) await mainWindow.setFocus();
      await getCurrentWindow().close();
    } catch (closeError) {
      console.error("Failed to close custom OAuth companion", closeError);
    }
  };

  const refreshIntegrations = async () => {
    try {
      await emit("refresh_integrations");
    } catch (eventError) {
      console.warn("refresh_integrations emit failed", eventError);
    }
    try {
      window.dispatchEvent(new Event("refresh_integrations"));
    } catch {
      // no-op
    }
  };

  const handleSave = async () => {
    if (!agentId) {
      setError("This companion must be opened from a specific agent so the bridge stays isolated.");
      setStatus("error");
      return;
    }
    if (!providerName.trim()) {
      setError("Provider name is required.");
      setStatus("error");
      return;
    }
    if (!clientId.trim()) {
      setError("Client ID is required.");
      setStatus("error");
      return;
    }
    if (!isAbsoluteHttpUrl(authUrl.trim()) || !isAbsoluteHttpUrl(tokenUrl.trim())) {
      setError("Authorization URL and Token URL must be valid absolute http(s) URLs.");
      setStatus("error");
      return;
    }
    if (parsedScopes.length === 0) {
      setError("Add at least one OAuth scope so the agent request is explicit.");
      setStatus("error");
      return;
    }

    setStatus("saving");
    setError("");

    try {
      const bridges = await invoke<BridgeRecord[]>("list_bridges", { agentId });
      const existingBridge = bridges.find(isCustomBridge);
      const currentProviders = getCustomOAuthProvidersFromScope(existingBridge?.config?.scope);
      const providerId = slugifyCustomOAuthProvider(providerName);
      const existingProvider = currentProviders.find(provider => provider.id === providerId);

      const clientSecretKey =
        clientSecret.trim().length > 0
          ? `agent_${agentId}_custom_oauth_${providerId}_client_secret`
          : existingProvider?.clientSecretKey;

      if (clientSecret.trim().length > 0 && clientSecretKey) {
        await invoke("store_secret_cmd", {
          key: clientSecretKey,
          value: clientSecret.trim(),
        });
      }

      const timestamp = new Date().toISOString();
      const nextProvider: CustomOAuthProvider = {
        id: providerId,
        providerName: providerName.trim(),
        authUrl: authUrl.trim(),
        tokenUrl: tokenUrl.trim(),
        clientId: clientId.trim(),
        clientSecretKey,
        scopes: parsedScopes,
        accessMode,
        status: "configured",
        createdAt: existingProvider?.createdAt || timestamp,
        updatedAt: timestamp,
        requestedVia,
        notes: notes.trim() || undefined,
      };

      const nextScope = upsertCustomOAuthProviderInScope(existingBridge?.config?.scope, nextProvider);
      const nextProviders = getCustomOAuthProvidersFromScope(nextScope);
      const nextPermissions = {
        ...(existingBridge?.permissions || DEFAULT_PERMISSIONS),
        read: true,
        write: nextProviders.some(provider => provider.accessMode === "write"),
        delete: false,
      };
      const nextConfig = {
        scope: nextScope,
        expires_at: existingBridge?.config?.expires_at ?? null,
        push_enabled: existingBridge?.config?.push_enabled ?? false,
      };

      if (existingBridge) {
        await invoke("update_bridge_config", {
          bridgeId: existingBridge.id,
          config: nextConfig,
          permissions: nextPermissions,
        });
      } else {
        await invoke("enable_bridge", {
          agentId,
          bridgeType: "custom",
          config: nextConfig,
        });
      }

      const store = useWorldStore.getState();
      const currentAgent = store.agents.find(agent => agent.id === agentId);
      if (currentAgent && !currentAgent.integrations.includes("custom_oauth")) {
        const nextIntegrations = [...currentAgent.integrations, "custom_oauth"];
        await invoke("update_agent_integrations", {
          agentId,
          integrations: nextIntegrations,
        });
        store.setAgents(
          store.agents.map(agent =>
            agent.id === agentId ? { ...agent, integrations: nextIntegrations } : agent,
          ),
        );
      }

      setExistingProviders(nextProviders);
      setStatus("success");
      await emit("companion-finished", {
        type: "custom_oauth",
        providerId,
        providerName: nextProvider.providerName,
      });
      await refreshIntegrations();
      setTimeout(() => {
        void closeWindow();
      }, 1800);
    } catch (saveError: any) {
      console.error(saveError);
      setStatus("error");
      setError(saveError?.toString() || "Failed to save custom OAuth provider.");
    }
  };

  return (
    <div
      data-tauri-drag-region
      style={{
        width: "100%",
        height: "100vh",
        background: "linear-gradient(to bottom, #faf9f6, #f1eee7)",
        fontFamily: "'Manrope', system-ui, -apple-system, sans-serif",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      <div style={{ position: "sticky", top: 0, zIndex: 9999, display: "flex", width: "100%", height: 32 }}>
        <div
          data-tauri-drag-region
          style={{ flex: 1, cursor: "grab", WebkitAppRegion: "drag", height: "100%" } as any}
          onPointerDown={async () => {
            try {
              const { getCurrentWindow } = await import("@tauri-apps/api/window");
              await getCurrentWindow().startDragging();
            } catch {
              // no-op
            }
          }}
        />
        <div
          style={{
            padding: "0 16px",
            cursor: "pointer",
            opacity: 0.8,
            fontSize: 18,
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
          }}
          onClick={() => {
            void closeWindow();
          }}
        >
          ✕
        </div>
      </div>

      <div style={{ padding: "0 24px 32px 24px", flex: 1, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginBottom: 28,
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? "translateY(0)" : "translateY(10px)",
            transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              background: "white",
              boxShadow: "0 8px 24px rgba(48,51,48,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16,
            }}
          >
            <Link2 size={36} color="#3c6663" />
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 20,
              color: "#303330",
              fontWeight: 700,
              fontFamily: "'Noto Serif', Georgia, serif",
            }}
          >
            Custom OAuth Bridge
          </h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#636E72", textAlign: "center", padding: "0 16px", lineHeight: 1.5 }}>
            Register an agent-specific OAuth provider for services Canopy does not natively ship yet. The provider definition is stored in this agent&apos;s custom bridge, not shared globally.
          </p>
        </div>

        <div
          style={{
            marginBottom: 20,
            padding: 16,
            background: "white",
            borderRadius: 16,
            boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
            border: "1px solid rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <ShieldCheck size={16} color="#3c6663" />
            <div style={{ fontSize: 13, fontWeight: 700, color: "#3c6663" }}>Isolation boundary</div>
          </div>
          <div style={{ fontSize: 13, color: "#4A5568", lineHeight: 1.55 }}>
            This setup is scoped to <strong>{agentName}</strong>. Saving here records the provider definition and requested scopes in the agent&apos;s custom bridge so future runtime/auth work can stay zero-trust and explicit.
          </div>
        </div>

        {existingProviders.length > 0 && (
          <div
            style={{
              marginBottom: 20,
              padding: 16,
              background: "white",
              borderRadius: 16,
              boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
              border: "1px solid rgba(0,0,0,0.05)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: "#3c6663", marginBottom: 10 }}>Configured for {agentName}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {existingProviders.map(provider => (
                <button
                  key={provider.id}
                  onClick={() => loadProviderIntoForm(provider)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid rgba(60,102,99,0.16)",
                    background: "rgba(60,102,99,0.06)",
                    color: "#3c6663",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {provider.providerName}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#636E72" }}>
              Click an existing provider to load it back into the form and update its config.
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: 16,
            background: "white",
            borderRadius: 16,
            boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
            border: "1px solid rgba(0,0,0,0.05)",
          }}
        >
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Provider Name</label>
            <input
              type="text"
              value={providerName}
              onChange={event => setProviderName(event.target.value)}
              placeholder="e.g. Airbnb Partner API"
              style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Authorization URL</label>
            <input
              type="url"
              value={authUrl}
              onChange={event => setAuthUrl(event.target.value)}
              placeholder="https://provider.example.com/oauth/authorize"
              style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Token URL</label>
            <input
              type="url"
              value={tokenUrl}
              onChange={event => setTokenUrl(event.target.value)}
              placeholder="https://provider.example.com/oauth/token"
              style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Client ID</label>
              <input
                type="text"
                value={clientId}
                onChange={event => setClientId(event.target.value)}
                placeholder="public-client-id"
                style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Client Secret (optional)</label>
              <PasswordInput
                value={clientSecret}
                onChange={event => setClientSecret(event.target.value)}
                placeholder="Leave blank for PKCE/public clients"
                style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9" }}
              />
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Scopes</label>
            <input
              type="text"
              value={scopesInput}
              onChange={event => setScopesInput(event.target.value)}
              placeholder="reservations.read, reservations.write"
              style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9" }}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: "#636E72" }}>
              Comma-separated. Saving deduplicates and trims the list so the agent request stays explicit.
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 8 }}>Requested access mode</div>
            <div style={{ display: "flex", gap: 10 }}>
              {([
                { id: "read", title: "Read-only", body: "Safer default for data fetches and status lookups." },
                { id: "write", title: "Read + write", body: "Use when the agent may create, update, or confirm actions." },
              ] as const).map(option => (
                <button
                  key={option.id}
                  onClick={() => setAccessMode(option.id)}
                  style={{
                    flex: 1,
                    padding: 12,
                    textAlign: "left",
                    borderRadius: 12,
                    border: accessMode === option.id ? "2px solid #3c6663" : "1px solid rgba(0,0,0,0.08)",
                    background: accessMode === option.id ? "rgba(60,102,99,0.06)" : "#f9f9f9",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: accessMode === option.id ? "#3c6663" : "#303330" }}>{option.title}</div>
                  <div style={{ marginTop: 4, fontSize: 12, color: "#636E72", lineHeight: 1.45 }}>{option.body}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#3c6663", marginBottom: 6 }}>Operator notes (optional)</label>
            <textarea
              value={notes}
              onChange={event => setNotes(event.target.value)}
              placeholder="Anything the companion or future bridge runtime should remember about this provider."
              rows={3}
              style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, boxSizing: "border-box", background: "#f9f9f9", resize: "vertical" }}
            />
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            padding: 16,
            background: "rgba(60,102,99,0.07)",
            borderRadius: 14,
            border: "1px solid rgba(60,102,99,0.1)",
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <KeyRound size={16} color="#3c6663" style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: "#4A5568", lineHeight: 1.55 }}>
            This companion saves a provider definition and any optional client secret securely. It does <strong>not</strong> fake a successful OAuth token exchange. That keeps the UI honest today and gives us a clean, agent-scoped place to plug the real handshake into next.
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 14, color: "#E53E3E", fontSize: 12, fontWeight: 600 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 22 }}>
          <button
            onClick={() => {
              void closeWindow();
            }}
            style={{
              flex: 1,
              padding: "12px 16px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.08)",
              background: "white",
              color: "#303330",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              void handleSave();
            }}
            disabled={status === "saving" || status === "loading"}
            style={{
              flex: 1.3,
              padding: "12px 16px",
              borderRadius: 10,
              border: "none",
              background: status === "success" ? "#2EB67D" : "#3c6663",
              color: "white",
              fontWeight: 700,
              cursor: status === "saving" || status === "loading" ? "default" : "pointer",
              opacity: status === "saving" || status === "loading" ? 0.7 : 1,
            }}
          >
            {status === "saving"
              ? "Saving bridge..."
              : status === "success"
                ? "Saved"
                : "Save custom provider"}
          </button>
        </div>
      </div>
    </div>
  );
}
