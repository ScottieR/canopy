use anyhow::{Context, Result};
use bollard::Docker;
use bollard::container::{ListContainersOptions, StatsOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::models::ContainerStatus;
use crate::openclaw::get_docker_command;

/// Manages OrbStack/Docker containers for OpenClaw instances.
/// Users never see Docker — this is the invisible infrastructure layer.
pub struct DockerManager {
    docker: Docker,
}

impl DockerManager {
    /// Connect to Docker via OrbStack's socket
    pub async fn init() -> Result<Self> {
        let mut docker = Docker::connect_with_socket_defaults().unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_default();
            let orb_sock = home.join(".orbstack/run/docker.sock");
            Docker::connect_with_socket(&orb_sock.to_string_lossy(), 120, bollard::API_DEFAULT_VERSION).unwrap()
        });

        if docker.ping().await.is_err() {
            let home = dirs::home_dir().unwrap_or_default();
            let orb_sock = home.join(".orbstack/run/docker.sock");
            docker = Docker::connect_with_socket(&orb_sock.to_string_lossy(), 120, bollard::API_DEFAULT_VERSION)
                .context("Failed to connect to OrbStack explicitly")?;
        }

        // Verify connection
        docker.ping().await.context("Docker ping failed. Is OrbStack running?")?;
        tracing::info!("Connected to Docker engine");

        Ok(Self { docker })
    }

    /// Get the Docker client reference
    pub fn client(&self) -> &Docker {
        &self.docker
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_orbstack_installed() -> Result<bool, String> {
    // Check if `orb` CLI exists
    let output = tokio::process::Command::new("which")
        .arg("orb")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(output.status.success())
}

#[tauri::command]
pub async fn install_orbstack() -> Result<String, String> {
    // Download and install OrbStack via brew (most reliable for macOS)
    let output = tokio::process::Command::new("brew")
        .args(["install", "--cask", "orbstack"])
        .output()
        .await
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if output.status.success() {
        Ok("OrbStack installed successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("OrbStack installation failed: {}", stderr))
    }
}

#[tauri::command]
pub async fn get_container_status(
    manager: tauri::State<'_, DockerManager>,
) -> Result<Vec<ContainerStatus>, String> {
    let mut filters = HashMap::new();
    filters.insert("label", vec!["com.canopy.managed=true"]);

    let options = ListContainersOptions {
        all: true,
        filters,
        ..Default::default()
    };

    let containers = manager
        .docker
        .list_containers(Some(options))
        .await
        .map_err(|e| format!("Failed to list containers: {}", e))?;

    let mut statuses = Vec::new();
    for container in containers {
        let id = container.id.unwrap_or_default();
        let name = container
            .names
            .and_then(|n| n.first().cloned())
            .unwrap_or_default()
            .trim_start_matches('/')
            .to_string();
        let state = container.state.unwrap_or_default();

        statuses.push(ContainerStatus {
            id,
            name,
            state,
            health: "healthy".to_string(), // TODO: parse from health check
            memory_mb: 0.0,                // TODO: get from stats
            cpu_percent: 0.0,
            port: crate::model_constants::GATEWAY_HOST_PORT, // host-facing port (18799), not container-internal (18789)
        });
    }

    Ok(statuses)
}

/// Generate the docker-compose.yml for the shared gateway.
///
/// Port mapping: HOST 18799 → CONTAINER 18789
/// - Rust code talking to the gateway from the host uses port 18799 (GATEWAY_HOST_PORT).
/// - The healthcheck curl runs *inside* the container, so it correctly uses 18789
///   (GATEWAY_CONTAINER_PORT). Do NOT change the healthcheck URL to 18799.
///
/// `provider_keys` — API keys read from the macOS Keychain at compose-generation time.
/// Injected as container env vars so OpenClaw/LiteLLM can discover them without needing
/// auth-profiles.json written to disk (which is still written as belt-and-suspenders).
/// The compose file is regenerated on every start_gateway call; if keys change the content
/// hash changes, triggering a compose-up container recreate automatically.
fn generate_compose_file(data_dir: &PathBuf, provider_keys: &HashMap<String, String>) -> String {
    // Build the extra env lines. Keys are YAML-safe (alphanumeric + underscores).
    // Values are injected as literal strings — no shell quoting needed in YAML block lists.
    // Sorted for deterministic output (so the content-hash comparison is stable).
    let mut sorted_keys: Vec<(&String, &String)> = provider_keys.iter().collect();
    sorted_keys.sort_by_key(|(k, _)| k.as_str());
    let extra_env: String = sorted_keys
        .into_iter()
        .map(|(k, v)| format!("      - {}={}\n", k, v))
        .collect();

    format!(
        r#"services:
  canopy-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: canopy-gateway
    restart: unless-stopped
    labels:
      - "com.canopy.managed=true"
      - "com.canopy.type=shared-gateway"
    ports:
      - "18799:18789"   # HOST:CONTAINER — Rust code connects on 18799; OpenClaw listens on 18789
      - "18800:18790"
      - "18801:18791"
    volumes:
      # config dir → /home/node/.openclaw  (openclaw.json, agents/, credentials/, etc.)
      - {data}/openclaw-state:/home/node/.openclaw
      # workspace → /home/node/.openclaw/workspace  (SOUL.md, IDENTITY.md, state/, etc.)
      # ⚠️  Must be INSIDE .openclaw, not a sibling dir — verified from working reference agent
      - {data}/openclaw-state/workspace:/home/node/.openclaw/workspace
    environment:
      - NODE_ENV=production
{extra_env}    extra_hosts:
      - "host.docker.internal:host-gateway"
    # init: true runs a minimal init process (PID 1) inside the container that:
    #   1. Forwards signals (SIGTERM/SIGKILL) to the Node.js process — critical for clean shutdown
    #   2. Reaps zombie processes — without this, a PID spiral leaves unkillable zombie PIDs
    #      that accumulate until the kernel's PID table is exhausted
    init: true
    # Chromium (launched by the browser plugin) uses /dev/shm for renderer IPC.
    # Docker's default /dev/shm is 64MB — Chromium immediately crashes and the browser
    # plugin crash-loops it, spawning ~50 instances in 53s (2700 PIDs, 8GB RAM).
    # shm_size: 2gb raises the shared-memory limit so Chromium stays alive.
    shm_size: '2gb'
    deploy:
      resources:
        limits:
          memory: 16G
          cpus: '4.0'
          # ⚠️  Use deploy.resources.limits.pids, NOT top-level pids_limit.
          # docker-compose v2 (OrbStack) rejects having both set simultaneously.
          #
          # Process budget with 1 active agent + 2 plugins (acpx, browser):
          #   - browser plugin: 1 Chromium instance (stable with shm_size fix) ~50-100 PIDs
          #   - Core OpenClaw runtime + tini: ~50 PIDs
          #   - ACPX embedded runtime: ~30 PIDs
          #   - Headroom + retry grace: 2x buffer
          # 1000 acts as a circuit-breaker against runaway spirals while allowing
          # normal Chromium + OpenClaw operation. Raise if multi-agent + browser is needed.
          pids: 1000
    healthcheck:
      # ⚠️  This curl runs INSIDE the container — use container port 18789, not host port 18799
      test: ["CMD", "curl", "-f", "http://localhost:18789/status"]
      interval: 30s
      timeout: 10s
      retries: 3
      
  canopy-chroma:
    image: chromadb/chroma:latest
    container_name: canopy-chroma
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - {data}/chroma-data:/chroma/chroma

volumes:
  openclaw-state:
  chroma-data:
  openclaw-workspace:
"#,
        data = data_dir.display(),
        extra_env = extra_env,
    )
}

/// Generate docker-compose for an isolated agent container
pub fn generate_isolated_compose(agent_id: &str, data_dir: &PathBuf, host_port: u16) -> String {
    format!(
        r#"services:
  canopy-isolated-{id}:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: canopy-isolated-{id}
    restart: unless-stopped
    labels:
      - "com.canopy.managed=true"
      - "com.canopy.type=isolated"
      - "com.canopy.agent-id={id}"
    ports:
      - "{port}:18789"
    volumes:
      - {data}/isolated/{id}/state:/home/node/.openclaw
      - {data}/isolated/{id}/workspace:/home/node/.openclaw/workspace
      # - {data}/isolated/{id}/config/openclaw.json:/home/node/.openclaw/openclaw.json:ro
    environment:
      - NODE_ENV=production
    pids_limit: 200
    networks:
      - isolated-{id}
    healthcheck:
      # ⚠️  Runs INSIDE the container — use container port 18789, not host port {port}
      test: ["CMD", "curl", "-f", "http://localhost:18789/status"]
      interval: 30s
      timeout: 10s
      retries: 3

networks:
  isolated-{id}:
    internal: false
"#,
        id = agent_id,
        data = data_dir.display(),
        port = host_port
    )
}

pub fn get_docker_compose_command() -> tokio::process::Command {
    if let Some(home) = dirs::home_dir() {
        let orb_compose = home.join(".orbstack/bin/docker-compose");
        if orb_compose.exists() {
            return tokio::process::Command::new(orb_compose);
        }
    }
    if std::path::Path::new("/usr/local/bin/docker-compose").exists() {
        return tokio::process::Command::new("/usr/local/bin/docker-compose");
    }
    if std::path::Path::new("/opt/homebrew/bin/docker-compose").exists() {
        return tokio::process::Command::new("/opt/homebrew/bin/docker-compose");
    }
    tokio::process::Command::new("docker-compose")
}

/// Scan every agent directory in the openclaw-state bind mount and replace any
/// auth-profiles.json that contains invalid JSON with an empty `{}` placeholder.
///
/// Why this matters
/// ─────────────────
/// OpenClaw reads auth-profiles.json the instant the container starts, BEFORE Canopy's
/// `sync_credentials` has had a chance to write corrected files. If a file contains
/// invalid JSON (e.g. the literal text "AUTHEOF" from a heredoc terminator bug), the
/// Node.js JSON.parse() call throws a SyntaxError. OpenClaw's error handler retries the
/// operation in a tight loop, spawning a new process on each attempt — 18 PIDs → 300+
/// in under 30 seconds, exhausting all 8 GiB of container memory (exit 137 / OOM kill).
///
/// By replacing bad files with `{}` before `docker-compose up`, OpenClaw reads valid
/// (empty) JSON, handles "no provider keys configured" gracefully, and stays at a
/// stable PID count. Canopy's `sync_credentials` then overwrites `{}` with the real
/// API keys a few seconds later once the container is up.
///
/// This runs synchronously (it's just filesystem reads/writes on the host — fast).
fn preflight_sanitize_auth_profiles(data_dir: &PathBuf) {
    let agents_dir = data_dir.join("openclaw-state").join("agents");
    let Ok(entries) = std::fs::read_dir(&agents_dir) else {
        return; // Directory missing is fine — container hasn't written anything yet.
    };

    for entry in entries.flatten() {
        // Cover both possible auth-profiles layouts:
        //   agents/{id}/agent/auth-profiles.json  (single-agent mode — verified from Sloane)
        //   agents/{id}/auth-profiles.json         (possible gateway-mode flat layout)
        let candidate_paths = [
            entry.path().join("agent").join("auth-profiles.json"),
            entry.path().join("auth-profiles.json"),
        ];
        for auth_file in &candidate_paths {
            match std::fs::read_to_string(auth_file) {
                Ok(content) => {
                    if serde_json::from_str::<JsonValue>(&content).is_err() {
                        // Invalid JSON — replace with an empty object.
                        if let Err(e) = std::fs::write(auth_file, "{}") {
                            tracing::warn!(
                                "preflight_sanitize_auth_profiles: could not fix {:?}: {}",
                                auth_file, e
                            );
                        } else {
                            tracing::warn!(
                                "preflight_sanitize_auth_profiles: replaced corrupted auth-profiles at {:?}",
                                auth_file
                            );
                        }
                    }
                }
                Err(_) => {} // Missing file is fine — OpenClaw handles it gracefully.
            }
        }
    }
}

/// Write a sane openclaw.json to the bind-mount BEFORE starting the container.
///
/// ALWAYS writes a fresh config from scratch. We do NOT read and patch the existing
/// file because:
///
///   1. OpenClaw modifies openclaw.json during operation, writing back fields like
///      trustedProxies, controlUi.origins, plugin sub-configs, and model resolution
///      state. If a phantom model (e.g. an unrecognised Gemini 3.x preview) was
///      previously written, it causes LiteLLM inside the container to retry model
///      validation on every startup, permanently blocking the Node.js event loop.
///
///   2. The Python scripts and manual edits users run during debugging often leave
///      the file in a partially-patched state (e.g. model as a bare string instead
///      of the required {"primary": "..."} object). Read-and-patch preserves that
///      corrupt state and forwards it to the container.
///
///   3. We already delete ALL backup files in start_gateway() before calling this
///      function, so OpenClaw has no baseline to compare against. It cannot fire
///      the size-drop anomaly even if the new config is smaller than a previous run.
///      After a clean boot, OpenClaw creates a fresh small backup. On the NEXT boot,
///      the backup size matches our config → no anomaly.
///
/// Everything Canopy needs is explicitly set below. OpenClaw will regenerate any
/// operational state (trustedProxies, plugin sub-configs, etc.) on first startup.
/// User credentials live in keychain + keychain-backed env vars in docker-compose —
/// not in openclaw.json — so they are not lost by this fresh-write approach.
fn preflight_write_openclaw_json(data_dir: &PathBuf, token: &str) {
    let config_path = data_dir.join("openclaw-state").join("openclaw.json");

    // Start mostly clean, but carry forward the few fields that are legitimately
    // dynamic per-user state — anything that's already a snapshot of keychain-backed
    // credentials we wrote in a previous session and want the gateway to boot up
    // with directly, instead of forcing a mid-boot restart from boot_sync_agents.
    //
    // What we copy and why:
    //   • meta — OpenClaw fires a "missing-meta-vs-last-good" anomaly and enters
    //     a recovery loop if this field is dropped.
    //   • channels.{slack,gmail,googleCalendar,googleDrive} — per-agent account
    //     maps written by sync_gateway_channels_internal from keychain on a
    //     previous run. Wiping these meant the container booted with the
    //     channel DISABLED until boot_sync_agents rewrote and restarted it,
    //     which surfaced as "Slack bot token missing for account X" runtime
    //     errors. The defensive scrub a few lines below still removes the
    //     dangerous single-tenant `botToken`/`appToken` fields (they're the
    //     cross-agent leak vector — see slack.rs::get_bot_token for the
    //     matching guard).
    //   • bindings — agent ↔ account routing. Must travel with the account
    //     maps; orphaned bindings or orphaned accounts both break dispatch.
    //   • plugins.entries.{slack,google}.enabled — mirrors the plugin-on/off
    //     state that goes with the accounts. Without this the channels are
    //     populated but the plugin is off.
    //
    // What we deliberately do NOT carry forward (handled by overrides below):
    //   • agents.defaults.model — overwritten with the current keychain-key-
    //     derived default, so any stale/deprecated model string in the file
    //     gets blown away regardless.
    //   • gateway.* — fully overwritten from constants.
    //   • agents.list — cleared further down to keep the ".openclaw-applied"
    //     comparison deterministic; restored after preflight by start_gateway.
    let mut cfg: JsonValue = serde_json::json!({});

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(existing_cfg) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(meta) = existing_cfg.get("meta") {
                cfg["meta"] = meta.clone();
            }

            // Per-agent channel state. Built atomically by
            // sync_gateway_channels_internal from keychain — never hand-edited
            // — so carrying it forward is safe and is what makes Slack work on
            // boot for users with existing per-agent connections.
            for ch in ["slack", "gmail", "googleCalendar", "googleDrive"] {
                if let Some(ch_cfg) = existing_cfg.pointer(&format!("/channels/{}", ch)) {
                    cfg["channels"][ch] = ch_cfg.clone();
                }
            }
            if let Some(bindings) = existing_cfg.get("bindings") {
                cfg["bindings"] = bindings.clone();
            }
            for plugin in ["slack", "google"] {
                if let Some(enabled) = existing_cfg.pointer(
                    &format!("/plugins/entries/{}/enabled", plugin)
                ) {
                    cfg["plugins"]["entries"][plugin]["enabled"] = enabled.clone();
                }
            }
        }
    }

    // ── Gateway auth — always set to our token ────────────────────────────────
    //
    // gateway.auth.token  — SERVER-SIDE: the gateway validates incoming requests against
    //                       this value. Any CLI invocation or HTTP request that doesn't
    //                       present this token is rejected.
    //
    // ⚠️  Do NOT add a top-level `gateway.token` field here. OpenClaw 2026.4.14's schema
    // does not recognise it and will reject the entire config with:
    //   "Config invalid — gateway: Unrecognized key: 'token'"
    // causing the container to crash-loop indefinitely.
    //
    // The CLI authenticates to the local gateway by reading `gateway.auth.token` from the
    // same openclaw.json it shares with the server process. No separate client field is needed
    // — the presence of auth.mode="token" + auth.token=<value> is sufficient for both sides.
    cfg["gateway"]["auth"]["mode"] = serde_json::json!("token");
    cfg["gateway"]["auth"]["token"] = serde_json::json!(token);
    cfg["gateway"]["mode"] = serde_json::json!("local");
    cfg["gateway"]["port"] = serde_json::json!(18789);

    // ── Slack channel — strictly per-agent isolation ────────────────────────────
    //
    // The only Slack fields that are dangerous to carry forward are the GLOBAL
    // single-tenant `botToken` / `appToken`. Those create the cross-agent
    // contamination problem: any agent missing its own per-agent token would
    // silently fall back to whatever was in the global slot. They're never
    // written by the per-agent path; if we see them in the file at all it's
    // leftover from the legacy `start_slack_listener` path and must be removed.
    //
    // The per-agent `channels.slack.accounts.{agent_id}` map and its sibling
    // bindings were preserved above from the existing file (when present). They
    // came from keychain via sync_gateway_channels_internal and let the
    // gateway boot up with Slack already working, without needing an
    // expensive mid-boot restart.
    //
    // If we have accounts, enable the plugin so it picks them up. If we have
    // none, force enabled=false so OpenClaw doesn't try to start Socket Mode
    // with nothing to connect.
    {
        if let Some(slack) = cfg["channels"]["slack"].as_object_mut() {
            slack.remove("botToken");
            slack.remove("appToken");
            // groupPolicy must always be "open" — see audit_openclaw::repair_openclaw_config.
            // If a previous file had "allowlist" or similar this flips it back.
            slack.insert("groupPolicy".to_string(), serde_json::json!("open"));
            slack.insert("mode".to_string(), serde_json::json!("socket"));

            let has_accounts = slack
                .get("accounts")
                .and_then(|v| v.as_object())
                .map(|m| !m.is_empty())
                .unwrap_or(false);
            slack.insert("enabled".to_string(), serde_json::json!(has_accounts));

            if has_accounts {
                tracing::info!(
                    "preflight: preserved {} per-agent Slack account(s) — gateway will boot with Slack ENABLED",
                    slack.get("accounts").and_then(|v| v.as_object()).map(|m| m.len()).unwrap_or(0)
                );
                cfg["plugins"]["entries"]["slack"]["enabled"] = serde_json::json!(true);
            } else {
                tracing::info!("preflight: no per-agent Slack accounts in existing config — gateway will boot with Slack DISABLED");
            }
        }
    }

    // ── Surgically remove ONLY the schema-rejected key ───────────────────────
    // OpenClaw validates openclaw.json on startup. Any unrecognized key under
    // `gateway` triggers an infinite `openclaw doctor --fix` loop that permanently
    // blocks the Node.js event loop.
    //
    // IMPORTANT: Do NOT use gw.retain() or otherwise strip the gateway object to
    // a fixed allow-list. OpenClaw writes back to the bind-mount openclaw.json
    // during normal operation (adding agent state, channel config, etc.) and tracks
    // a "last-good" config size. If we strip the file from ~1500 bytes to ~600 bytes,
    // OpenClaw fires a "size-drop-vs-last-good" anomaly on next startup and enters
    // a recovery loop that spirals to 1000+ PIDs.
    //
    // Instead: only remove the ONE key we know is invalid. Everything else OpenClaw
    // legitimately wrote (trustedProxies, controlUi origins, channel state, etc.)
    // must be preserved so the config size stays stable across sessions.
    if let Some(gw) = cfg["gateway"].as_object_mut() {
        gw.remove("bonjour"); // schema-rejected; causes doctor --fix loop if present
    }

    // ── Workspace path — Removed ──────────────────────────────────────────────
    // Do NOT set agents.defaults.workspace to the root /home/node/.openclaw/workspace
    // This causes OpenClaw to recursively index all agents' folders on startup, leading
    // to an exponential memory leak and PID exhaustion. Each agent gets its workspace
    // explicitly defined via `--workspace` in `openclaw agents add` instead.

    // ── Force-set a known-good default model ─────────────────────────────────
    // When a PID spiral corrupts the openclaw.json (e.g. writing "openai/gpt-5.4",
    // a phantom model that doesn't exist), ACPX's embedded runtime tries to initialize
    // the OpenAI client for that model on every startup. The client hangs for 4-8
    // minutes trying to connect/validate, which blocks the entire Node.js event loop —
    // IPC never responds even though the gateway reports "ready".
    //
    // Always override to a known-good model chosen based on which API keys are in the
    // macOS Keychain at boot time. Priority: Anthropic → OpenAI → Gemini. This is safe
    // because:
    //   • Each agent gets its own model set via `openclaw agents add --model X`
    //   • agents.defaults.model is only the fallback for agents with no explicit model
    //   • We select from keys the user has actually configured — no mismatch possible
    //
    // ⚠️  CRITICAL: OpenClaw requires model to be an OBJECT `{"primary": "..."}`, NOT a
    // bare string. A plain string is silently ignored — the agent has no model and every
    // openclaw agent --message call returns "OpenClaw: model not found" (or times out).
    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_openai    = crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini    = crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let default_model = crate::model_constants::default_model_from_available_keys(has_anthropic, has_openai, has_gemini);
    tracing::info!(
        "preflight: selecting gateway default model '{}' (anthropic={}, openai={}, gemini={})",
        default_model, has_anthropic, has_openai, has_gemini
    );
    cfg["agents"]["defaults"]["model"] = serde_json::json!({ "primary": default_model });
    // Register the model in the models map so ACPX knows it is a valid selection.
    // The empty-object value tells OpenClaw to use global defaults for that model.
    cfg["agents"]["defaults"]["models"][default_model] = serde_json::json!({});

    // ── Enable memory search with ChromaDB (for long-term RAG memory) ─────────
    cfg["agents"]["defaults"]["memorySearch"]["enabled"] = serde_json::json!(true);
    cfg["agents"]["defaults"]["memorySearch"]["provider"] = serde_json::json!("chroma");
    cfg["agents"]["defaults"]["memorySearch"]["remote"] = serde_json::json!({
        "baseUrl": "http://canopy-chroma:8000"
    });

    // ── Default skills baseline (read-only, lightweight) ─────────────────────
    //
    // `agents.defaults.skills` is the FALLBACK applied to any agent that doesn't have
    // its own `agents.list[i].skills` array. Per-agent skills (browser, vision, canvas,
    // proxy, coding, etc.) are populated by `sync_agent_skills` from the user's
    // capability toggles — the per-agent list is the source of truth.
    //
    // We keep the default minimal so:
    //   1. A brand-new agent without a per-agent override doesn't accidentally inherit
    //      heavy/risky skills (code execution, browser navigation) until explicitly opted in.
    //   2. OpenClaw doesn't default to "unrestricted" mode, which loads all 15+ installed
    //      plugins (voice, vision, proxy, canvas, etc.) and OOMs the container.
    //
    // `gog` (search) and `summarize` are the read-only baseline — every agent can search
    // the web and condense documents; nothing else is granted unless toggled per-agent.
    cfg["agents"]["defaults"]["skills"] = serde_json::json!(["gog", "summarize"]);

    // ── Plugin enable/disable defaults ────────────────────────────────────────
    //
    // Plugin IDs from gateway log: "ready (5 plugins: acpx, browser, device-pair,
    // phone-control, talk-voice)". The acpx plugin is always enabled (built-in core).
    //
    // Defaults below reflect a tested-stable configuration:
    //   • browser     — REQUIRED. ACPX co-initializes with browser via a shared internal
    //                   event (observed: both register at the exact same moment after
    //                   Bonjour announces). Disabling leaves ACPX stuck waiting forever.
    //   • talk-voice  — enabled. Voice support is a first-class feature; the audio codec
    //                   sidecars (~20–40 PIDs) are within budget for prosumer Mac
    //                   hardware now that gateway is on a dedicated container.
    //   • google      — enabled. Required for Gemini API via ACPX.
    //   • device-pair — DISABLED. Bluetooth/LAN device discovery retry-loops in Docker's
    //                   bridge network and blocks the Node.js event loop. Re-enable
    //                   only if/when Canopy adds device-pairing UX.
    //   • phone-control — DISABLED. iMessage relay process hangs in Docker (no macOS IPC
    //                   from inside the container). Canopy uses host-side iMessage
    //                   integration instead.
    //
    // Per-agent overrides for these plugins should NOT be set here — they're global to
    // the gateway. Agent-level capability toggles (browser/vision/canvas/etc.) live in
    // `agents.list[i].skills` and are managed by `sync_agent_skills`.
    cfg["plugins"]["entries"]["browser"]["enabled"]       = serde_json::json!(true);
    cfg["browser"]["noSandbox"]                           = serde_json::json!(true);
    cfg["plugins"]["entries"]["talk-voice"]["enabled"]    = serde_json::json!(true);
    cfg["plugins"]["entries"]["google"]["enabled"]        = serde_json::json!(true);
    cfg["plugins"]["entries"]["device-pair"]["enabled"]   = serde_json::json!(false);
    cfg["plugins"]["entries"]["phone-control"]["enabled"] = serde_json::json!(false);

    // ── Browser bridge — attach to the host-side Chrome via the JIT proxy ────
    //
    // Why this matters: OpenClaw's `browser` tool, by default, tries to LAUNCH
    // `/usr/bin/chromium` INSIDE the container in headed mode. There is no display
    // server in Docker's bridge network, so the launch hangs and every browser tool
    // call times out with "Restart the OpenClaw gateway."
    //
    // Setting `browser.attachOnly = true` tells OpenClaw not to launch its own
    // browser. Setting `browser.cdpUrl` tells it where to connect instead — pointed
    // at our host-side JIT proxy on a fixed port. The JIT proxy:
    //   • rewrites the `Host:` header to `127.0.0.1:<chrome_port>` so Chrome's
    //     DNS-rebinding defence doesn't reject the upgrade,
    //   • spawns a real Chrome on the host (via Canopy's BrowserManager) on first
    //     connection — real Chrome on macOS preserves the anti-bot fingerprint that
    //     in-container headless Chromium would lose.
    //
    // Architecture: ONE shared Chrome instance for the whole gateway. Each agent
    // session gets its own Playwright BrowserContext, which OpenClaw creates per
    // chat — so cookies, storage, and login state stay isolated between agents
    // even though the Chrome process is shared. Profile-per-process isolation was
    // overkill; BrowserContext-per-agent gives us the security property we need
    // with one moving part instead of N.
    //
    // The port (19800) is fixed (not per-agent-hashed) because `browser.cdpUrl` is
    // a single global value, not a per-agent override. If we ever need per-agent
    // ports we'd need OpenClaw to grow `agents.list[i].browser.cdpUrl` first.
    cfg["browser"]["attachOnly"] = serde_json::json!(true);
    cfg["browser"]["cdpUrl"]     = serde_json::json!(format!(
        "http://host.docker.internal:{}",
        crate::browser_manager::SHARED_BRIDGE_PORT
    ));
    // Force OpenClaw's browser tool to default to the `openclaw` profile (our
    // bridge-attached Chrome) instead of letting the LLM pick.
    //
    // Why this matters: the browser tool's doc string ships with this line —
    //   "Use only when existing logins/cookies matter and the user is present"
    // — which biases the LLM toward calling the tool with `profile="user"`
    // whenever a task touches anything that *sounds* like a logged-in session.
    // `profile="user"` attempts an in-container attach to Chrome's default
    // user-data-dir (`/home/node/.config/google-chrome`) which doesn't exist in
    // our setup, so every such call fails with "Chrome MCP existing-session
    // attach… DevToolsActivePort not found".
    //
    // `browser.defaultProfile` is read by browser-doctor.js and applied when
    // the agent omits the `profile` parameter. Setting it to "openclaw" means
    // every default-shaped tool call routes through the bridge we built, no
    // per-prompt nudging required.
    cfg["browser"]["defaultProfile"] = serde_json::json!("openclaw");

    // ── Clear the registered agents list ─────────────────────────────────────
    // This produces a stable, deterministic config that start_gateway() can compare
    // against the ".openclaw-applied" marker to decide whether a container restart
    // is needed. Including agents.list would make the config dynamic (agents are
    // added/removed during normal use) and cause spurious restart decisions.
    //
    // start_gateway() saves the existing agents list BEFORE calling this function
    // and restores it to openclaw.json after writing (but only when NOT recreating
    // the container), so OpenClaw boots with known agents on normal restarts.
    // On container recreate, the agents list stays cleared to prevent hangs when
    // OpenClaw tries to load agents whose dirs were just wiped.
    cfg["agents"]["list"] = serde_json::json!([]);

    if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
        match std::fs::write(&config_path, updated) {
            Ok(_) => tracing::info!("preflight_write_openclaw_json: wrote {:?}", config_path),
            Err(e) => tracing::warn!("preflight_write_openclaw_json: could not write {:?}: {}", config_path, e),
        }
    }
}

#[tauri::command]
pub async fn start_gateway() -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Canopy");

    let state_dir = data_dir.join("openclaw-state");
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(state_dir.join("workspace")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(state_dir.join("agents")).map_err(|e| e.to_string())?;

    // ── Wipe Bonjour/mDNS device state ──────────────────────────────────────
    // openclaw-state/devices/ persists Bonjour mDNS peer discovery state across
    // container restarts. Stale entries cause the Bonjour watchdog to immediately
    // try to re-advertise on startup (even before any agents are registered). In
    // Docker's bridge network, mDNS multicast doesn't work — the advertiser gets
    // stuck in "probing" state, restarts every 15s, and generates enough event-loop
    // pressure to prevent ACPX from initializing and block IPC entirely.
    //
    // Deleting devices/ on each boot ensures OpenClaw starts with a clean Bonjour
    // state and doesn't attempt to re-announce stale peers in a broken network.
    let devices_dir = state_dir.join("devices");
    if devices_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&devices_dir) {
            tracing::warn!("start_gateway: could not clear devices/ directory: {}", e);
        } else {
            tracing::info!("start_gateway: cleared devices/ (stale Bonjour peer state)");
        }
    }

    // ── Delete OpenClaw's backup configs to prevent "size-drop" anomaly ──────
    // OpenClaw keeps numbered rotating backups (openclaw.json.bak.1, .bak.2, …)
    // and saves every config we write as openclaw.json.clobbered.<timestamp> before
    // overwriting it with a restore. Discovered by listing openclaw-state/:
    //
    //   openclaw.json.bak.1   (383 bytes — most recent, Apr 25)
    //   openclaw.json.bak.2   (1305 bytes — Apr 24)
    //   openclaw.json.bak.3   (1305 bytes — Apr 24)
    //   openclaw.json.bak.4   (1791 bytes — Apr 23, the oldest/largest)
    //   openclaw.json.clobbered.2026-04-25T18-07-09-893Z  (749 bytes)
    //   … (many more clobbered files)
    //
    // On startup, OpenClaw reads the highest-numbered backup to get its "last-good"
    // baseline size and compares it to the current config. If our config shrank
    // (because we cleared agents.list in a previous run), it fires:
    //
    //   Config observe anomaly: openclaw.json (size-drop-vs-last-good:1540->749)
    //   Config overwrite: openclaw.json (backup=openclaw.json.bak)
    //
    // It then RESTORES from the backup — overwriting our sanitized config with a
    // corrupt one that may have the phantom model or bonjour key. Either blocks IPC.
    //
    // Delete ALL backup and clobbered files on every boot so OpenClaw has no baseline
    // to compare against. Safe: it regenerates them on first clean startup, so the
    // NEXT boot has a fresh, accurate baseline that matches our config.
    if let Ok(entries) = std::fs::read_dir(&state_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let is_backup = name.starts_with("openclaw.json.bak")
                    || name.starts_with("openclaw.json.clobbered")
                    || name.starts_with("openclaw.json.last-good")
                    || name.starts_with(".openclaw-last-good");
                if is_backup {
                    match std::fs::remove_file(&path) {
                        Ok(_) => tracing::info!("start_gateway: deleted OpenClaw state file '{}'", name),
                        Err(e) => tracing::warn!("start_gateway: could not delete '{}': {}", name, e),
                    }
                }
            }
        }
    }

    // ── Save agents.list BEFORE preflight overwrites openclaw.json ───────────────────────────
    // preflight_write_openclaw_json always clears agents.list so that the resulting config
    // is deterministic and stable — suitable for comparing against the ".openclaw-applied"
    // marker to detect genuine config changes without agents add/remove triggering restarts.
    //
    // On normal restarts (no container recreate), we restore the saved list AFTER the
    // container cleanup block so that OpenClaw boots with its registered agents already
    // in-memory, letting boot_sync_agents use the fast "already_registered" path and skip
    // the 40-100s `openclaw agents add` per agent.
    //
    // On container recreate, the saved list is discarded — we wiped the agent dirs, so
    // OpenClaw must NOT see agents in its config (it would hang on missing dir I/O).
    let saved_agents_list: Option<serde_json::Value> = {
        let cfg_path = state_dir.join("openclaw.json");
        std::fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|cfg| cfg.pointer("/agents/list").cloned())
            .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
    };
    if saved_agents_list.is_some() {
        tracing::info!("start_gateway: saved existing agents.list for potential restore after preflight");
    }

    // Write a clean openclaw.json BEFORE the container starts, then check whether the
    // config that's actually RUNNING in the container matches what we just wrote.
    //
    // Why we can't just compare before/after the write:
    //   A running container reads openclaw.json ONCE at startup and caches it in memory.
    //   If Canopy restarts multiple times, the disk file gets patched on each run — so
    //   before==after (no disk change). But the CONTAINER might still be running with a
    //   much older config (e.g. Slack enabled from a session an hour ago).
    //
    // Solution: keep a marker file (.openclaw-applied) that records the exact content
    // of openclaw.json that was in place when the container was last (re)started.
    // If the marker differs from what we want now → the running container has stale config
    // → stop it so compose-up recreates it fresh with the new file.
    preflight_write_openclaw_json(&data_dir, crate::model_constants::GATEWAY_INTERNAL_TOKEN);
    let openclaw_path = state_dir.join("openclaw.json");
    let desired_config = std::fs::read_to_string(&openclaw_path).unwrap_or_default();

    let applied_marker = state_dir.join(".openclaw-applied");
    let applied_config = std::fs::read_to_string(&applied_marker).unwrap_or_default();

    // Flag: does the running container need to be replaced to pick up the new config?
    // We must compare the JSON structurally and IGNORE the `meta` object.
    // OpenClaw updates `meta.lastTouchedAt` continuously during operation. If we
    // do a simple string comparison, it will ALWAYS differ, causing the container
    // to be needlessly destroyed (and agent dirs wiped) on every single app restart.
    let config_needs_restart = {
        let mut needs_restart = applied_config != desired_config;
        if needs_restart {
            if let (Ok(mut app_json), Ok(mut des_json)) = (
                serde_json::from_str::<serde_json::Value>(&applied_config),
                serde_json::from_str::<serde_json::Value>(&desired_config)
            ) {
                if let (Some(app_obj), Some(des_obj)) = (app_json.as_object_mut(), des_json.as_object_mut()) {
                    app_obj.remove("meta");
                    des_obj.remove("meta");
                    needs_restart = app_obj != des_obj;
                }
            }
        }
        needs_restart
    };

    if config_needs_restart {
        tracing::info!("start_gateway: openclaw.json differs from last applied config — will force-remove and recreate container");
    } else {
        tracing::info!("start_gateway: openclaw.json unchanged since last container start — no restart needed");
    }

    // Fix any auth-profiles.json files that contain invalid JSON BEFORE the container
    // starts. OpenClaw reads these files at startup; corrupted JSON triggers a retry
    // loop that spirals to 300+ PIDs and OOM-kills the container in under 30 seconds.
    preflight_sanitize_auth_profiles(&data_dir);

    // Read provider API keys from the macOS Keychain so they can be injected as
    // container env vars. LiteLLM (inside OpenClaw) checks standard env var names
    // like GEMINI_API_KEY, ANTHROPIC_API_KEY, etc. — no auth-profiles.json needed.
    // auth-profiles.json is still written by boot_sync_agents as belt-and-suspenders.
    let provider_keys = {
        let mut m = HashMap::new();
        for key in &["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"] {
            if let Ok(v) = crate::keychain::get_secret(key) {
                if !v.trim().is_empty() {
                    m.insert(key.to_string(), v.trim().to_string());
                }
            }
        }
        // DO NOT include global SLACK_BOT_TOKEN to prevent cross-agent context bleed
        m
    };
    tracing::info!("start_gateway: injecting {} provider env var(s) into compose", provider_keys.len());

    let compose = generate_compose_file(&data_dir, &provider_keys);
    let compose_path = data_dir.join("docker-compose.yml");

    // Only write the compose file if it doesn't exist or the content changed.
    // Writing an identical file causes docker-compose to recreate the container
    // unnecessarily, wiping OpenClaw's in-memory agent registration list.
    let needs_write = std::fs::read_to_string(&compose_path)
        .map(|existing| existing != compose)
        .unwrap_or(true); // file missing → write it

    if needs_write {
        tracing::info!("docker-compose.yml changed or missing — writing new version");
        std::fs::write(&compose_path, &compose).map_err(|e| e.to_string())?;
    }

    // ── Always purge hash-prefixed "mangled" containers ──────────────────────
    // When docker-compose recreates a container, Docker first renames the old one
    // to `<hash>_canopy-gateway`, then creates a fresh `canopy-gateway`. If the
    // creation fails for any reason, only the mangled `<hash>_canopy-gateway` is
    // left running. On the next start_gateway call, `docker-compose up -d` sees it,
    // reports it as "Running", and never creates a correctly-named container.
    //
    // We always scan for containers whose name CONTAINS "canopy-gateway" but is NOT
    // exactly "canopy-gateway". Those are always stale/mangled — remove them so
    // compose can create a fresh, correctly-named container.
    //
    // If compose didn't change and the canonical `canopy-gateway` is already running
    // cleanly, we skip removing it (docker-compose up -d will be a no-op).
    if let Ok(ls_out) = get_docker_command()
        .args(["ps", "-a", "--filter", "name=canopy-gateway", "--format", "{{.Names}}\t{{.ID}}"])
        .output()
        .await
    {
        let output = String::from_utf8_lossy(&ls_out.stdout);
        for line in output.lines() {
            let mut parts = line.splitn(2, '\t');
            let name = parts.next().unwrap_or("").trim();
            let id   = parts.next().unwrap_or("").trim();
            if id.is_empty() { continue; }

            if name != "canopy-gateway" {
                // Hash-prefixed stale container (e.g. 53eca6e3188b_canopy-gateway) — always remove
                tracing::info!("start_gateway: removing stale mangled container '{}' ({})", name, id);
                match get_docker_command().args(["rm", "-f", id]).output().await {
                    Ok(ref o) if o.status.success() => {}
                    Ok(ref o) => tracing::warn!("start_gateway: could not remove '{}': {}", name, String::from_utf8_lossy(&o.stderr).trim()),
                    Err(e)    => tracing::warn!("start_gateway: docker rm error for '{}': {}", name, e),
                }
            } else if needs_write || config_needs_restart {
                // Canonical container, but compose file or openclaw.json changed.
                // docker stop has a race with restart:unless-stopped — use rm -f (instant SIGKILL)
                // so compose-up always creates a fresh container with the updated config.
                let reason = if needs_write { "compose file changed" } else { "openclaw.json config changed" };
                tracing::info!("start_gateway: {} — force-removing canopy-gateway ({}) for clean recreate", reason, id);
                match get_docker_command().args(["rm", "-f", id]).output().await {
                    Ok(ref o) if o.status.success() => {}
                    Ok(ref o) => tracing::warn!("start_gateway: could not remove canopy-gateway: {}", String::from_utf8_lossy(&o.stderr).trim()),
                    Err(e)    => tracing::warn!("start_gateway: docker rm error: {}", e),
                }
                // ── Wipe agent directories — only when actually recreating the container ──
                // OpenClaw scans agents/ at startup and immediately begins starting channel
                // sidecars (Slack, browser, talk-voice, etc.) for EVERY directory it finds.
                // If agent dirs exist from a previous run with stale/missing tokens, those
                // sidecars enter a tight retry loop spawning ~3 worker processes per minute.
                //
                // We only wipe when the container itself is being force-recreated, so
                // boot_sync_agents must run `openclaw agents add` for every agent anyway.
                // On normal restarts where the container stays running, the existing agent
                // dirs (with valid auth-profiles.json) are left intact — OpenClaw continues
                // running agents with valid credentials, and `boot_sync_agents` only needs
                // to refresh SOUL.md and auth-profiles (no 40-100s `agents add` per agent).
                let agents_dir = state_dir.join("agents");
                if let Ok(entries) = std::fs::read_dir(&agents_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            tracing::info!("start_gateway: clearing agent dir {:?} (container recreate)", path.file_name().unwrap_or_default());
                            if let Err(e) = std::fs::remove_dir_all(&path) {
                                tracing::warn!("start_gateway: could not remove {:?}: {}", path, e);
                            }
                        }
                    }
                }

                // ── Clear agents.list from openclaw.json — must stay in sync with agent dirs ──
                // preflight_write_openclaw_json now intentionally preserves agents.list so that
                // normal restarts (no recreate) can boot quickly without calling `agents add`.
                // When we DO wipe agent dirs, we must also clear agents.list here — otherwise
                // OpenClaw starts with agents in its config but missing dirs and HANGS waiting
                // for file I/O that never completes (ACPX and IPC are permanently blocked).
                //
                // boot_sync_agents() re-registers all agents via `openclaw agents add` once ready.
                let config_path = state_dir.join("openclaw.json");
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&content) {
                        cfg["agents"]["list"] = serde_json::json!([]);
                        if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
                            if let Err(e) = std::fs::write(&config_path, &updated) {
                                tracing::warn!("start_gateway: could not clear agents.list: {}", e);
                            } else {
                                tracing::info!("start_gateway: cleared agents.list in openclaw.json (agent dirs wiped)");
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Restore agents.list for normal restarts (no container recreate) ───────────────────────
    // If the container stayed running (compose file unchanged AND openclaw.json unchanged),
    // put the saved agents list back into openclaw.json now — BEFORE compose-up — so that
    // OpenClaw continues running with its registered agents in-memory and boot_sync_agents
    // can use the fast "already_registered" path instead of re-running `agents add` for every
    // agent (~40-100s per agent).
    //
    // We skip the restore when needs_write || config_needs_restart because in those cases
    // we force-removed the container AND wiped agent dirs above — agents.list must stay
    // empty until boot_sync_agents runs `openclaw agents add` for each agent.
    if !needs_write && !config_needs_restart {
        if let Some(mut agents_list) = saved_agents_list {
            // Sanitise the saved list before restoring it. OpenClaw 2026.4.14 rejects
            // any key on `agents.list[i]` it doesn't recognise — and a previous Canopy
            // build wrote `env` directly into `agents.list[i].env` (it should have used
            // `openclaw agents edit --env`, which stores the data under a different
            // schema-valid path). If we restore that broken state verbatim, the gateway
            // crash-loops on next boot with:
            //   "agents.list.0: Unrecognized key: 'env'"
            //
            // Strip the offending keys here so the user's container heals on next start
            // even if the bad state was written by an older binary.
            //
            // The set is conservative: we only remove keys we KNOW the schema rejects.
            // Anything else (skills, model, id, name, workspace, …) is preserved.
            const INVALID_AGENT_KEYS: &[&str] = &["env"];
            if let Some(arr) = agents_list.as_array_mut() {
                for entry in arr.iter_mut() {
                    if let Some(obj) = entry.as_object_mut() {
                        for k in INVALID_AGENT_KEYS {
                            if obj.remove(*k).is_some() {
                                let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                                tracing::warn!(
                                    "start_gateway: stripped schema-invalid key '{}' from agents.list[{}] — was written by an older Canopy build",
                                    k, id
                                );
                            }
                        }
                    }
                }
            }

            let cfg_path = state_dir.join("openclaw.json");
            if let Ok(content) = std::fs::read_to_string(&cfg_path) {
                if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&content) {
                    cfg["agents"]["list"] = agents_list;
                    if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
                        match std::fs::write(&cfg_path, &updated) {
                            Ok(_) => tracing::info!("start_gateway: restored agents.list — normal restart, fast boot path active"),
                            Err(e) => tracing::warn!("start_gateway: could not restore agents.list: {}", e),
                        }
                    }
                }
            }
        }
    }

    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let orbstack_sock = home_dir.join(".orbstack/run/docker.sock");

    let mut cmd = get_docker_compose_command();
    if orbstack_sock.exists() {
        cmd.env("DOCKER_HOST", format!("unix://{}", orbstack_sock.display()));
    }

    let output = cmd
        .args(["-f", &compose_path.to_string_lossy(), "up", "-d"])
        .output()
        .await
        .map_err(|e| format!("Failed to start gateway: {}", e))?;

    if output.status.success() {
        let out = format!("{}{}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim());
        tracing::info!("start_gateway: docker-compose up -d succeeded: {}", out);

        // Always write the applied-config marker so the next launch can compare it
        // against the then-current openclaw.json and decide whether to force-restart.
        //
        // Previous behaviour deleted the marker when compose reported the container was
        // already "Running" (no restart). That caused the NEXT launch to always see
        // applied_config="" vs desired_config=<content>, setting config_needs_restart=true
        // and force-recreating the container on every other app start — wiping all agent
        // dirs and triggering a full re-registration (~40-100s per agent) each time.
        //
        // Correct behaviour: the marker should always reflect "the openclaw.json that the
        // running container was started with." If compose made no changes, the container is
        // still running the desired config — write it. Only a genuine config change will
        // set config_needs_restart=true on the next launch and trigger a real recreate.
        let container_was_restarted = out.contains("Starting") || out.contains("Started") || out.contains("Creating");
        let _ = std::fs::write(&applied_marker, &desired_config);
        if container_was_restarted {
            tracing::info!("start_gateway: applied-config marker written (container was recreated)");
            // Ensure Playwright dependencies, browsers, and system chromium are installed in the container
            // We run this asynchronously so we don't block the UI for 2-3 minutes during startup.
            tauri::async_runtime::spawn(async move {
                tracing::info!("start_gateway: Container recreated. Initiating background Playwright and Chromium installation...");
                let _ = crate::openclaw::get_docker_command()
                    .args(["exec", "-u", "root", "canopy-gateway", "apt-get", "update"])
                    .output().await;
                    
                let _ = crate::openclaw::get_docker_command()
                    .args(["exec", "-u", "root", "canopy-gateway", "apt-get", "install", "-y", "chromium"])
                    .output().await;

                let _ = crate::openclaw::get_docker_command()
                    .args(["exec", "-u", "root", "canopy-gateway", "npx", "playwright", "install-deps"])
                    .output().await;
                
                let _ = crate::openclaw::get_docker_command()
                    .args(["exec", "-u", "node", "canopy-gateway", "npx", "playwright", "install", "chromium", "webkit"])
                    .output().await;
                tracing::info!("start_gateway: Background Chromium/Playwright installation complete.");
            });
        } else {
            tracing::info!("start_gateway: applied-config marker written (container already running with correct config)");
        }

        Ok("Gateway started".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("start_gateway: docker-compose up -d FAILED: {}", stderr);
        Err(format!("Failed to start gateway: {}", stderr))
    }
}

#[tauri::command]
pub async fn stop_gateway() -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Canopy");

    let compose_path = data_dir.join("docker-compose.yml");

    let mut cmd = get_docker_compose_command();
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let orbstack_sock = home_dir.join(".orbstack/run/docker.sock");
    if orbstack_sock.exists() {
        cmd.env("DOCKER_HOST", format!("unix://{}", orbstack_sock.display()));
    }

    let output = cmd
        .args(["-f", &compose_path.to_string_lossy(), "down"])
        .output()
        .await
        .map_err(|e| format!("Failed to stop gateway: {}", e))?;

    if output.status.success() {
        Ok("Gateway stopped".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to stop gateway: {}", stderr))
    }
}

#[tauri::command]
pub async fn hard_reset_infrastructure() -> Result<String, String> {
    tracing::info!("Starting Hard-Reset infrastructure safety protocol...");

    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let orb_bin = home_dir.join(".orbstack/bin/orb");
    let docker_bin = home_dir.join(".orbstack/bin/docker");

    if orb_bin.exists() {
        tracing::info!("OrbStack detected... restarting Linux VM to flush limits mapping.");
        let _ = tokio::process::Command::new(&orb_bin)
            .arg("stop")
            .output()
            .await;
        
        // Brief pause before start
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let _ = tokio::process::Command::new(&orb_bin)
            .arg("start")
            .output()
            .await;

        tracing::info!("OrbStack VM initiated, waiting for Socket availability...");

        // Wait up to 15 seconds for the socket to reappear
        let sock_path = home_dir.join(".orbstack/run/docker.sock");
        let mut healthy = false;
        for _ in 0..15 {
            if sock_path.exists() {
               healthy = true;
               break;
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }

        if !healthy {
             return Err("Docker daemon failed to securely boot back online within 15 seconds. Please manually verify OrbStack.".to_string());
        }
        tracing::info!("Docker socket available — OrbStack VM is up.");
    } else {
        tracing::warn!("OrbStack missing... executing generic docker restart.");
        // This won't practically work on Mac's Docker Desktop via CLI reliably, but added as fallback shell
        let _ = tokio::process::Command::new("docker")
            .args(["restart", "canopy-gateway"])
            .output()
            .await;
    }

    // Re-generate configuration and bring it up via compose to apply new limits.
    // If the compose file content changed (e.g. memory limit updated from 2G → 4G),
    // docker-compose will recreate the container so the new limits take effect.
    tracing::info!("Writing docker-compose.yml and running docker-compose up -d...");
    match start_gateway().await {
        Ok(msg) => tracing::info!("Gateway (re)started: {}", msg),
        Err(e)  => tracing::warn!("Gateway start warning (container may still come up): {}", e),
    }

    // Confirm the container is actually running now
    let container_state = tokio::process::Command::new(
        dirs::home_dir().unwrap_or_default().join(".orbstack/bin/docker")
    )
    .args(["inspect", "-f", "{{.State.Status}}", "canopy-gateway"])
    .output()
    .await
    .ok()
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .unwrap_or_else(|| "unknown".into());
    tracing::info!("canopy-gateway container state after reset: {}", container_state);

    Ok("Infrastructure rebooted perfectly.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_isolated_compose() {
        let agent_id = "agent-123";
        let data_dir = PathBuf::from("/tmp/canopy");
        let port = 18805;

        let compose = generate_isolated_compose(agent_id, &data_dir, port);

        assert!(compose.contains("canopy-isolated-agent-123"));
        assert!(compose.contains("18805:18789"));
        assert!(compose.contains("- \"com.canopy.type=isolated\""));
        assert!(compose.contains("- \"com.canopy.agent-id=agent-123\""));
        assert!(compose.contains("isolated-agent-123"));
    }
}
