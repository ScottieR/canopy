import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { AgentData, useWorldStore } from '../store/worldStore';

// Dashboard reads agents from the already-loaded Zustand store (like every
// other page in the app) rather than fetching its own copy — so tests seed
// useWorldStore directly instead of mocking a "list_agents" invoke call.
// It still calls invoke() itself for the aggregate heatmap
// (get_agent_activity_heatmap, once per agent) and the aggregate work log
// (get_global_audit_log) — both mocked to resolve empty arrays by default so
// tests can focus on the agent-derived aggregation math.
const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

function makeAgent(overrides: Partial<AgentData>): AgentData {
  return {
    id: overrides.id || "agent-x",
    name: overrides.name || "Agent X",
    role: overrides.role || "assistant",
    emoji: overrides.emoji || "🦞",
    color: "#34D399",
    status: overrides.status || "active",
    isolated: overrides.isolated ?? false,
    paused: false,
    container_id: null,
    title: overrides.name || "Agent X",
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
    weeklyCompute: "0.000",
    monthlySpend: 0,
    spendLimit: overrides.spendLimit ?? 100,
    integrations: [],
    created_at: "2026-06-04T00:00:00Z",
    permissions: [],
    recentSpend: [],
    chatLog: [],
    memories: [],
    personalityPrompt: "",
    avatarPrompt: "",
    ...overrides,
    stats: {
      tasks_today: 0,
      messages_handled: 0,
      uptime_seconds: 0,
      total_cost_usd: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      ...(overrides.stats || {}),
    },
  } as unknown as AgentData;
}

describe('Dashboard (My Usage)', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([]);
    useWorldStore.setState({ agents: [] });
  });

  describe('rendering', () => {
    const agents = [
      makeAgent({
        id: 'agent-1', name: 'The Assistant', role: 'assistant', status: 'active', isolated: false, spendLimit: 100,
        stats: { tasks_today: 5, messages_handled: 12, uptime_seconds: 3600, total_cost_usd: 0.45, total_tokens_in: 1000, total_tokens_out: 500 },
      }),
      makeAgent({
        id: 'agent-2', name: 'The Accountant', role: 'accountant', status: 'sleeping', isolated: true, spendLimit: 50,
        stats: { tasks_today: 2, messages_handled: 0, uptime_seconds: 7200, total_cost_usd: 0.12, total_tokens_in: 200, total_tokens_out: 100 },
      }),
    ];

    beforeEach(() => {
      useWorldStore.setState({ agents });
    });

    it('renders the aggregate heading', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('My Usage')).toBeDefined();
      });
    });

    it('shows every role represented among the agents', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('assistant')).toBeDefined();
        expect(screen.getByText('accountant')).toBeDefined();
      });
    });

    it('shows per-role task/message aggregates', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const textNodes = screen.getAllByText(/tasks/);
        expect(textNodes.some(n => n.textContent?.includes('5 tasks'))).toBeTruthy();
        expect(textNodes.some(n => n.textContent?.includes('2 tasks'))).toBeTruthy();
      });
    });

    it('sums cost across all agents in the total cost card', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        // 0.45 + 0.12 = 0.57
        expect(screen.getByText('$0.57')).toBeDefined();
      });
    });

    it('sums spend limits across all agents', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        // 100 + 50 = 150
        expect(screen.getByText(/of \$150 combined limit/)).toBeDefined();
      });
    });

    it('reflects active/idle counts in the subtitle', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText(/1 active · 1 idle · 1 isolated/)).toBeDefined();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no agents exist', async () => {
      useWorldStore.setState({ agents: [] });
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText(/No agents yet/i)).toBeDefined();
      });
    });
  });
});
