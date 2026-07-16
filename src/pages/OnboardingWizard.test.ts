import { describe, expect, it } from "vitest";
import { getInitialOnboardingStep } from "../utils/onboardingFlow";
import { getAgentProviderSecretSlot, getManagedProviderId, syncAgentProviderCredentials } from "../security/providerCredentials";

describe("getInitialOnboardingStep", () => {
  it("shows the engine gate for a true first-run setup", () => {
    expect(getInitialOnboardingStep(undefined, false)).toBe(-1);
  });

  it("skips the engine gate for the Add Agent flow", () => {
    expect(getInitialOnboardingStep(undefined, true)).toBe(1);
  });

  it("ignores a legacy engine-step draft for an existing installation", () => {
    expect(getInitialOnboardingStep(-1, true)).toBe(1);
  });

  it("resumes an in-progress agent draft", () => {
    expect(getInitialOnboardingStep(3, true)).toBe(3);
  });
});

describe("onboarding provider credential isolation", () => {
  it("maps every manual provider key to an agent-scoped Keychain slot", () => {
    const agentId = "agent-test";
    expect(getAgentProviderSecretSlot(agentId, "OpenAI")).toBe("agent_agent-test_openai_key");
    expect(getAgentProviderSecretSlot(agentId, "Anthropic")).toBe("agent_agent-test_anthropic_key");
    expect(getAgentProviderSecretSlot(agentId, "Google Gemini")).toBe("agent_agent-test_gemini_key");
    expect(getAgentProviderSecretSlot(agentId, "xAI Grok")).toBe("agent_agent-test_grok_key");

    for (const provider of ["OpenAI", "Anthropic", "Google Gemini", "xAI Grok"] as const) {
      expect(getAgentProviderSecretSlot(agentId, provider)).toMatch(/^agent_agent-test_/);
      expect(getAgentProviderSecretSlot(agentId, provider)).not.toMatch(/^(OPENAI|ANTHROPIC|GEMINI|XAI)_API_KEY$/);
    }
  });

  it("enables automatic provisioning only for supported management APIs", () => {
    expect(getManagedProviderId("OpenAI")).toBe("openai");
    expect(getManagedProviderId("xAI Grok")).toBe("xai");
    expect(getManagedProviderId("Anthropic")).toBeNull();
    expect(getManagedProviderId("Google Gemini")).toBeNull();
    expect(getManagedProviderId("")).toBeNull();
  });

  it("syncs provider credentials without reading raw keys into the onboarding UI", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    await syncAgentProviderCredentials(invoke, "agent-test");

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("sync_agent_api_keys", { agentId: "agent-test" });
    expect(invoke).not.toHaveBeenCalledWith("get_secret_cmd", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("sync_credentials", expect.anything());
  });
});
