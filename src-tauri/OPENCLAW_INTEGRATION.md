# OpenClaw Integration — Known Failure Modes & Config Reference

This document captures every non-obvious configuration detail that has caused Canopy agents
to stop communicating. Read this before modifying anything in `openclaw.rs`, `audit_openclaw.rs`,
`slack.rs`, `docker.rs`, or `model_constants.rs`.

Last verified against: **OpenClaw 2026.5.26 / Node 24.14.0** inside OrbStack (arm64)

---

## 1. Model String Format

### The rule

OpenClaw model identifiers follow a strict `"provider/model-name"` format. The model family
name always comes **before** the version suffix — never after.

```
✅  anthropic/claude-sonnet-4-6      (family "sonnet" then version "4-6")
❌  anthropic/claude-4-6-sonnet      (version before family — WRONG, causes silent failure)

✅  google/gemini-2.5-flash
✅  google/gemini-3.1-pro-preview    (confirmed working Apr 2026)
❌  google/gemini-3-flash-preview    (NOT confirmed in LiteLLM runtime — causes retry loop)
```

### Why it matters

When OpenClaw receives an unknown model string via `openclaw config set agents.defaults.model`,
it either errors silently or falls back to a model you have no key for. The agent appears to
exist and receive messages but never responds.

### Model must be an object — CRITICAL

OpenClaw requires the model to be a nested object, not a bare string:

```json
// ✅ Correct
"agents": { "defaults": { "model": { "primary": "google/gemini-3.1-pro-preview" } } }

// ❌ Wrong — silently ignored, agent has no model and never responds
"agents": { "defaults": { "model": "google/gemini-3.1-pro-preview" } }
```

When writing model values in JavaScript config patches, use:
```javascript
c.agents.defaults.model = {primary: 'google/gemini-3.1-pro-preview'};   // ✅
c.agents.defaults.model = 'google/gemini-3.1-pro-preview';               // ❌
```

When using `openclaw config set`, use the dotted-path syntax to produce the nested object:
```bash
openclaw config set agents.defaults.model.primary "google/gemini-3.1-pro-preview"
# ↑ This creates {"agents":{"defaults":{"model":{"primary":"..."}}}}
```

### The source of truth

All model strings are defined in `src/model_constants.rs`. **Do not hardcode model strings
anywhere else in the codebase.** When model versions change, update `model_constants.rs` and
run `cargo test model_constants` to validate the change.

### Confirmed working Gemini models (Apr 2026)

| Model | Status | Notes |
|---|---|---|
| `google/gemini-3.1-pro-preview` | ✅ Confirmed | Only Gemini 3.x confirmed in LiteLLM runtime |
| `google/gemini-2.5-flash` | ✅ Stable GA | Shutdown June 2026 |
| `google/gemini-2.5-pro` | ✅ Stable GA | Shutdown June 2026 |
| `google/gemini-3.1-flash-lite-preview` | ⚠️ Unconfirmed | Causes retry loop at startup |
| `google/gemini-2.0-flash` | ❌ Deprecated | Shutdown June 1 2026 |

### Updating for new model releases

1. Update the relevant constant in `model_constants.rs`
2. Run `cargo test model_constants::tests::all_default_constants_pass_validation`
3. Run `cargo test model_constants::tests::anthropic_model_string_has_correct_order`
4. Nothing else needs to change — all call sites import from `model_constants`

---

## 2. Gateway Auth

### The one token field

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "canopy_internal_token_2026"
    },
    "mode": "local",
    "port": 18789
  }
}
```

`gateway.auth.token` is the only field needed. The CLI reads `gateway.auth.token` from the
shared `openclaw.json` and uses it to authenticate both sides of the local connection.

### ⚠️ `gateway.token` is NOT a valid field

`gateway.token` (top-level, not nested under `auth`) is **not recognised** by OpenClaw
2026.4.14 and causes an immediate config validation failure:

```
Config invalid
File: ~/.openclaw/openclaw.json
Problem:
  - gateway: Unrecognized key: "token"
```

This crashes the container into a restart loop. Do not write `gateway.token` anywhere —
not in Rust config writes, not in JavaScript `node -e` patches, not via `openclaw config set`.

### What "pairing required" means

If you see:
```
gateway connect failed: GatewayClientRequestError: pairing required
Gateway agent failed; falling back to embedded
```

This means the CLI could not authenticate to the gateway. OpenClaw falls back to **embedded
mode** — running inference directly instead of routing through the gateway. This works (the
agent will respond) but spawns a full LiteLLM Node.js process per call (~150 PIDs). Under
PID pressure this can fail. The fix is ensuring `gateway.auth.mode` and `gateway.auth.token`
are correctly set in `openclaw.json` before the container starts.

### Testing gateway auth inside the container

```bash
docker exec -u node -e NODE_OPTIONS=--v8-pool-size=1 canopy-gateway \
  openclaw agent --agent <id> --message "ping" --json
```

Check stderr — `"gateway connect failed"` means auth isn't set. Verify with:

```bash
docker exec canopy-gateway cat /home/node/.openclaw/openclaw.json | python3 -m json.tool | grep -A5 '"auth"'
```

---

## 3. Gateway Port Mapping

### The mapping

```
Docker compose:   HOST 18799  →  CONTAINER 18789
                  (GATEWAY_HOST_PORT)  (GATEWAY_CONTAINER_PORT)
```

### Which port to use where

| Context | Port | Constant |
|---|---|---|
| Rust HTTP client calling the gateway from the host | **18799** | `GATEWAY_HOST_PORT` |
| `GATEWAY_URL` for reqwest calls | **18799** | `GATEWAY_URL` |
| Docker healthcheck (`curl` inside the container) | **18789** | — (literal in compose YAML) |
| `allowedOrigins` audit check | **18799** | `GATEWAY_HOST_PORT` |
| Port scan in `scan_local_agents` | **18799** | `GATEWAY_HOST_PORT` |

---

## 4. Auth-Profile Path

### Correct layout (OpenClaw expects)

```
/home/node/.openclaw/agents/{agent_id}/auth-profiles.json
```

### Wrong layout (previously in the code — DO NOT use)

```
/home/node/.openclaw/agents/{agent_id}/agent/auth-profiles.json
                                              ^^^^^^
                                              this extra subdir breaks everything
```

OpenClaw looks for `auth-profiles.json` directly inside the agent folder. The `agent/`
subdirectory comes from single-agent mode layout and does not apply in gateway (multi-agent) mode.

### How to build the path

Always use the helper from `model_constants.rs`:

```rust
use crate::model_constants::agent_auth_profile_path;
let filepath = agent_auth_profile_path(&agent_id);
// → "/home/node/.openclaw/agents/my-agent/auth-profiles.json"
```

---

## 5. `uv_thread_create` Crash — NODE_OPTIONS Fix

### The crash

```
node[2583]: std::unique_ptr<...> node::WorkerThreadsTaskRunner::DelayedTaskScheduler::Start()
  at ../src/node_platform.cc:109
# Assertion failed: (0) == (uv_thread_create(t.get(), start_thread, this))
```

### Root cause

Node.js creates 4 worker threads at startup (derived from `cpus: '4.0'` in docker-compose).
Under PID pressure inside the container (near the 500 PID limit), `pthread_create` returns
`EAGAIN` and Node.js aborts.

The openclaw CLI is a thin IPC client — it does not need 4 worker threads. One is sufficient.

### Fix

Pass `NODE_OPTIONS=--v8-pool-size=1` via `docker exec -e` on **every** `openclaw` CLI
invocation inside the container:

```bash
docker exec -u node -e NODE_OPTIONS=--v8-pool-size=1 canopy-gateway \
  openclaw agent --agent <id> --message "hello" --json
```

In Rust, this means every `get_docker_command()` call that invokes openclaw must include:

```rust
get_docker_command()
    .args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway",
           "openclaw", ...])
```

**All 13 openclaw CLI invocations in `openclaw.rs` have this flag applied.** If you add
new `docker exec ... openclaw` calls, you must add `-e NODE_OPTIONS=--v8-pool-size=1` as well.

---

## 6. Orphaned Processes — Container-Side Timeout

### The problem

`tokio::time::timeout()` cancels the Rust future but does **not** kill the process running
inside the Docker container. Each timed-out `openclaw agents add` call leaves an orphaned
Node.js process consuming ~150-200 PIDs. Near the 500-PID limit, `docker exec` itself fails.

### Fix: container-side `timeout` binary

Wrap every long-running `openclaw agents add` call with the container's `timeout` binary,
set 5 seconds shorter than the Rust timeout:

```rust
let rust_timeout_secs: u64 = 180;
let container_secs = rust_timeout_secs.saturating_sub(5).to_string(); // "175"

tokio::time::timeout(
    std::time::Duration::from_secs(rust_timeout_secs),
    get_docker_command()
        .args([
            "exec", "-u", "node",
            "-e", "NODE_OPTIONS=--v8-pool-size=1",
            "canopy-gateway",
            "timeout", &container_secs,   // ← container binary kills on deadline
            "openclaw", "agents", "add", &id,
            "--workspace", &workspace_path,
        ])
        .output(),
)
.await
```

Exit code 124 from the container means the container-side `timeout` fired — treat it the same
as a Rust timeout (i.e., retry once):

```rust
let timed_out = match &result {
    Err(_) => true,
    Ok(Ok(o)) => o.status.code() == Some(124),
    _ => false,
};
```

### Fix: pkill orphan cleanup before registration

Before running `agents add`, kill any leftover `openclaw agents` processes from previous
boot cycles:

```rust
let _ = tokio::time::timeout(
    std::time::Duration::from_secs(5),
    get_docker_command()
        .args(["exec", "canopy-gateway", "sh", "-c",
               "pkill -f 'openclaw agents' 2>/dev/null; true"])
        .output(),
).await;
```

---

## 7. Config Validation — Known Valid and Invalid Fields

OpenClaw 2026.4.14 strictly validates `openclaw.json` on startup. Unrecognized keys cause:
```
[openclaw] Failed to start CLI
Config observe anomaly: openclaw.json (unrecognized-key: gateway.listen)
```

### INVALID fields (cause hard failure — do not write)

| Field | Notes |
|---|---|
| `gateway.token` | **Confirmed invalid in 2026.4.14** — causes crash-loop: "Unrecognized key: token". Auth uses `gateway.auth.token` only. |
| `gateway.listen` | Not a valid key — use `gateway.port` + `gateway.bind` |
| `gateway.provider` | Not valid |
| `gateway.model` | Not valid |
| `gateway.agents` | Not valid |
| `agents.defaults.embedding_provider` | Not valid in 2026.4.14 |
| `agents.list[i].env` | **Confirmed invalid in 2026.4.14** — causes "agents.list.0: Unrecognized key: 'env'" and the gateway refuses to load any agents. To set a per-agent env var use `openclaw agents edit <id> --env KEY=VALUE` (the CLI knows the schema-valid storage path). Do NOT write `env` directly into `openclaw.json` via `node -e` or `config set`. |
| `channels.slack.groupPolicy: "allowall"` | Invalid value — use `"open"` |

### VALID fields (confirmed working)

| Field | Example value | Notes |
|---|---|---|
| `gateway.mode` | `"local"` | Required for local gateway operation |
| `gateway.port` | `18789` | Container-internal listen port |
| `gateway.bind` | `"0.0.0.0"` | Optional; defaults to localhost |
| `gateway.auth.mode` | `"token"` | Enable token auth |
| `gateway.auth.token` | `"..."` | Authenticates BOTH the gateway server and the CLI client (the CLI reads this same file at startup). No separate client-side field. |
| `agents.defaults.model` | `{"primary": "..."}` | Must be object, not string |
| `agents.defaults.workspace` | `"/home/node/.openclaw/workspace"` | |
| `agents.defaults.memorySearch.enabled` | `false` | Disable vector DB requirement |
| `channels.slack.enabled` | `false` / `true` | |
| `channels.slack.botToken` | `"xoxb-..."` | |
| `channels.slack.appToken` | `"xapp-..."` | |
| `channels.slack.mode` | `"socket"` | Socket mode for DMs |
| `channels.slack.groupPolicy` | `"open"` / `"disabled"` / `"allowlist"` | |
| `session.dmScope` | `"per-channel-peer"` | |
| `tools.profile` | `"coding"` | |
| `plugins.entries.browser.enabled` | `true` | Keep enabled — ACPX co-init dependency |
| `plugins.entries.talk-voice.enabled` | `true` | Voice support is first-class; ~20-40 PIDs is within budget on prosumer hardware |
| `plugins.entries.google.enabled` | `true` | Required for Gemini API via ACPX |
| `plugins.entries.device-pair.enabled` | `false` | Bluetooth/LAN discovery retry-loops in Docker bridge network |
| `plugins.entries.phone-control.enabled` | `false` | iMessage relay needs macOS IPC; Canopy uses host-side path instead |
| `agents.list` | `[]` | Clear on boot; re-registered via boot_sync_agents |

### Size-drop anomaly

OpenClaw compares the current config size to a numbered backup (`.bak.1`, `.bak.2`, ...). If
the file shrank, it fires a "size-drop-vs-last-good" anomaly and **restores from backup**,
overwriting your sanitized config with the previous corrupt one.

**Fix**: Delete all backup files (`openclaw.json.bak.*`, `openclaw.json.clobbered.*`,
`openclaw.json.last-good`) before each container start. Without a baseline, OpenClaw cannot
fire the anomaly. After one clean boot it writes a fresh backup — matching your config — so
the next boot is also clean.

---

## 8. CLI Command Reference

### Sending a chat message

```bash
# ✅ Correct flags — use --agent and --message (or -m)
openclaw agent --agent <id> --message "Hello" --json
openclaw agent --agent <id> -m "Hello" --json    # -m is shorthand for --message

# Default agent name in single-agent mode: "main"
# In multi-agent gateway mode: use the registered ID (e.g. "sloane", "agent-sloane")
```

### Agent registration

```bash
openclaw agents add <id> --workspace /home/node/.openclaw/workspace/<id>
openclaw agents list          # shows all registered agents
openclaw agents remove <id>
```

### Config management

```bash
openclaw config set gateway.mode local
openclaw config set gateway.token "canopy_internal_token_2026"
openclaw config set agents.defaults.model.primary "google/gemini-3.1-pro-preview"
openclaw config get agents.defaults.model
```

**Warning**: `openclaw config set` sends OpenClaw a SIGTERM, causing a full process restart.
Multiple rapid `config set` calls cascade into OOM. Prefer writing openclaw.json directly
via `node -e` when multiple values need updating.

### Pairing

```bash
openclaw pairing approve slack <CODE>   # approve a Slack pairing code
```

### Status and diagnostics

```bash
openclaw status            # show gateway status, Slack config, active sessions
openclaw agents list       # show all registered agents with model/routing info
openclaw doctor --fix      # validate and repair openclaw.json
```

### Session key formats

```
agent:main:main                         # direct CLI message (single-agent mode)
agent:main:slack:direct:<userid>        # Slack DM
agent:main:slack:channel:<channelid>    # Slack channel message
```

---

## 9. Slack Socket Mode Setup

### Two tokens are required

| Token | Prefix | How to get it | Keychain key |
|---|---|---|---|
| Bot Token | `xoxb-` | OAuth flow (`start_slack_oauth`) | `slack-bot-token` |
| App-Level Token | `xapp-` | Slack dashboard → App-Level Tokens | `slack-app-token` |

The App-Level Token is **not** obtained via the OAuth redirect. The user must:
1. Open their Slack app in `api.slack.com`
2. Navigate to **Settings → Basic Information → App-Level Tokens**
3. Create a token with the `connections:write` scope
4. Copy the `xapp-...` string and paste it into Canopy Settings → Slack

### Required OAuth bot scopes

`channels:read`, `channels:history`, `chat:write`, `users:read`

### How Slack is configured in OpenClaw

OpenClaw does **not** have a `channels add` CLI command for Slack. Slack is configured by
writing values into `openclaw.json` via `openclaw config set`, then restarting the gateway:

```bash
openclaw config set channels.slack.botToken  xoxb-...
openclaw config set channels.slack.appToken  xapp-...
openclaw config set channels.slack.enabled   true
openclaw config set channels.slack.mode      socket
```

---

## 10. Creating/Importing Agents — Model Must Not Be None

Every agent created or imported into Canopy must have `personality.active_model` set to a
valid model string. An `active_model: None` value causes the system to fall back to a
model that may not have an available API key.

### Key selection priority

```
Anthropic key present?  →  use DEFAULT_ANTHROPIC_MODEL
No Anthropic, OpenAI?   →  use DEFAULT_OPENAI_MODEL
No Anthropic/OpenAI?    →  use DEFAULT_GEMINI_MODEL (last resort)
No keys at all?         →  use DEFAULT_ANTHROPIC_MODEL (so UI prompts for key)
```

This logic lives in `model_constants::default_model_from_available_keys()`.

---

## 11. Running Diagnostics

### Test chat message from terminal

```bash
docker exec -u node -e NODE_OPTIONS=--v8-pool-size=1 canopy-gateway \
  openclaw agent --agent agent-sloane -m "Are you there?" --json
```

Check stderr for `"gateway connect failed"` (auth issue) or `"uv_thread_create"` (PID issue).

### Check gateway config

```bash
docker exec canopy-gateway cat /home/node/.openclaw/openclaw.json
docker exec -u node -e NODE_OPTIONS=--v8-pool-size=1 canopy-gateway openclaw doctor --fix
```

### Verify auth-profiles file exists for an agent

```bash
docker exec canopy-gateway cat /home/node/.openclaw/agents/agent-sloane/auth-profiles.json
# Should show: {"google": {"apiKey": "AIza..."}}
```

### Check container PID count (detect spirals early)

```bash
docker stats canopy-gateway --no-stream --format "PIDs={{.PIDs}} MEM={{.MemUsage}}"
# Healthy: PIDs=19, MEM~350-400MiB
# Concerning: PIDs>100 (channel sidecars initializing)
# Critical: PIDs>400 (approaching 500-PID limit — restart immediately)
```

### Check Slack is configured

```bash
docker exec canopy-gateway openclaw config get channels.slack.enabled
docker exec canopy-gateway openclaw config get channels.slack.mode
```

---

## 12. Regression Test Coverage

Run the model-constants tests to catch any format regressions:

```bash
cargo test --package canopy-lib model_constants
```

Key tests and what they guard:

| Test | Guards against |
|---|---|
| `anthropic_model_string_has_correct_order` | `claude-4-6-sonnet` reversal bug |
| `default_gemini_model_is_gemini_31_pro` | Switching to unconfirmed flash-lite model |
| `gateway_url_uses_host_port_not_container_port` | using 18789 in GATEWAY_URL |
| `auth_profile_path_contains_agent_id_and_filename` | extra `agent/` directory bug |
| `anthropic_key_is_preferred_over_others` | Gemini-first priority inversion |
| `all_default_constants_pass_validation` | any future typo in model constants |
| `all_models_catalogue_has_stable_gemini_25_models` | dropping stable Gemini 2.5 |
| `catalogue_does_not_contain_deprecated_gemini_20_models` | re-adding deprecated models |

---

## 13. System Calls — Bypassing OpenClaw Intentionally

Some internal Canopy operations should **never** route through OpenClaw. They must not:
- Create sessions or conversation history
- Appear in any agent's chat tab (`ThreadsRail`, `ThreadSwitcher`)
- Accumulate context across calls (causes token snowball and quota hits)
- Require a specific agent to be running

### The `system_assess` command

`system_assess` in `openclaw.rs` is the canonical example of a "bypass" call. It:
1. Reads global API keys directly from the macOS Keychain (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
2. Picks the cheapest `strategy="light"` model from whichever provider has a key
3. Makes a direct HTTPS POST to the provider's REST API — not to the OpenClaw gateway
4. Returns plain text; no session ID, no agent ID, no conversation footprint

**Provider priority (cheapest first):** Gemini 2.5 Flash Lite → Claude Haiku 4.5 → GPT-4o Mini

**Model name translation for direct API calls:**

| OpenClaw model string | Direct API model name | Endpoint |
|-----------------------|-----------------------|----------|
| `google/gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=` |
| `anthropic/claude-haiku-4-5` | `claude-haiku-4-5` | `api.anthropic.com/v1/messages` |
| `openai/gpt-4o-mini` | `gpt-4o-mini` | `api.openai.com/v1/chat/completions` |

The `google/` / `anthropic/` / `openai/` provider prefix used inside OpenClaw is stripped before
calling the provider REST API directly. `call_gemini_direct` handles this automatically via
`.strip_prefix("google/")`.

### The `_sys_` session prefix (legacy — superceded by system_assess)

Before `system_assess` existed, internal calls used `sessionId: "_sys_forum_assessment"` with
`send_message`. This routed through OpenClaw but used a stable session ID that was filtered from
`ThreadsRail` and `ThreadSwitcher` by a `.filter(c => !c.id?.startsWith("_sys_"))` guard.

This approach is **deprecated for new system calls** — it still accumulates context inside
OpenClaw and depends on a specific agent being running. Use `system_assess` instead.

### When to add a new system call vs. using an agent

Use `system_assess` (or a similar direct-API command) when:
- The task is internal/meta (assessment, classification, routing, summarization of app state)
- You don't want the call visible in any agent's history
- You want the cheapest available model regardless of which agents the user has configured
- The call is one-shot with no follow-up

Use `send_message` to a real agent when:
- The agent's persona, SOUL.md, or conversation history is relevant
- The response will be shown to the user as an agent message
- The task requires the agent's specific capabilities or integrations

---

## 14. OrbStack VM Memory — Required Configuration

### The problem

OrbStack runs all Docker containers inside a Linux VM. By default that VM gets **8 GB of RAM**.
The `canopy-gateway` container was previously configured with `memory: 16G` — double what the VM
could actually allocate — so the Linux OOM killer would fire under normal load.

### Current container budget

| Container | Memory limit | Notes |
|-----------|-------------|-------|
| `canopy-gateway` | `4 G` | OpenClaw + Node.js proxying external APIs; 4 GB is 2× peak load |
| `canopy-chroma` | `512 m` | Local vector DB; personal scale stays well under this |
| `canopy-isolated-*` | `2 G` each | Per isolated agent; one at a time in normal use |
| OrbStack VM overhead | ~1 GB | Reserved for the VM kernel + macOS IPC |
| **Total worst case** | ~5.5 GB | One isolated agent + chroma + gateway |

**The default OrbStack 8 GB VM is sufficient** for normal use with the corrected limits.

### If you hit OOM again

The limits above stop container overcommit. If OOM still occurs, the VM itself is probably
undersized for your workload (many forums running simultaneously, isolated agents, browser plugin).

**Fix:** OrbStack → Settings → Resources → Memory → raise to **12–16 GB**.

### Debugging container memory

```bash
# Live memory stats for all Canopy containers
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" $(docker ps --filter "label=com.canopy.managed=true" -q)

# One-liner to check if gateway is near its limit
docker stats canopy-gateway --no-stream --format "MEM: {{.MemUsage}} / {{.MemPerc}}"
```

If `MemPerc` is consistently above 70%, raise the container limit in `docker.rs`
`generate_compose_file()` **and** ensure the OrbStack VM has at least 2× headroom.

---

## 15. Keeping This Document Updated

When OpenClaw releases a new version:

1. Check the changelog at `https://docs.openclaw.ai` for new/removed config keys
2. Run `docker exec canopy-gateway openclaw --version` to confirm the new version
3. Run `docker exec canopy-gateway openclaw doctor` and look for new validation warnings
4. Test `openclaw config set` with any new fields before committing them to Canopy
5. Update the **valid/invalid fields tables** in section 7 above
6. Update the **confirmed working models table** in section 1 if LiteLLM support changes
7. Update the `Last verified against:` line at the top of this file

The most fragile areas across version bumps are:
- Model string formats (new model IDs, deprecated ones)
- Config schema (new required fields, removed fields, renamed keys)
- CLI flag names (`--message` vs `-m`, `--agent` flag requirement)
