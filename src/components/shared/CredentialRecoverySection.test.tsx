import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  KeyRound: () => null,
  RefreshCw: () => null,
}));

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe("CredentialRecoverySection", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("renders nothing when the agent has no recovery history", async () => {
    mockInvoke.mockResolvedValue(null);
    const { CredentialRecoverySection } = await import("./CredentialRecoverySection");

    const { container } = render(<CredentialRecoverySection agentId="agent-1" />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_credential_recovery_status", { agentId: "agent-1" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("does not crash and renders nothing when the backend returns an unexpected shape", async () => {
    mockInvoke.mockResolvedValue([]);
    const { CredentialRecoverySection } = await import("./CredentialRecoverySection");

    const { container } = render(<CredentialRecoverySection agentId="agent-1" />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a pending recovery with a Regenerate link button", async () => {
    mockInvoke.mockResolvedValue({
      agentId: "agent-1",
      provider: "anthropic",
      status: "pending",
      url: "https://canopy.app/connect/tok-123",
      triggeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const { CredentialRecoverySection } = await import("./CredentialRecoverySection");

    render(<CredentialRecoverySection agentId="agent-1" />);

    expect(await screen.findByText("Link sent — waiting")).toBeInTheDocument();
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Regenerate link/i })).toBeInTheDocument();
  });

  it("hides the Regenerate link button once resolved", async () => {
    mockInvoke.mockResolvedValue({
      agentId: "agent-1",
      provider: "gemini",
      status: "completed",
      url: "https://canopy.app/connect/tok-123",
      triggeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const { CredentialRecoverySection } = await import("./CredentialRecoverySection");

    render(<CredentialRecoverySection agentId="agent-1" />);

    expect(await screen.findByText("Resolved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Regenerate link/i })).not.toBeInTheDocument();
  });

  it("regenerating the link re-invokes the backend and updates the displayed status", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_credential_recovery_status") {
        return Promise.resolve({
          agentId: "agent-1",
          provider: "anthropic",
          status: "expired",
          url: "https://canopy.app/connect/tok-old",
          triggeredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        });
      }
      if (cmd === "regenerate_credential_recovery_link") {
        return Promise.resolve({
          agentId: "agent-1",
          provider: "anthropic",
          status: "pending",
          url: "https://canopy.app/connect/tok-new",
          triggeredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
      }
      return Promise.resolve(null);
    });
    const { CredentialRecoverySection } = await import("./CredentialRecoverySection");

    render(<CredentialRecoverySection agentId="agent-1" />);
    expect(await screen.findByText("Link expired")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Regenerate link/i }));

    expect(await screen.findByText("Link sent — waiting")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("regenerate_credential_recovery_link", {
      agentId: "agent-1",
      provider: "anthropic",
    });
  });
});
