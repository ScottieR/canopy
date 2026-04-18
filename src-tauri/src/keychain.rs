use keyring::Entry;

const SERVICE_NAME: &str = "com.canopy.app";

/// Secure credential storage via macOS Keychain.
/// Agents never see raw tokens — the bridge layer injects them.

/// Internal helper: store a secret (callable from other Rust modules)
pub fn store_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())?;
    tracing::info!("Stored secret: {}", key);
    Ok(())
}

/// Internal helper: get a secret (callable from other Rust modules)
pub fn get_secret(key: &str) -> Result<String, String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| format!("Secret '{}' not found: {}", key, e))
}

/// Internal helper: delete a secret (callable from other Rust modules)
pub fn delete_secret_internal(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.delete_credential().map_err(|e| e.to_string())?;
    tracing::info!("Deleted secret: {}", key);
    Ok(())
}

// ─── Tauri Commands (take owned Strings for IPC deserialization) ────────────

#[tauri::command]
pub fn store_secret_cmd(key: String, value: String) -> Result<(), String> {
    store_secret(&key, &value)
}

#[tauri::command]
pub fn get_secret_cmd(key: String) -> Result<String, String> {
    get_secret(&key)
}

#[tauri::command]
pub fn delete_secret_cmd(key: String) -> Result<(), String> {
    delete_secret_internal(&key)
}
