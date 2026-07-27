import { describe, expect, it } from "vitest";
import {
  getCustomOAuthProvidersFromScope,
  parseConnectionRequestTag,
  parseCustomOAuthScopes,
  slugifyCustomOAuthProvider,
  upsertCustomOAuthProviderInScope,
  type CustomOAuthProvider,
} from "./customOAuth";

function makeProvider(overrides: Partial<CustomOAuthProvider> = {}): CustomOAuthProvider {
  return {
    id: "airbnb",
    providerName: "Airbnb",
    authUrl: "https://airbnb.com/oauth/authorize",
    tokenUrl: "https://airbnb.com/oauth/token",
    clientId: "client-123",
    scopes: ["reservations.read"],
    accessMode: "read",
    status: "configured",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("customOAuth helpers", () => {
  it("slugifies provider names for stable ids", () => {
    expect(slugifyCustomOAuthProvider("Airbnb Partner API")).toBe("airbnb-partner-api");
    expect(slugifyCustomOAuthProvider("   ")).toBe("custom-provider");
  });

  it("deduplicates and trims scopes", () => {
    expect(parseCustomOAuthScopes("read, write,read, , profile")).toEqual([
      "read",
      "write",
      "profile",
    ]);
  });

  it("upserts providers inside the custom bridge scope", () => {
    const initialScope = upsertCustomOAuthProviderInScope({}, makeProvider());
    expect(getCustomOAuthProvidersFromScope(initialScope)).toEqual([makeProvider()]);

    const updatedScope = upsertCustomOAuthProviderInScope(
      initialScope,
      makeProvider({
        scopes: ["reservations.read", "reservations.write"],
        updatedAt: "2026-07-25T13:00:00.000Z",
        accessMode: "write",
      }),
    );

    expect(getCustomOAuthProvidersFromScope(updatedScope)).toEqual([
      makeProvider({
        scopes: ["reservations.read", "reservations.write"],
        updatedAt: "2026-07-25T13:00:00.000Z",
        accessMode: "write",
      }),
    ]);
  });

  it("parses structured connection request tags", () => {
    expect(
      parseConnectionRequestTag(
        "Please connect this. [request_connection: custom_oauth?providerName=Airbnb&scopes=reservations.read,reservations.write]",
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
});
