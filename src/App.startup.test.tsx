import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/event.js", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("./utils/useIdleTimer", () => ({
  useIdleTimer: vi.fn(),
}));

vi.mock("./pages/ForumView/forumOrchestrator", () => ({
  initializeGlobalBackgroundOrchestrator: vi.fn(),
}));

vi.mock("./components/LockScreen", () => ({
  LockScreen: () => null,
}));

vi.mock("./components/shared/UpdateManager", () => ({
  UpdateManager: () => null,
}));

vi.mock("./components/shared/TopNav", () => ({
  TopNav: () => null,
}));

vi.mock("./components/shared/AgentRequestNotifier", () => ({
  AgentRequestNotifier: () => null,
}));

vi.mock("./pages/CanopyView", () => ({
  CanopyView: () => <div data-testid="canopy-view">Canopy workspace</div>,
}));

import App from "./App";
import { useWorldStore } from "./store/worldStore";

const establishedAgent = {
  id: "agent-test",
  name: "Test",
  role: "Assistant",
  emoji: "agent",
  color: "#447766",
  status: "active" as const,
  isolated: false,
  paused: false,
  container_id: null,
  visual_identity: { accessories: [] },
  personality: {
    name: "Test",
    communication_style: "concise",
    expertise: [],
    guardrails: [],
    custom_instructions: "",
  },
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
    browser: false,
    proxy: false,
    vision: false,
    canvas: false,
    coding: false,
    gog: false,
    summarize: false,
  },
  integrations: [],
  created_at: "2026-01-01T00:00:00Z",
  stats: {
    tasks_today: 0,
    messages_handled: 0,
    uptime_seconds: 0,
    total_cost_usd: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
  },
};

describe("established installation startup", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        transformCallback: vi.fn().mockReturnValue(1),
        unregisterCallback: vi.fn(),
        invoke: vi.fn().mockResolvedValue(null),
      },
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: vi.fn() },
    });
    useWorldStore.setState({
      agents: [],
      selectedAgent: null,
      activeView: "loading",
      gatewayReady: false,
      usageTelemetryEnabled: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
  });

  it("opens the local workspace without waiting for gateway reconciliation", async () => {
    const neverFinishes = new Promise<never>(() => {});
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "list_agents") return [establishedAgent];
      if (command === "get_token_usage_history") return [];
      if (command === "preflight_cleanup") return neverFinishes;
      if (command === "check_agent_status") return "initializing";
      return null;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({}),
    }));

    render(<React.StrictMode><App /></React.StrictMode>);

    expect(screen.getAllByText("Waking up the lobsters...")).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("canopy-view")).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("preflight_cleanup", undefined);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_agents")).toHaveLength(1);
    expect(useWorldStore.getState().agents).toHaveLength(1);
  });
});
