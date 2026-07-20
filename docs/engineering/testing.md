# Canopy Testing Strategy

This document outlines the testing infrastructure and strategy for the Canopy Agent Management platform.

## Overview

We maintain **two-pronged test coverage**:

1. **Rust Backend Tests** — Testing critical deterministic systems (payment rules engine, audit logging, bridge permissions)
2. **React Frontend Tests** — Testing UI components and user interactions

## Critical Path: Phase 1 Testing

### Highest Priority: Deterministic Payment Rules Engine

**Why:** The payment gateway cannot be prompt-injected or socially engineered because it has no intelligence. It's pure, deterministic Rust code. Same input must ALWAYS produce same output.

**Location:** `src-tauri/src/payment.rs`

**Test Coverage:**
- ✅ Determinism (same input → same output, always)
- ✅ Gate 0: Payments enabled/disabled
- ✅ Gate 1: Category allowlist enforcement
- ✅ Gate 2: Per-transaction limits
- ✅ Gate 3: Daily budget limits
- ✅ Gate 4: Monthly budget limits
- ✅ Auto-approve threshold
- ✅ Multi-gate denial with all reasons
- ✅ Edge cases (zero dollars, max u64, zero limits)

**Run tests:**
```bash
cd canopy/src-tauri
cargo test payment::tests
```

### Security: Audit Logging

**Why:** Append-only, immutable audit trails are critical for compliance and detecting breaches.

**Location:** `src-tauri/src/audit.rs`

**Test Coverage:**
- ✅ Action serialization (AuditAction → string)
- ✅ Content hashing (deterministic, same input = same hash)
- ✅ Alert severity levels
- ✅ Security alert creation

**Run tests:**
```bash
cd canopy/src-tauri
cargo test audit::tests
```

### Security: Bridge Permission Enforcement

**Why:** Bridges are the boundary between agents and user data. Permissions must be enforced deterministically.

**Location:** `src-tauri/src/bridge.rs`

**Test Coverage:**
- ✅ Default permissions (read-only by default, write requires opt-in)
- ✅ Permission isolation (changes on one bridge don't affect others)
- ✅ Time-bounded access (expiry timestamps prevent indefinite access)
- ✅ Scope management (bridges scoped to specific resources)
- ✅ Push notification configuration
- ✅ All bridge types supported

**Run tests:**
```bash
cd canopy/src-tauri
cargo test bridge::tests
```

### UI: Agent Cards & Dashboard

**Why:** Users interact with the UI to create agents, manage permissions, and understand system state. Regressions here block users.

**Location:**
- `src/components/agents/AgentCard.test.tsx`
- `src/pages/Dashboard.test.tsx`

**Test Coverage:**
- ✅ Component rendering (name, role, status, integrations)
- ✅ Status changes (active → sleeping → thinking → error)
- ✅ Stats display (tasks, costs, uptime)
- ✅ Isolation badge (shown only for isolated agents)
- ✅ Keyboard accessibility
- ✅ Color theming
- ✅ Dashboard grid layout (2-column desktop, 1-column mobile)
- ✅ Agent creation flow
- ✅ Briefing card display
- ✅ Security scorecard
- ✅ Filtering and sorting
- ✅ Real-time updates (status changes, new agents)

**Run tests:**
```bash
npm test                    # Run all React tests
npm test -- --ui          # Open test UI
npm test -- --coverage    # Generate coverage report
```

## Running All Tests

### Quick test of critical systems
```bash
# Rust tests
cd canopy/src-tauri && cargo test payment::tests bridge::tests audit::tests

# React tests
cd canopy && npm test
```

### Full test suite with coverage
```bash
# Rust
cd canopy/src-tauri && cargo test --all

# React
cd canopy && npm test -- --coverage
```

### Watch mode (auto-rerun on file changes)
```bash
cd canopy/src-tauri && cargo watch -x test      # Rust
cd canopy && npm test -- --watch                # React
```

## Test Structure

### Rust Tests
- Located in `#[cfg(test)]` modules at the end of each file
- Use built-in Rust testing framework
- Helper functions at the top of test module for common setup
- Organized by feature/gate

Example:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn default_budget(agent_id: &str) -> AgentBudget {
        // Test fixture
    }

    #[test]
    fn test_payments_disabled_always_denied() {
        // Test implementation
    }
}
```

### React Tests
- Located in `.test.tsx` files next to components
- Use Vitest + React Testing Library
- Render components and query by accessible selectors (text, role, testid)
- Organize tests by feature (rendering, interaction, accessibility)

Example:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentCard } from './AgentCard';

describe('AgentCard', () => {
  it('should render agent name', () => {
    render(<AgentCard agent={mockAgent} />);
    expect(screen.getByText('The Assistant')).toBeDefined();
  });
});
```

## Configuration Files

### `canopy/vitest.config.ts`
- Vitest configuration for React tests
- JSDOM environment (simulates browser DOM)
- Test setup file: `src/tests/setup.ts`
- Coverage provider: v8

### `canopy/src-tauri/Cargo.toml`
- Includes dev-dependencies for testing:
  - `tokio-test` — async runtime testing
  - `mockall` — mocking framework
  - `tempfile` — temporary file handling

## Coverage Targets

| Component | Target | Current |
|-----------|--------|---------|
| Payment rules engine | 95% | ✅ |
| Audit logging | 90% | ✅ |
| Bridge permissions | 90% | ✅ |
| React components | 80% | ✅ |

## Continuous Integration

Tests should run on every:
1. **Pre-commit** — Local validation before pushing
2. **Pull request** — Full test suite blocks merge until passing
3. **Main branch** — Every commit to main must have passing tests

## Adding New Tests

When adding features:

1. **Identify critical path** — What could break production if untested?
2. **Write tests first** (TDD) or immediately after feature code
3. **Aim for >80% coverage** on security-critical paths
4. **Document test intent** — Why this test matters
5. **Use clear test names** — `test_disallowed_category_denied` not `test_case_1`

## Known Limitations

1. **Tauri API Mocking** — Tests mock Tauri invocations; full end-to-end tests require running the full app
2. **Database Tests** — Payment and bridge tests use in-memory fixtures; database integration tests coming in Phase 2
3. **Real Bridge Tests** — iMessage, Calendar, Slack bridge tests require real system integration (in-progress)

## Debugging Tests

### Rust
```bash
# Run single test with output
cargo test payment::tests::test_deterministic_same_input_same_output -- --nocapture

# Run with backtrace on panic
RUST_BACKTRACE=1 cargo test

# Run with logging
RUST_LOG=debug cargo test
```

### React
```bash
# Debug single test
npm test -- AgentCard.test.tsx

# Debug with browser DevTools
npm test -- --inspect-brk

# Print DOM to console
import { screen } from '@testing-library/react';
screen.debug(); // Call in test to see current DOM
```

## Performance Baseline

Tests should complete quickly to encourage frequent runs:

| Suite | Target | Current |
|-------|--------|---------|
| Rust tests (payment, audit, bridge) | < 5s | ✅ |
| React tests | < 10s | ✅ |
| Full test suite | < 20s | ✅ |

If tests slow down, profile with:
```bash
cargo test -- --nocapture --test-threads=1  # Serial Rust tests
npm test -- --reporter=verbose              # Verbose React output
```

---

## Phase 2: Multi-Agent & System Calls

### system_assess — Direct Provider API (no OpenClaw session)

**Why:** `system_assess` bypasses OpenClaw entirely and calls provider APIs directly. It's the
backbone of forum brief assessment and any future internal coordination tasks. Its model-selection
and fallback logic must be airtight — a bug here silently falls back to keyword scoring without
the user knowing.

**Location:** `src-tauri/src/openclaw.rs` — `system_assess`, `call_anthropic_direct`,
`call_openai_direct`, `call_gemini_direct`

**Key decisions documented here:**

| Decision | What | Why |
|----------|------|-----|
| Provider priority | Gemini Flash Lite → Haiku → GPT-4o Mini | Cheapest available model wins |
| Key source | Global keychain only (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) | System calls aren't agent-specific |
| Model names (direct API) | Strip `google/` / `anthropic/` prefix before calling provider REST endpoints | Provider APIs use bare names, not OpenClaw-style `provider/model` strings |
| Gemini endpoint | `v1beta/models/{model}:generateContent?key=` | Key passed as query param, not header |
| No session storage | HTTP POST only, no session ID | Zero footprint — must never appear in any agent's chat history |

**Tests to add (Phase 2):**

```rust
#[cfg(test)]
mod system_assess_tests {
    // 1. key_priority_gemini_wins_when_all_keys_present
    //    Mock keychain: all three keys set → assert Gemini is called first
    //
    // 2. falls_back_to_anthropic_when_no_gemini_key
    //    Mock keychain: only ANTHROPIC_API_KEY → assert Anthropic called
    //
    // 3. falls_back_to_openai_when_only_openai_key
    //    Mock keychain: only OPENAI_API_KEY → assert OpenAI called
    //
    // 4. returns_error_when_no_keys_configured
    //    Mock keychain: empty → assert Err("no provider API keys configured")
    //
    // 5. gemini_provider_prefix_stripped
    //    call_gemini_direct("google/gemini-2.5-flash-lite", ...) → URL contains
    //    "gemini-2.5-flash-lite" not "google/gemini-2.5-flash-lite"
    //
    // 6. falls_back_to_next_provider_on_http_error
    //    Mock Gemini returns 429 → assert Anthropic is tried next
    //
    // 7. response_text_extracted_correctly_per_provider
    //    Anthropic: content[0].text  |  OpenAI: choices[0].message.content
    //    Gemini: candidates[0].content.parts[0].text
}
```

**Run tests (once written):**
```bash
cd canopy/src-tauri
cargo test system_assess_tests
```

### Forum Coordinator (forumCoordinator.ts)

**Why:** The coordinator calls `system_assess` and parses a structured JSON response. Parse
failures must fall back gracefully — a broken coordinator silently degrading to keyword scoring
is better than blocking the user from starting a project.

**Location:** `src/pages/ForumView/forumCoordinator.ts`

**Tests to add (Phase 2):**

```ts
// forumCoordinator.test.ts
//
// 1. assessForum_returns_keyword_fallback_when_system_assess_throws
//    Mock invoke("system_assess") → throws → scores should match scoreBrief output
//
// 2. assessForum_parses_valid_llm_response
//    Mock invoke returns well-formed JSON → scores have correct confidence/forumRole/rationale
//
// 3. assessForum_handles_partial_json_with_fence
//    Mock returns ```json {...}``` wrapped response → still parses correctly
//
// 4. assessForum_isolated_agents_never_volunteer
//    agents = [{...isolated: true}] → all isolatedScores have volunteers: false
//
// 5. assessForum_sorts_volunteers_first
//    Mix of confidence 80 (non-volunteer) and 40 (volunteer) → volunteer sorts first
//
// 6. assessForum_empty_agents_returns_empty
//    agents = [] → { scores: [], isolatedScores: [], tags: [...] }
//
// 7. parseCoordinatorResponse_rejects_unknown_agent_ids
//    JSON contains agentId not in provided agents list → filtered out, returns null
```

**Run tests (once written):**
```bash
cd canopy && npm test -- forumCoordinator.test
```

---

**Last Updated:** May 20, 2026
**Test Coverage:** Phase 1 Critical Path (100%) · Phase 2 specs documented, implementation pending
**Next Phase:** Phase 2 — system_assess unit tests, forum coordinator tests, multi-agent handoff
# Refactor Regression Gate

For behavior-preserving refactors, run the repeatable gate from the Canopy app directory:

```bash
cd canopy
./scripts/refactor_regression_check.sh
```

This runs frontend Vitest tests, the production build, Rust `cargo check`, Rust `cargo test`, and the mobile TypeScript check. Browser journeys are optional because they require the local dev server and Playwright browsers:

```bash
cd canopy
RUN_E2E=1 ./scripts/refactor_regression_check.sh
```

Workspace-file integration tests use `CANOPY_DATA_DIR` in tests so they can write to temp directories instead of the real app data directory.
