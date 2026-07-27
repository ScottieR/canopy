import { describe, expect, it } from "vitest";
import {
  buildCompanionDeepLink,
  parseCompanionDeepLink,
  parseConnectionRequestTag,
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
