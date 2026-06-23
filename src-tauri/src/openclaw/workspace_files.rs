use base64::Engine;

fn validate_workspace_filename(filename: &str) -> Result<(), String> {
    if filename.contains("..") || filename.starts_with('/') || filename.starts_with('\\') {
        return Err("Invalid filename".into());
    }
    Ok(())
}

fn find_file_in_workspace(
    dir: &std::path::Path,
    target_filename: &str,
) -> Option<std::path::PathBuf> {
    // 1. Direct check
    let direct = dir.join(target_filename);
    if direct.is_file() {
        return Some(direct);
    }

    // 2. Recursive check - only if target_filename doesn't contain path separators
    if target_filename.contains('/') || target_filename.contains('\\') {
        return None;
    }

    let mut dirs_to_visit = vec![dir.to_path_buf()];
    while let Some(current_dir) = dirs_to_visit.pop() {
        if let Ok(entries) = std::fs::read_dir(&current_dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_dir() {
                        dirs_to_visit.push(entry.path());
                    } else if file_type.is_file() && entry.file_name() == target_filename {
                        return Some(entry.path());
                    }
                }
            }
        }
    }
    None
}

fn is_app_managed_filename(filename: &str) -> bool {
    super::APP_MANAGED_FRAMEWORK_FILES.contains(&filename)
}

fn write_workspace_file_inner(
    db: &crate::db::Database,
    agent_id: &str,
    filename: &str,
    content: &str,
) -> Result<(), String> {
    validate_workspace_filename(filename)?;
    if is_app_managed_filename(filename) {
        return Err(format!(
            "{} is app-managed and not directly editable",
            filename
        ));
    }
    if filename == "USER.md" {
        return super::sync_shared_user_md_to_all_agents(db, content);
    }

    let workspace = super::get_agent_workspace_dir(db, agent_id)?;
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let file_path = workspace.join(filename);
    std::fs::write(&file_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_workspace_file(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    filename: String,
) -> Result<String, String> {
    validate_workspace_filename(&filename)?;
    let workspace = super::get_agent_workspace_dir(&db, &agent_id)?;

    let file_path = match find_file_in_workspace(&workspace, &filename) {
        Some(path) => path,
        None => return Ok("".to_string()),
    };

    std::fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_workspace_file(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    write_workspace_file_inner(&db, &agent_id, &filename, &content)
}

#[tauri::command]
pub async fn upload_workspace_file(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    filename: String,
    base64_data: String,
) -> Result<(), String> {
    validate_workspace_filename(&filename)?;
    let workspace = super::get_agent_workspace_dir(&db, &agent_id)?;

    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let file_path = workspace.join(&filename);

    let clean_base64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(clean_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    std::fs::write(&file_path, decoded).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn copy_file_to_workspace(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    source_path: String,
    target_filename: String,
) -> Result<(), String> {
    validate_workspace_filename(&target_filename)?;
    let workspace = super::get_agent_workspace_dir(&db, &agent_id)?;

    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let file_path = workspace.join(&target_filename);

    std::fs::copy(&source_path, &file_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn read_workspace_file_base64(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    filename: String,
) -> Result<String, String> {
    validate_workspace_filename(&filename)?;
    let workspace = super::get_agent_workspace_dir(&db, &agent_id)?;

    let file_path = match find_file_in_workspace(&workspace, &filename) {
        Some(path) => path,
        None => return Ok("".to_string()),
    };

    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let mime = if filename.ends_with(".png") {
        "image/png"
    } else if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
        "image/jpeg"
    } else if filename.ends_with(".gif") {
        "image/gif"
    } else if filename.ends_with(".webp") {
        "image/webp"
    } else if filename.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    };

    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_validation_rejects_path_escape() {
        assert!(validate_workspace_filename("../secret.txt").is_err());
        assert!(validate_workspace_filename("/etc/passwd").is_err());
        assert!(validate_workspace_filename("\\windows\\system32").is_err());
    }

    #[test]
    fn filename_validation_accepts_plain_filenames() {
        assert!(validate_workspace_filename("notes.md").is_ok());
        assert!(validate_workspace_filename("screen-shot_1.png").is_ok());
        assert!(validate_workspace_filename("nested/file.txt").is_ok());
    }

    #[test]
    fn app_managed_files_are_not_directly_editable() {
        assert!(is_app_managed_filename("APP_PROTOCOLS.md"));
        assert!(is_app_managed_filename("APP_CAPABILITIES.md"));
        assert!(is_app_managed_filename("APP_OPERATING_MODEL.md"));
    }
}
