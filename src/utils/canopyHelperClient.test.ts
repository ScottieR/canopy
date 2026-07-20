import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { requestCanopyHelper } from "./canopyHelperClient";

describe("requestCanopyHelper", () => {
  beforeEach(() => invokeMock.mockReset());

  it("never contacts a model while Eddy is in offline guidance mode", async () => {
    invokeMock.mockResolvedValueOnce({ mode: "offline", credentialPresent: false });

    await expect(requestCanopyHelper("hello", { raw_logs: "local only" })).rejects.toThrow("offline");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_canopy_helper_config");
  });

  it("sends one message through the local Rust allowlist for provider mode", async () => {
    invokeMock
      .mockResolvedValueOnce({ mode: "provider", provider: "openai", credentialPresent: true })
      .mockResolvedValueOnce({ reply: "All set." });

    await expect(requestCanopyHelper("latest message", { runtime_ready: true }, { topic: "diagnostics" }))
      .resolves.toBe("All set.");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "send_canopy_helper_message", {
      message: "latest message",
      context: { runtime_ready: true },
      continuity: { topic: "diagnostics" },
    });
  });

  it("uses the same Rust privacy boundary for first-run bootstrap mode", async () => {
    invokeMock
      .mockResolvedValueOnce({ mode: "bootstrap", credentialPresent: false })
      .mockResolvedValueOnce({ reply: "Let's build your first agent." });

    await expect(requestCanopyHelper(
      "I need help with research",
      { active_view: "onboarding", onboarding: { in_onboarding: true } },
      { topic: "onboarding" },
    )).resolves.toBe("Let's build your first agent.");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "send_canopy_helper_message", {
      message: "I need help with research",
      context: { active_view: "onboarding", onboarding: { in_onboarding: true } },
      continuity: { topic: "onboarding" },
    });
  });
});
