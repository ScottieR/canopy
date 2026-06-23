import { describe, expect, it } from "vitest";
import { getOnboardingIntegrationIds } from "./onboardingIntegrations";

describe("getOnboardingIntegrationIds", () => {
  it("maps supported onboarding plugins to persisted integrations", () => {
    expect(
      getOnboardingIntegrationIds({
        slack: true,
        email: true,
        calendar: true,
        imessage: true,
        github: true,
        telegram: true,
        discord: true,
        twilio: true,
      })
    ).toEqual([
      "slack",
      "email_read",
      "calendar_read",
      "imessage",
      "github",
      "telegram",
      "discord",
      "twilio",
    ]);
  });

  it("persists selected GitHub repositories only when github is enabled", () => {
    expect(
      getOnboardingIntegrationIds(
        { github: true },
        { githubRepos: ["openai/openai-node", "canopy-ai/bridge"] }
      )
    ).toEqual([
      "github",
      "github_repo_openai/openai-node",
      "github_repo_canopy-ai/bridge",
    ]);

    expect(
      getOnboardingIntegrationIds(
        { github: false },
        { githubRepos: ["openai/openai-node"] }
      )
    ).toEqual([]);
  });
});
