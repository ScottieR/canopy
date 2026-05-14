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
pub async fn update_agent_allowed_directories(agent_id: String, directories: Vec<String>) -> Result<(), String> {
    let path = get_agent_workspace_config_path(&agent_id)
        .map_err(|e| e.to_string())?;

    let content = serde_json::to_string_pretty(&directories)
        .map_err(|e| format!("Failed to serialize allowed directories: {}", e))?;

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write allowed directories: {}", e))?;

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
