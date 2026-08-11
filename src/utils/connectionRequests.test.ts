import { describe, expect, it } from "vitest";
import {
  buildApiKeyCompanionRequest,
  buildCompanionDeepLink,
  parseCompanionDeepLink,
  parseConnectionRequestTag,
  sanitizeSecretName,
} from "./connectionRequests";

describe("connection request helpers", () => {
  it("parses request tags into companion metadata", () => {
    expect(
      parseConnectionRequestTag(
        "Please connect this bridge. [request_connection: custom_oauth?providerName=Airbnb&scopes=reservations.read,reservations.write]",
      ),
    ).toEqual({
      fullMatch:
        "[request_connection: custom_oauth?providerName=Airbnb&scopes=reservations.read,reservations.write]",
      companionType: "custom_oauth",
      params: {
        providerName: "Airbnb",
        scopes: "reservations.read,reservations.write",
      },
    });
  });

  it("builds and parses Canopy companion deep links", () => {
    const url = buildCompanionDeepLink("custom_oauth", {
      agentId: "agent-1",
      agentName: "Bridge Bot",
      extraParams: {
        providerName: "Airbnb",
        scopes: "reservations.read,reservations.write",
      },
    });

    expect(url).toBe(
      "canopy://companion?companion=custom_oauth&agentId=agent-1&agentName=Bridge+Bot&providerName=Airbnb&scopes=reservations.read%2Creservations.write",
    );
    expect(parseCompanionDeepLink(url)).toEqual({
      companionType: "custom_oauth",
      params: {
        agentId: "agent-1",
        agentName: "Bridge Bot",
        providerName: "Airbnb",
        scopes: "reservations.read,reservations.write",
      },
    });
  });
});

describe("generic api_key companion requests", () => {
  it("builds a full request from agent-supplied params (Seats.aero shape)", () => {
    const request = buildApiKeyCompanionRequest({
      providerName: "Seats.aero",
      tokenUrl: "https://seats.aero/account",
      instructions:
        "Sign in to your Seats.aero Pro account, open the Developer tab, and copy your API Key.",
    });

    expect(request).toEqual({
      providerName: "Seats.aero",
      secretName: "SEATS_AERO_API_KEY",
      tokenUrl: "https://seats.aero/account",
      instructions:
        "Sign in to your Seats.aero Pro account, open the Developer tab, and copy your API Key.",
      placeholder: "Paste your API key here",
    });
  });

  it("requires a providerName", () => {
    expect(buildApiKeyCompanionRequest({ tokenUrl: "https://example.com" })).toBeNull();
    expect(buildApiKeyCompanionRequest({ providerName: "   " })).toBeNull();
  });

  it("honors an explicit secretKey and preserves existing suffixes", () => {
    expect(
      buildApiKeyCompanionRequest({ providerName: "Acme", secretKey: "acme prod token" })
        ?.secretName,
    ).toBe("ACME_PROD_TOKEN");
    expect(
      buildApiKeyCompanionRequest({ providerName: "Acme", secretKey: "ACME_KEY" })?.secretName,
    ).toBe("ACME_KEY");
  });

  it("drops non-http(s) and malformed token URLs from agent-authored params", () => {
    expect(
      buildApiKeyCompanionRequest({ providerName: "Acme", tokenUrl: "javascript:alert(1)" })
        ?.tokenUrl,
    ).toBeNull();
    expect(
      buildApiKeyCompanionRequest({ providerName: "Acme", tokenUrl: "canopy://companion" })
        ?.tokenUrl,
    ).toBeNull();
    expect(
      buildApiKeyCompanionRequest({ providerName: "Acme", tokenUrl: "not a url" })?.tokenUrl,
    ).toBeNull();
  });

  it("caps instruction length", () => {
    const request = buildApiKeyCompanionRequest({
      providerName: "Acme",
      instructions: "x".repeat(1000),
    });
    expect(request?.instructions).toHaveLength(600);
  });

  it("sanitizes secret names to env-style identifiers", () => {
    expect(sanitizeSecretName("Seats.aero")).toBe("SEATS_AERO");
    expect(sanitizeSecretName("--weird!! name--")).toBe("WEIRD_NAME");
    expect(sanitizeSecretName("   ")).toBe("");
  });
});
