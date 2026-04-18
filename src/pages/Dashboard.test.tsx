import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { Agent, AgentStatus } from '../types';

describe('Dashboard', () => {
  let mockAgents: Agent[];

  beforeEach(() => {
    mockAgents = [
      {
        id: 'agent-1',
        name: 'The Assistant',
        role: 'assistant',
        emoji: '🦞',
        color: '#34D399',
        status: 'active' as AgentStatus,
        isolated: false,
        container_id: null,
        personality: {
          name: 'Assistant',
          communication_style: 'warm',
          expertise: ['calendar', 'email'],
          guardrails: [],
          custom_instructions: '',
        },
        integrations: ['imessage', 'calendar'],
        created_at: new Date().toISOString(),
        stats: {
          tasks_today: 5,
          messages_handled: 12,
          uptime_seconds: 3600,
          total_cost_usd: 0.45,
        },
      },
      {
        id: 'agent-2',
        name: 'The Accountant',
        role: 'accountant',
        emoji: '📊',
        color: '#F59E3F',
        status: 'sleeping' as AgentStatus,
        isolated: true,
        container_id: 'container-2',
        personality: {
          name: 'Accountant',
          communication_style: 'precise',
          expertise: ['accounting', 'taxes'],
          guardrails: ['no_write_critical_files'],
          custom_instructions: 'Focus on accuracy',
        },
        integrations: ['files'],
        created_at: new Date(Date.now() - 86400000).toISOString(),
        stats: {
          tasks_today: 2,
          messages_handled: 0,
          uptime_seconds: 7200,
          total_cost_usd: 0.12,
        },
      },
    ];

    // Mock Tauri API
    global.mockTauriInvoke = vi.fn().mockResolvedValue(mockAgents);
  });

  describe('rendering', () => {
    it('should render dashboard heading', () => {
      render(<Dashboard />);
      expect(screen.getByText(/dashboard/i)).toBeDefined();
    });

    it('should display all agents', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
        expect(screen.getByText('The Accountant')).toBeDefined();
      });
    });

    it('should show agent count in header', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const header = screen.getByTestId('dashboard-header');
        expect(header.textContent).toContain('2');
      });
    });

    it('should display isolation count for isolated agents', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const header = screen.getByTestId('dashboard-header');
        expect(header.textContent).toContain('1 isolated');
      });
    });
  });

  describe('agent grid layout', () => {
    it('should use 2-column grid on desktop', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const grid = screen.getByTestId('agent-grid');
        expect(grid.className).toContain('grid-cols-2');
      });
    });

    it('should switch to 1-column on mobile', async () => {
      // Set narrow viewport
      window.innerWidth = 375;
      fireEvent(window, new Event('resize'));

      render(<Dashboard />);
      await waitFor(() => {
        const grid = screen.getByTestId('agent-grid');
        expect(grid.className).toContain('grid-cols-1');
      });

      // Reset
      window.innerWidth = 1024;
    });

    it('should update grid on window resize', async () => {
      const { container } = render(<Dashboard />);

      // Start at desktop width
      expect(window.innerWidth).toBeGreaterThanOrEqual(768);

      // Resize to mobile
      window.innerWidth = 375;
      fireEvent(window, new Event('resize'));

      await waitFor(() => {
        const grid = container.querySelector('[data-testid="agent-grid"]');
        expect(grid?.className).toContain('grid-cols-1');
      });
    });
  });

  describe('agent creation', () => {
    it('should have create agent button', () => {
      render(<Dashboard />);
      const createButton = screen.getByTestId('create-agent-button');
      expect(createButton).toBeDefined();
    });

    it('should open agent creation modal on button click', async () => {
      render(<Dashboard />);
      const createButton = screen.getByTestId('create-agent-button');
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByTestId('agent-creation-modal')).toBeDefined();
      });
    });

    it('should close modal after successful creation', async () => {
      render(<Dashboard />);
      const createButton = screen.getByTestId('create-agent-button');
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByTestId('agent-creation-modal')).toBeDefined();
      });

      const confirmButton = screen.getByText('Create Agent');
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.queryByTestId('agent-creation-modal')).toBeNull();
      });
    });
  });

  describe('briefing card', () => {
    it('should display morning briefing section', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByTestId('briefing-card')).toBeDefined();
      });
    });

    it('should show summary for active agents', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const briefing = screen.getByTestId('briefing-card');
        expect(briefing.textContent).toContain('5 tasks');
      });
    });

    it('should list overnight activity', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const briefing = screen.getByTestId('briefing-card');
        // Should show activity summary
        expect(briefing).toBeDefined();
      });
    });
  });

  describe('security indicators', () => {
    it('should show security scorecard', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByTestId('security-scorecard')).toBeDefined();
      });
    });

    it('should highlight security issues', async () => {
      // Create agent with permission risk
      mockAgents[0].integrations = ['imessage', 'gmail', 'slack', 'website'];
      mockAgents[0].isolated = false;

      render(<Dashboard />);
      await waitFor(() => {
        const scorecard = screen.getByTestId('security-scorecard');
        expect(scorecard.textContent).toContain('warn');
      });
    });

    it('should show green for well-configured agents', async () => {
      mockAgents[1].isolated = true;
      mockAgents[1].integrations = ['files'];

      render(<Dashboard />);
      await waitFor(() => {
        const scorecard = screen.getByTestId('security-scorecard');
        expect(scorecard.textContent).toContain('✓');
      });
    });
  });

  describe('filtering and sorting', () => {
    it('should allow filter by agent role', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const roleFilter = screen.getByTestId('role-filter');
        expect(roleFilter).toBeDefined();
      });

      const roleFilter = screen.getByTestId('role-filter');
      fireEvent.click(roleFilter);
      const assistantOption = screen.getByText('Assistant');
      fireEvent.click(assistantOption);

      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
        expect(screen.queryByText('The Accountant')).toBeNull();
      });
    });

    it('should allow sort by recent activity', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const sortButton = screen.getByTestId('sort-button');
        fireEvent.click(sortButton);
      });

      const sortOption = screen.getByText('Most Recent');
      fireEvent.click(sortOption);

      const cards = screen.getAllByTestId(/agent-card/);
      // Most recently active agent (The Assistant) should be first
      expect(cards[0].textContent).toContain('The Assistant');
    });
  });

  describe('performance', () => {
    it('should render 2 agents efficiently', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
      });

      // No layout shift
      const grid = screen.getByTestId('agent-grid');
      expect(grid).toBeDefined();
    });

    it('should handle 20+ agents without lag', async () => {
      // Create many agents
      mockAgents = Array.from({ length: 25 }, (_, i) => ({
        ...mockAgents[0],
        id: `agent-${i}`,
        name: `Agent ${i}`,
      }));

      const startTime = performance.now();
      render(<Dashboard />);
      const endTime = performance.now();

      // Should render in under 500ms
      expect(endTime - startTime).toBeLessThan(500);
    });
  });

  describe('real-time updates', () => {
    it('should update when agent status changes', async () => {
      const { rerender } = render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
      });

      // Update agent status
      mockAgents[0].status = 'thinking' as AgentStatus;

      // Mock would be called again with new state
      global.mockTauriInvoke = vi.fn().mockResolvedValue(mockAgents);

      rerender(<Dashboard />);

      await waitFor(() => {
        const statusIndicator = screen.getByTestId('agent-1-status');
        expect(statusIndicator.className).toContain('thinking');
      });
    });

    it('should add new agent card when agent is created', async () => {
      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
      });

      // New agent would be added
      const newAgent = {
        ...mockAgents[0],
        id: 'agent-3',
        name: 'New Agent',
      };
      mockAgents.push(newAgent);

      global.mockTauriInvoke = vi.fn().mockResolvedValue(mockAgents);

      await waitFor(() => {
        expect(screen.getByText('New Agent')).toBeDefined();
      });
    });
  });

  describe('empty state', () => {
    it('should show empty state when no agents exist', async () => {
      global.mockTauriInvoke = vi.fn().mockResolvedValue([]);
      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText(/no agents/i)).toBeDefined();
        expect(screen.getByText(/create your first agent/i)).toBeDefined();
      });
    });

    it('should show create agent button in empty state', async () => {
      global.mockTauriInvoke = vi.fn().mockResolvedValue([]);
      render(<Dashboard />);

      await waitFor(() => {
        const createButton = screen.getByTestId('empty-state-create-button');
        expect(createButton).toBeDefined();
      });
    });
  });

  describe('accessibility', () => {
    it('should have proper heading hierarchy', async () => {
      render(<Dashboard />);
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toBeDefined();
    });

    it('should announce agent count to screen readers', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        const liveRegion = screen.getByRole('status');
        expect(liveRegion.textContent).toContain('2 agents');
      });
    });
  });
});
