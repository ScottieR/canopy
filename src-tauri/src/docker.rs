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
fn generate_compose_file(data_dir: &PathBuf) -> String {
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
          memory: 8G
          cpus: '4.0'
          # ⚠️  Use deploy.resources.limits.pids, NOT top-level pids_limit.
          # docker-compose v2 (OrbStack) rejects having both set simultaneously.
          #
          # Process budget with 1 active agent + 2 plugins (acpx, browser):
          #   - browser plugin: 1 Chromium instance (stable with shm_size fix) ~50-100 PIDs
          #   - Core OpenClaw runtime + tini: ~50 PIDs
          #   - ACPX embedded runtime: ~30 PIDs
          #   - Headroom + retry grace: 2x buffer
          # 500 acts as a circuit-breaker against runaway spirals while allowing
          # normal Chromium + OpenClaw operation. Raise if multi-agent + browser is needed.
          pids: 500
    healthcheck:
      # ⚠️  This curl runs INSIDE the container — use container port 18789, not host port 18799
      test: ["CMD", "curl", "-f", "http://localhost:18789/status"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  openclaw-state:
  openclaw-workspace:
"#,
        data = data_dir.display()
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

    // Always start from a clean slate — never read the existing file.
    let mut cfg: JsonValue = serde_json::json!({});

    // ── Gateway auth — always set to our token ────────────────────────────────
    cfg["gateway"]["auth"]["mode"] = serde_json::json!("token");
    cfg["gateway"]["auth"]["token"] = serde_json::json!(token);
    cfg["gateway"]["mode"] = serde_json::json!("local");
    cfg["gateway"]["port"] = serde_json::json!(18789);

    // ── Disable channels that start heavyweight sidecars ─────────────────────
    // Slack socket-mode sidecar: ALWAYS disabled at gateway startup.
    //
    // The previous code had a conditional bug: it only set enabled=false when slack
    // was ALREADY false. If a previous run had enabled=true (persisted in the bind-mount
    // openclaw.json), it was preserved — and Slack would connect, hit pong timeouts,
    // enter a reconnect loop, and block the IPC event loop indefinitely.
    //
    // We ALWAYS force-disable here. When the user connects Slack via the Integrations
    // tab, we write the tokens to the keychain and restart the gateway with the
    // SLACK_BOT_TOKEN / SLACK_APP_TOKEN env vars set in docker-compose.yml — that's
    // the correct way to enable Slack (env vars, not just openclaw.json).
    cfg["channels"]["slack"]["enabled"] = serde_json::json!(false);

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

    // ── Workspace path — must match the volume mount inside the container ─────
    // Verified from working reference: ./workspace:/home/node/.openclaw/workspace
    cfg["agents"]["defaults"]["workspace"] = serde_json::json!("/home/node/.openclaw/workspace");

    // ── Force-set a known-good default model ─────────────────────────────────
    // When a PID spiral corrupts the openclaw.json (e.g. writing "openai/gpt-5.4",
    // a phantom model that doesn't exist), ACPX's embedded runtime tries to initialize
    // the OpenAI client for that model on every startup. The client hangs for 4-8
    // minutes trying to connect/validate, which blocks the entire Node.js event loop —
    // IPC never responds even though the gateway reports "ready".
    //
    // Always override to our stable default (gemini-3.1-flash-lite-preview). This is safe
    // because:
    //   • Each agent gets its own model set via `openclaw agents add --model X`
    //   • agents.defaults.model is only the fallback for agents with no explicit model
    //   • Google keys are already configured in every Canopy deployment
    //
    // ⚠️  CRITICAL: OpenClaw requires model to be an OBJECT `{"primary": "..."}`, NOT a
    // bare string. A plain string is silently ignored — the agent has no model and every
    // openclaw agent --message call returns "OpenClaw: model not found" (or times out).
    let default_model = crate::model_constants::DEFAULT_GEMINI_MODEL;
    cfg["agents"]["defaults"]["model"] = serde_json::json!({ "primary": default_model });
    // Register the model in the models map so ACPX knows it is a valid selection.
    // The empty-object value tells OpenClaw to use global defaults for that model.
    cfg["agents"]["defaults"]["models"][default_model] = serde_json::json!({});

    // ── Disable memory search (requires vector DB, causes startup lag) ────────
    cfg["agents"]["defaults"]["memorySearch"]["enabled"] = serde_json::json!(false);

    // ── Disable heavyweight plugins — prevents per-agent sidecar OOM ──────────
    // When these plugins are enabled, OpenClaw spawns per-agent sidecar processes
    // when a new agent is hot-reloaded into a running gateway:
    //   • browser:       Chromium instance per agent (~80–150 PIDs)
    //   • talk-voice:    audio codec processes (~20–40 PIDs)
    //   • phone-control: iMessage relay process (hangs in Docker — no macOS IPC)
    //   • device-pair:   Bluetooth/LAN device discovery (retry-loops in bridge network)
    //
    // In Docker's bridge network these sidecars either retry indefinitely (blocking
    // the Node.js event loop) or consume memory until the container is OOM-killed.
    // Observed: container dies ~45s after the first hot reload with all plugins active.
    //
    // These are set PER-BOOT. When a user enables iMessage, voice, or browser tools
    // from the Integrations tab, we restart the gateway with the appropriate env vars
    // and re-enable only the needed plugin at that time. Until then: disabled.
    //
    // Plugin IDs from gateway log: "ready (5 plugins: acpx, browser, device-pair,
    // phone-control, talk-voice)". The acpx plugin is always enabled (built-in core).
    // browser: keep enabled — ACPX co-initializes with browser via a shared internal
    // event (observed: both register at the exact same moment after Bonjour announces).
    // Disabling browser leaves ACPX stuck waiting for that trigger indefinitely.
    cfg["plugins"]["entries"]["browser"]["enabled"]       = serde_json::json!(true);
    // The three below spawn per-agent sidecar processes (iMessage relay, Bluetooth
    // device pairing, audio codec workers) that OOM the container in Docker's bridge
    // network. Disable them until those features are explicitly activated by the user.
    cfg["plugins"]["entries"]["device-pair"]["enabled"]   = serde_json::json!(false);
    cfg["plugins"]["entries"]["phone-control"]["enabled"] = serde_json::json!(false);
    cfg["plugins"]["entries"]["talk-voice"]["enabled"]    = serde_json::json!(false);
    // Preserve google plugin (required for Gemini API via ACPX)
    cfg["plugins"]["entries"]["google"]["enabled"]        = serde_json::json!(true);

    // ── Clear the registered agents list ─────────────────────────────────────
    // When agents are in agents.list, OpenClaw tries to initialize them at startup
    // (loading SOUL.md, workspace, credentials) before completing the plugin pipeline.
    // If the agent directories were wiped (as we do in start_gateway()), OpenClaw
    // hits missing files and HANGS — the event loop blocks waiting for file I/O that
    // never completes. ACPX, browser, and heartbeat never start; IPC is permanently
    // blocked even though the gateway reports "ready".
    //
    // WHY this doesn't cause a size-drop anomaly (unlike before):
    //   We now DELETE all backup files (bak.1, bak.2, …) before each container start.
    //   Without a "last-good" backup to compare against, OpenClaw has no baseline —
    //   it cannot fire the size-drop anomaly regardless of how much the config shrinks.
    //   After a clean boot, OpenClaw creates a NEW small backup from our clean config.
    //   On the next boot, the backup size matches our config → no anomaly.
    //
    // boot_sync_agents() re-registers all agents via IPC once the gateway is up.
    // openclaw agents add is idempotent — it replaces stale entries with fresh data.
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

    // ── Wipe agent directories before every container start ──────────────────
    // OpenClaw scans agents/ at startup and immediately begins starting channel
    // sidecars (Slack, browser, talk-voice, etc.) for EVERY directory it finds.
    // If agent dirs exist from a previous run, those sidecars start before our
    // openclaw tokens/configs are in place — Slack with no token enters a tight
    // retry loop, spawning ~3 worker processes per minute that never exit.
    // After ~5 minutes you have 30+ processes consuming all CPU/RAM.
    //
    // Deleting agent dirs ensures OpenClaw boots with zero agents → zero sidecars
    // → IPC is immediately responsive.
    //
    // This is safe:
    //   • SOUL.md / workspace files live in openclaw-state/workspace/{id}/ — NOT in agents/
    //   • Agent metadata (name, role, emoji, keys) is in SQLite — boot_sync_agents re-registers all agents
    //   • Slack credentials live in openclaw-state/credentials/ — NOT in agents/
    //   • Only per-session runtime state (session logs, channel auth state) is discarded — it's transient
    let agents_dir = state_dir.join("agents");
    if let Ok(entries) = std::fs::read_dir(&agents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                tracing::info!("start_gateway: clearing agent dir {:?} to prevent stale sidecar init", path.file_name().unwrap_or_default());
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    tracing::warn!("start_gateway: could not remove {:?}: {}", path, e);
                }
            }
        }
    }

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
    // Used below in the container cleanup block to force rm -f on the canonical container.
    let config_needs_restart = applied_config != desired_config;
    if config_needs_restart {
        tracing::info!("start_gateway: openclaw.json differs from last applied config — will force-remove and recreate container");
    } else {
        tracing::info!("start_gateway: openclaw.json unchanged since last container start — no restart needed");
    }

    // Fix any auth-profiles.json files that contain invalid JSON BEFORE the container
    // starts. OpenClaw reads these files at startup; corrupted JSON triggers a retry
    // loop that spirals to 300+ PIDs and OOM-kills the container in under 30 seconds.
    preflight_sanitize_auth_profiles(&data_dir);

    let compose = generate_compose_file(&data_dir);
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

        // Update the applied-config marker ONLY if the container was actually
        // (re)started — not if compose reported it was already "Running" unchanged.
        // If we write the marker when the container didn't restart, the next launch
        // would think the config is applied when it isn't, skipping the necessary restart.
        let container_was_restarted = out.contains("Starting") || out.contains("Started") || out.contains("Creating");
        if container_was_restarted {
            let _ = std::fs::write(&applied_marker, &desired_config);
            tracing::info!("start_gateway: applied-config marker updated (container was recreated)");
        } else {
            // Container was already running and compose made no changes.
            // Delete the marker so the next launch knows to restart.
            let _ = std::fs::remove_file(&applied_marker);
            tracing::info!("start_gateway: container unchanged (compose: Running) — marker cleared for next launch restart");
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
