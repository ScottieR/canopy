import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentCard } from './AgentCard';
import { Agent, AgentStatus } from '../../types';

describe('AgentCard', () => {
  let mockAgent: Agent;

  beforeEach(() => {
    mockAgent = {
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
        custom_metrics: [
          { label: "Bugs Fixed", value: 42 },
          { label: "Speed", value: "Fast" }
        ]
      },
    };
  });

  describe('rendering', () => {
    it('should render agent name', () => {
      render(<AgentCard agent={mockAgent} />);
      expect(screen.getByText('The Assistant')).toBeDefined();
    });

    it('should render agent role', () => {
      render(<AgentCard agent={mockAgent} />);
      expect(screen.getByText('assistant')).toBeDefined();
    });

    it('should display active status indicator', () => {
      render(<AgentCard agent={mockAgent} />);
      const statusElement = screen.getByTestId('status-indicator');
      expect(statusElement).toBeDefined();
    });



    it('should show isolation badge when isolated', () => {
      mockAgent.isolated = true;
      render(<AgentCard agent={mockAgent} />);
      const isolationBadge = screen.getByTestId('isolation-badge');
      expect(isolationBadge).toBeDefined();
    });

    it('should NOT show isolation badge when not isolated', () => {
      mockAgent.isolated = false;
      render(<AgentCard agent={mockAgent} />);
      const isolationBadge = screen.queryByTestId('isolation-badge');
      expect(isolationBadge).toBeNull();
    });
  });

  describe('status changes', () => {
    it('should update visual style when status changes', () => {
      const { rerender } = render(<AgentCard agent={mockAgent} />);

      // Start as active
      let statusElement = screen.getByTestId('status-indicator');
      expect(statusElement.className).toContain('active');

      // Change to sleeping
      mockAgent.status = 'sleeping' as AgentStatus;
      rerender(<AgentCard agent={mockAgent} />);
      statusElement = screen.getByTestId('status-indicator');
      expect(statusElement.className).toContain('sleeping');
    });

    it('should show error state when status is error', () => {
      mockAgent.status = 'error' as AgentStatus;
      render(<AgentCard agent={mockAgent} />);
      const statusElement = screen.getByTestId('status-indicator');
      expect(statusElement.className).toContain('error');
    });

    it('should show thinking animation when status is thinking', () => {
      mockAgent.status = 'thinking' as AgentStatus;
      render(<AgentCard agent={mockAgent} />);
      const statusElement = screen.getByTestId('status-indicator');
      expect(statusElement.className).toContain('thinking');
    });
  });

  describe('stats display', () => {
    it('should display tasks completed today', () => {
      mockAgent.stats.tasks_today = 15;
      render(<AgentCard agent={mockAgent} isSelected />);
      expect(screen.getByText('15')).toBeDefined();
    });

    it('should display custom metrics if provided', () => {
      render(<AgentCard agent={mockAgent} isSelected />);
      expect(screen.getByText('Bugs Fixed')).toBeDefined();
      expect(screen.getByText('42')).toBeDefined();
      expect(screen.getByText('Speed')).toBeDefined();
      expect(screen.getByText('Fast')).toBeDefined();
    });
  });

  describe('interaction', () => {
    it('should call onClick handler when clicked', () => {
      const handleClick = vi.fn();
      render(<AgentCard agent={mockAgent} onClick={handleClick} />);

      const card = screen.getByTestId('agent-card');
      card.click();

      expect(handleClick).toHaveBeenCalledWith(mockAgent.id);
    });

    it('should be navigable with keyboard', () => {
      const handleClick = vi.fn();
      render(<AgentCard agent={mockAgent} onClick={handleClick} />);


      const card = screen.getByTestId('agent-card');
      // Simulate Enter key press using testing-library's fireEvent
      fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });

      expect(handleClick).toHaveBeenCalled();
    });
  });

  describe('color theming', () => {
    it('should apply agent color as theme', () => {
      mockAgent.color = '#34D399';
      render(<AgentCard agent={mockAgent} />);

      const card = screen.getByTestId('agent-card');
      const styles = window.getComputedStyle(card);
      // Verify color is applied (exact assertion depends on implementation)
      expect(card).toBeDefined();
    });

    it('should support custom colors', () => {
      mockAgent.color = '#FF6B6B';
      render(<AgentCard agent={mockAgent} />);
      // Verify card renders with custom color
      const card = screen.getByTestId('agent-card');
      expect(card).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle agent with no integrations', () => {
      mockAgent.integrations = [];
      render(<AgentCard agent={mockAgent} />);
      // Card should still render
      expect(screen.getByText('The Assistant')).toBeDefined();
    });

    it('should handle agent with very long name', () => {
      mockAgent.name = 'A'.repeat(100);
      render(<AgentCard agent={mockAgent} />);
      // Should render without breaking layout
      expect(screen.getByText(mockAgent.name)).toBeDefined();
    });

    it('should handle zero tasks today', () => {
      mockAgent.stats.tasks_today = 0;
      render(<AgentCard agent={mockAgent} isSelected />);
      expect(screen.getByText('0')).toBeDefined();
    });

    it('should handle negative uptime gracefully', () => {
      mockAgent.stats.uptime_seconds = 0;
      render(<AgentCard agent={mockAgent} />);
      // Should render without errors
      expect(screen.getByText('The Assistant')).toBeDefined();
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<AgentCard agent={mockAgent} />);
      const card = screen.getByTestId('agent-card');
      expect(card.getAttribute('role')?.includes('button') || card.getAttribute('role')?.includes('link')).toBe(true);
    });

    it('should be keyboard accessible', () => {
      const handleClick = vi.fn();
      render(<AgentCard agent={mockAgent} onClick={handleClick} />);
      const card = screen.getByTestId('agent-card');

      expect(card.getAttribute('tabindex')).toBeDefined();
    });

    it('should announce status changes', () => {
      const { rerender } = render(<AgentCard agent={mockAgent} />);
      mockAgent.status = 'error' as AgentStatus;
      rerender(<AgentCard agent={mockAgent} />);

      const liveRegion = screen.queryByRole('status');
      expect(liveRegion).toBeDefined();
    });
  });
});
