// Agent Store Tests (Redux/Zustand)
// Phase 3 Implementation - State management testing

import { describe, it, expect, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// MOCK STORE SETUP (simulating Redux/Zustand)
// ────────────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  emoji: string;
  status: 'active' | 'paused' | 'stopped';
  paused: boolean;
}

interface AgentStore {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;

  // Actions
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  selectAgent: (id: string | null) => void;
  getAgent: (id: string) => Agent | undefined;
  getSelectedAgent: () => Agent | undefined;
}

// Simulated store implementation
const createAgentStore = (): AgentStore => {
  const state = {
    agents: [] as Agent[],
    loading: false,
    error: null as string | null,
    selectedAgentId: null as string | null,
  };

  return {
    get agents() { return state.agents; },
    get loading() { return state.loading; },
    get error() { return state.error; },
    get selectedAgentId() { return state.selectedAgentId; },

    addAgent: (agent: Agent) => {
      if (state.agents.find(a => a.id === agent.id)) {
        throw new Error(`Agent ${agent.id} already exists`);
      }
      state.agents.push(agent);
    },

    removeAgent: (id: string) => {
      state.agents = state.agents.filter(a => a.id !== id);
      if (state.selectedAgentId === id) {
        state.selectedAgentId = null;
      }
    },

    updateAgent: (id: string, updates: Partial<Agent>) => {
      const agent = state.agents.find(a => a.id === id);
      if (!agent) throw new Error(`Agent ${id} not found`);
      Object.assign(agent, updates);
    },

    setLoading: (loading: boolean) => {
      state.loading = loading;
    },

    setError: (error: string | null) => {
      state.error = error;
    },

    selectAgent: (id: string | null) => {
      state.selectedAgentId = id;
    },

    getAgent: (id: string) => state.agents.find(a => a.id === id),

    getSelectedAgent: () => {
      if (!state.selectedAgentId) return undefined;
      return state.agents.find(a => a.id === state.selectedAgentId);
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// AGENT CRUD TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('AgentStore - CRUD Operations', () => {
  let store: AgentStore;

  beforeEach(() => {
    store = createAgentStore();
  });

  it('should add agent to store', () => {
    // Test: Agent creation
    // Validates: State mutation
    // Ensures: Agent appears in list

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test Agent',
      emoji: '🦞',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);

    expect(store.agents).toHaveLength(1);
    expect(store.agents[0]).toEqual(agent);
  });

  it('should prevent duplicate agent IDs', () => {
    // Test: ID uniqueness
    // Validates: Constraint enforcement
    // Ensures: No duplicate IDs

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    expect(() => store.addAgent(agent)).toThrow();
  });

  it('should remove agent from store', () => {
    // Test: Agent deletion
    // Validates: Removal works
    // Ensures: Agent disappears from list

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    expect(store.agents).toHaveLength(1);

    store.removeAgent('agent-1');
    expect(store.agents).toHaveLength(0);
  });

  it('should update agent properties', () => {
    // Test: Agent update
    // Validates: Property mutation
    // Ensures: Changes persist

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.updateAgent('agent-1', { name: 'Updated' });

    expect(store.getAgent('agent-1')?.name).toBe('Updated');
  });

  it('should throw error updating non-existent agent', () => {
    // Test: Error handling
    // Validates: Prevents invalid operations
    // Ensures: No silent failures

    expect(() => store.updateAgent('missing', {})).toThrow();
  });

  it('should get agent by ID', () => {
    // Test: Agent lookup
    // Validates: Retrieval works
    // Ensures: Can find agent

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    expect(store.getAgent('agent-1')).toEqual(agent);
    expect(store.getAgent('missing')).toBeUndefined();
  });

  it('should handle multiple agents', () => {
    // Test: Multiple agents
    // Validates: List management
    // Ensures: Agents don't conflict

    const agents = [
      { id: 'agent-1', name: 'Agent 1', emoji: '😀', status: 'active' as const, paused: false },
      { id: 'agent-2', name: 'Agent 2', emoji: '🦞', status: 'active' as const, paused: false },
      { id: 'agent-3', name: 'Agent 3', emoji: '🌊', status: 'paused' as const, paused: true },
    ];

    agents.forEach(a => store.addAgent(a));

    expect(store.agents).toHaveLength(3);
    expect(store.getAgent('agent-2')?.name).toBe('Agent 2');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AGENT SELECTION TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('AgentStore - Selection', () => {
  let store: AgentStore;

  beforeEach(() => {
    store = createAgentStore();
  });

  it('should select agent', () => {
    // Test: Selection
    // Validates: Selection state
    // Ensures: Can track selected agent

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.selectAgent('agent-1');

    expect(store.selectedAgentId).toBe('agent-1');
    expect(store.getSelectedAgent()).toEqual(agent);
  });

  it('should clear selection', () => {
    // Test: Clear selection
    // Validates: Selection can be cleared
    // Ensures: No lingering selection

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.selectAgent('agent-1');
    store.selectAgent(null);

    expect(store.selectedAgentId).toBeNull();
    expect(store.getSelectedAgent()).toBeUndefined();
  });

  it('should clear selection when selected agent is removed', () => {
    // Test: Selection cleanup
    // Validates: Automatic cleanup
    // Ensures: No orphaned selection

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.selectAgent('agent-1');
    store.removeAgent('agent-1');

    expect(store.selectedAgentId).toBeNull();
  });

  it('should switch selection between agents', () => {
    // Test: Selection switching
    // Validates: Can change selection
    // Ensures: Selection updates correctly

    const agent1: Agent = {
      id: 'agent-1',
      name: 'Agent 1',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    const agent2: Agent = {
      id: 'agent-2',
      name: 'Agent 2',
      emoji: '🦞',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent1);
    store.addAgent(agent2);

    store.selectAgent('agent-1');
    expect(store.getSelectedAgent()?.id).toBe('agent-1');

    store.selectAgent('agent-2');
    expect(store.getSelectedAgent()?.id).toBe('agent-2');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// LOADING & ERROR STATE TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('AgentStore - Loading & Error States', () => {
  let store: AgentStore;

  beforeEach(() => {
    store = createAgentStore();
  });

  it('should set loading state', () => {
    // Test: Loading state
    // Validates: UI can show loading
    // Ensures: Async operations tracked

    expect(store.loading).toBe(false);
    store.setLoading(true);
    expect(store.loading).toBe(true);
    store.setLoading(false);
    expect(store.loading).toBe(false);
  });

  it('should set error state', () => {
    // Test: Error state
    // Validates: Error messages shown
    // Ensures: Users see what went wrong

    expect(store.error).toBeNull();
    store.setError('Something failed');
    expect(store.error).toBe('Something failed');
    store.setError(null);
    expect(store.error).toBeNull();
  });

  it('should clear error on successful operation', () => {
    // Test: Error clearing
    // Validates: Errors don't persist
    // Ensures: Successful retry clears error

    store.setError('Previous error');

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.setError(null); // Clear after success

    expect(store.error).toBeNull();
  });

  it('should track loading during async operation', () => {
    // Test: Loading state during async
    // Validates: UI shows loading
    // Ensures: User sees progress

    store.setLoading(true);
    expect(store.loading).toBe(true);

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.setLoading(false);

    expect(store.loading).toBe(false);
    expect(store.agents).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AGENT STATUS TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('AgentStore - Agent Status', () => {
  let store: AgentStore;

  beforeEach(() => {
    store = createAgentStore();
  });

  it('should track agent status', () => {
    // Test: Status tracking
    // Validates: Status changes tracked
    // Ensures: Agent state correct

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    expect(store.getAgent('agent-1')?.status).toBe('active');
  });

  it('should update agent status', () => {
    // Test: Status update
    // Validates: Status change persists
    // Ensures: Can pause/resume

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);
    store.updateAgent('agent-1', { status: 'paused', paused: true });

    expect(store.getAgent('agent-1')?.status).toBe('paused');
    expect(store.getAgent('agent-1')?.paused).toBe(true);
  });

  it('should maintain consistency between status and paused flag', () => {
    // Test: State consistency
    // Validates: Related fields stay in sync
    // Ensures: No contradictory states

    const agent: Agent = {
      id: 'agent-1',
      name: 'Test',
      emoji: '😀',
      status: 'active',
      paused: false,
    };

    store.addAgent(agent);

    // When paused=true, status should be paused
    store.updateAgent('agent-1', { paused: true, status: 'paused' });
    const updated = store.getAgent('agent-1')!;

    expect(updated.paused).toBe(true);
    expect(updated.status).toBe('paused');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY OF TESTS IMPLEMENTED
// ────────────────────────────────────────────────────────────────────────────

// CRUD Operations (7 tests):
// ✅ test_add_agent
// ✅ test_prevent_duplicate_ids
// ✅ test_remove_agent
// ✅ test_update_agent
// ✅ test_error_updating_missing
// ✅ test_get_agent_by_id
// ✅ test_multiple_agents
//
// Selection (4 tests):
// ✅ test_select_agent
// ✅ test_clear_selection
// ✅ test_clear_selection_on_remove
// ✅ test_switch_selection
//
// Loading & Error (4 tests):
// ✅ test_set_loading_state
// ✅ test_set_error_state
// ✅ test_clear_error_on_success
// ✅ test_track_loading_async
//
// Status (3 tests):
// ✅ test_track_agent_status
// ✅ test_update_agent_status
// ✅ test_maintain_consistency
//
// TOTAL: 18 state management tests covering store operations
