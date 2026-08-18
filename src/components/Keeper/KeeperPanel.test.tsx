// KeeperPanel (Eddy) — fresh-profile behavior.
// Regression for the fresh-user CUJ finding (2026-08-15): on a brand-new
// profile (no agents, no keys, runtime not yet installed) Eddy opened already
// alarmed — "Something needs attention" + "Diagnose what's wrong" — because
// ambient health checks treat the not-yet-set-up runtime as trouble. Before
// initial setup completes, Eddy must welcome, not warn; genuine setup blockers
// surface as onboarding guidance instead.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { KeeperPanel } from './KeeperPanel';
import { useWorldStore } from '../../store/worldStore';

const SETUP_COMPLETE_KEY = 'canopy_initial_setup_complete';

// jsdom doesn't implement smooth scrolling on elements.
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
});

const openPanel = () => {
  render(<KeeperPanel />);
  act(() => {
    window.dispatchEvent(new Event('canopy:open-keeper'));
  });
};

// localStorage is a vi.fn() mock from tests/setup.ts; program it per scenario.
const mockStoredValues = (values: Record<string, string>) => {
  (window.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(
    (key: string) => values[key] ?? null,
  );
};

const setWorld = (state: Partial<ReturnType<typeof useWorldStore.getState>>) => {
  act(() => {
    useWorldStore.setState({
      agents: [],
      selectedAgent: null,
      activeView: 'canopy',
      gatewayReady: false,
      ...state,
    } as any);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStoredValues({});
});

describe('KeeperPanel — fresh profile (first launch, setup not complete)', () => {
  beforeEach(() => {
    setWorld({ agents: [], gatewayReady: false });
  });

  it('greets with a welcome subtitle instead of an alarm', () => {
    openPanel();

    expect(screen.getByText('Here to help you get set up')).toBeInTheDocument();
    expect(screen.queryByText('Something needs attention')).not.toBeInTheDocument();
  });

  it('does not offer the "Diagnose what\'s wrong" quick action', () => {
    openPanel();

    expect(
      screen.queryByRole('button', { name: /diagnose what's wrong/i }),
    ).not.toBeInTheDocument();
  });

  it('answers runtime questions with setup guidance, not an OrbStack error', async () => {
    openPanel();

    fireEvent.change(
      screen.getByPlaceholderText(/tell eddy what's wrong/i),
      { target: { value: 'Is something wrong with my setup?' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(
      await screen.findByText(/nothing's wrong — you're just getting set up/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/can't reach canopy's local runtime/i)).not.toBeInTheDocument();
  });
});

describe('KeeperPanel — established install (setup previously completed)', () => {
  it('still raises the attention state when the runtime is down', () => {
    mockStoredValues({ [SETUP_COMPLETE_KEY]: 'true' });
    setWorld({ agents: [], gatewayReady: false });

    openPanel();

    expect(screen.getByText('Something needs attention')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /diagnose what's wrong/i }),
    ).toBeInTheDocument();
  });

  it('raises the attention state for an errored agent even with agents present', () => {
    setWorld({
      agents: [{ id: 'a1', name: 'Patch', status: 'error', paused: false } as any],
      gatewayReady: true,
    });

    openPanel();

    expect(screen.getByText('Something needs attention')).toBeInTheDocument();
  });

  it('shows the healthy subtitle when everything is fine', () => {
    setWorld({
      agents: [{ id: 'a1', name: 'Patch', status: 'active', paused: false } as any],
      gatewayReady: true,
    });

    openPanel();

    expect(screen.getByText(/all systems healthy/i)).toBeInTheDocument();
    expect(screen.queryByText('Something needs attention')).not.toBeInTheDocument();
  });
});
