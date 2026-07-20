import { describe, expect, it } from "vitest";
import sharedConnectors from "../../shared/connectors.json";
import { CONNECTOR_CATALOG, buildCompanionUrl, getConnectorSecretKey } from "./connectorCatalog";

describe("connectorCatalog", () => {
  it("matches the shared connector source of truth", () => {
    expect(CONNECTOR_CATALOG).toEqual(sharedConnectors);
  });

  it("uses agent-scoped secret keys for per-agent bridge connectors", () => {
    expect(getConnectorSecretKey("calendar", "agent-1")).toBe("agent_agent-1_google_calendar_access_token");
    expect(getConnectorSecretKey("drive", "agent-1")).toBe("agent_agent-1_google_drive_access_token");
    expect(getConnectorSecretKey("telegram", "agent-1")).toBe("agent_agent-1_telegram_bot_token");
    expect(getConnectorSecretKey("discord", "agent-1")).toBe("agent_agent-1_discord_bot_token");
    expect(getConnectorSecretKey("twilio", "agent-1")).toBe("agent_agent-1_twilio_account_sid");
    expect(getConnectorSecretKey("figma", "agent-1")).toBe("agent_agent-1_figma_token");
    expect(getConnectorSecretKey("bluetooth", "agent-1")).toBe("agent_agent-1_BLUETOOTH_TOKEN");
  });

  it("falls back to legacy global token names when a connector is not agent-scoped", () => {
    expect(getConnectorSecretKey("custom_plugin")).toBe("CUSTOM_PLUGIN_TOKEN");
  });

  it("builds per-agent companion URLs with explicit agent scope", () => {
    expect(
      buildCompanionUrl("slack", { agentId: "agent-1", agentName: "Patch", isNew: true })
    ).toBe("/index.html?companion=slack&agentId=agent-1&agentName=Patch&isNew=true");
  });

  it("includes extra companion parameters when provided", () => {
    expect(
      buildCompanionUrl("drive", {
        agentId: "agent-1",
        extraParams: { mode: "write", scope: "granular", readOnly: false },
      })
    ).toBe("/index.html?companion=drive&agentId=agent-1&mode=write&scope=granular&readOnly=false");
  });
});
