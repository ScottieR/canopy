use anyhow::{Context, Result};
use bollard::Docker;
use bollard::container::{ListContainersOptions, StatsOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::models::ContainerStatus;

/// Manages OrbStack/Docker containers for OpenClaw instances.
/// Users never see Docker — this is the invisible infrastructure layer.
pub struct DockerManager {
    docker: Docker,
}

impl DockerManager {
    /// Connect to Docker via OrbStack's socket
    pub async fn init() -> Result<Self> {
        // OrbStack uses the standard Docker socket
        let docker = Docker::connect_with_socket_defaults()
            .context("Failed to connect to Docker. Is OrbStack running?")?;

        // Verify connection
        docker.ping().await.context("Docker ping failed")?;
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
            port: 18789,                   // TODO: parse from port mappings
        });
    }

    Ok(statuses)
}

/// Generate the docker-compose.yml for the shared gateway
fn generate_compose_file(data_dir: &PathBuf) -> String {
    format!(
        r#"version: '3.8'
services:
  canopy-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: canopy-gateway
    restart: unless-stopped
    labels:
      - "com.canopy.managed=true"
      - "com.canopy.type=shared-gateway"
    ports:
      - "18789:18789"
      - "18790:18790"
      - "18791:18791"
    volumes:
      - {data}/openclaw-state:/root/.openclaw
      - {data}/openclaw-workspace:/root/openclaw/workspace
      - {data}/config/openclaw.json:/root/.openclaw/openclaw.json:ro
    environment:
      - NODE_ENV=production
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/api/status"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M

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
        r#"version: '3.8'
services:
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
      - {data}/isolated/{id}/state:/root/.openclaw
      - {data}/isolated/{id}/workspace:/root/openclaw/workspace
      - {data}/isolated/{id}/config/openclaw.json:/root/.openclaw/openclaw.json:ro
    environment:
      - NODE_ENV=production
    networks:
      - isolated-{id}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/api/status"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M

networks:
  isolated-{id}:
    internal: false
"#,
        id = agent_id,
        data = data_dir.display(),
        port = host_port
    )
}

#[tauri::command]
pub async fn start_gateway() -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Canopy");

    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(data_dir.join("config")).map_err(|e| e.to_string())?;

    let compose = generate_compose_file(&data_dir);
    let compose_path = data_dir.join("docker-compose.yml");
    std::fs::write(&compose_path, compose).map_err(|e| e.to_string())?;

    let output = tokio::process::Command::new("docker-compose")
        .args(["-f", &compose_path.to_string_lossy(), "up", "-d"])
        .output()
        .await
        .map_err(|e| format!("Failed to start gateway: {}", e))?;

    if output.status.success() {
        Ok("Gateway started".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to start gateway: {}", stderr))
    }
}

#[tauri::command]
pub async fn stop_gateway() -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Canopy");

    let compose_path = data_dir.join("docker-compose.yml");

    let output = tokio::process::Command::new("docker-compose")
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
