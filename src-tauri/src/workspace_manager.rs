use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub fn get_agent_workspace_config_path(agent_id: &str) -> Result<PathBuf> {
    crate::validators::agent::validate_id(agent_id).map_err(|e| anyhow::anyhow!(e.to_string()))?;

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

fn read_allowed_directories(path: &Path) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read allowed directories: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse allowed directories: {}", e))
}

fn ensure_directory_update_allowed(
    is_isolated: bool,
    existing: &[String],
    requested: &[String],
) -> Result<(), String> {
    if !is_isolated && requested.iter().any(|dir| !existing.contains(dir)) {
        return Err(
            "Custom folder access requires Isolated Mode. Shared agents may only remove previously saved folders."
                .to_string(),
        );
    }
    Ok(())
}

fn normalize_allowed_directories(directories: Vec<String>) -> Result<Vec<String>, String> {
    if directories.len() > 64 {
        return Err("An agent can access at most 64 custom folders.".to_string());
    }

    let mut normalized = Vec::with_capacity(directories.len());
    for directory in directories {
        if directory.trim().is_empty() {
            return Err("Allowed folder paths cannot be empty.".to_string());
        }

        let path = Path::new(&directory);
        if !path.is_absolute() {
            return Err(format!(
                "Allowed folder path must be absolute: {}",
                directory
            ));
        }

        let canonical = std::fs::canonicalize(path)
            .map_err(|e| format!("Could not access allowed folder '{}': {}", directory, e))?;
        if !canonical.is_dir() {
            return Err(format!(
                "Allowed folder path is not a directory: {}",
                directory
            ));
        }

        let canonical = canonical
            .into_os_string()
            .into_string()
            .map_err(|_| "Allowed folder path is not valid UTF-8.".to_string())?;
        if !normalized.contains(&canonical) {
            normalized.push(canonical);
        }
    }

    Ok(normalized)
}

#[tauri::command]
pub async fn get_agent_allowed_directories(agent_id: String) -> Result<Vec<String>, String> {
    let path = get_agent_workspace_config_path(&agent_id).map_err(|e| e.to_string())?;
    read_allowed_directories(&path)
}

#[tauri::command]
pub async fn update_agent_allowed_directories(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    directories: Vec<String>,
) -> Result<(), String> {
    let path = get_agent_workspace_config_path(&agent_id).map_err(|e| e.to_string())?;
    let existing = read_allowed_directories(&path)?;
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| format!("Failed to load agent: {}", e))?
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    let is_isolated = agent.isolated;

    ensure_directory_update_allowed(is_isolated, &existing, &directories)?;
    let directories = if is_isolated {
        normalize_allowed_directories(directories)?
    } else {
        directories
    };

    let content = serde_json::to_string_pretty(&directories)
        .map_err(|e| format!("Failed to serialize allowed directories: {}", e))?;

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write allowed directories: {}", e))?;

    // Isolated containers must be recreated to pick up the new volume mounts.
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
        if let Ok(gh_token) =
            crate::keychain::get_secret(&format!("github-access-token-{}", agent_id))
        {
            let gh_user =
                crate::keychain::get_secret(&format!("github-username-{}", agent_id)).ok();
            let _ =
                crate::channels::configure_github(db.clone(), agent_id.clone(), gh_token, gh_user)
                    .await;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_agents_cannot_add_custom_directories() {
        let existing = vec!["/already/saved".to_string()];
        let requested = vec!["/already/saved".to_string(), "/new/folder".to_string()];

        let error = ensure_directory_update_allowed(false, &existing, &requested)
            .expect_err("shared agents must not gain custom folder access");

        assert!(error.contains("requires Isolated Mode"));
    }

    #[test]
    fn shared_agents_can_remove_previously_saved_directories() {
        let existing = vec!["/keep".to_string(), "/remove".to_string()];
        let requested = vec!["/keep".to_string()];

        assert!(ensure_directory_update_allowed(false, &existing, &requested).is_ok());
    }

    #[test]
    fn isolated_directory_updates_are_canonical_and_deduplicated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().to_string();

        let normalized =
            normalize_allowed_directories(vec![path.clone(), path]).expect("valid directories");

        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized[0],
            std::fs::canonicalize(dir.path())
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        );
    }

    #[test]
    fn directory_validation_rejects_relative_paths_and_files() {
        assert!(normalize_allowed_directories(vec!["relative/path".to_string()]).is_err());

        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("not-a-directory.txt");
        std::fs::write(&file, "test").expect("test file");

        assert!(normalize_allowed_directories(vec![file.to_string_lossy().to_string()]).is_err());
    }

    #[test]
    fn workspace_config_path_rejects_agent_id_traversal() {
        assert!(get_agent_workspace_config_path("../shared").is_err());
    }
}
