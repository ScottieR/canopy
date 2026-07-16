import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeedbackModal } from "./FeedbackModal";
import { useWorldStore } from "../../store/worldStore";

const mockInvoke = vi.fn(async (command: string) => {
  if (command === "submit_feedback_report") return { id: "report-1" };
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

describe("FeedbackModal", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    useWorldStore.setState((state) => ({
      ...state,
      activeView: "architect",
      selectedAgent: "agent-1",
      agents: [
        {
          id: "agent-1",
          name: "Patch",
          role: "Engineer",
          emoji: "🦀",
          color: "#3c6663",
          status: "active",
          isolated: false,
          paused: false,
          container_id: null,
          personality: {
            name: "Patch",
            communication_style: "",
            expertise: [],
            guardrails: [],
            custom_instructions: "",
          },
          capabilities: {
            ext_network: true,
            int_network: true,
            autonomous: true,
            scheduled: true,
            memory_write: true,
            file_read: true,
            file_write: true,
            payments: false,
            spend_auto: false,
            browser: true,
            proxy: false,
            vision: false,
            canvas: false,
            coding: true,
            gog: true,
            summarize: true,
          },
          integrations: [],
          created_at: new Date().toISOString(),
          stats: {
            tasks_today: 0,
            messages_handled: 0,
            uptime_seconds: 0,
            total_cost_usd: 0,
          },
        } as any,
      ],
    }));
  });

  it("submits feedback with the selected agent and current view", async () => {
    const onClose = vi.fn();
    render(<FeedbackModal open={true} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("Short summary"), {
      target: { value: "Browser tab froze" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("What happened, what you expected, and what you want changed."),
      { target: { value: "The browser stream froze after opening auth mode." } }
    );

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("submit_feedback_report", {
        submission: expect.objectContaining({
          kind: "bug",
          title: "Browser tab froze",
          description: "The browser stream froze after opening auth mode.",
          agentId: "agent-1",
          currentView: "architect",
          includeDiagnostics: true,
        }),
      })
    );

    expect(onClose).toHaveBeenCalled();
  });
});
