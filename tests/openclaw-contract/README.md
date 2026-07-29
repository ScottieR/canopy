# OpenClaw Engine Contract Tests

Canopy depends on behaviors of the OpenClaw engine that are not covered by any
API guarantee: config schema keys, the model-string object format, the bundled
model catalog, and — critically — **how API keys are delivered to the runtime**.
These behaviors have changed under us repeatedly. This suite pins them down.

Each test maps to a real production breakage that shipped because nothing
checked the contract:

| Test | Contract | Real incident it would have caught |
|------|----------|-----------------------------------|
| T0 | Engine version/digest matches `expected-engine.txt` | July 2026 engine update landing without review — "things change randomly" |
| T1 | Canopy's canonical `openclaw.json` keys are accepted | `gateway.token` schema rejection → container crash-loop |
| T2 | `agents.defaults.model` round-trips as `{"primary": ...}` | Bare-string model silently ignored → agent never responds |
| T3 | Every ID in `shared/models.json` is known to the engine | `claude-sonnet-5` missing from bundled catalog → resolver fell through to `openai-responses` transport, sent Anthropic key to OpenAI |
| T4 | Keys written as `auth-profiles.json` become effective auth after `doctor --fix` | **July 2026: auth moved to per-agent `openclaw-agent.sqlite`; legacy JSON no longer read at runtime → fleet-wide "No API key found for provider X"** |
| T5 | `agents.defaults.model.fallbacks` is honored | Runtime failover chain (added July 2026) silently ignored |

## Running

Requires Docker (OrbStack) on the host. Uses a throwaway state dir; never
touches real agent state, and only ever uses dummy keys.

```bash
# Against the pinned image (must match docker.rs):
./tests/openclaw-contract/run.sh

# Canary against upstream latest (early warning of coming breakage):
IMAGE=ghcr.io/openclaw/openclaw:latest ./tests/openclaw-contract/run.sh

# After consciously reviewing an engine change, accept the new identity:
UPDATE_EXPECTED=1 ./tests/openclaw-contract/run.sh
```

## When to run

1. **Before every bump of the pinned image tag in `src-tauri/src/docker.rs`.**
   The suite failing means the new engine breaks a Canopy flow — fix Canopy
   first, then bump, then `UPDATE_EXPECTED=1`.
2. **Weekly in CI against `:latest`** (allowed to fail without blocking; its
   job is early warning, giving you lead time before you're forced to upgrade).
3. **On any PR touching** `docker.rs`, `openclaw.rs` credential/model sync
   paths, or `shared/models.json`.

## Notes

- T4a is a *behavior probe*, not an assertion: it reports whether the engine
  currently reads the legacy JSON directly. Either state is survivable because
  `import_auth_into_store()` always runs `doctor --fix` after credential
  writes; T4b is the hard contract that must never fail.
- A tag pin (`:2026.7.1`) is not immutable — upstream can re-push it. T0's
  digest check is what actually detects that.
- Keep `PINNED_IMAGE` in `run.sh` in sync with `docker.rs` (T0 will drift-warn
  via digest if they diverge).
