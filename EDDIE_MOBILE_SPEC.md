# Eddie Mobile — Spec

Research-only pass, no code changes. Grounded in the actual Canopy desktop codebase (`canopy/`), the existing `canopy-admin` server, and the existing `canopy-mobile` Expo app. The single biggest finding: **a secure mobile companion app already exists and already pairs with the desktop over an encrypted LAN channel.** Eddie Mobile should be built as new commands on that existing channel, not as a new HTTP server. Section 2 explains why.

---

## 1. What Eddie does on desktop today

Eddie ("Eddy" in code, "the Keeper") is a **chat-based setup/diagnostics assistant**, not an autonomous monitoring daemon. There is no background process today that watches logs and reacts on its own — everything is either user-initiated (opens a panel, clicks a button) or triggered by a chat question.

### Surfaces
- `src/components/Keeper/KeeperPanel.tsx` — the pill (bottom-right) + slide-up chat panel. Present on every view except `canopy` (the 3D world) and `onboarding`, which have their own Eddy surface.
- `src/components/World/EddyCorner.tsx` — a fixed, non-rotating 3D "reef cave" bottom-left of the Canopy world view. Clicking it fires `canopy:open-keeper`, which opens the same `KeeperPanel`.
- Both surfaces are one Eddy, not two separate assistants.

### Modes (`src-tauri/src/canopy_helper.rs`)
Four modes, chosen by the user in the panel's settings gear: `bootstrap` (Canopy-funded, onboarding-only, hits `canopy-admin`'s `/api/canopy-helper/bootstrap`), `provider` (uses the user's own connected/dedicated key, direct from the Mac), `local` (Ollama on-device), `offline` (no model — rule-based fallback only). `resolve_mode()` auto-upgrades from bootstrap to provider the moment a real key exists.

### Context payload Eddy sees
`useKeeperContext()` in `KeeperPanel.tsx` assembles: `runtime_ready` (gateway up/down), `active_view`, onboarding step, per-agent `{name, status, paused, isolated, model, integrations, slack_paired}`, and `provider_health[]`. Slack pairing is read per-agent from the keychain (`agent_{id}_slack_paired`). This is capped, sanitized server-side too — `sanitize_context()` / `sanitize_bootstrap_context()` in `canopy_helper.rs` strip raw logs, credentials, permissions, agent instructions, and conversation history before anything leaves the process, with unit tests enforcing it.

### Provider health preflight (`src-tauri/src/model_health.rs`)
`check_model_health` makes a **real 1-output-token generation call** per provider (Anthropic/OpenAI/Gemini/xAI) because key-listing endpoints can't surface quota exhaustion. Maps HTTP codes to states:
- `200` → `ok`
- `401`/`403` → `invalid_key`
- `429` → `rate_limited`
- `404` → `model_unavailable`
- other → `error`

This is the existing, working version of "detect a dead provider key" — it's exactly the 429/quota and invalid-key detection the task description asks for, already built and tested (`model_health.rs` tests assert error messages never leak provider response bodies).

### Offline rule-based diagnosis (`offlineDiagnosis()` in `KeeperPanel.tsx`)
When no model is reachable, Eddy falls back to a deterministic decision tree over the context payload: runtime down → tell user to open OrbStack; named agent + Slack/GitHub/Telegram/Discord/Google question → integration-specific guidance; named agent in `error` or `paused` state → point at Diagnostics; provider `rate_limited`/`invalid_key` → explain it's the provider's limit, suggest wait/upgrade/switch model; generic errored agent → point at Diagnostics. Replies can carry an `<ACTION>{"type":"navigate"|"view",...}</ACTION>` directive that the UI strips and turns into a "Take me there" button, which navigates and pulse-highlights the relevant control (`runKeeperAction`, `highlightByText`).

**Eddy only ever guides a human to click something.** It has no tool-call ability to change settings or restart anything itself today.

### The remediation actions that *do* exist (all manual, all human-triggered)
These are the real levers Eddie Mobile would need to expose remotely. None of them run autonomously today.

| Action | Where | What it does |
|---|---|---|
| `ping_agent_routing` | `DiagnosticsTab.tsx` → openclaw.rs | Sends a test message, checks for a reply |
| `ping_agent_browser` | same | Checks the agent's dedicated Chromium/CDP process |
| `ping_agent_connections` | same | Per-integration live auth check (Slack `auth.test`, etc.) |
| `repair_openclaw_config` | `src-tauri/src/audit_openclaw.rs:248` | Guarded by a `REPAIR_RUNNING` atomic (concurrent runs would double-restart into an OOM cascade). Writes `agents.defaults.model.primary`, `gateway.trustedProxies`, `gateway.controlUi.allowedOrigins`, `channels.slack.groupPolicy`. **Preserves the current model if it's already valid and has a key** — it no longer blindly stomps a user-chosen model (a prior bug). OpenClaw self-SIGTERMs and restarts after a config write. This is the real "re-apply model config fix" the task asked for. |
| `repair_gateway` | `src-tauri/src/openclaw.rs:5343` | Per-agent, 6-step: Docker daemon reachable → gateway container running → ... → diagnostics. Returns a step-by-step log string. |
| `stop_machine_browser` / `start_machine_browser` | `DiagnosticsTab.tsx` | Kill + relaunch one agent's dedicated Chromium. `start_machine_browser` is idempotent (kills any existing instance first), which is why the UI calls stop-then-start rather than a single "restart" (a prior bug: "restart" used to be stop-only and looked broken). |
| `hard_reset_infrastructure` | `src-tauri/src/docker.rs:1904` | **Nuclear option.** Stops/restarts the whole OrbStack Linux VM, waits up to 15s for the Docker socket, regenerates `docker-compose.yml`, brings the gateway back up. Affects every agent at once. |
| `scripts/reconcile_isolated_containers.sh` | standalone shell script, **not wired into the UI at all** | Finds isolated agent containers whose DB record says `isolated=0` or no longer exists, but which are still running (because teardown is a best-effort `docker compose down` and the compose sets `restart: unless-stopped`, so a failed teardown becomes a permanent zombie). Report-only by default; `--apply` removes them. |

### Documented failure modes already fought in code (comments in `docker.rs`)
- **SIGUSR1 crash loop for isolated containers**: `SIGUSR1` hot-reloads OpenClaw's JSON config, not its JS. Isolated containers boot with a minimal `openclaw.json`; a hot-reload against that minimal config fails strict validation in OpenClaw 2026.5.26+, crashing the process, which Docker restarts, which re-triggers the signal path → loop. Fix already in place: isolated containers are never sent `SIGUSR1`; they pick up patches on their next natural restart instead.
- **Chromium `/dev/shm` OOM crash-loop storm**: default Docker `/dev/shm` (64MB) crashes Chromium immediately; the browser plugin then respawned ~50 instances in 53 seconds (2700 PIDs, 8GB RAM) before `shm_size: 2gb` was added to the compose file.
- **PID exhaustion**: `deploy.resources.limits.pids: 1000` acts as a circuit breaker against exactly that kind of spiral.
- **Memory ceiling**: gateway capped at 4G (2× realistic peak) so the OrbStack VM's OOM killer never fires; `canopy-chroma` (the vector memory-search DB) capped at 512MB.
- **`crash_guard.cjs`**: injected via `NODE_OPTIONS=--require` to catch `uncaughtException`/`unhandledRejection` and log instead of letting the container die.

### The gap
Everything above is **pull-based**: a human has to open the Diagnostics tab, ask Eddy a question, or notice something's wrong. Nothing tails logs continuously, nothing auto-restarts on a known-bad signature, and there is no notification path when the user is away from the Mac. That gap is what Eddie Mobile is for.

---

## 2. Mobile architecture

### Critical existing infrastructure: `canopy-mobile` already exists

Before designing anything new: `/Users/scottieryan/Documents/Claude/Projects/Agent Management/canopy-mobile` is a working Expo app (portfolio-preview status) that **already does exactly the "lightweight server + mobile client over LAN" pairing the task envisioned** — just for chat/forums/inbox, not health. Building Eddie Mobile as a brand-new plaintext HTTP server on the Mac Mini would be a regression against what's already shipped. Reuse it.

**Desktop side** — `src-tauri/src/dispatch.rs` (1679 lines):
- `DispatchState` holds the pairing token and a `broadcast` channel for pushing live updates to connected clients.
- `start_websocket_server()` runs a `tokio-tungstenite` WS server on the Mac (loopback/LAN-bound; `dispatch::generate_pairing_token` mints the `{token, ip, port}` QR payload).
- **Handshake**: server sends a random `auth_challenge`; client proves possession of the pairing token via HMAC-SHA-256 (`auth_proof`) — the token itself never crosses the wire. Server then derives a per-session key via HKDF-SHA-256 (`derive_dispatch_key`).
- **Transport encryption**: every message after auth is ChaCha20-Poly1305 sealed (`DispatchEncryptor`/`DispatchDecryptor`), constant-time comparisons throughout (`constant_time_token_eq`), replay protection via directional counters (per `canopy-mobile` README).
- **Two access tiers**, already modeled:
  - `AuthorizedClient::legacy_full_access()` — `experience: "full"`, no `allowed_agent_ids` restriction. This is **the owner's own device**.
  - Scoped **companion grants** (`create_companion_pairing`) — `profile_type` ∈ `child|adult|guest`, `experience` ∈ `focused|learning` **only** (the validator explicitly rejects `"full"` for companions — see `validate_companion_pairing_request`, `dispatch.rs:88`), `allowed_agent_ids` allowlist enforced by `AuthorizedClient::can_access_agent()`.
- The RPC loop (`handle_connection`, `dispatch.rs:805`) is a single `match req.command.as_str()` with existing arms: `list_agents`, `get_chat_history`, `ping`, `list_companion_resources`, `companion_resource_action`, `list_forums`, `list_projects`, `list_inbox`, `send_message`, `resolve_inbox_item`, `set_sensor_token`.

**Mobile side** — `context/DispatchContext.tsx`:
- `WebSocket` to `ws://{ip}:{port}`, same challenge/proof/encrypt flow, `subscribe(msgType, cb)` pub-sub for push updates, exponential-backoff reconnect (2s → 60s, 10 tries), 30s ping / 10s pong timeout, and — important for push design (§6) — explicit handling of iOS suspending the socket in background with reconnect-on-foreground.
- Repo already has `expo-camera` (QR scanning), `expo-secure-store` (pairing data + counters), `expo-router` tab/stack structure (`app/(tabs)/*`, `app/chat/[id].tsx`, `app/live/[id].tsx`).

### Recommendation: extend the existing channel, don't build a new one

1. **Don't open a new HTTP server on the Mac Mini.** The README is explicit that the current dispatch server is scoped to a trusted local network and isn't hardened for broader exposure. A second, separate HTTP surface would duplicate the auth/crypto work already done and widen the attack surface for no benefit.
2. **Add new RPC command arms to `dispatch.rs`'s existing `match`** (e.g. `eddie_health`, `eddie_agent_status`, `eddie_restart_agent`, `eddie_repair_config`, `eddie_clear_session`, `eddie_tail_logs`, `eddie_fix_all`) instead of REST routes. Same encrypted WebSocket, same pairing flow, same QR-scan UX the app already has.
3. **Gate every Eddie command behind `AuthorizedClient::is_full_access()`.** A companion/child/guest pairing must never be able to restart a container, patch gateway config, or read logs — those pairings are explicitly scoped to chat/forums/inbox today, and remediation actions have real blast radius (§7). This is a one-line guard per new match arm, consistent with how `can_access_agent()` is already used to scope `send_message`.
4. **Put the actual health/remediation logic in a new Rust module** (e.g. `src-tauri/src/eddie_mobile.rs`) rather than inline in `dispatch.rs`, and expose it two ways: as `#[tauri::command]`s (so the *desktop* `KeeperPanel` can eventually call the same functions instead of duplicating diagnosis logic) and as the new dispatch RPC arms (for mobile). Single source of truth for "what's wrong and what can we do about it."
5. **Reachability when away from home Wi-Fi**: the dispatch server binds to a LAN address; today the phone must be on the same network. The lowest-risk way to reach it remotely is **Tailscale on the Mac Mini + Tailscale on the phone**, then pointing the existing pairing `{ip, port}` at the Mac's Tailscale IP (or MagicDNS name) instead of its LAN IP. No new server, no new auth model — same HMAC/ChaCha20 handshake, just a different (still private, WireGuard-encrypted) network path. This should be an explicit opt-in toggle in the pairing flow, not silently expanded, since it does widen the trust boundary from "same Wi-Fi" to "same tailnet."

---

## 3. API surface (implemented as authenticated dispatch RPC commands, not raw HTTP)

Presented below in the REST shape the task asked for, with the actual RPC mapping next to each — all require `is_full_access()`.

| Conceptual endpoint | Dispatch RPC command | Backing logic |
|---|---|---|
| `GET /health` | `eddie_health` | New aggregator: `model_health::check_model_health(None,...)` for provider status + `docker inspect` / `get_container_status` for `canopy-gateway`, `canopy-chroma`, and each isolated container, plus last-known error per agent from the DB's audit log |
| `GET /agents` | `eddie_agent_status` | Per-agent `{name, status, paused, isolated, model, integrations, slack_paired, last_active}` — mostly what `useKeeperContext()` already assembles server-side today, minus the browser-only bits |
| `POST /agents/:id/restart` | `eddie_restart_agent {agentId}` | `get_agent_container_name(db, agent_id)` → `docker restart <container>` (isolated container) or `canopy-gateway` for shared agents |
| `POST /gateway/patch-models` | `eddie_repair_config` | Thin wrapper around existing `repair_openclaw_config` (already has the `REPAIR_RUNNING` guard — reuse it, don't reimplement) |
| `POST /agents/:id/clear-session` | `eddie_clear_session {agentId}` | **Does not exist today** — needs new work. Closest existing primitive is the `session_id()` derivation in `dispatch.rs` (`companion_{device}_{agent}`), but there's no OpenClaw-side "abort in-flight tool call" API yet. Scope this as new backend work, not a wrapper. |
| `GET /logs/:container` | `eddie_tail_logs {container, lines}` | `docker logs --tail N <container>`, then run the result through a `sanitize_*`-style redaction pass (reuse the allowlist/truncation pattern from `canopy_helper.rs::sanitize_context`) before it ever reaches the wire — raw logs currently never leave the Mac (Eddy's own context payload explicitly excludes them), and that invariant should hold for mobile too |

`eddie_fix_all` (backing the mobile "Fix all" button, §4/§7) is a sequencing command, not a new capability — it just calls the above in order and reports per-step results.

---

## 4. Expo mobile UI screens

Fits the app's existing `expo-router` structure (`app/(tabs)/*` for top-level tabs, `app/chat/[id].tsx` / `app/live/[id].tsx` for detail routes) rather than inventing a new navigation pattern.

- **`app/(tabs)/health.tsx`** — new tab, agent health dashboard. One row per agent: red/yellow/green dot (red = `status === "error"` or container not running; yellow = `rate_limited`/`invalid_key` on its provider or `paused`; green = everything checked out), last-active time, one-line last error. Gateway/Chroma container rows above the agent list since a dead gateway explains every agent going red at once — mirrors how `offlineDiagnosis()` already leads with `runtime_ready` before anything agent-specific.
- **`app/eddie/[agentId].tsx`** — agent detail: recent log tail (`eddie_tail_logs`), last error with timestamp, action buttons (Restart, Clear session, Ask agent to self-diagnose — the last one can literally reuse `send_message` with the same structured self-diagnostic prompt `DiagnosticsTab.tsx::handleAskAgent` already sends).
- **`app/eddie/history.tsx`** — incident history: what Eddie detected and what it did about it (§7's audit trail), newest first, filterable by agent.
- **Quick actions**: a "Fix all" button on the health dashboard, wired to `eddie_fix_all` (§3), running the auto-safe playbook items in order (§7) and streaming per-step status back over the same subscribed channel `DispatchContext.subscribe()` already supports.
- Auth/pairing screen: none needed — reuse the existing QR-scan pairing flow verbatim. Eddie is a new set of commands available *after* pairing, not a new pairing type, as long as the device paired at `experience: "full"`.

---

## 5. Detection rules

| Pattern | Signal | Existing detection | Gap to close |
|---|---|---|---|
| **429 / quota exhausted** | Provider returns HTTP 429 on the 1-token preflight | `model_health.rs::status_from_http` → `rate_limited` — already exact | None — reuse as-is |
| **Invalid/revoked key (`account_inactive`)** | 401/403 on preflight | `status_from_http` → `invalid_key` — already exact | None for keys. A Slack/Google *token* revocation (not an API key) isn't covered by `check_model_health` — that needs `ping_agent_connections`' per-integration check surfaced continuously, not just on-demand |
| **`startup_failed`** | Gateway or agent container never reaches "running" | `repair_gateway`'s step 2 (`docker inspect -f {{.State.Running}}`) and `wait_for_gateway_ready` in `openclaw.rs` | Needs to run on a timer/watch instead of only when a human opens Diagnostics or hits Send |
| **`canopy-gateway` container not running** | `docker inspect` state | `get_container_status` (`docker.rs:304`) already lists all `com.canopy.managed=true` containers, but `health` field is a hardcoded `"healthy"` TODO — not real yet | Wire up the actual healthcheck status (compose already defines one: `curl -f http://localhost:18789/status`, 30s interval) instead of the stub |
| **`memory_search` hung >120s** | Chroma vector-search call never returns | Not detected anywhere today — `canopy-chroma` has a memory cap but no call-level timeout | New: wrap memory-search calls with a timeout; on timeout, treat as an incident and offer restarting the `canopy-chroma` container (isolated blast radius — safe) |
| **SIGUSR1 crash loop (isolated containers)** | Container repeatedly restarting after a config hot-reload signal | Already prevented at the source (isolated containers are never sent `SIGUSR1` — see `docker.rs:1736` comment) | Detection-as-defense-in-depth: watch restart count/frequency per container (`docker inspect .RestartCount` deltas) in case the guard is ever bypassed or a different signal causes the same loop |
| **Browser/Chromium crash-loop spawn storm** | PID count for a container approaching the `pids: 1000` ceiling, or many short-lived Chromium processes | Root cause fixed (`shm_size: 2gb`), but nothing watches for a *recurrence* | New: alert if a container's PID count crosses a threshold (e.g. 700/1000) well before the hard `pids` limit kills things |
| **Zombie isolated container** | Container labeled `com.canopy.type=isolated` whose agent is deleted or de-isolated in the DB, but still running (failed `docker compose down` + `restart: unless-stopped`) | `scripts/reconcile_isolated_containers.sh` — logic exists but is a standalone script, not wired into any runtime check | New: run the script's detection query (not its removal) on the health timer; report as an incident rather than auto-removing (see §7 — removal stays approve-only) |

---

## 6. Push notification strategy

Two layers, because the existing transport has a real limitation the mobile README already documents: **iOS suspends the WebSocket when the app backgrounds**, so `DispatchContext`'s live `subscribe()` push only works while Eddie Mobile is foregrounded (or briefly backgrounded before iOS kills the socket).

1. **While the app is open (foreground/near-foreground) and on the same network/tailnet**: reuse the existing `updates` broadcast channel in `DispatchState` — the desktop already has this pattern for `assignment_updated` events. Eddie's health module publishes an `incident_detected` event the moment a detection rule fires; connected mobile clients get it instantly via the already-encrypted channel, no new infra.
2. **While the app is backgrounded/killed, or the phone is off the tailnet entirely**: this needs real OS push (APNs for iOS / FCM for Android), which requires *something* reachable from the public internet to hold a device push token and fire the notification — the LAN-only dispatch server cannot do this by design. `canopy-admin` (the existing cloud server that already talks to Gemini/Anthropic for the bootstrap Eddy path) is the natural place for this relay: the desktop app registers the device's push token with `canopy-admin` once (during pairing), and on a **high-severity** incident (gateway down, all agents red) the desktop calls a new `canopy-admin` endpoint to fire the push, rather than the phone polling anything. Keep this path minimal and rare — it only needs to carry "something's wrong, open Eddie" plus a severity/agent-name string, never logs or credentials, mirroring the same context-minimization discipline `canopy_helper.rs::sanitize_bootstrap_context` already applies to the bootstrap path.
3. Practical severity split so the cloud relay isn't spammy: a single rate-limited key or one paused agent → in-app/LAN push only (layer 1); gateway unreachable, `hard_reset_infrastructure` about to be needed, or 3+ agents red at once → also fire the cloud push (layer 2).

---

## 7. Remediation playbooks

Grounded in what actually broke recently (missing model config, quota errors, revoked tokens) plus documented history (boot loops, browser stream drops, SIGUSR1 crash loops). Split by blast radius — this determines auto vs. approve, not by how annoying the error is.

| Error pattern | Auto (no approval) | Requires approval | Why |
|---|---|---|---|
| Missing/invalid model in gateway config | ✅ `eddie_repair_config` (→ `repair_openclaw_config`) | — | Already the documented, idempotent, UI-triggered fix; preserves a valid existing model rather than overwriting it; guarded against concurrent runs |
| 429 rate-limited provider key | — | Notify only; **switching the agent's model/provider** requires approval | Provider-side limit, not fixable by Canopy; changing the user's chosen provider is a real decision, not a repair |
| Invalid/revoked key or `account_inactive` | — | Notify only, deep-link to Integrations | Needs a new secret from the user — nothing to automate |
| `startup_failed` / container not running | ✅ one bounded auto-retry (`eddie_restart_agent` or `repair_gateway`), rate-limited to roughly the same "no concurrent repairs" discipline `REPAIR_RUNNING` already enforces | Second failure within the window → escalate to approval before trying `hard_reset_infrastructure` | A single restart is low-risk and often fixes a transient Docker hiccup; repeated restarts without human awareness risk masking a real problem or, per the SIGUSR1 history, causing a restart loop |
| Browser/CDP hung | ✅ `stop_machine_browser` → `start_machine_browser` | — | Already the exact idempotent, low-risk sequence the desktop Diagnostics tab runs today |
| `memory_search` hung >120s | ✅ restart `canopy-chroma` container | — | Isolated single-purpose container; restarting loses no agent state (vector index persists on its volume) |
| Zombie isolated container detected | Notify + list the zombie | ✅ removal requires approval | The reconciliation script itself defaults to report-only for a reason — misidentifying a container to remove is destructive and the identification logic, while solid, has never been run unattended in production |
| Everything red / gateway down | — | ✅ `hard_reset_infrastructure` always requires approval, never auto | Restarts the entire OrbStack VM and every agent at once — the single highest blast-radius action in the system |

**"Fix all" button** runs the auto-safe rows in a fixed order — `eddie_repair_config` → per-agent `eddie_restart_agent` for anything still down → browser restart → Chroma restart — skipping anything flagged approval-required, then reports a per-step result list (mirrors `repair_gateway`'s existing step-log string style). Every action Eddie takes, automatic or approved, gets written to the incident history (§4) so the "what did Eddie do while I was out" question always has a real answer instead of a black box.
