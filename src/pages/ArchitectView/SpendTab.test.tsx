import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpendTab } from "./SpendTab";

const mockInvoke = vi.fn();
const mockClipboardWriteText = vi.fn();
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

vi.mock("../../App", () => ({
  glass: () => ({}),
}));

const agent = {
  id: "agent-pay-1",
  name: "Poppy",
} as any;

describe("SpendTab", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockClipboardWriteText.mockReset();
    mockClipboardWriteText.mockResolvedValue(undefined);
    eventHandlers.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockClipboardWriteText,
      },
    });
  });

  it("renders dashboard data and submits a dev purchase request", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 1200,
        monthly_spent_cents: 3400,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [
        {
          id: "approval-1",
          purchase_request: {
            merchant: "Amazon",
            category: "software",
            amount_cents: 9000,
          },
          reason: "Amount exceeds threshold",
          flags: ["exceeds_auto_approve_threshold"],
          expires_at: "2026-07-17T17:00:00Z",
        },
      ],
      recent_purchases: [
        {
          id: "purchase-1",
          merchant: "Amazon",
          category: "software",
          amount_cents: 2400,
          timestamp: "2026-07-17T16:00:00Z",
          decision: { Approved: null },
        },
      ],
      active_virtual_cards: [
        {
          id: "card-1",
          last_four: "4242",
          merchant: "Amazon",
          status: "active",
          amount_cents: 2400,
          provider: "mock",
          provider_card_ref: "mock-agent-pay-1-2400",
          expires_at: "2026-07-17T18:00:00Z",
        },
      ],
      recent_transactions: [],
      recent_audit_entries: [
        {
          id: "audit-1",
          event_type: "purchase_requires_approval",
          detail_json: { merchant: "Amazon", amountCents: 9000 },
          created_at: "2026-07-17T16:05:00Z",
        },
      ],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") return dashboard.active_virtual_cards;
      if (command === "request_purchase") return { message: "queued" };
      return null;
    });

    render(<SpendTab agent={agent} />);

    expect(await screen.findByText("Dev Purchase Simulator")).toBeInTheDocument();
    expect(screen.getAllByText("Amazon · $90.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Active Virtual Cards")).toBeInTheDocument();
    expect(screen.getByText("Amazon · •••• 4242")).toBeInTheDocument();
    expect(screen.getByText("Audit Trail")).toBeInTheDocument();
    expect(screen.getByText("Purchase Requires Approval")).toBeInTheDocument();
    expect(screen.getAllByText(/Expires/).length).toBeGreaterThanOrEqual(2);

    fireEvent.change(screen.getByPlaceholderText("Amount"), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Request Purchase" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("request_purchase", {
        request: expect.objectContaining({
          agent_id: "agent-pay-1",
          amount_cents: 4800,
          merchant: "Amazon",
          category: "software",
        }),
      });
    });
  });

  it("issues a synthetic Privacy provider card for local sandbox testing", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 0,
        monthly_spent_cents: 0,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [],
      recent_transactions: [],
      recent_audit_entries: [],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") return dashboard.active_virtual_cards;
      if (command === "issue_development_provider_card") {
        return "Development Privacy.com test card ending in 2400 issued locally for $24.00.";
      }
      return null;
    });

    render(<SpendTab agent={agent} />);
    expect(await screen.findByText("Create Privacy Test Card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Privacy Test Card" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("issue_development_provider_card", {
        agentId: "agent-pay-1",
        amountCents: 2400,
        category: "software",
        merchant: "Amazon",
        provider: "privacy",
      });
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_payment_dashboard").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("refreshes when a payment_state_changed event arrives for the same agent", async () => {
    mockInvoke.mockResolvedValue({
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 0,
        monthly_spent_cents: 0,
        monthly_limit_cents: 10000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [],
      recent_transactions: [],
      recent_audit_entries: [],
    });

    render(<SpendTab agent={agent} />);
    await screen.findByText("Dev Purchase Simulator");

    const handler = eventHandlers.get("payment_state_changed");
    expect(handler).toBeTypeOf("function");

    handler?.({ payload: { agent_id: "agent-pay-1" } });

    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_payment_dashboard").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("cancels a virtual card and refreshes the dashboard", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 1200,
        monthly_spent_cents: 3400,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [
        {
          id: "card-1",
          last_four: "4242",
          merchant: "Amazon",
          status: "active",
          amount_cents: 2400,
          provider: "mock",
          provider_card_ref: "mock-agent-pay-1-2400",
          expires_at: "2026-07-17T18:00:00Z",
        },
      ],
      recent_transactions: [],
      recent_audit_entries: [],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") return dashboard.active_virtual_cards;
      if (command === "cancel_virtual_card") return { id: "card-1", status: "cancelled" };
      return null;
    });

    render(<SpendTab agent={agent} />);
    expect(await screen.findByText("Amazon · •••• 4242")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Card" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cancel_virtual_card", { cardId: "card-1" });
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_payment_dashboard").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("simulates mock card use and refreshes card activity", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 1200,
        monthly_spent_cents: 3400,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [
        {
          id: "card-1",
          last_four: "4242",
          merchant: "Amazon",
          status: "active",
          amount_cents: 2400,
          provider: "mock",
          provider_card_ref: "mock-agent-pay-1-2400",
          expires_at: "2026-07-17T18:00:00Z",
        },
      ],
      recent_transactions: [
        {
          id: "txn-1",
          merchant: "Prior Vendor",
          amount_cents: 777,
          status: "captured",
          source: "mock_simulated_charge",
          created_at: "2026-07-17T15:00:00Z",
          decline_reason: null,
        },
      ],
      recent_audit_entries: [
        {
          id: "audit-2",
          event_type: "payment_transaction_captured",
          detail_json: { merchant: "Prior Vendor", amountCents: 777 },
          created_at: "2026-07-17T15:00:00Z",
        },
      ],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") {
        return [
          ...dashboard.active_virtual_cards,
          {
            id: "card-2",
            last_four: "1111",
            merchant: "Old Vendor",
            status: "consumed",
            amount_cents: 999,
            provider: "mock",
            provider_card_ref: "mock-agent-pay-1-999",
            expires_at: "2026-07-17T16:00:00Z",
          },
        ];
      }
      if (command === "simulate_virtual_card_charge") return { id: "card-1", status: "consumed" };
      return null;
    });

    render(<SpendTab agent={agent} />);
    expect(await screen.findByText("Simulate Use")).toBeInTheDocument();
    expect(screen.getByText("Card Activity")).toBeInTheDocument();
    expect(screen.getByText("Transaction Activity")).toBeInTheDocument();
    expect(screen.getByText("Old Vendor · •••• 1111")).toBeInTheDocument();
    expect(screen.getAllByText("Prior Vendor · $7.77").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Simulate Use" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("simulate_virtual_card_charge", { cardId: "card-1" });
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_payment_dashboard").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("simulates mock decline and calls the decline command", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 1200,
        monthly_spent_cents: 3400,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [
        {
          id: "card-1",
          last_four: "4242",
          merchant: "Amazon",
          status: "active",
          amount_cents: 2400,
          provider: "mock",
          provider_card_ref: "mock-agent-pay-1-2400",
          expires_at: "2026-07-17T18:00:00Z",
        },
      ],
      recent_transactions: [],
      recent_audit_entries: [],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") return dashboard.active_virtual_cards;
      if (command === "simulate_virtual_card_decline") return { id: "txn-decline", status: "declined" };
      return null;
    });

    render(<SpendTab agent={agent} />);
    expect(await screen.findByText("Simulate Decline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Simulate Decline" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("simulate_virtual_card_decline", { cardId: "card-1" });
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_payment_dashboard").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("injects a provider-style capture event for non-mock cards", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 1200,
        monthly_spent_cents: 3400,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [
        {
          id: "card-privacy-1",
          last_four: "5555",
          merchant: "Linear",
          status: "active",
          amount_cents: 7200,
          provider: "privacy",
          provider_card_ref: "privacy-card-ref-1234567890",
          expires_at: "2026-07-17T18:00:00Z",
        },
      ],
      recent_transactions: [],
      recent_audit_entries: [],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") return dashboard.active_virtual_cards;
      if (command === "simulate_provider_transaction_event") {
        return { id: "txn-privacy-1", status: "captured" };
      }
      return null;
    });

    render(<SpendTab agent={agent} />);
    expect(await screen.findByText("Inject Capture")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inject Capture" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("simulate_provider_transaction_event", {
        cardId: "card-privacy-1",
        outcome: "captured",
      });
    });
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_payment_dashboard").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("copies the provider card reference for non-mock cards", async () => {
    const dashboard = {
      agent_id: "agent-pay-1",
      budget: {
        daily_spent_cents: 1200,
        monthly_spent_cents: 3400,
        monthly_limit_cents: 200000,
      },
      pending_approvals: [],
      recent_purchases: [],
      active_virtual_cards: [
        {
          id: "card-privacy-1",
          last_four: "5555",
          merchant: "Linear",
          status: "active",
          amount_cents: 7200,
          provider: "privacy",
          provider_card_ref: "privacy-card-ref-1234567890",
          expires_at: "2026-07-17T18:00:00Z",
        },
      ],
      recent_transactions: [],
      recent_audit_entries: [],
    };

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_payment_dashboard") return dashboard;
      if (command === "get_virtual_cards_for_agent") return dashboard.active_virtual_cards;
      return null;
    });

    render(<SpendTab agent={agent} />);
    expect(await screen.findByText("Copy Provider Ref")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy Provider Ref" }));

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("privacy-card-ref-1234567890");
    });
    expect(screen.getByText("Provider reference copied for sandbox testing.")).toBeInTheDocument();
  });
});
