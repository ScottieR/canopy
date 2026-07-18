import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentRequestNotifier } from "./AgentRequestNotifier";

const mockInvoke = vi.fn();
const eventHandlers = new Map<string, (event: any) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: any) => void) => {
    eventHandlers.set(eventName, handler);
    return () => eventHandlers.delete(eventName);
  }),
}));

describe("AgentRequestNotifier", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    eventHandlers.clear();
  });

  it("renders payment approval modal and approves a purchase", async () => {
    render(<AgentRequestNotifier agents={[{ id: "agent-1", name: "Poppy" }]} />);

    const handler = eventHandlers.get("payment_approval_requested");
    expect(handler).toBeTypeOf("function");

    handler?.({
      payload: {
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
      },
    });

    expect(await screen.findByText("Poppy needs payment approval")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve purchase" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("approve_purchase", {
        approvalId: "approval-1",
      });
    });
  });

  it("denies a purchase request from the payment approval modal", async () => {
    render(<AgentRequestNotifier agents={[{ id: "agent-2", name: "Sloane" }]} />);

    const handler = eventHandlers.get("payment_approval_requested");
    handler?.({
      payload: {
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
          reason: "Recurring or subscription-like purchase requires review",
          flags: ["recurring"],
          status: "pending",
        },
      },
    });

    expect(await screen.findByText("Sloane needs payment approval")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny purchase" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("deny_purchase", {
        approvalId: "approval-2",
      });
    });
  });
});
