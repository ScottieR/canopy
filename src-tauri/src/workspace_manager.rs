use anyhow::{Context, Result};
use std::path::PathBuf;

pub fn get_agent_workspace_config_path(agent_id: &str) -> Result<PathBuf> {
    let data_dir = dirs::data_dir().context("Could not find data directory")?;
    let path = data_dir
        .join("Canopy")
        .join("agent-workspaces")
        .join(agent_id)
        .join("allowed_directories.json");
    
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    
    Ok(path)
}

#[tauri::command]
pub async fn get_agent_allowed_directories(agent_id: String) -> Result<Vec<String>, String> {
    let path = get_agent_workspace_config_path(&agent_id)
        .map_err(|e| e.to_string())?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read allowed directories: {}", e))?;

    let directories: Vec<String> = serde_json::from_str(&content)
        .unwrap_or_default();

    Ok(directories)
}

#[tauri::command]
pub async fn update_agent_allowed_directories(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    directories: Vec<String>,
) -> Result<(), String> {
    let path = get_agent_workspace_config_path(&agent_id)
        .map_err(|e| e.to_string())?;

    let content = serde_json::to_string_pretty(&directories)
        .map_err(|e| format!("Failed to serialize allowed directories: {}", e))?;

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write allowed directories: {}", e))?;

    // If the agent is isolated, we must restart its specific container to pick up the new volume mounts
    let is_isolated = db.get_agent(&agent_id).ok().flatten().map(|a| a.isolated).unwrap_or(false);
    if is_isolated {
        let data_dir = dirs::data_dir().unwrap().join("Canopy");
        let port = crate::openclaw::get_agent_isolated_port(&agent_id);
        let compose_content = crate::docker::generate_isolated_compose(&agent_id, &data_dir, port);
        let compose_path = data_dir.join(format!("docker-compose-{}.yml", agent_id));
        let _ = std::fs::write(&compose_path, compose_content);

        let _ = crate::docker::get_docker_compose_command()
            .args(["-f", compose_path.to_str().unwrap(), "up", "-d"])
            .output()
            .await;
            
        // Because recreating the container wipes any root filesystem changes (like apt-get installs),
        // we must re-apply the GitHub configuration if they had it enabled.
        if let Ok(gh_token) = crate::keychain::get_secret(&format!("github-access-token-{}", agent_id)) {
            let gh_user = crate::keychain::get_secret(&format!("github-username-{}", agent_id)).ok();
            let _ = crate::channels::configure_github(db.clone(), agent_id.clone(), gh_token, gh_user).await;
        }
    }

    Ok(())
}

pub fn get_all_agents_allowed_directories() -> Result<Vec<String>> {
    let mut all_dirs = Vec::new();
    let data_dir = dirs::data_dir().context("Could not find data directory")?;
    let workspaces_dir = data_dir.join("Canopy").join("agent-workspaces");

    if let Ok(entries) = std::fs::read_dir(workspaces_dir) {
        for entry in entries.flatten() {
            let path = entry.path().join("allowed_directories.json");
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(mut dirs) = serde_json::from_str::<Vec<String>>(&content) {
                        for dir in dirs {
                            if !all_dirs.contains(&dir) {
                                all_dirs.push(dir);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(all_dirs)
}
