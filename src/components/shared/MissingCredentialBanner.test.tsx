import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  AlertTriangle: () => null,
  X: () => null,
  Eye: () => null,
  EyeOff: () => null,
}));

const mockInvoke = vi.fn().mockResolvedValue(null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

type Listener = (event: { payload: any }) => void;
const listeners: Record<string, Listener[]> = {};
const mockListen = vi.fn((event: string, cb: Listener) => {
  listeners[event] = listeners[event] || [];
  listeners[event].push(cb);
  return Promise.resolve(() => {
    listeners[event] = (listeners[event] || []).filter((l) => l !== cb);
  });
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: any[]) => (mockListen as any)(...args),
}));

function emit(event: string, payload: any) {
  act(() => {
    (listeners[event] || []).forEach((cb) => cb({ payload }));
  });
}

describe("MissingCredentialBanner", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(null);
    Object.keys(listeners).forEach((k) => delete listeners[k]);
  });

  it("renders nothing until an auth failure event arrives for this agent", async () => {
    const { MissingCredentialBanner } = await import("./MissingCredentialBanner");
    const { container } = render(<MissingCredentialBanner agentId="agent-1" />);
    await waitFor(() => expect(mockListen).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores auth failures for other agents", async () => {
    const { MissingCredentialBanner } = await import("./MissingCredentialBanner");
    const { container } = render(<MissingCredentialBanner agentId="agent-1" />);
    await waitFor(() => expect(mockListen).toHaveBeenCalled());

    emit("agent_provider_auth_failed", { agent_id: "agent-2", provider: "anthropic", detail: "boom" });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a banner with a Re-enter credentials button for this agent's failure", async () => {
    const { MissingCredentialBanner } = await import("./MissingCredentialBanner");
    render(<MissingCredentialBanner agentId="agent-1" />);
    await waitFor(() => expect(mockListen).toHaveBeenCalled());

    emit("agent_provider_auth_failed", { agent_id: "agent-1", provider: "anthropic", detail: "no api key found" });

    expect(await screen.findByText(/Anthropic/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-enter credentials/i })).toBeInTheDocument();
  });

  it("clears the banner when credential_recovery_resolved fires for this agent", async () => {
    const { MissingCredentialBanner } = await import("./MissingCredentialBanner");
    const { container } = render(<MissingCredentialBanner agentId="agent-1" />);
    await waitFor(() => expect(mockListen).toHaveBeenCalled());

    emit("agent_provider_auth_failed", { agent_id: "agent-1", provider: "gemini", detail: "expired" });
    expect(await screen.findByText(/Google Gemini/)).toBeInTheDocument();

    emit("credential_recovery_resolved", { agentId: "agent-1", provider: "gemini" });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("re-entering a key stores it at the agent's provider slot and syncs, then clears the banner", async () => {
    const { MissingCredentialBanner } = await import("./MissingCredentialBanner");
    const { container } = render(<MissingCredentialBanner agentId="agent-1" />);
    await waitFor(() => expect(mockListen).toHaveBeenCalled());

    emit("agent_provider_auth_failed", { agent_id: "agent-1", provider: "grok", detail: "no api key found for provider grok" });
    fireEvent.click(await screen.findByRole("button", { name: /Re-enter credentials/i }));

    const input = await screen.findByPlaceholderText(/Enter your xAI Grok API key/i);
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("store_secret_cmd", {
        key: "agent_agent-1_grok_key",
        value: "sk-test-key",
      })
    );
    expect(mockInvoke).toHaveBeenCalledWith("sync_agent_api_keys", { agentId: "agent-1" });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
