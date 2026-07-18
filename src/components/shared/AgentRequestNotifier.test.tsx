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
