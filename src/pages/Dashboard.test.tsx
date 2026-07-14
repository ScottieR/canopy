import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { AgentData, useWorldStore } from '../store/worldStore';

// Dashboard reads agents from the already-loaded Zustand store (like every
// other page in the app) rather than fetching its own copy. It calls
// invoke() for three things:
//   - get_agent_activity_heatmap (once per agent) — source of truth for
//     message/tool-call counts, since agent.stats.messages_handled/
//     tasks_today are never incremented anywhere in the Rust codebase.
//   - get_token_usage_history (once, agentId: null) — source of truth for
//     tokens/cost, since agent.stats.total_cost_usd is only updated in the
//     same (currently broken) code path that feeds this same ledger table.
//   - get_global_audit_log (once) — the Work Log list.
// Tests mock all three per-command so the aggregation math under test
// exercises the real (ledger-based) data path, not the dead `agent.stats`
// counters.
const mockInvoke = vi.fn((cmd: string, args?: any) => {
  if (cmd === "get_agent_activity_heatmap") {
    if (args?.agentId === "agent-1") {
      return Promise.resolve([{ date: "2026-07-11", interactions: 5, tools: 2, system: 0, total: 7 }]);
    }
    if (args?.agentId === "agent-2") {
      return Promise.resolve([{ date: "2026-07-11", interactions: 2, tools: 0, system: 0, total: 2 }]);
    }
    return Promise.resolve([]);
  }
  if (cmd === "get_token_usage_history") {
    return Promise.resolve([
      { id: "u1", agent_id: "agent-1", conversation_id: null, timestamp: "2026-07-11T12:00:00Z", model: "claude-sonnet-4-6", provider: "anthropic", tokens_in: 1000, tokens_out: 500, cost_usd: 0.45 },
      { id: "u2", agent_id: "agent-2", conversation_id: null, timestamp: "2026-07-11T12:00:00Z", model: "claude-sonnet-4-6", provider: "anthropic", tokens_in: 200, tokens_out: 100, cost_usd: 0.12 },
    ]);
  }
  if (cmd === "get_global_audit_log") return Promise.resolve([]);
  return Promise.resolve([]);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => (mockInvoke as any)(...args),
}));

function makeAgent(overrides: Partial<AgentData>): AgentData {
  return {
    id: overrides.id || "agent-x",
    name: overrides.name || "Agent X",
    role: overrides.role || "assistant",
    emoji: overrides.emoji || "agent",
    color: "#34D399",
    status: overrides.status || "active",
    isolated: overrides.isolated ?? false,
    paused: false,
    container_id: null,
    title: overrides.name || "Agent X",
    description: "Test agent",
    image: overrides.image,
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
    mockInvoke.mockClear();
    useWorldStore.setState({ agents: [] });
  });

  describe('rendering', () => {
    const agents = [
      makeAgent({
        id: 'agent-1', name: 'The Assistant', role: 'assistant', status: 'active', isolated: false, spendLimit: 100,
      }),
      makeAgent({
        id: 'agent-2', name: 'The Accountant', role: 'accountant', status: 'sleeping', isolated: true, spendLimit: 50,
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

    it('shows each agent\'s given name and role', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
        expect(screen.getByText('The Accountant')).toBeDefined();
        expect(screen.getByText('assistant')).toBeDefined();
        expect(screen.getByText('accountant')).toBeDefined();
      });
    });

    it('shows per-agent message/tool-call counts from the activity heatmap', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const textNodes = screen.getAllByText(/msgs/);
        expect(textNodes.some(n => n.textContent?.includes('5') && n.textContent?.includes('msgs'))).toBeTruthy();
        expect(textNodes.some(n => n.textContent?.includes('2') && n.textContent?.includes('msgs'))).toBeTruthy();
      });
    });

    it('sums cost across all agents from the token usage ledger, not agent.stats', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        // 0.45 + 0.12 = 0.57, from get_token_usage_history — agent.stats.total_cost_usd
        // is intentionally ignored since it's never reliably populated.
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

    it('defaults the date range filter to the last 7 days', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('Resource Use (7d)')).toBeDefined();
        expect(screen.getByText('Cost (7d)')).toBeDefined();
      });
    });

    it('requests a wider ledger window when the range filter changes', async () => {
      render(<Dashboard />);
      await waitFor(() => expect(screen.getByText('My Usage')).toBeDefined());
      mockInvoke.mockClear();
      screen.getByText('Last 30d').click();
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('get_token_usage_history', { agentId: null, conversationId: null, days: 30 });
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
