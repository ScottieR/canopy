use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const FOLDER_MANIFEST_VERSION: u8 = 2;
const MAX_CUSTOM_FOLDERS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderAccessMode {
    ReadOnly,
    ReadWrite,
}

impl Default for FolderAccessMode {
    fn default() -> Self {
        Self::ReadOnly
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderGrant {
    pub id: String,
    pub path: String,
    pub name: String,
    pub access: FolderAccessMode,
    #[serde(default = "folder_grant_active_default")]
    pub active: bool,
}

fn folder_grant_active_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderGrantManifest {
    version: u8,
    grants: Vec<FolderGrant>,
}

pub fn get_agent_workspace_config_path(agent_id: &str) -> Result<PathBuf> {
    crate::validators::agent::validate_id(agent_id).map_err(|e| anyhow::anyhow!(e.to_string()))?;

    let data_dir = crate::flavor::canopy_data_dir().context("Could not find data directory")?;
    let path = data_dir
        .join("agent-workspaces")
        .join(agent_id)
        .join("allowed_directories.json");

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    Ok(path)
}

fn legacy_grant(path: String) -> FolderGrant {
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Folder")
        .to_string();
    FolderGrant {
        id: format!("folder-{}", uuid::Uuid::new_v4().simple()),
        path,
        name,
        // Legacy mounts were writable at the Docker layer, but migrating them to
        // read-only is the safe failure mode until the user explicitly re-enables write.
        access: FolderAccessMode::ReadOnly,
        active: true,
    }
}

fn read_folder_grants(path: &Path) -> Result<Vec<FolderGrant>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read allowed folders: {}", e))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse allowed folders: {}", e))?;

    if value.is_array() {
        let paths: Vec<String> = serde_json::from_value(value)
            .map_err(|e| format!("Failed to parse legacy allowed folders: {}", e))?;
        return Ok(paths.into_iter().map(legacy_grant).collect());
    }

    let manifest: FolderGrantManifest = serde_json::from_value(value)
        .map_err(|e| format!("Failed to parse folder grant manifest: {}", e))?;
    if manifest.version != FOLDER_MANIFEST_VERSION {
        return Err(format!(
            "Unsupported folder grant manifest version: {}",
            manifest.version
        ));
    }
    Ok(manifest.grants)
}

fn write_folder_grants(path: &Path, grants: &[FolderGrant]) -> Result<(), String> {
    let manifest = FolderGrantManifest {
        version: FOLDER_MANIFEST_VERSION,
        grants: grants.to_vec(),
    };
    let content = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize folder grants: {}", e))?;
    std::fs::write(path, content).map_err(|e| format!("Failed to write folder grants: {}", e))
}

fn read_and_migrate_folder_grants(path: &Path) -> Result<Vec<FolderGrant>, String> {
    let was_legacy = std::fs::read_to_string(path)
        .ok()
        .map(|content| content.trim_start().starts_with('['))
        .unwrap_or(false);
    let grants = read_folder_grants(path)?;
    if was_legacy {
        write_folder_grants(path, &grants)?;
    }
    Ok(grants)
}

fn normalize_folder_grants(
    directories: Vec<String>,
    access: FolderAccessMode,
    existing: &[FolderGrant],
) -> Result<Vec<FolderGrant>, String> {
    if directories.len() > MAX_CUSTOM_FOLDERS {
        return Err(format!(
            "An agent can access at most {} custom folders.",
            MAX_CUSTOM_FOLDERS
        ));
    }

    let existing_by_path: HashMap<&str, &FolderGrant> = existing
        .iter()
        .map(|grant| (grant.path.as_str(), grant))
        .collect();
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
        if normalized
            .iter()
            .any(|grant: &FolderGrant| grant.path == canonical)
        {
            continue;
        }

        let previous = existing_by_path.get(canonical.as_str()).copied();
        let name = Path::new(&canonical)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Allowed folder has no usable name: {}", canonical))?
            .to_string();
        normalized.push(FolderGrant {
            id: previous
                .map(|grant| grant.id.clone())
                .unwrap_or_else(|| format!("folder-{}", uuid::Uuid::new_v4().simple())),
            path: canonical,
            name,
            access,
            active: true,
        });
    }

    Ok(normalized)
}

fn validate_folder_access_mode(
    isolated: bool,
    requested_access: FolderAccessMode,
) -> Result<(), String> {
    if !isolated && requested_access == FolderAccessMode::ReadWrite {
        return Err(
            "Shared agents may access custom folders through the read-only Files Bridge only. Switch to Isolated Mode to grant write access."
                .to_string(),
        );
    }
    Ok(())
}

fn apply_folder_delivery_policy(
    grants: &mut [FolderGrant],
    isolated: bool,
    file_read_enabled: bool,
) {
    for grant in grants {
        grant.active = file_read_enabled;
        if !isolated {
            grant.access = FolderAccessMode::ReadOnly;
        }
    }
}

pub(crate) fn get_folder_grants_for_agent(agent_id: &str) -> Result<Vec<FolderGrant>, String> {
    let path = get_agent_workspace_config_path(agent_id).map_err(|e| e.to_string())?;
    read_and_migrate_folder_grants(&path)
}

async fn recreate_isolated_container(agent_id: &str) -> Result<(), String> {
    let Some(data_dir) = crate::flavor::canopy_data_dir() else {
        return Err("Could not locate the Canopy data directory".to_string());
    };
    let port = crate::openclaw::get_agent_isolated_port(agent_id);
    let compose_content = crate::docker::generate_isolated_compose(agent_id, &data_dir, port);
    let compose_path = data_dir.join(format!("docker-compose-{}.yml", agent_id));
    std::fs::write(&compose_path, compose_content)
        .map_err(|e| format!("Failed to write isolated compose file: {}", e))?;

    let compose_path = compose_path.to_string_lossy().to_string();
    let started = crate::docker::get_docker_compose_command()
        .args(["-f", &compose_path, "up", "-d"])
        .output()
        .await
        .map_err(|e| format!("Failed to refresh isolated folder mounts: {}", e))?;
    if !started.status.success() {
        return Err(format!(
            "Failed to refresh isolated folder mounts: {}",
            String::from_utf8_lossy(&started.stderr).trim()
        ));
    }

    let container_name = crate::flavor::isolated_container_name(agent_id);
    crate::channels::restore_agent_github_runtime(agent_id, &container_name).await;
    tracing::info!("Refreshed isolated folder mounts for {}", agent_id);
    Ok(())
}

pub(crate) async fn set_agent_allowed_directories(
    db: &crate::db::Database,
    agent_id: &str,
    directories: Vec<String>,
    requested_access: FolderAccessMode,
) -> Result<Vec<FolderGrant>, String> {
    crate::validators::agent::validate_id(agent_id).map_err(|e| e.to_string())?;
    let agent = db
        .get_agent(agent_id)
        .map_err(|e| format!("Failed to load agent: {}", e))?
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;

    validate_folder_access_mode(agent.isolated, requested_access)?;

    let path = get_agent_workspace_config_path(agent_id).map_err(|e| e.to_string())?;
    let existing = read_folder_grants(&path)?;
    let mut grants = normalize_folder_grants(directories, requested_access, &existing)?;
    apply_folder_delivery_policy(&mut grants, agent.isolated, agent.capabilities.file_read);
    write_folder_grants(&path, &grants)?;
    crate::bridge::sync_files_bridge(db, &agent, &grants)?;
    crate::openclaw::write_app_managed_instruction_files(&agent, db);

    if agent.isolated {
        recreate_isolated_container(agent_id).await?;
    }

    Ok(grants)
}

pub(crate) async fn refresh_folder_delivery(
    db: &crate::db::Database,
    agent_id: &str,
    refresh_isolated_mounts: bool,
) -> Result<(), String> {
    let agent = db
        .get_agent(agent_id)
        .map_err(|e| format!("Failed to load agent: {}", e))?
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    let path = get_agent_workspace_config_path(agent_id).map_err(|e| e.to_string())?;
    let mut grants = read_folder_grants(&path)?;

    apply_folder_delivery_policy(&mut grants, agent.isolated, agent.capabilities.file_read);
    write_folder_grants(&path, &grants)?;

    crate::bridge::sync_files_bridge(db, &agent, &grants)?;
    crate::openclaw::write_app_managed_instruction_files(&agent, db);
    if refresh_isolated_mounts && agent.isolated {
        recreate_isolated_container(agent_id).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_agent_allowed_directories(agent_id: String) -> Result<Vec<String>, String> {
    Ok(get_folder_grants_for_agent(&agent_id)?
        .into_iter()
        .map(|grant| grant.path)
        .collect())
}

#[tauri::command]
pub async fn update_agent_allowed_directories(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    directories: Vec<String>,
    access: Option<FolderAccessMode>,
) -> Result<(), String> {
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| format!("Failed to load agent: {}", e))?
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    let access = access.unwrap_or_else(|| {
        if agent.isolated && agent.capabilities.file_write {
            FolderAccessMode::ReadWrite
        } else {
            FolderAccessMode::ReadOnly
        }
    });
    set_agent_allowed_directories(&db, &agent_id, directories, access).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_folder_arrays_migrate_to_read_only_grants() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = dir.path().join("allowed.json");
        std::fs::write(&config, r#"["/tmp/example"]"#).expect("legacy config");

        let grants = read_and_migrate_folder_grants(&config).expect("legacy grants");
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].access, FolderAccessMode::ReadOnly);
        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).expect("migrated config"))
                .expect("manifest json");
        assert_eq!(persisted["version"], FOLDER_MANIFEST_VERSION);
    }

    #[test]
    fn directory_updates_are_canonical_and_deduplicated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().to_string();

        let normalized =
            normalize_folder_grants(vec![path.clone(), path], FolderAccessMode::ReadOnly, &[])
                .expect("valid directories");

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].access, FolderAccessMode::ReadOnly);
        assert_eq!(
            normalized[0].path,
            std::fs::canonicalize(dir.path())
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        );
    }

    #[test]
    fn directory_validation_rejects_relative_paths_and_files() {
        assert!(normalize_folder_grants(
            vec!["relative/path".to_string()],
            FolderAccessMode::ReadOnly,
            &[]
        )
        .is_err());

        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("not-a-directory.txt");
        std::fs::write(&file, "test").expect("test file");

        assert!(normalize_folder_grants(
            vec![file.to_string_lossy().to_string()],
            FolderAccessMode::ReadOnly,
            &[]
        )
        .is_err());
    }

    #[test]
    fn workspace_config_path_rejects_agent_id_traversal() {
        assert!(get_agent_workspace_config_path("../shared").is_err());
    }

    #[test]
    fn shared_agents_are_read_only_but_isolated_agents_may_write() {
        assert!(validate_folder_access_mode(false, FolderAccessMode::ReadOnly).is_ok());
        assert!(validate_folder_access_mode(false, FolderAccessMode::ReadWrite).is_err());
        assert!(validate_folder_access_mode(true, FolderAccessMode::ReadWrite).is_ok());
    }

    #[test]
    fn delivery_policy_deactivates_mounts_and_downgrades_shared_write() {
        let mut grants = vec![FolderGrant {
            id: "folder-test".to_string(),
            path: "/tmp/test".to_string(),
            name: "test".to_string(),
            access: FolderAccessMode::ReadWrite,
            active: true,
        }];

        apply_folder_delivery_policy(&mut grants, true, false);
        assert!(!grants[0].active);
        assert_eq!(grants[0].access, FolderAccessMode::ReadWrite);

        apply_folder_delivery_policy(&mut grants, false, true);
        assert!(grants[0].active);
        assert_eq!(grants[0].access, FolderAccessMode::ReadOnly);
    }
}
