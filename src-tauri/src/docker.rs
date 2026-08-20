use anyhow::{Context, Result};
use bollard::container::{ListContainersOptions, StatsOptions};
use bollard::Docker;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::models::ContainerStatus;
use crate::openclaw::get_docker_command;

/// Write a runtime control file with owner-only permissions.
///
/// Compose files must not contain provider credentials, but they still describe
/// local ports and host mount paths. Keeping every generated control file at
/// `0600` prevents other local users from learning or modifying that topology.
pub(crate) fn write_private_file(path: &Path, contents: impl AsRef<[u8]>) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open {}: {}", path.display(), error))?;
    file.write_all(contents.as_ref())
        .map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
    file.sync_data()
        .map_err(|error| format!("Failed to flush {}: {}", path.display(), error))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure {}: {}", path.display(), error))?;
    }

    Ok(())
}

/// Manages OrbStack/Docker containers for OpenClaw instances.
/// Users never see Docker — this is the invisible infrastructure layer.
pub struct DockerManager {
    docker: Docker,
}

impl DockerManager {
    /// Connect to Docker via OrbStack's socket
    pub async fn init() -> Result<Self> {
        let mut docker = match Docker::connect_with_socket_defaults() {
            Ok(docker) => docker,
            Err(_) => {
                // Default socket discovery failed (e.g. OrbStack's socket isn't
                // up yet at app launch — a real startup race, not hypothetical).
                // Previously this fell through to a bare `.unwrap()`, which
                // aborted the whole app (panic = "abort" in release) instead of
                // letting the caller handle it like every other failure path
                // here does. See GitHub issue #17.
                let home = dirs::home_dir().unwrap_or_default();
                let orb_sock = home.join(".orbstack/run/docker.sock");
                Docker::connect_with_socket(
                    &orb_sock.to_string_lossy(),
                    120,
                    bollard::API_DEFAULT_VERSION,
                )
                .context("Failed to connect to OrbStack via default or fallback socket")?
            }
        };

        if docker.ping().await.is_err() {
            let home = dirs::home_dir().unwrap_or_default();
            let orb_sock = home.join(".orbstack/run/docker.sock");
            docker = Docker::connect_with_socket(
                &orb_sock.to_string_lossy(),
                120,
                bollard::API_DEFAULT_VERSION,
            )
            .context("Failed to connect to OrbStack explicitly")?;
        }

        // Verify connection
        docker
            .ping()
            .await
            .context("Docker ping failed. Is OrbStack running?")?;
        tracing::info!("Connected to Docker engine");

        Ok(Self { docker })
    }

    /// Get the Docker client reference
    pub fn client(&self) -> &Docker {
        &self.docker
    }
}

/// Restart the local container engine without invoking a command shell.
///
/// All executable names and arguments are fixed application constants. Keeping
/// this as direct process execution prevents future refactors from accidentally
/// interpolating container names or error text into a `sh -c` string.
fn restart_local_container_engine() {
    let orb_stopped = std::process::Command::new("orbctl")
        .arg("stop")
        .status()
        .is_ok_and(|status| status.success());
    if orb_stopped {
        if !std::process::Command::new("orbctl")
            .arg("start")
            .status()
            .is_ok_and(|status| status.success())
        {
            tracing::warn!("restart_local_container_engine: orbctl start failed");
        }
        return;
    }

    for (app, quit_script) in [
        ("OrbStack", "quit app \"OrbStack\""),
        ("Docker", "quit app \"Docker\""),
    ] {
        let quit_succeeded = std::process::Command::new("osascript")
            .args(["-e", quit_script])
            .status()
            .is_ok_and(|status| status.success());
        if !quit_succeeded {
            continue;
        }

        std::thread::sleep(std::time::Duration::from_secs(3));
        if std::process::Command::new("open")
            .args(["-a", app])
            .status()
            .is_ok_and(|status| status.success())
        {
            return;
        }
    }

    tracing::warn!("restart_local_container_engine: no supported engine could be restarted");
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
pub async fn check_docker_installed() -> Result<bool, String> {
    let output = tokio::process::Command::new("which")
        .arg("docker")
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
        // Immediately apply the correct memory ceiling so the VM never starts undersized.
        let _ = ensure_orbstack_memory_internal().await;
        Ok("OrbStack installed successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("OrbStack installation failed: {}", stderr))
    }
}

// ─── OrbStack VM memory configuration ────────────────────────────────────────

/// Minimum VM memory for comfortable multi-agent operation.
/// - 4 GB  canopy-gateway container
/// - 512 MB canopy-chroma container
/// - ~1 GB  OrbStack VM kernel + macOS IPC overhead
/// - headroom for isolated agents and future growth
const ORBSTACK_TARGET_MEMORY_MIB: u64 = 16_384; // 16 GB

/// Read/update `~/.orbstack/config/config.json` to ensure the VM gets at least
/// `ORBSTACK_TARGET_MEMORY_MIB` of RAM.
///
/// Returns `(changed, previous_mib, new_mib)`.
///
/// If the value was already sufficient, the file is NOT touched and `changed = false`.
/// A restart is required for the new value to take effect — callers decide whether to
/// trigger one.
async fn ensure_orbstack_memory_internal() -> Result<(bool, u64, u64), String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let config_dir = home.join(".orbstack/config");
    let config_path = config_dir.join("config.json");

    // Read existing config, or start from empty object.
    let existing_raw = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read OrbStack config: {}", e))?
    } else {
        "{}".to_string()
    };

    let mut cfg: serde_json::Value =
        serde_json::from_str(&existing_raw).unwrap_or(serde_json::json!({}));

    let current_mib: u64 = cfg.get("vmMemoryMiB").and_then(|v| v.as_u64()).unwrap_or(0); // 0 = not set → OrbStack picks its own default (~8 GB)

    if current_mib >= ORBSTACK_TARGET_MEMORY_MIB {
        return Ok((false, current_mib, current_mib));
    }

    // Apply the new ceiling.
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create OrbStack config dir: {}", e))?;
    cfg["vmMemoryMiB"] = serde_json::json!(ORBSTACK_TARGET_MEMORY_MIB);
    let updated = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("Failed to serialize OrbStack config: {}", e))?;
    std::fs::write(&config_path, updated)
        .map_err(|e| format!("Failed to write OrbStack config: {}", e))?;

    tracing::info!(
        "OrbStack VM memory updated: {} MiB → {} MiB",
        current_mib,
        ORBSTACK_TARGET_MEMORY_MIB
    );
    Ok((true, current_mib, ORBSTACK_TARGET_MEMORY_MIB))
}

/// Tauri command — called from the setup/diagnostics flow.
///
/// Ensures the OrbStack VM is configured for 16 GB. If the value changed, restarts
/// the OrbStack VM so the new limit takes effect immediately (takes ~5-10 s).
///
/// Returns a human-readable status string suitable for display in the UI.
#[tauri::command]
pub async fn configure_orbstack_memory() -> Result<String, String> {
    let (changed, prev_mib, new_mib) = ensure_orbstack_memory_internal().await?;

    if !changed {
        return Ok(format!(
            "OrbStack VM memory already at {} GB — no change needed.",
            new_mib / 1024
        ));
    }

    // Restart the VM so the new memory limit takes effect.
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let orb_bin = home.join(".orbstack/bin/orb");

    if orb_bin.exists() {
        tracing::info!(
            "Restarting OrbStack VM to apply new memory limit ({} MiB)…",
            new_mib
        );
        let _ = tokio::process::Command::new(&orb_bin)
            .arg("stop")
            .output()
            .await;
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        let _ = tokio::process::Command::new(&orb_bin)
            .arg("start")
            .output()
            .await;

        // Wait up to 20 s for the Docker socket to reappear.
        let sock_path = home.join(".orbstack/run/docker.sock");
        let mut up = false;
        for _ in 0..20 {
            if sock_path.exists() {
                up = true;
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }

        if !up {
            return Err(format!(
                "OrbStack config updated ({} GB → {} GB) but the VM did not restart within 20 s. \
                 Please restart OrbStack manually from the menu bar.",
                prev_mib / 1024,
                new_mib / 1024
            ));
        }
    }

    Ok(format!(
        "OrbStack VM memory raised from {} GB to {} GB and restarted successfully.",
        prev_mib / 1024,
        new_mib / 1024
    ))
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
        // The managed label matches BOTH flavors' containers. Reporting the other
        // flavor's fleet here is how a fresh dev instance "adopted" the prod
        // gateway and agents as its own (2026-08-15 incident) — skip them.
        if !crate::flavor::container_belongs_to_active_flavor(&name) {
            continue;
        }
        let state = container.state.unwrap_or_default();

        statuses.push(ContainerStatus {
            id,
            name,
            state,
            health: "healthy".to_string(), // TODO: parse from health check
            memory_mb: 0.0,                // TODO: get from stats
            cpu_percent: 0.0,
            port: crate::model_constants::gateway_host_port(), // host-facing port, not container-internal (18789)
        });
    }

    Ok(statuses)
}

/// Generate the docker-compose.yml for the shared gateway.
///
/// Port mapping: HOST gateway_host_port() → CONTAINER 18789 (flavored: prod
/// 18799, dev 18797 — see `flavor.rs`; container names are flavored too).
/// - Rust code talking to the gateway from the host uses gateway_host_port().
/// - The healthcheck curl runs *inside* the container, so it correctly uses 18789
///   (GATEWAY_CONTAINER_PORT). Do NOT change the healthcheck URL to 18799.
///
/// Provider credentials are deliberately absent from this file. Agent-scoped
/// auth-profiles.json files are generated from the macOS Keychain at runtime,
/// avoiding plaintext secrets in compose files and container metadata.
fn generate_compose_file(data_dir: &PathBuf) -> String {
    let crash_guard_js = r#"// [Canopy Auto-Generated] Prevent unhandled exceptions from taking down the container
process.on('uncaughtException', (err) => {
    console.error('[CRASH GUARD] Prevented fatal container exit from uncaught exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH GUARD] Prevented fatal container exit from unhandled rejection at:', promise, 'reason:', reason);
});
"#;
    let state_dir = data_dir.join("openclaw-state");
    let _ = std::fs::create_dir_all(&state_dir);
    let _ = std::fs::write(state_dir.join("crash_guard.cjs"), crash_guard_js);

    let flavor = crate::flavor::flavor();
    format!(
        r#"name: {project}
services:
  {gateway}:
    image: ghcr.io/openclaw/openclaw:2026.7.1
    container_name: {gateway}
    restart: unless-stopped
    labels:
      - "com.canopy.managed=true"
      - "com.canopy.type=shared-gateway"
      - "com.canopy.flavor={flavor_name}"
    ports:
      - "127.0.0.1:{gw_port}:18789"   # Loopback only — never expose the gateway on the LAN
      - "127.0.0.1:{aux0}:18790"
      - "127.0.0.1:{aux1}:18791"
    volumes:
      # config dir → /home/node/.openclaw  (openclaw.json, agents/, credentials/, etc.)
      - {data}/openclaw-state:/home/node/.openclaw
      # workspace → /home/node/.openclaw/workspace  (SOUL.md, IDENTITY.md, state/, etc.)
      # ⚠️  Must be INSIDE .openclaw, not a sibling dir — verified from working reference agent
      - {data}/openclaw-state/workspace:/home/node/.openclaw/workspace
    environment:
      - NODE_ENV=production
      - NODE_OPTIONS=--require /home/node/.openclaw/crash_guard.cjs
    extra_hosts:
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
          # ── Memory budget ──────────────────────────────────────────────────────
          # OrbStack's default VM size is 8 GB. We MUST stay well below that total
          # so the OOM killer inside the VM never fires.
          #
          # Memory breakdown for normal operation (3–5 agents, external LLM APIs):
          #   - Node.js runtime + OpenClaw core: ~300 MB
          #   - Per-agent session context (SQLite + markdown): ~100 MB each
          #   - LLM response buffering (large completions): ~500 MB
          #   - shm_size allocated separately (2 GB): does NOT count here
          #   - Total realistic peak: ~1.5–2 GB
          #
          # We set 4 GB — 2× the realistic peak — as a comfortable ceiling.
          # This leaves 4 GB for: OrbStack VM overhead (~1 GB), canopy-chroma
          # (~512 MB), macOS host pressure, and growth headroom.
          #
          # To run heavier workloads (many concurrent forums, browser plugin):
          #   Raise OrbStack VM memory in OrbStack > Settings > Resources to 12–16 GB
          #   and raise this limit to match.
          memory: 4G
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
      
  {chroma}:
    image: chromadb/chroma:0.4.24
    container_name: {chroma}
    restart: unless-stopped
    ports:
      - "127.0.0.1:{chroma_port}:8000"
    volumes:
      - {data}/chroma-data:/chroma/chroma
    deploy:
      resources:
        limits:
          # Chroma is a local vector DB for agent memory search.
          # Personal-scale workloads (thousands of memories) stay well under 512 MB.
          # Without this limit, Chroma competes with canopy-gateway for the OrbStack VM budget.
          memory: 512m

volumes:
  openclaw-state:
  chroma-data:
  openclaw-workspace:
"#,
        project = flavor.compose_project,
        gateway = flavor.gateway_container,
        flavor_name = flavor.name,
        gw_port = flavor.gateway_host_port,
        aux0 = flavor.gateway_aux_host_ports.0,
        aux1 = flavor.gateway_aux_host_ports.1,
        chroma = flavor.chroma_container,
        chroma_port = flavor.chroma_host_port,
        data = data_dir.display(),
    )
}

fn format_allowed_directory_volume(
    grant: &crate::workspace_manager::FolderGrant,
) -> Option<String> {
    let source = serde_json::to_string(&grant.path).ok()?;
    let target = serde_json::to_string(&format!(
        "/home/node/.openclaw/workspace/mounts/{}",
        grant.id
    ))
    .ok()?;
    let read_only = grant.access == crate::workspace_manager::FolderAccessMode::ReadOnly;
    Some(format!(
        "      - type: bind\n        source: {}\n        target: {}\n        read_only: {}\n",
        source, target, read_only
    ))
}

/// Generate docker-compose for an isolated agent container
pub fn generate_isolated_compose(agent_id: &str, data_dir: &PathBuf, host_port: u16) -> String {
    let crash_guard_js = r#"// [Canopy Auto-Generated] Prevent unhandled exceptions from taking down the container
process.on('uncaughtException', (err) => {
    console.error('[CRASH GUARD] Prevented fatal container exit from uncaught exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH GUARD] Prevented fatal container exit from unhandled rejection at:', promise, 'reason:', reason);
});
"#;
    let state_dir = data_dir.join("isolated").join(agent_id).join("state");
    let _ = std::fs::create_dir_all(&state_dir);
    let _ = std::fs::write(state_dir.join("crash_guard.cjs"), crash_guard_js);

    let mut extra_volumes = String::new();
    if let Ok(grants) = crate::workspace_manager::get_folder_grants_for_agent(agent_id) {
        for grant in grants.into_iter().filter(|grant| grant.active) {
            if let Some(volume) = format_allowed_directory_volume(&grant) {
                extra_volumes.push_str(&volume);
            }
        }
    }

    let container_name = crate::flavor::isolated_container_name(agent_id);
    format!(
        r#"name: {name}
services:
  {name}:
    image: ghcr.io/openclaw/openclaw:2026.7.1
    container_name: {name}
    restart: unless-stopped
    labels:
      - "com.canopy.managed=true"
      - "com.canopy.type=isolated"
      - "com.canopy.agent-id={id}"
      - "com.canopy.flavor={flavor_name}"
    ports:
      - "127.0.0.1:{port}:18789"
    volumes:
      - {data}/isolated/{id}/state:/home/node/.openclaw
      - {data}/isolated/{id}/workspace:/home/node/.openclaw/workspace
{extra_volumes}      # - {data}/isolated/{id}/config/openclaw.json:/home/node/.openclaw/openclaw.json:ro
    environment:
      - NODE_ENV=production
      - NODE_OPTIONS=--require /home/node/.openclaw/crash_guard.cjs
    deploy:
      resources:
        limits:
          # Isolated containers get a capped budget so they can't OOM the OrbStack VM.
          # 2 GB is generous for a single agent proxying to external LLM APIs.
          memory: 2G
          pids: 200
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
        name = container_name,
        id = agent_id,
        flavor_name = crate::flavor::flavor().name,
        data = data_dir.display(),
        port = host_port,
        extra_volumes = extra_volumes
    )
}

/// Label every Canopy-managed isolated container carries (see
/// `generate_isolated_compose`). Matching on the label rather than the name survives
/// renames and never picks up a container Canopy didn't create.
pub const ISOLATED_TYPE_LABEL: &str = "com.canopy.type=isolated";
/// Label holding the owning agent id.
pub const AGENT_ID_LABEL: &str = "com.canopy.agent-id";

fn canopy_data_dir() -> Option<PathBuf> {
    crate::flavor::canopy_data_dir()
}

/// Return the container's Docker state (`running`, `exited`, …), or `None` if no such
/// container exists.
async fn container_state(container_name: &str) -> Option<String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::openclaw::get_docker_command()
            .args(["inspect", "--format", "{{.State.Status}}", container_name])
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None; // `inspect` fails when the container doesn't exist
    }
    let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!state.is_empty()).then_some(state)
}

/// Remove an agent's isolated container and CONFIRM it is gone.
///
/// The compose file sets `restart: unless-stopped`, so a container that survives
/// teardown is not merely stale — it resurrects on every Docker daemon start and runs
/// forever against a frozen config. Every exit path here is therefore checked:
///
///   1. `compose down` (the graceful path, also removes the project network)
///   2. verify by `docker inspect`; if the container is still there, `docker rm -f`
///   3. verify again — only then report success
///   4. retire the compose file so nothing can `compose up` it back
///
/// The agent's `isolated/<id>/state` and `workspace` directories are deliberately
/// left untouched: re-isolating later must restore the agent exactly as it was.
pub async fn teardown_isolated_container(agent_id: &str) -> Result<(), String> {
    let container_name = crate::flavor::isolated_container_name(agent_id);
    let data_dir = canopy_data_dir().ok_or("Could not locate the Canopy data directory")?;
    let compose_path = data_dir.join(format!("docker-compose-{}.yml", agent_id));

    // ── 1. Graceful teardown ─────────────────────────────────────────────────
    if compose_path.exists() {
        let compose_arg = compose_path.to_string_lossy().to_string();
        match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            get_docker_compose_command()
                .args(["-f", compose_arg.as_str(), "down"])
                .output(),
        )
        .await
        {
            Ok(Ok(out)) if out.status.success() => {
                tracing::info!(
                    "teardown_isolated_container: compose down ok for {}",
                    agent_id
                );
            }
            Ok(Ok(out)) => tracing::warn!(
                "teardown_isolated_container: compose down exited {} for {}: {}",
                out.status,
                agent_id,
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Ok(Err(e)) => {
                tracing::warn!(
                    "teardown_isolated_container: compose down failed to spawn for {}: {}",
                    agent_id,
                    e
                )
            }
            Err(_) => tracing::warn!(
                "teardown_isolated_container: compose down timed out for {}",
                agent_id
            ),
        }
    }

    // ── 2. Verify, then force ────────────────────────────────────────────────
    if let Some(state) = container_state(&container_name).await {
        tracing::warn!(
            "teardown_isolated_container: {} still present after compose down (state={}), forcing removal",
            container_name,
            state
        );
        let forced = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            crate::openclaw::get_docker_command()
                .args(["rm", "-f", &container_name])
                .output(),
        )
        .await;
        match forced {
            Ok(Ok(out)) if out.status.success() => {}
            Ok(Ok(out)) => {
                return Err(format!(
                    "docker rm -f {} exited {}: {}",
                    container_name,
                    out.status,
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
            Ok(Err(e)) => return Err(format!("docker rm -f {} failed: {}", container_name, e)),
            Err(_) => return Err(format!("docker rm -f {} timed out", container_name)),
        }
    }

    // ── 3. Confirm ───────────────────────────────────────────────────────────
    if let Some(state) = container_state(&container_name).await {
        return Err(format!(
            "{} is still present after forced removal (state={})",
            container_name, state
        ));
    }

    // ── 4. Retire the compose file ───────────────────────────────────────────
    // Leaving it in place means any stray `compose up` — including our own boot path
    // if the DB flag flaps — can resurrect the container. A fresh one is generated
    // from scratch whenever the agent is isolated again.
    if compose_path.exists() {
        let retired = compose_path.with_extension("yml.orphaned");
        if let Err(e) = std::fs::rename(&compose_path, &retired) {
            tracing::warn!(
                "teardown_isolated_container: could not retire {}: {}",
                compose_path.display(),
                e
            );
        }
    }

    tracing::info!(
        "teardown_isolated_container: {} removed; state dir preserved",
        container_name
    );
    Ok(())
}

/// Every `(agent_id, container_name)` pair Docker currently knows about that carries
/// the Canopy isolated label — running or stopped.
pub async fn list_isolated_containers() -> Vec<(String, String)> {
    let format_arg = format!("{{{{.Label \"{}\"}}}}|{{{{.Names}}}}", AGENT_ID_LABEL);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::openclaw::get_docker_command()
            .args([
                "ps",
                "-a",
                "--filter",
                &format!("label={}", ISOLATED_TYPE_LABEL),
                "--format",
                &format_arg,
            ])
            .output(),
    )
    .await;

    let Ok(Ok(output)) = output else {
        tracing::warn!("list_isolated_containers: docker ps failed or timed out");
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (agent_id, name) = line.split_once('|')?;
            let (agent_id, name) = (agent_id.trim(), name.trim());
            (!agent_id.is_empty() && !name.is_empty())
                .then(|| (agent_id.to_string(), name.to_string()))
        })
        .collect()
}

/// Remove isolated containers that the database says shouldn't exist.
///
/// A container is a zombie when its agent is marked `isolated = 0` (switched back to
/// the shared gateway) or no longer exists in the database at all (deleted agent).
/// Because the compose sets `restart: unless-stopped`, such a container otherwise
/// outlives every app restart with a frozen config — invisible in the UI, unreachable
/// by app traffic (all routing goes through the DB-driven `get_agent_container_name`),
/// but still holding memory and any channel sockets it had.
///
/// Runs at boot, before agents are registered, so a zombie can never race the
/// gateway registration of the same agent. Returns the number removed.
pub async fn reconcile_isolated_containers(db: &crate::db::Database) -> usize {
    let containers = list_isolated_containers().await;
    if containers.is_empty() {
        return 0;
    }

    let mut removed = 0usize;
    for (agent_id, container_name) in containers {
        // The label filter matches BOTH flavors' containers (the labels predate
        // flavor isolation). A dev instance with an empty database would otherwise
        // classify every prod container as "agent no longer exists" and tear the
        // real fleet down — the 2026-08-15 incident. Only containers whose name
        // exactly matches this flavor's naming are ours to reconcile.
        if container_name != crate::flavor::isolated_container_name(&agent_id) {
            tracing::debug!(
                "reconcile_isolated_containers: skipping {} — not a {} -flavor container",
                container_name,
                crate::flavor::flavor().name
            );
            continue;
        }
        let verdict = match db.get_agent(&agent_id) {
            Ok(Some(agent)) if agent.isolated => continue, // legitimate
            Ok(Some(_)) => "agent is shared-gateway in the database",
            Ok(None) => "agent no longer exists in the database",
            Err(e) => {
                // Never delete on a DB read error — that is how a transient lock
                // turns into data loss.
                tracing::warn!(
                    "reconcile_isolated_containers: skipping {} — could not read agent {}: {}",
                    container_name,
                    agent_id,
                    e
                );
                continue;
            }
        };

        tracing::warn!(
            "reconcile_isolated_containers: {} is a zombie ({}) — removing",
            container_name,
            verdict
        );

        match teardown_isolated_container(&agent_id).await {
            Ok(()) => {
                removed += 1;
                let _ = db.log_audit(
                    &agent_id,
                    "reconcile_isolated_container",
                    Some("docker"),
                    &format!("Removed zombie isolated container ({})", verdict),
                    None,
                );
            }
            Err(e) => tracing::error!(
                "reconcile_isolated_containers: could not remove {}: {}",
                container_name,
                e
            ),
        }
    }

    if removed > 0 {
        tracing::info!(
            "reconcile_isolated_containers: removed {} zombie container(s)",
            removed
        );
    }
    removed
}

pub fn get_docker_compose_command() -> tokio::process::Command {
    if let Some(home) = dirs::home_dir() {
        let orb_compose = home.join(".orbstack/bin/docker-compose");
        if orb_compose.exists() {
            let mut cmd = tokio::process::Command::new(orb_compose);
            cmd.kill_on_drop(true);
            return cmd;
        }
    }
    let mut cmd = if std::path::Path::new("/usr/local/bin/docker-compose").exists() {
        tokio::process::Command::new("/usr/local/bin/docker-compose")
    } else if std::path::Path::new("/opt/homebrew/bin/docker-compose").exists() {
        tokio::process::Command::new("/opt/homebrew/bin/docker-compose")
    } else {
        tokio::process::Command::new("docker-compose")
    };
    cmd.kill_on_drop(true);
    cmd
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
                                auth_file,
                                e
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

fn merge_json(a: &mut serde_json::Value, b: &serde_json::Value) {
    match (a, b) {
        (&mut serde_json::Value::Object(ref mut a_obj), serde_json::Value::Object(b_obj)) => {
            for (k, v) in b_obj {
                merge_json(a_obj.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (a_val, b_val) => {
            *a_val = b_val.clone();
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ProviderKeyAvailability {
    has_anthropic: bool,
    has_openai: bool,
    has_gemini: bool,
}

fn discover_provider_key_availability() -> ProviderKeyAvailability {
    ProviderKeyAvailability {
        has_anthropic: crate::keychain::get_secret("ANTHROPIC_API_KEY").is_ok(),
        has_openai: crate::keychain::get_secret("OPENAI_API_KEY").is_ok(),
        has_gemini: crate::keychain::get_secret("GEMINI_API_KEY").is_ok(),
    }
}

fn memory_search_config_for_keys(key_availability: ProviderKeyAvailability) -> serde_json::Value {
    // OpenClaw's current memory-search runtime supports OpenAI, Gemini, or "none".
    // Older Canopy builds wrote "chroma", which now causes the gateway to log
    // "Unknown memory embedding provider: chroma" and degrade startup behavior.
    if key_availability.has_openai {
        serde_json::json!({
            "enabled": true,
            "provider": "openai"
        })
    } else if key_availability.has_gemini {
        serde_json::json!({
            "enabled": true,
            "provider": "gemini"
        })
    } else {
        serde_json::json!({
            "enabled": true,
            "provider": "none"
        })
    }
}

fn preflight_sanitize_and_merge_config_with_keys(
    state_dir: &std::path::Path,
    // `Some(agent_id)` → this is an isolated agent container; `None` → main gateway.
    // The id is needed (not just a bool) so the isolated branch can compute the
    // agent's deterministic JIT-proxy port for its `browser.cdpUrl`.
    isolated_agent_id: Option<&str>,
    token: &str,
    key_availability: ProviderKeyAvailability,
) {
    let is_isolated = isolated_agent_id.is_some();
    let config_path = state_dir.join("openclaw.json");

    // ── 1. Delete OpenClaw's backup configs to prevent "size-drop" anomaly ──────
    if let Ok(entries) = std::fs::read_dir(state_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let is_backup = name.starts_with("openclaw.json.bak")
                    || name.starts_with("openclaw.json.clobbered")
                    || name.starts_with("openclaw.json.last-good")
                    || name.starts_with(".openclaw-last-good");
                if is_backup {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    // ── 2. Build from Scratch (Whitelist Preservation) ─────────────────────────
    let mut cfg = match std::fs::read_to_string(&config_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(existing) => {
                let mut base = serde_json::json!({});
                // Preserve crucial state to avoid anomaly loops and keep integrations
                if let Some(meta) = existing.get("meta") {
                    base["meta"] = meta.clone();
                }
                if let Some(channels) = existing.get("channels") {
                    base["channels"] = channels.clone();
                }
                if let Some(bindings) = existing.get("bindings") {
                    base["bindings"] = bindings.clone();
                }
                if let Some(models) = existing.get("models") {
                    base["models"] = models.clone();
                }

                // For plugins, preserve the enabled flags of specific integrations
                if let Some(plugins) = existing.pointer("/plugins/entries") {
                    if let Some(slack) = plugins.get("slack") {
                        base["plugins"]["entries"]["slack"] = slack.clone();
                    }
                    if let Some(google) = plugins.get("google") {
                        base["plugins"]["entries"]["google"] = google.clone();
                    }
                }

                // For isolated containers, we must preserve their agents.list and full plugins
                if is_isolated {
                    if let Some(agents_list) = existing.pointer("/agents/list") {
                        base["agents"]["list"] = agents_list.clone();
                    }
                    if let Some(plugins) = existing.get("plugins") {
                        base["plugins"] = plugins.clone();
                    }
                }
                base
            }
            Err(_) => serde_json::json!({}),
        },
        Err(_) => serde_json::json!({}),
    };

    // ── 3. Forceful Sanitization (Protects against known OpenClaw bugs) ─────────
    if let Some(gw) = cfg.get_mut("gateway").and_then(|g| g.as_object_mut()) {
        gw.remove("bonjour");
    }

    if let Some(channels) = cfg.get_mut("channels").and_then(|c| c.as_object_mut()) {
        // Remove known broken/deprecated channels that cause OpenClaw to crash
        channels.remove("bluebubbles");

        if let Some(slack) = channels.get_mut("slack").and_then(|s| s.as_object_mut()) {
            slack.remove("botToken");
            slack.remove("appToken");
        }
    }

    let default_model = crate::model_constants::default_model_from_available_keys(
        key_availability.has_anthropic,
        key_availability.has_openai,
        key_availability.has_gemini,
    );

    // Primary + fallback chain. OpenClaw walks `fallbacks` on quota/auth/overload
    // failures with cooldowns and auto-recovery (see model_constants::
    // default_fallback_chain). NOTE: this covers agents on the configured default;
    // per-agent primaries set via `agents edit --model` are strict by OpenClaw
    // policy unless given their own fallbacks — tracked as a follow-up.
    let default_fallbacks = crate::model_constants::default_fallback_chain(
        default_model,
        key_availability.has_anthropic,
        key_availability.has_openai,
        key_availability.has_gemini,
    );
    cfg["agents"]["defaults"]["model"] = serde_json::json!({
        "primary": default_model,
        "fallbacks": default_fallbacks,
    });
    // Register EVERY model in the chain, not just the primary. OpenClaw only loads
    // models it knows about — an unregistered fallback fails with "Unknown model"
    // at the exact moment failover reaches for it, turning a single provider
    // hiccup into "All models failed" (this is what muted every agent in Aug 2026
    // when the chain walked to an unregistered gemini model).
    for chain_model in std::iter::once(&default_model).chain(default_fallbacks.iter()) {
        if cfg["agents"]["defaults"]["models"]
            .get(*chain_model)
            .is_none()
        {
            cfg["agents"]["defaults"]["models"][*chain_model] = serde_json::json!({});
        }
    }
    cfg["agents"]["defaults"]["skills"] = serde_json::json!(["gog", "summarize"]);

    // ── 4. Build Required Baseline ─────────────────────────────────────────────
    let mut required_baseline = serde_json::json!({
        "gateway": {
            "auth": {
                "mode": "token",
                "token": token
            },
            "mode": "local",
            "port": 18789
        },
        // OpenClaw's bundled anthropic plugin catalog lags behind the model IDs
        // Canopy targets (e.g. claude-sonnet-5 isn't in its static list yet).
        // Without an explicit transport, OpenClaw's model resolver falls through
        // every lookup to its hardcoded "openai-responses" default, sending the
        // Anthropic key to the OpenAI transport and failing auth. Pin it here so
        // every config rebuild keeps the correct native transport.
        //
        // claude-sonnet-5 also gets a FULL inline model definition. A model that is
        // referenced in config but absent from the catalog gets a synthesized row
        // with NO `cost` object, and OpenClaw 2026.7.1's applyAnthropicSonnet5Cost
        // reads `model.cost.input` unguarded — crashing the entire CLI ("Cannot
        // read properties of undefined (reading 'input')") for any command that
        // normalizes model rows (`models list`, `models auth login`, `configure`).
        // The runtime overrides sonnet-5 cost with its own pricing table whenever
        // the values differ, so the numbers here only need to exist, not be exact.
        "models": {
            "providers": {
                "anthropic": {
                    "baseUrl": "https://api.anthropic.com",
                    "api": "anthropic-messages",
                    "models": [
                        {
                            "id": "claude-sonnet-5",
                            "name": "Claude Sonnet 5",
                            "input": ["text", "image"],
                            "contextWindow": 200000,
                            "maxTokens": 64000,
                            "reasoning": true,
                            "cost": {
                                "input": 3.0,
                                "output": 15.0,
                                "cacheRead": 0.3,
                                "cacheWrite": 3.75
                            }
                        },
                        {
                            "id": "claude-opus-5",
                            "name": "Claude Opus 5",
                            "input": ["text", "image"],
                            "contextWindow": 200000,
                            "maxTokens": 64000,
                            "reasoning": true,
                            "cost": {
                                "input": 5.0,
                                "output": 25.0,
                                "cacheRead": 0.5,
                                "cacheWrite": 6.25
                            }
                        }
                    ]
                }
            }
        }
    });

    // ── 5. Context-Aware Injections (gateway vs isolated) ──────────────────────
    if !is_isolated {
        required_baseline["agents"]["defaults"]["memorySearch"] =
            memory_search_config_for_keys(key_availability);

        required_baseline["plugins"]["entries"]["browser"]["enabled"] = serde_json::json!(true);
        required_baseline["browser"] = serde_json::json!({
            "noSandbox": true,
            "attachOnly": true,
            "cdpUrl": crate::browser_manager::browser_bridge_url(
                "http",
                crate::browser_manager::SHARED_BRIDGE_PORT,
                "shared-browser"
            ),
            "defaultProfile": "openclaw"
        });

        required_baseline["plugins"]["entries"]["talk-voice"]["enabled"] = serde_json::json!(true);
        required_baseline["plugins"]["entries"]["google"]["enabled"] = serde_json::json!(true);
        required_baseline["plugins"]["entries"]["device-pair"]["enabled"] =
            serde_json::json!(false);
        required_baseline["plugins"]["entries"]["phone-control"]["enabled"] =
            serde_json::json!(false);

        cfg["agents"]["list"] = serde_json::json!([]);
        // Bindings MUST be cleared together with agents.list. OpenClaw 2026.7.1
        // validates the whole config on every mutation, so a binding referencing an
        // agent that is not (yet) in agents.list makes EVERY subsequent
        // `openclaw agents add` fail with "bindings.N.agentId: Unknown agent id" —
        // boot_sync can then never re-register a single agent and the app is dead
        // until someone hand-edits the config (this is what emptied the fleet in
        // Aug 2026). sync_gateway_channels rebuilds bindings from the Canopy DB
        // right after boot sync, so dropping them here loses nothing.
        cfg["bindings"] = serde_json::json!([]);
    } else if let Some(agent_id) = isolated_agent_id {
        // Isolated containers previously received NO browser config at all — the
        // plugin stayed disabled and there was no cdpUrl, so isolated agents
        // reported "no connection to the browser" even with the browser
        // capability turned on.
        //
        // Unlike the main gateway (which shares one bridge on SHARED_BRIDGE_PORT),
        // an isolated agent points at its OWN JIT proxy. That keeps the isolation
        // promise: its Chrome profile, cookies, and logins stay per-agent instead
        // of landing in the shared-browser profile alongside other agents'
        // sessions. The JIT proxy rewrites /json/version responses (same helper
        // as the shared bridge), so OpenClaw's `attachOnly` preflight resolves a
        // reachable webSocketDebuggerUrl through it.
        required_baseline["plugins"]["entries"]["browser"]["enabled"] = serde_json::json!(true);
        required_baseline["browser"] = serde_json::json!({
            "noSandbox": true,
            "attachOnly": true,
            "cdpUrl": crate::browser_manager::browser_bridge_url(
                "http",
                crate::browser_manager::jit_proxy_port_for(agent_id),
                agent_id
            ),
            "defaultProfile": "openclaw"
        });
    }

    // ── 6. Graceful Deep Merge ─────────────────────────────────────────────────
    merge_json(&mut cfg, &required_baseline);

    // ── 7. Write back ──────────────────────────────────────────────────────────
    let _ = std::fs::create_dir_all(state_dir);
    if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
        let _ = std::fs::write(&config_path, updated);
        tracing::info!("preflight_sanitize_and_merge_config (isolated={}): ensured safe baseline config at {:?}", is_isolated, config_path);
    }
}

pub fn preflight_sanitize_and_merge_config(
    state_dir: &std::path::Path,
    isolated_agent_id: Option<&str>,
    token: &str,
) {
    preflight_sanitize_and_merge_config_with_keys(
        state_dir,
        isolated_agent_id,
        token,
        discover_provider_key_availability(),
    );
}

#[tauri::command]
pub async fn start_gateway(app_handle: tauri::AppHandle) -> Result<String, String> {
    start_gateway_internal(Some(app_handle)).await
}

pub async fn start_gateway_internal(
    app_handle: Option<tauri::AppHandle>,
) -> Result<String, String> {
    // ── Engine readiness fast-fail (Workstream A) ──
    // If background provisioning is known to be mid-flight or failed, return a
    // clear, immediate error instead of letting downstream docker calls hang or
    // fail cryptically. Idle (returning users, provisioning never ran) passes
    // through to the legacy behavior below.
    crate::engine_install::ensure_engine_ready_for_deploy()?;

    // ── RATE LIMITING ──
    crate::rate_limiter::limiters::DOCKER_EXEC_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;

    // Helper to emit progress securely
    let emit_progress = |msg: &str| {
        if let Some(ref app) = app_handle {
            use tauri::Emitter;
            let _ = app.emit("boot-sync-progress", msg);
        }
    };

    // ── Ensure OrbStack VM has the right memory ceiling ───────────────────────
    // This runs on every gateway start so it catches users who had OrbStack
    // installed before Canopy (fresh installs are already handled by install_orbstack).
    // If the config is already correct it's a fast no-op (one file read).
    // If it needs updating, we restart OrbStack before proceeding so the new
    // limit is in effect before any containers start.
    emit_progress("Checking OrbStack memory configuration…");
    match ensure_orbstack_memory_internal().await {
        Ok((true, prev, new)) => {
            tracing::info!(
                "start_gateway: OrbStack VM memory raised {} MiB → {} MiB; restarting VM…",
                prev,
                new
            );
            emit_progress("Applying new OrbStack memory limit — restarting VM (one-time, ~10 s)…");
            let home = dirs::home_dir().unwrap_or_default();
            let orb_bin = home.join(".orbstack/bin/orb");
            if orb_bin.exists() {
                let _ = tokio::process::Command::new(&orb_bin)
                    .arg("stop")
                    .output()
                    .await;
                tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
                let _ = tokio::process::Command::new(&orb_bin)
                    .arg("start")
                    .output()
                    .await;
                // Wait up to 20 s for Docker socket
                let sock = home.join(".orbstack/run/docker.sock");
                for _ in 0..20 {
                    if sock.exists() {
                        break;
                    }
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                }
            }
        }
        Ok((false, _, _)) => {
            tracing::debug!("start_gateway: OrbStack VM memory already at target — no change.");
        }
        Err(e) => {
            // Non-fatal: log and continue. The gateway can still start; we just
            // couldn't verify the memory config (e.g. Docker Desktop user).
            tracing::warn!(
                "start_gateway: could not check OrbStack memory config: {}",
                e
            );
        }
    }

    let data_dir = canopy_data_dir().ok_or("Could not find data directory")?;

    let state_dir = data_dir.join("openclaw-state");
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(state_dir.join("workspace")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(state_dir.join("agents")).map_err(|e| e.to_string())?;

    emit_progress("Preparing gateway filesystem...");

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
        tracing::info!(
            "start_gateway: saved existing agents.list for potential restore after preflight"
        );
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
    preflight_sanitize_and_merge_config(
        &state_dir,
        None,
        crate::model_constants::gateway_internal_token(),
    );
    let openclaw_path = state_dir.join("openclaw.json");
    let desired_config = std::fs::read_to_string(&openclaw_path).unwrap_or_default();

    let applied_marker = state_dir.join(".openclaw-applied");
    let applied_config = std::fs::read_to_string(&applied_marker).unwrap_or_default();

    // Flag: does the running container need to be replaced to pick up the new config?
    // We must compare the JSON structurally and IGNORE the `meta` object.
    // OpenClaw updates `meta.lastTouchedAt` continuously during operation. If we
    // do a simple string comparison, it will ALWAYS differ, causing the container
    // to be needlessly destroyed (and agent dirs wiped) on every single app restart.
    let mut config_needs_restart = {
        let mut needs_restart = applied_config != desired_config;
        if needs_restart {
            if let (Ok(mut app_json), Ok(mut des_json)) = (
                serde_json::from_str::<serde_json::Value>(&applied_config),
                serde_json::from_str::<serde_json::Value>(&desired_config),
            ) {
                if let (Some(app_obj), Some(des_obj)) =
                    (app_json.as_object_mut(), des_json.as_object_mut())
                {
                    app_obj.remove("meta");
                    des_obj.remove("meta");
                    needs_restart = app_obj != des_obj;
                }
            }
        }
        needs_restart
    };

    if !config_needs_restart {
        // ZOMBIE DETECTION: The container might be marked as "Running" by docker ps,
        // but its PID namespace has crashed. A simple exec probe will fail with
        // "error executing setns process". If so, we MUST force a restart.
        if let Ok(exec_out) = get_docker_command()
            .args(["exec", crate::flavor::gateway_container(), "true"])
            .output()
            .await
        {
            if !exec_out.status.success() {
                let stderr = String::from_utf8_lossy(&exec_out.stderr).to_lowercase();
                let stdout = String::from_utf8_lossy(&exec_out.stdout).to_lowercase();
                if stderr.contains("error executing setns process")
                    || stderr.contains("no such file or directory")
                    || stdout.contains("error executing setns process")
                    || stdout.contains("no such file or directory")
                {
                    tracing::warn!("start_gateway: zombie canopy-gateway detected (setns error)! Forcing container recreate.");
                    config_needs_restart = true;
                }
            }
        }
    }

    if config_needs_restart {
        tracing::info!("start_gateway: openclaw.json differs from last applied config, or container is zombified — will force-remove and recreate container");
    } else {
        tracing::info!(
            "start_gateway: openclaw.json unchanged since last container start — no restart needed"
        );
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
        write_private_file(&compose_path, &compose)?;
    }

    // ── Always purge hash-prefixed "mangled" containers ──────────────────────
    // When docker-compose recreates a container, Docker first renames the old one
    // to `<hash>_canopy-gateway`, then creates a fresh `canopy-gateway`. If the
    // creation fails for any reason, only the mangled `<hash>_canopy-gateway` is
    // left running. On the next start_gateway call, `docker-compose up -d` sees it,
    // reports it as "Running", and never creates a correctly-named container.
    //
    // We always scan for containers whose name CONTAINS the gateway name but is NOT
    // exactly the gateway name. Those are always stale/mangled — remove them so
    // compose can create a fresh, correctly-named container.
    //
    // If compose didn't change and the canonical `canopy-gateway` is already running
    // cleanly, we skip removing it (docker-compose up -d will be a no-op).
    let gateway_name = crate::flavor::gateway_container();
    let name_filter = format!("name={}", gateway_name);
    if let Ok(ls_out) = get_docker_command()
        .args([
            "ps",
            "-a",
            "--filter",
            name_filter.as_str(),
            "--format",
            "{{.Names}}\t{{.ID}}",
        ])
        .output()
        .await
    {
        let output = String::from_utf8_lossy(&ls_out.stdout);
        for line in output.lines() {
            let mut parts = line.splitn(2, '\t');
            let name = parts.next().unwrap_or("").trim();
            let id = parts.next().unwrap_or("").trim();
            if id.is_empty() {
                continue;
            }

            if name != gateway_name {
                // Docker's `name=` filter is a SUBSTRING match, so a prod scan for
                // "canopy-gateway" also matches the dev flavor's "canopy-gateway-dev".
                // Only the hash-prefix mangle (`<id>_<gateway>`) is ours to remove;
                // anything else is another flavor's healthy container — leave it.
                if !name.ends_with(&format!("_{}", gateway_name)) {
                    continue;
                }
                // Hash-prefixed stale container (e.g. 53eca6e3188b_canopy-gateway) — always remove
                tracing::info!(
                    "start_gateway: removing stale mangled container '{}' ({})",
                    name,
                    id
                );
                match get_docker_command().args(["rm", "-f", id]).output().await {
                    Ok(ref o) if o.status.success() => {}
                    Ok(ref o) => {
                        let err_msg = String::from_utf8_lossy(&o.stderr);
                        tracing::warn!(
                            "start_gateway: could not remove '{}': {}",
                            name,
                            err_msg.trim()
                        );

                        if err_msg
                            .to_lowercase()
                            .contains("did not receive an exit event")
                            || err_msg.to_lowercase().contains("cannot kill container")
                        {
                            tracing::error!("start_gateway: FATAL DOCKER ENGINE WEDGE DETECTED on mangled container. Attempting to force-restart Docker engine...");
                            emit_progress(
                                "Docker daemon frozen. Restarting engine (takes ~12s)...",
                            );
                            restart_local_container_engine();
                            tracing::info!("start_gateway: Docker engine restart command issued. Waiting 12 seconds...");
                            tokio::time::sleep(std::time::Duration::from_secs(12)).await;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("start_gateway: docker rm error for '{}': {}", name, e)
                    }
                }
            } else if needs_write || config_needs_restart {
                // Canonical container, but compose file or openclaw.json changed.
                // docker stop has a race with restart:unless-stopped — use rm -f (instant SIGKILL)
                // so compose-up always creates a fresh container with the updated config.
                let reason = if needs_write {
                    "compose file changed"
                } else {
                    "openclaw.json config changed"
                };
                tracing::info!(
                    "start_gateway: {} — force-removing canopy-gateway ({}) for clean recreate",
                    reason,
                    id
                );
                match get_docker_command().args(["rm", "-f", id]).output().await {
                    Ok(ref o) if o.status.success() => {}
                    Ok(ref o) => {
                        let err_msg = String::from_utf8_lossy(&o.stderr);
                        tracing::warn!(
                            "start_gateway: could not remove canopy-gateway: {}",
                            err_msg.trim()
                        );

                        if err_msg
                            .to_lowercase()
                            .contains("did not receive an exit event")
                            || err_msg.to_lowercase().contains("cannot kill container")
                        {
                            tracing::error!("start_gateway: FATAL DOCKER ENGINE WEDGE DETECTED. The container process cannot be killed by Docker. Attempting to force-restart Docker engine...");
                            emit_progress(
                                "Docker daemon frozen. Restarting engine (takes ~12s)...",
                            );
                            // Try OrbStack first, fallback to Docker Desktop
                            restart_local_container_engine();

                            tracing::info!("start_gateway: Docker engine restart command issued. Waiting 12 seconds for daemon to recover...");
                            tokio::time::sleep(std::time::Duration::from_secs(12)).await;
                        }
                    }
                    Err(e) => tracing::warn!("start_gateway: docker rm error: {}", e),
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
                            tracing::info!(
                                "start_gateway: clearing agent dir {:?} (container recreate)",
                                path.file_name().unwrap_or_default()
                            );
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
                        // Bindings referencing agents missing from agents.list fail
                        // OpenClaw's config validation on EVERY mutation, which makes
                        // the `openclaw agents add` calls in boot_sync error out with
                        // "bindings.N.agentId: Unknown agent id" — clearing the list
                        // without the bindings bricks re-registration. They're rebuilt
                        // from the Canopy DB by sync_gateway_channels after boot sync.
                        cfg["bindings"] = serde_json::json!([]);
                        if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
                            if let Err(e) = std::fs::write(&config_path, &updated) {
                                tracing::warn!("start_gateway: could not clear agents.list: {}", e);
                            } else {
                                tracing::info!("start_gateway: cleared agents.list + bindings in openclaw.json (agent dirs wiped)");
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
        let out = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
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

        let container_was_restarted =
            out.contains("Starting") || out.contains("Started") || out.contains("Creating");
        let _ = std::fs::write(&applied_marker, &desired_config);
        if container_was_restarted {
            tracing::info!(
                "start_gateway: applied-config marker written (container was recreated)"
            );
            ensure_browser_dependencies(crate::flavor::gateway_container().to_string());
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

pub fn ensure_browser_dependencies(container_name: String) {
    tauri::async_runtime::spawn(async move {
        // Apply Gemini models / thinking budget fixes, and SSRF patch for host.docker.internal.
        // The SSRF patch was previously a hardcoded `sed -i` against `/app/dist/net-Dtn7wx2q.js`,
        // but that filename is content-addressable and changes with every OpenClaw release.
        // It is now folded into the JS scan below so it works across versions.
        let patch_js = r#"
const fs = require("fs");
const path = require("path");
const distDir = "/app/dist";

const files = fs.readdirSync(distDir);
for (const file of files) {
  const filePath = path.join(distDir, file);
  if (fs.statSync(filePath).isFile() && file.endsWith(".js")) {
    let content = fs.readFileSync(filePath, "utf8");
    let modified = false;

    // SSRF patch: allow host.docker.internal as a loopback-equivalent host so
    // agents can reach Canopy's JIT server inside the OrbStack VM network.
    if (content.includes("function isLoopbackHost(host)") && !content.includes("host.docker.internal")) {
      content = content.replace(
        "function isLoopbackHost(host) {",
        "function isLoopbackHost(host) { if (host === 'host.docker.internal') return true;"
      );
      console.log("Patched isLoopbackHost (SSRF) in " + file);
      modified = true;
    }

    if (content.includes("isGemini3ProModel")) {
      const orig = content;
      content = content.replace("/gemini-3(?:\\.\\d+)?-pro/", "/gemini-(?:2\\\\.5|[3-9](?:\\\\.\\\\d+)?)-pro/");
      if (content !== orig) {
        console.log("Patched isGemini3ProModel in " + file);
        modified = true;
      }
    }

    if (content.includes("isGemini3FlashModel")) {
      const orig = content;
      content = content.replace("/gemini-3(?:\\.\\d+)?-flash/", "/gemini-(?:2\\\\.5|[3-9](?:\\\\.\\\\d+)?)-flash/");
      if (content !== orig) {
        console.log("Patched isGemini3FlashModel in " + file);
        modified = true;
      }
    }

    if (content.includes("isGemini31Model")) {
      const orig = content;
      const targetStr = "normalized.includes(\"gemini-3.1-pro\") || normalized.includes(\"gemini-3.1-flash\")";
      const replacementStr = "/gemini-(?:2\\\\.5|[3-9](?:\\\\.\\\\d+)?)-(?:pro|flash)/.test(normalized)";
      if (content.includes(targetStr)) {
        content = content.replace(targetStr, replacementStr);
        console.log("Patched isGemini31Model in " + file);
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, content, "utf8");
    }
  }
}
"#;

        let patch_output = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "root",
                &container_name,
                "node",
                "-e",
                patch_js,
            ])
            .output()
            .await;

        match patch_output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                tracing::info!(
                    "ensure_browser_dependencies: Gemini patch applied successfully:\n{}",
                    stdout.trim()
                );
                // SIGUSR1 tells OpenClaw to hot-reload its JSON config — NOT its JS code.
                // It is therefore useless for making Gemini patches take effect (those
                // require a full process restart to re-import the patched dist files).
                //
                // For ISOLATED containers, SIGUSR1 actively causes the crash loop:
                //   • The container starts with a minimal openclaw.json (gateway block only).
                //   • SIGUSR1 triggers a hot-reload, which OpenClaw 2026.5.26+ validates
                //     strictly — it crashes/exits on a config that lacks required fields,
                //     causing Docker to restart it, which triggers SIGUSR1 again, etc.
                //   • The Gemini patches written to /app/dist/ persist in the container's
                //     writable layer across restarts, so the next natural restart picks them
                //     up without any signal.
                //
                // For the GATEWAY container, SIGUSR1 is only worth sending when non-patch
                // channel/credential config changed — the Gemini patches don't need it.
                // We send it only if files were actually changed AND this is not an isolated
                // container, so at-rest gateway configs still get refreshed when needed.
                let is_isolated = container_name.contains("isolated");
                if stdout.contains("Patched") {
                    if is_isolated {
                        tracing::info!(
                            "ensure_browser_dependencies: {} — Gemini JS patched; skipping SIGUSR1 \
                             (isolated containers reload on natural restart, not SIGUSR1)",
                            container_name
                        );
                    } else {
                        let _ = crate::openclaw::get_docker_command()
                            .args(["exec", &container_name, "pkill", "-USR1", "-f", "openclaw"])
                            .output()
                            .await;
                    }
                } else {
                    tracing::info!("ensure_browser_dependencies: no files modified by Gemini patch — skipping SIGUSR1 reload");
                }
            }
            Ok(out) => {
                tracing::error!(
                    "ensure_browser_dependencies: Gemini patch failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Err(e) => {
                tracing::error!(
                    "ensure_browser_dependencies: Gemini patch command error: {}",
                    e
                );
            }
        }

        // Check if chromium is already installed
        let check = crate::openclaw::get_docker_command()
            .args(["exec", "-u", "root", &container_name, "which", "chromium"])
            .output()
            .await;

        if let Ok(out) = check {
            if out.status.success() {
                tracing::info!(
                    "ensure_browser_dependencies: Chromium already installed in {}",
                    container_name
                );
                return;
            }
        }

        tracing::info!("ensure_browser_dependencies: Initiating background Playwright and Chromium installation for {}...", container_name);

        let _ = crate::openclaw::get_docker_command()
            .args(["exec", "-u", "root", &container_name, "apt-get", "update"])
            .output()
            .await;

        let _ = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "root",
                &container_name,
                "apt-get",
                "install",
                "-y",
                "chromium",
            ])
            .output()
            .await;

        let _ = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "root",
                &container_name,
                "npx",
                "playwright",
                "install-deps",
            ])
            .output()
            .await;

        let _ = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "npx",
                "playwright",
                "install",
                "chromium",
                "webkit",
            ])
            .output()
            .await;

        tracing::info!("ensure_browser_dependencies: Background Chromium/Playwright installation complete for {}.", container_name);

        let _ = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "openclaw",
                "plugins",
                "install",
                "@openclaw/slack@2026.7.1",
            ])
            .output()
            .await;

        tracing::info!(
            "ensure_browser_dependencies: Background Slack plugin installation complete for {}.",
            container_name
        );
    });
}

#[tauri::command]
pub async fn stop_gateway() -> Result<String, String> {
    // ── RATE LIMITING ──
    crate::rate_limiter::limiters::DOCKER_EXEC_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;

    let data_dir = canopy_data_dir().ok_or("Could not find data directory")?;

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
    // ── RATE LIMITING ──
    crate::rate_limiter::limiters::DOCKER_EXEC_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;

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
            .args(["restart", crate::flavor::gateway_container()])
            .output()
            .await;
    }

    // Re-generate configuration and bring it up via compose to apply new limits.
    // If the compose file content changed (e.g. memory limit updated from 2G → 4G),
    // docker-compose will recreate the container so the new limits take effect.
    tracing::info!("Writing docker-compose.yml and running docker-compose up -d...");
    match start_gateway_internal(None).await {
        Ok(msg) => tracing::info!("SUCCESS: {}", msg),
        Err(e) => tracing::warn!("ERROR: {}", e),
    }

    // Confirm the container is actually running now
    let container_state = tokio::process::Command::new(
        dirs::home_dir()
            .unwrap_or_default()
            .join(".orbstack/bin/docker"),
    )
    .args([
        "inspect",
        "-f",
        "{{.State.Status}}",
        crate::flavor::gateway_container(),
    ])
    .output()
    .await
    .ok()
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .unwrap_or_else(|| "unknown".into());
    tracing::info!("gateway container state after reset: {}", container_state);

    Ok("Infrastructure rebooted perfectly.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_image_tag_matches_model_support_gating() {
        // The model picker hides models the shipped OpenClaw image can't resolve
        // (model_constants::CONTAINER_SUPPORTED_MODELS). That allowlist is only
        // valid for the image it was audited against — bumping the image here
        // without updating OPENCLAW_IMAGE_TAG (and re-auditing the list, see the
        // "Updating when bumping the OpenClaw image" comment in model_constants.rs)
        // silently re-exposes unsupported models in the picker.
        let dir = tempfile::tempdir().expect("tempdir");
        let expected = format!(
            "ghcr.io/openclaw/openclaw:{}",
            crate::model_constants::OPENCLAW_IMAGE_TAG
        );
        let shared = generate_compose_file(&dir.path().to_path_buf());
        assert!(
            shared.contains(&expected),
            "shared compose image must match model_constants::OPENCLAW_IMAGE_TAG ({expected})"
        );
        let isolated = generate_isolated_compose("agent-x", &dir.path().to_path_buf(), 18805);
        assert!(
            isolated.contains(&expected),
            "isolated compose image must match model_constants::OPENCLAW_IMAGE_TAG ({expected})"
        );
    }

    #[test]
    fn shared_compose_never_mounts_agent_custom_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let compose = generate_compose_file(&dir.path().to_path_buf());

        assert!(
            !compose.contains("/home/node/.openclaw/workspace/mounts/"),
            "custom folders must never cross into the shared gateway"
        );
    }

    #[test]
    fn shared_compose_keeps_secrets_out_and_services_on_loopback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let compose = generate_compose_file(&dir.path().to_path_buf());

        for secret_name in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "XAI_API_KEY",
            "SLACK_BOT_TOKEN",
        ] {
            assert!(!compose.contains(secret_name));
        }
        let flavor = crate::flavor::flavor();
        assert!(compose.contains(&format!("127.0.0.1:{}:18789", flavor.gateway_host_port)));
        assert!(compose.contains(&format!("container_name: {}", flavor.gateway_container)));
        assert!(compose.contains(&format!("127.0.0.1:{}:8000", flavor.chroma_host_port)));
        assert!(!compose.contains(&format!("\n      - \"{}:8000\"", flavor.chroma_host_port)));
    }

    #[cfg(unix)]
    #[test]
    fn private_runtime_files_are_owner_only_even_when_rewriting_existing_files() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("docker-compose.yml");
        std::fs::write(&path, "old").expect("seed public file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("make seed public");

        write_private_file(&path, "new").expect("private rewrite");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn custom_directory_volume_is_yaml_escaped_and_read_only() {
        let grant = crate::workspace_manager::FolderGrant {
            id: "folder-test".to_string(),
            path: "/tmp/folder\"with\ncontrols".to_string(),
            name: "folder".to_string(),
            access: crate::workspace_manager::FolderAccessMode::ReadOnly,
            active: true,
        };
        let volume = format_allowed_directory_volume(&grant).expect("volume entry");

        assert!(volume.contains("\\\""));
        assert!(volume.contains("\\n"));
        assert!(volume.contains("target: \"/home/node/.openclaw/workspace/mounts/folder-test\""));
        assert!(volume.contains("read_only: true"));
    }

    #[test]
    fn read_write_grant_is_explicit_in_compose() {
        let grant = crate::workspace_manager::FolderGrant {
            id: "folder-write".to_string(),
            path: "/tmp/write".to_string(),
            name: "write".to_string(),
            access: crate::workspace_manager::FolderAccessMode::ReadWrite,
            active: true,
        };
        let volume = format_allowed_directory_volume(&grant).expect("volume entry");

        assert!(volume.contains("read_only: false"));
    }

    #[test]
    fn test_generate_isolated_compose() {
        let agent_id = "agent-123";
        let data_dir = PathBuf::from("/tmp/canopy");
        let port = 18805;

        let compose = generate_isolated_compose(agent_id, &data_dir, port);

        assert!(compose.contains(&crate::flavor::isolated_container_name("agent-123")));
        assert!(compose.contains("127.0.0.1:18805:18789"));
        assert!(!compose.contains("\n      - \"18805:18789\""));
        assert!(compose.contains("- \"com.canopy.type=isolated\""));
        assert!(compose.contains("- \"com.canopy.agent-id=agent-123\""));
        assert!(compose.contains("isolated-agent-123"));
    }

    #[test]
    fn isolated_preflight_injects_browser_config() {
        // Regression: isolated containers previously got NO browser block and no
        // browser plugin enable, so isolated agents could never reach a browser.
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_id = "agent-iso-test";

        preflight_sanitize_and_merge_config_with_keys(
            dir.path(),
            Some(agent_id),
            "test-token",
            ProviderKeyAvailability {
                has_anthropic: false,
                has_openai: false,
                has_gemini: true,
            },
        );

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("openclaw.json")).expect("config written"),
        )
        .expect("valid json");

        assert_eq!(
            cfg.pointer("/plugins/entries/browser/enabled"),
            Some(&serde_json::json!(true)),
            "browser plugin must be enabled for isolated containers"
        );
        let expected_url = crate::browser_manager::browser_bridge_url(
            "http",
            crate::browser_manager::jit_proxy_port_for(agent_id),
            agent_id,
        );
        assert_eq!(
            cfg.pointer("/browser/cdpUrl").and_then(|v| v.as_str()),
            Some(expected_url.as_str()),
            "cdpUrl must point at the agent's own JIT proxy"
        );
        assert_eq!(
            cfg.pointer("/browser/attachOnly"),
            Some(&serde_json::json!(true))
        );
    }

    #[test]
    fn gateway_preflight_uses_shared_bridge_not_jit() {
        let dir = tempfile::tempdir().expect("tempdir");

        preflight_sanitize_and_merge_config_with_keys(
            dir.path(),
            None,
            "test-token",
            ProviderKeyAvailability {
                has_anthropic: true,
                has_openai: false,
                has_gemini: false,
            },
        );

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("openclaw.json")).expect("config written"),
        )
        .expect("valid json");

        let expected_url = crate::browser_manager::browser_bridge_url(
            "http",
            crate::browser_manager::SHARED_BRIDGE_PORT,
            "shared-browser",
        );
        assert_eq!(
            cfg.pointer("/browser/cdpUrl").and_then(|v| v.as_str()),
            Some(expected_url.as_str()),
            "gateway must keep pointing at the shared bridge"
        );
        assert_eq!(
            cfg.pointer("/agents/defaults/model/primary")
                .and_then(|v| v.as_str()),
            Some(crate::model_constants::DEFAULT_ANTHROPIC_MODEL),
            "preflight model selection should be deterministic in tests and not depend on host keychain state"
        );
        assert_eq!(
            cfg.pointer("/agents/defaults/memorySearch/provider")
                .and_then(|v| v.as_str()),
            Some("none"),
            "without a supported embeddings key, memory search should fall back to keyword-only mode"
        );
    }

    #[test]
    fn gateway_preflight_registers_every_fallback_model_and_sonnet5_cost() {
        // Regression (Aug 2026): preflight wrote defaults.model.fallbacks but only
        // registered the PRIMARY in agents.defaults.models. When failover walked the
        // chain, the unregistered fallback died with "Unknown model" and every agent
        // went mute. Also: a config-referenced model missing from the catalog gets a
        // synthesized row with no `cost`, which crashes OpenClaw 2026.7.1's
        // applyAnthropicSonnet5Cost — so claude-sonnet-5 must ship a full inline
        // provider model definition including cost.
        let dir = tempfile::tempdir().expect("tempdir");

        preflight_sanitize_and_merge_config_with_keys(
            dir.path(),
            None,
            "test-token",
            ProviderKeyAvailability {
                has_anthropic: true,
                has_openai: false,
                has_gemini: true,
            },
        );

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("openclaw.json")).expect("config written"),
        )
        .expect("valid json");

        let primary = cfg
            .pointer("/agents/defaults/model/primary")
            .and_then(|v| v.as_str())
            .expect("primary set");
        let fallbacks: Vec<String> = cfg
            .pointer("/agents/defaults/model/fallbacks")
            .and_then(|v| v.as_array())
            .expect("fallbacks array")
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        assert!(
            !fallbacks.is_empty(),
            "keys for two providers must produce a chain"
        );

        let registered = cfg
            .pointer("/agents/defaults/models")
            .and_then(|v| v.as_object())
            .expect("defaults.models object");
        for model in std::iter::once(primary.to_string()).chain(fallbacks) {
            assert!(
                registered.contains_key(&model),
                "chain model '{}' must be registered in agents.defaults.models",
                model
            );
        }

        let sonnet_def = cfg
            .pointer("/models/providers/anthropic/models")
            .and_then(|v| v.as_array())
            .and_then(|models| {
                models
                    .iter()
                    .find(|m| m.get("id").and_then(|i| i.as_str()) == Some("claude-sonnet-5"))
            })
            .expect("claude-sonnet-5 inline provider definition");
        assert!(
            sonnet_def.pointer("/cost/input").is_some(),
            "sonnet-5 definition must carry a cost object (missing cost crashes the OpenClaw CLI)"
        );
    }

    #[test]
    fn gateway_preflight_clears_bindings_with_agents_list() {
        // Regression (Aug 2026): preflight cleared agents.list but carried the old
        // bindings forward. OpenClaw validates the whole config on every mutation,
        // so a binding pointing at an agent not in agents.list made every
        // `openclaw agents add` fail ("bindings.N.agentId: Unknown agent id") and
        // boot_sync could never re-register the fleet.
        let dir = tempfile::tempdir().expect("tempdir");
        let seeded = serde_json::json!({
            "agents": { "list": [{"id": "agent-x"}] },
            "bindings": [
                { "agentId": "agent-x", "match": { "channel": "slack", "accountId": "agent-x" } }
            ]
        });
        std::fs::write(
            dir.path().join("openclaw.json"),
            serde_json::to_string_pretty(&seeded).unwrap(),
        )
        .expect("seed config");

        preflight_sanitize_and_merge_config_with_keys(
            dir.path(),
            None,
            "test-token",
            ProviderKeyAvailability {
                has_anthropic: true,
                has_openai: false,
                has_gemini: true,
            },
        );

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("openclaw.json")).expect("config written"),
        )
        .expect("valid json");

        assert_eq!(
            cfg.pointer("/agents/list"),
            Some(&serde_json::json!([])),
            "gateway preflight clears agents.list"
        );
        assert_eq!(
            cfg.pointer("/bindings"),
            Some(&serde_json::json!([])),
            "bindings must be cleared with agents.list or agents add fails validation"
        );
    }

    #[test]
    fn preflight_helper_unit_tests_do_not_touch_host_keychain() {
        let dir = tempfile::tempdir().expect("tempdir");

        preflight_sanitize_and_merge_config_with_keys(
            dir.path(),
            None,
            "test-token",
            ProviderKeyAvailability {
                has_anthropic: false,
                has_openai: true,
                has_gemini: false,
            },
        );

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("openclaw.json")).expect("config written"),
        )
        .expect("valid json");

        assert_eq!(
            cfg.pointer("/agents/defaults/model/primary")
                .and_then(|v| v.as_str()),
            Some(crate::model_constants::DEFAULT_OPENAI_MODEL)
        );
        assert_eq!(
            cfg.pointer("/agents/defaults/memorySearch/provider")
                .and_then(|v| v.as_str()),
            Some("openai")
        );
    }

    #[test]
    fn preflight_uses_gemini_memory_search_when_only_gemini_key_exists() {
        let dir = tempfile::tempdir().expect("tempdir");

        preflight_sanitize_and_merge_config_with_keys(
            dir.path(),
            None,
            "test-token",
            ProviderKeyAvailability {
                has_anthropic: false,
                has_openai: false,
                has_gemini: true,
            },
        );

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("openclaw.json")).expect("config written"),
        )
        .expect("valid json");

        assert_eq!(
            cfg.pointer("/agents/defaults/memorySearch/provider")
                .and_then(|v| v.as_str()),
            Some("gemini")
        );
    }
}
