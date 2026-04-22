# OpenClaw Integration — Known Failure Modes & Config Reference

This document captures every non-obvious configuration detail that has caused Canopy agents
to stop communicating. Read this before modifying anything in `openclaw.rs`, `audit_openclaw.rs`,
`slack.rs`, `docker.rs`, or `model_constants.rs`.

---

## 1. Model String Format

### The rule

OpenClaw model identifiers follow a strict `"provider/model-name"` format. The model family
name always comes **before** the version suffix — never after.

```
✅  anthropic/claude-sonnet-4-6      (family "sonnet" then version "4-6")
❌  anthropic/claude-4-6-sonnet      (version before family — WRONG, causes silent failure)

✅  google/gemini-2.0-flash
❌  google/gemini-3-flash-preview    (this model does not exist)
```

### Why it matters

When OpenClaw receives an unknown model string via `openclaw config set agents.defaults.model`,
it either errors silently or falls back to a model you have no key for. The agent appears to
exist and receive messages but never responds.

### The source of truth

All model strings are defined in `src/model_constants.rs`. **Do not hardcode model strings
anywhere else in the codebase.** When model versions change, update `model_constants.rs` and
run `cargo test model_constants` to validate the change.

```rust
// model_constants.rs — the only place model strings should appear
pub const ANTHROPIC_CLAUDE_SONNET: &str = "anthropic/claude-sonnet-4-6";
pub const GOOGLE_GEMINI_FLASH: &str = "google/gemini-2.0-flash";
```

### Updating for new model releases

1. Update the relevant constant in `model_constants.rs`
2. Run `cargo test model_constants::tests::all_default_constants_pass_validation`
3. Run `cargo test model_constants::tests::anthropic_model_string_has_correct_order`
4. Nothing else needs to change — all call sites import from `model_constants`

---

## 2. Gateway Port Mapping

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

### The bug this replaces

The audit function previously checked whether `allowedOrigins` contained `"18789"` (the
container-internal port). Since host-side config always references `18799`, this check
permanently reported `port_mismatch = true`, triggering spurious repair runs on every startup.

---

## 3. Auth-Profile Path

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

### Why it matters

OpenClaw looks for `auth-profiles.json` directly inside the agent folder. If the file is
one level deeper (in the spurious `agent/` subdirectory), the gateway silently runs without
API keys and every agent call fails with an auth error.

### How to build the path

Always use the helper from `model_constants.rs`:

```rust
use crate::model_constants::agent_auth_profile_path;
let filepath = agent_auth_profile_path(&agent_id);
// → "/home/node/.openclaw/agents/my-agent/auth-profiles.json"
```

---

## 4. Slack Socket Mode Setup

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

Without the App-Level Token, Socket Mode cannot open its WebSocket connection. The OAuth
flow will appear to succeed but agents will never receive Slack messages.

### Required OAuth bot scopes

`channels:read`, `channels:history`, `chat:write`, `users:read`

These are requested in `start_slack_oauth()`. If you change the scopes there, you must also
reinstall the Slack app to apply them.

### How Slack is configured in OpenClaw

OpenClaw does **not** have a `channels add` CLI command for Slack. Slack is configured by
writing values into `openclaw.json` via `openclaw config set`, then restarting the gateway:

```bash
openclaw config set channels.slack.botToken  xoxb-...
openclaw config set channels.slack.appToken  xapp-...
openclaw config set channels.slack.enabled   true
openclaw config set channels.slack.mode      socket
```

The previous implementation incorrectly called `openclaw channels add --channel slack ...`
which does not exist. The `start_slack_listener()` function in `slack.rs` now uses
`config set` calls.

---

## 5. Creating/Importing Agents — Model Must Not Be None

### The rule

Every agent created or imported into Canopy must have `personality.active_model` set to a
valid model string. An `active_model: None` value causes the system to fall back to a
model that may not have an available API key, silently breaking message routing.

### Key selection priority

```
Anthropic key present?  →  use DEFAULT_ANTHROPIC_MODEL
No Anthropic, OpenAI?   →  use DEFAULT_OPENAI_MODEL
No Anthropic/OpenAI?    →  use DEFAULT_GEMINI_MODEL (last resort)
No keys at all?         →  use DEFAULT_ANTHROPIC_MODEL (so UI prompts for key)
```

This logic lives in `model_constants::default_model_from_available_keys()`. Use it whenever
you need to pick a default model — do not replicate the if/else chain inline.

---

## 6. Running Diagnostics

### Check gateway config alignment

```bash
# From the Canopy UI: Settings → Infrastructure → Run Diagnostics
# Or via CLI inside the container:
docker exec canopy-gateway openclaw doctor --fix
docker exec canopy-gateway cat /home/node/.openclaw/openclaw.json
```

### Verify model string in gateway config

```bash
docker exec canopy-gateway openclaw config get agents.defaults.model
# Should return: anthropic/claude-sonnet-4-6  (or whichever model is configured)
```

### Verify auth-profiles file exists for an agent

```bash
docker exec canopy-gateway cat /home/node/.openclaw/agents/agent-myagent/auth-profiles.json
# Should show: {"anthropic": {"apiKey": "sk-ant-..."}}
```

### Verify Slack is configured

```bash
docker exec canopy-gateway openclaw config get channels.slack.enabled
docker exec canopy-gateway openclaw config get channels.slack.mode
```

---

## 7. Regression Test Coverage

The tests in `src/model_constants.rs` cover all of the above. Run them with:

```bash
cargo test --package canopy-lib model_constants
```

Key tests and what they guard:

| Test | Guards against |
|---|---|
| `anthropic_model_string_has_correct_order` | `claude-4-6-sonnet` reversal bug |
| `gemini_model_does_not_use_nonexistent_preview_name` | `gemini-3-flash-preview` typo |
| `gateway_url_uses_host_port_not_container_port` | using 18789 in GATEWAY_URL |
| `auth_profile_path_has_no_extra_agent_subdir` | extra `agent/` directory bug |
| `anthropic_key_is_preferred_over_others` | Gemini-first priority inversion |
| `all_default_constants_pass_validation` | any future typo in model constants |
