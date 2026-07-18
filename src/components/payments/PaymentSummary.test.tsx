import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PaymentSummary } from "./PaymentSummary";
import { useWorldStore } from "../../store/worldStore";

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

describe("PaymentSummary", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    eventHandlers.clear();
    useWorldStore.setState({
      agents: [
        {
          id: "agent-pay-1",
          name: "Poppy",
          role: "assistant",
          emoji: "agent",
          color: "#34D399",
          status: "active",
          isolated: false,
          paused: false,
          container_id: null,
          title: "Poppy",
          description: "Test agent",
          robeColor: "#34D399",
          accentColor: "#34D399",
          position: [0, 0, 0],
          targetPosition: [0, 0, 0],
          currentAction: "idle",
          socialMotive: 1,
          energy: 100,
          uptime: "1h",
          tokensUsed: "0",
          weeklyCompute: "0.0",
          monthlySpend: 0,
          spendLimit: 100,
          integrations: [],
          created_at: "2026-07-17T00:00:00Z",
          permissions: [],
          recentSpend: [],
          chatLog: [],
          memories: [],
          personalityPrompt: "",
          avatarPrompt: "",
          capabilities: {
            ext_network: false,
            int_network: false,
            autonomous: false,
            scheduled: false,
            memory_write: false,
            file_read: false,
            file_write: false,
            payments: true,
            spend_auto: true,
            browser: false,
            proxy: false,
            vision: false,
            canvas: false,
            coding: false,
            gog: false,
            summarize: false,
          },
          stats: {
            tasks_today: 0,
            messages_handled: 0,
            uptime_seconds: 0,
            total_cost_usd: 0,
          },
          personality: {
            name: "Poppy",
            communication_style: "warm",
            expertise: [],
            guardrails: [],
            custom_instructions: "",
          },
          visual_identity: {
            baseModelUrl: null,
            accessories: [],
          },
        } as any,
      ],
    });
  });

  it("refreshes aggregate totals when payment_state_changed fires", async () => {
    let dashboardCalls = 0;
    mockInvoke.mockImplementation(async (command: string) => {
      if (command !== "get_payment_dashboard") return null;
      dashboardCalls += 1;
      if (dashboardCalls === 1) {
        return {
          budget: {
            payments_enabled: true,
            monthly_spent_cents: 1000,
            monthly_limit_cents: 10000,
          },
          pending_approvals: [],
          active_virtual_cards: [{ id: "card-1" }],
        };
      }
      return {
        budget: {
          payments_enabled: true,
          monthly_spent_cents: 2500,
          monthly_limit_cents: 10000,
        },
        pending_approvals: [{ id: "approval-1" }],
        active_virtual_cards: [{ id: "card-1" }, { id: "card-2" }],
      };
    });

    render(<PaymentSummary />);

    expect(await screen.findByText("$10.00")).toBeInTheDocument();
    const handler = eventHandlers.get("payment_state_changed");
    expect(handler).toBeTypeOf("function");

    handler?.({ payload: { agent_id: "agent-pay-1" } });

    await waitFor(() => {
      expect(screen.getByText("$25.00")).toBeInTheDocument();
      expect(screen.getByText("1 pending approvals")).toBeInTheDocument();
      expect(screen.getByText("2 active cards")).toBeInTheDocument();
    });
  });
});
