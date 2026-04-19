import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { AgentStatus } from '../types';

describe('Dashboard', () => {
  let mockAgents: any[];

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
        stats: { tasks_today: 5, messages_handled: 12, uptime_seconds: 3600, total_cost_usd: 0.45 },
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
        stats: { tasks_today: 2, messages_handled: 0, uptime_seconds: 7200, total_cost_usd: 0.12 },
      },
    ];

    global.mockTauriInvoke = vi.fn().mockResolvedValue(mockAgents);
  });

  describe('rendering', () => {
    it('should display loading state initially', () => {
      render(<Dashboard />);
      expect(screen.getByText('Loading agents...')).toBeDefined();
    });

    it('should display all agents after load', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('The Assistant')).toBeDefined();
        expect(screen.getByText('The Accountant')).toBeDefined();
      });
    });

    it('should show agent stat summaries', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('5 tasks today · 12 messages')).toBeDefined();
        expect(screen.getByText('2 tasks today · 0 messages')).toBeDefined();
      });
    });

    it('should show correct active and isolated counts', async () => {
      render(<Dashboard />);
      await waitFor(() => {
        expect(screen.getByText('1 agents active · 1 isolated')).toBeDefined();
      });
    });
  });

  describe('empty state', () => {
    it('should show empty state when no agents exist', async () => {
      global.mockTauriInvoke = vi.fn().mockResolvedValue([]);
      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText(/No agents yet/i)).toBeDefined();
      });
    });
  });
});
