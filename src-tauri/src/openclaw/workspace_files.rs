use base64::Engine;

fn validate_workspace_filename(filename: &str) -> Result<(), String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn read_workspace_file(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    filename: String,
) -> Result<String, String> {
    validate_workspace_filename(&filename)?;
    let workspace = super::get_agent_workspace_dir(&db, &agent_id)?;
    let file_path = workspace.join(&filename);
    if !file_path.exists() {
        return Ok("".to_string());
    }
    std::fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_workspace_file(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    validate_workspace_filename(&filename)?;
    let workspace = super::get_agent_workspace_dir(&db, &agent_id)?;
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let file_path = workspace.join(&filename);
    std::fs::write(&file_path, content).map_err(|e| e.to_string())
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
    let file_path = workspace.join(&filename);
    if !file_path.exists() {
        return Ok("".to_string());
    }
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
        assert!(validate_workspace_filename("nested/file.txt").is_err());
        assert!(validate_workspace_filename("nested\\file.txt").is_err());
    }

    #[test]
    fn filename_validation_accepts_plain_filenames() {
        assert!(validate_workspace_filename("notes.md").is_ok());
        assert!(validate_workspace_filename("screen-shot_1.png").is_ok());
    }
}
