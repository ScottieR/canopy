import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Eye: () => null,
  AlertTriangle: () => null,
  X: () => null,
  KeyRound: () => null,
}));

describe("PaymentApprovalModal", () => {
  beforeEach(() => {
  });

  it("renders purchase details and triggers approve", async () => {
    const { PaymentApprovalModal } = await import("./AgentRequestNotifier");
    const onDecide = vi.fn();

    render(
      <PaymentApprovalModal
        prompt={{
          agent_name: "Poppy",
          approval: {
            id: "approval-1",
            agent_id: "agent-1",
            purchase_record_id: "purchase-1",
            purchase_request: {
              description: "Buy test software",
              merchant: "Amazon",
              amount_cents: 4900,
              category: "software",
            },
            reason: "Amount exceeds threshold",
            flags: ["exceeds_auto_approve_threshold"],
            status: "pending",
          },
        }}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("Poppy needs payment approval")).toBeInTheDocument();
    expect(screen.getByText("Buy test software")).toBeInTheDocument();
    expect(screen.getByText("Amazon")).toBeInTheDocument();
    expect(screen.getByText("$49.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve purchase" }));
    expect(onDecide).toHaveBeenCalledWith("approve");
  });

  it("triggers deny from the modal", async () => {
    const { PaymentApprovalModal } = await import("./AgentRequestNotifier");
    const onDecide = vi.fn();

    render(
      <PaymentApprovalModal
        prompt={{
          agent_name: "Sloane",
          approval: {
            id: "approval-2",
            agent_id: "agent-2",
            purchase_record_id: "purchase-2",
            purchase_request: {
              description: "Recurring plan",
              merchant: "GitHub",
              amount_cents: 9900,
              category: "software",
            },
            reason: "Recurring purchase requires review",
            flags: ["recurring"],
            status: "pending",
          },
        }}
        onDecide={onDecide}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deny purchase" }));
    expect(onDecide).toHaveBeenCalledWith("deny");
  });

});

describe("ProviderAuthFailureModal", () => {
  it("names the agent and provider, shows the gateway error, and deep-links to keys", async () => {
    const { ProviderAuthFailureModal } = await import("./AgentRequestNotifier");
    const onDecide = vi.fn();

    render(
      <ProviderAuthFailureModal
        prompt={{
          agent_id: "agent-atlas",
          provider: "anthropic",
          detail: "FailoverError: Couldn't sign in to anthropic. Your saved login looks expired.",
        }}
        agentName="Atlas"
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("Anthropic sign-in failed")).toBeInTheDocument();
    expect(screen.getByText(/Atlas couldn't/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't sign in to anthropic/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open provider keys" }));
    expect(onDecide).toHaveBeenCalledWith("open_keys");
  });

  it("falls back to a fleet-wide message when no agent is known and dismisses", async () => {
    const { ProviderAuthFailureModal } = await import("./AgentRequestNotifier");
    const onDecide = vi.fn();

    render(
      <ProviderAuthFailureModal
        prompt={{
          agent_id: null,
          provider: "gemini",
          detail: "No API key found for provider \"google\".",
        }}
        agentName={null}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("Google Gemini sign-in failed")).toBeInTheDocument();
    expect(screen.getByText(/Your agents couldn't/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDecide).toHaveBeenCalledWith("dismiss");
  });
});
