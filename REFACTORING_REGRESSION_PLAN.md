# Canopy Refactoring Regression Plan

This plan is the refactor guardrail for the Canopy desktop app and Canopy mobile app. It focuses on preserving end to end behavior while the large files called out in the PRD and developer guide are split into smaller modules.

## Refactor Goals

- Preserve the zero-trust credential model: agent integrations use per-agent keys only, especially Slack and other third-party access.
- Split oversized modules without changing user-visible behavior.
- Keep Tauri command boundaries explicit, validated, rate limited where expensive, and covered by regression tests.
- Keep mobile chat, note capture, inbox actions, and forum/project sync behavior stable while dispatch code is extracted.
- Keep forum orchestration, trust-budget accounting, and generated UI rendering safe during frontend refactors.

## Phase Plan

### Phase 0: Freeze Behavior

Status: implemented.

- Run the current regression suite before each refactor slice.
- Add focused tests for security and product invariants before moving code.
- Capture manual smoke notes for flows that are not yet fully automatable.
- Avoid deleting test files or legacy fixtures until the team explicitly confirms they are obsolete.

Required gate:

```bash
cd canopy
./scripts/refactor_regression_check.sh
```

Optional browser gate:

```bash
cd canopy
RUN_E2E=1 ./scripts/refactor_regression_check.sh
```

### Phase 1: Extract Pure Helpers

Status: in progress.

Start with helpers that have no side effects:

- Validation helpers in `src-tauri/src/channels.rs`, `dispatch.rs`, and `openclaw.rs`.
- Forum selectors, budget math, and message filters in `src/pages/ForumView`.
- `ConnectionsTab.tsx` presentational subcomponents and data mappers.

Rules:

- Move code first, then rename.
- Keep exported function signatures stable until tests are green.
- Add unit tests for each extracted helper before wiring it into larger commands.

Completed June 2, 2026:

- `src/store/forumBudget.ts` now owns pure forum trust-budget math.
- `src-tauri/src/channels.rs` has tested GitHub token validation.
- `src-tauri/src/dispatch.rs` has tested mobile system-command and message validation helpers.
- `src-tauri/src/keychain.rs` has tested IPC secret-key allowlist validation.

### Phase 2: Split `openclaw.rs`

Status: started.

Target modules:

- `openclaw/mod.rs`: public exports and shared types.
- `openclaw/agent_lifecycle.rs`: create, update, delete, list agents.
- `openclaw/conversations.rs`: send message, history, session routing.
- `openclaw/workspace.rs`: safe file and workspace operations.
- `openclaw/integrations.rs`: skills, capabilities, channel sync.
- `openclaw/config.rs`: gateway config and model defaults.
- `openclaw/docker.rs`: Docker command construction and timeout wrappers.

Completed June 2, 2026:

- `src-tauri/src/openclaw/workspace_files.rs` now owns workspace file Tauri commands:
  - `read_workspace_file`
  - `write_workspace_file`
  - `upload_workspace_file`
  - `copy_file_to_workspace`
  - `read_workspace_file_base64`
- `openclaw.rs` re-exports those commands to preserve existing invoke handlers and tests.
- `lib.rs` invoke handler entries use `openclaw::workspace_files::*` directly because Tauri command macro metadata is tied to the defining module path.
- `get_agent_workspace_dir()` remains in `openclaw.rs` until workspace path resolution can be moved without forcing Docker/GitHub/terminal history churn.
- `CANOPY_DATA_DIR` can override the host data directory for tests; production uses `dirs::data_dir()` when no override is present.
- Emergency follow-up: API-key sync helpers now consider both shared and isolated OpenClaw state dirs via `agent_state_dirs()`. This prevents isolated agents from being skipped when writing keychain-derived `auth-profiles.json`.
- Emergency follow-up: `list_agents` now fills blank SQLite `active_model` values from OpenClaw config before returning agents to the UI.

Regression focus:

- Agent create/update/delete still round trips through the UI.
- Mobile `send_message` uses the individual chat session and does not mix forum sessions.
- Workspace file operations reject unsafe paths.
- Docker commands use validated arguments and bounded timeouts.

### Phase 3: Split `ConnectionsTab.tsx`

Target pieces:

- `connections/ProviderCards.tsx`
- `connections/ConnectionModals.tsx`
- `connections/OAuthCompanionLinks.ts`
- `connections/useConnectionStatus.ts`
- `connections/useAgentCredentials.ts`

Regression focus:

- Onboarding and Connections tab always pass explicit `agentId` to companion windows.
- Slack, Telegram, GitHub, Google, and web credentials store under per-agent keys.
- Missing per-agent credentials leave an agent disconnected instead of inheriting globals.

### Phase 4: Split Forum Runtime

Target pieces:

- Store actions and selectors from `forumStore.ts`.
- Orchestrator phases from `forumOrchestrator.ts`.
- GenUI rendering and artifact sync helpers from view components.

Regression focus:

- Clicking Forums clears `activeForumId` and shows the list first.
- Trust budget token and USD accounting trips the circuit breaker.
- Forum orchestrator falls back cleanly when OpenClaw fails.
- Custom HTML renders only inside a sandboxed iframe.

### Phase 5: Mobile Dispatch Contract

Target pieces:

- Pairing/auth helpers.
- RPC request parser.
- Mobile system command allowlist.
- Agent message validation and rate limit checks.

Regression focus:

- Pairing token auth still rejects unauthenticated clients.
- System commands only allow known mobile shortcuts.
- Agent messages validate agent IDs and message size.
- Chat history filters forum orchestration prompts.

## Test Matrix

| Area | Test Type | Coverage |
| --- | --- | --- |
| Backend validation | Rust unit | IPC secret keys, GitHub token characters, mobile command allowlist |
| Backend safety | Rust integration | Injection payloads, workspace path safety, authorization, rate limits |
| Frontend store | Vitest | Forum persistence, budget accounting, circuit breaker state |
| Frontend security | Vitest | GenUI iframe sandbox, attachment source rewriting |
| Desktop build | Vite build | TypeScript and production bundle compatibility |
| Tauri backend | Cargo check/test | Rust compilation and command behavior |
| Mobile app | TypeScript | Route and payload type safety |
| Product journeys | Playwright optional | Agent setup, messaging, forums, edge cases |

## End To End Smoke Checklist

Run these manually after each large phase until the Playwright journeys are updated to match the current Tauri shell:

- Create an agent, edit it, and delete it.
- Configure a per-agent GitHub token and verify the workspace `.github_env` is agent scoped.
- Configure Slack for one agent and verify another agent remains disconnected unless it has its own token.
- Pair mobile, send an agent message, capture a note, and resolve an inbox item.
- Start a forum, wait for one agent message, verify budget usage changes, then return to the Forums list from top nav.
- Render a forum artifact with custom HTML and verify it appears in the iframe, not in the parent DOM.

## Refactor Rules

- Every refactor slice must be behavior preserving unless the PRD explicitly calls for a behavior change.
- No broad rewrites while security-sensitive code is being moved.
- No deletion of test files, fixtures, scripts, or legacy suites without explicit confirmation.
- New commands must validate input at the Tauri boundary and return typed errors when practical.
- Any shell or Docker command change must include injection-payload tests or reuse an already tested helper.
- Keep `openclaw.rs` as the module root until intentionally moving it to `openclaw/mod.rs`; while `openclaw.rs` exists, add submodules under `src-tauri/src/openclaw/*.rs` and declare them from `openclaw.rs`.
- For Tauri commands moved into submodules, update `tauri::generate_handler!` to the concrete defining path. Do not rely on `pub use` re-exports for command handler entries.
