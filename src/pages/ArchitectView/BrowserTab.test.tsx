import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserTab } from "./BrowserTab";
import { AgentData, useWorldStore } from "../../store/worldStore";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const baseAgent: AgentData = {
  id: "agent-browser-1",
  name: "Browser Agent",
  role: "assistant",
  emoji: "B",
  color: "#3c6663",
  status: "active",
  isolated: true,
  paused: false,
  container_id: null,
  title: "Browser Agent",
  description: "Test browser agent",
  robeColor: "#3c6663",
  accentColor: "#34D399",
  position: [0, 0, 0],
  targetPosition: [0, 0, 0],
  currentAction: "idle",
  socialMotive: 1,
  energy: 100,
  uptime: "1h",
  tokensUsed: "0",
  weeklyCompute: "$0.00",
  monthlySpend: 0,
  spendLimit: 10,
  integrations: [],
  created_at: "2026-06-04T00:00:00Z",
  stats: {
    tasks_today: 0,
    messages_handled: 0,
    uptime_seconds: 0,
    total_cost_usd: 0,
  },
  permissions: [
    { id: "browser", label: "Browser", description: "", enabled: true, category: "skills" },
    { id: "file_write", label: "File Write", description: "", enabled: false, category: "data" },
  ],
  recentSpend: [],
  chatLog: [],
  memories: [],
  personality: {
    name: "Browser Agent",
    communication_style: "direct",
    expertise: [],
    guardrails: [],
    custom_instructions: "",
  },
  personalityPrompt: "",
  avatarPrompt: "",
  visual_identity: { baseModelUrl: null, accessories: [] },
  capabilities: {
    ext_network: false,
    int_network: false,
    autonomous: false,
    scheduled: false,
    memory_write: false,
    file_read: false,
    file_write: false,
    payments: false,
    spend_auto: false,
    browser: true,
    proxy: false,
    vision: false,
    canvas: false,
    coding: false,
    gog: false,
    summarize: false,
  },
  browser_status: {
    agent_id: "agent-browser-1",
    port: 9222,
    profile_path: "/tmp/agent-browser-1",
    is_running: true,
    mode: "automated",
  },
};

describe("BrowserTab trusted auth handoff", () => {
  beforeEach(() => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_browser_status":
          return Promise.resolve(baseAgent.browser_status);
        case "get_agent_allowed_domains":
          return Promise.resolve([]);
        case "get_web_credentials_cmd":
          return Promise.resolve([]);
        case "get_agent_browser_history":
          return Promise.resolve([]);
        case "start_browser_stream":
        case "stop_browser_stream":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });

    useWorldStore.setState({ agents: [baseAgent] });
  });

  it("starts trusted Google login in the same agent profile", async () => {
    mockInvoke.mockImplementation((command: string, payload?: any) => {
      if (command === "start_browser_interactive_auth") {
        return Promise.resolve({
          agent_id: payload.agentId,
          port: 0,
          profile_path: "/tmp/agent-browser-1",
          is_running: true,
          mode: "interactive_auth",
        });
      }
      if (command === "get_browser_status") return Promise.resolve(baseAgent.browser_status);
      if (command === "get_agent_allowed_domains") return Promise.resolve([]);
      if (command === "get_web_credentials_cmd") return Promise.resolve([]);
      if (command === "get_agent_browser_history") return Promise.resolve([]);
      if (command === "start_browser_stream" || command === "stop_browser_stream") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<BrowserTab agent={baseAgent} />);
    fireEvent.click(screen.getByRole("button", { name: /trusted google login/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("start_browser_interactive_auth", {
        agentId: "agent-browser-1",
      })
    );
  });

  it("shows resume automation while interactive auth is active", async () => {
    const interactiveAgent: AgentData = {
      ...baseAgent,
      browser_status: {
        agent_id: "agent-browser-1",
        port: 0,
        profile_path: "/tmp/agent-browser-1",
        is_running: true,
        mode: "interactive_auth",
      },
    };

    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_browser_status") return Promise.resolve(interactiveAgent.browser_status);
      if (command === "get_agent_allowed_domains") return Promise.resolve([]);
      if (command === "get_web_credentials_cmd") return Promise.resolve([]);
      if (command === "get_agent_browser_history") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(<BrowserTab agent={interactiveAgent} />);

    expect(await screen.findByText(/trusted login window active/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resume automation/i })).toBeInTheDocument();
  });
});
