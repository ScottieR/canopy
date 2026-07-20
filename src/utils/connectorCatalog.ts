import connectorCatalog from "../../shared/connectors.json";

export type ConnectorCatalogEntry = {
  id: string;
  name: string;
  subtitle: string;
  icon: string;
  isGlobal: boolean;
  isVisible: boolean;
  isSuggested: boolean;
  needsCompanion: boolean;
  isPlugin?: boolean;
  type?: string;
  emoji?: string;
};

export const CONNECTOR_CATALOG = connectorCatalog as ConnectorCatalogEntry[];

const AGENT_SCOPED_SECRET_KEY_FACTORIES: Record<string, (agentId: string) => string> = {
  calendar: (agentId) => `agent_${agentId}_google_calendar_access_token`,
  drive: (agentId) => `agent_${agentId}_google_drive_access_token`,
  telegram: (agentId) => `agent_${agentId}_telegram_bot_token`,
  discord: (agentId) => `agent_${agentId}_discord_bot_token`,
  twilio: (agentId) => `agent_${agentId}_twilio_account_sid`,
  apple_health: (agentId) => `agent_${agentId}_APPLE_HEALTH_TOKEN`,
  live_location: (agentId) => `agent_${agentId}_LIVE_LOCATION_TOKEN`,
  shortcuts: (agentId) => `agent_${agentId}_SHORTCUTS_TOKEN`,
  vision: (agentId) => `agent_${agentId}_VISION_TOKEN`,
  notifications: (agentId) => `agent_${agentId}_NOTIFICATIONS_TOKEN`,
  homekit: (agentId) => `agent_${agentId}_HOMEKIT_TOKEN`,
  bluetooth: (agentId) => `agent_${agentId}_BLUETOOTH_TOKEN`,
  figma: (agentId) => `agent_${agentId}_figma_token`,
};

export function getConnectorSecretKey(connectorId: string, agentId?: string): string {
  const getAgentScopedKey = AGENT_SCOPED_SECRET_KEY_FACTORIES[connectorId];
  if (getAgentScopedKey && agentId) return getAgentScopedKey(agentId);
  return `${connectorId.toUpperCase()}_TOKEN`;
}

export function buildCompanionUrl(
  companionType: string,
  options?: {
    agentId?: string;
    agentName?: string;
    isNew?: boolean;
    extraParams?: Record<string, string | boolean | undefined>;
  }
): string {
  const params = new URLSearchParams({ companion: companionType });
  if (options?.agentId) params.set("agentId", options.agentId);
  if (options?.agentName) params.set("agentName", options.agentName);
  if (options?.isNew) params.set("isNew", "true");
  if (options?.extraParams) {
    Object.entries(options.extraParams).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
  }
  return `/index.html?${params.toString()}`;
}
