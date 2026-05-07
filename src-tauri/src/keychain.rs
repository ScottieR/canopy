use keyring::Entry;
use std::collections::HashMap;

const SERVICE_NAME: &str = "com.canopy.app";
const VAULT_KEY: &str = "canopy_vault_v2";

/// Secure credential storage via macOS Keychain.
/// Agents never see raw tokens — the bridge layer injects them.

fn get_vault() -> HashMap<String, String> {
    let entry = match Entry::new(SERVICE_NAME, VAULT_KEY) {
        Ok(e) => e,
        Err(_) => return HashMap::new(),
    };
    if let Ok(json_str) = entry.get_password() {
        serde_json::from_str(&json_str).unwrap_or_default()
    } else {
        HashMap::new()
    }
}

fn save_vault(vault: &HashMap<String, String>) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, VAULT_KEY).map_err(|e| e.to_string())?;
    let json_str = serde_json::to_string(vault).map_err(|e| e.to_string())?;
    entry.set_password(&json_str).map_err(|e| e.to_string())?;
    Ok(())
}

/// Internal helper: store a secret (callable from other Rust modules)
pub fn store_secret(key: &str, value: &str) -> Result<(), String> {
    let mut vault = get_vault();
    vault.insert(key.to_string(), value.to_string());
    save_vault(&vault)?;
    tracing::info!("Stored secret: {}", key);
    Ok(())
}

/// Internal helper: get a secret (callable from other Rust modules)
pub fn get_secret(key: &str) -> Result<String, String> {
    let vault = get_vault();
    vault.get(key).cloned().ok_or_else(|| format!("Secret '{}' not found: {}", key, key))
}

/// Internal helper: delete a secret (callable from other Rust modules)
pub fn delete_secret_internal(key: &str) -> Result<(), String> {
    let mut vault = get_vault();
    if vault.remove(key).is_some() {
        save_vault(&vault)?;
        tracing::info!("Deleted secret: {}", key);
    }
    Ok(())
}

/// Helper: Get an agent's API key with fallback to the global provider key
pub fn get_agent_api_key(agent_id: &str, provider_id: &str) -> Result<String, String> {
    // 1. Check agent-specific override
    let agent_key = format!("agent_{}_api_key", agent_id);
    if let Ok(key) = get_secret(&agent_key) {
        return Ok(key);
    }
    
    // 2. Fall back to global provider key
    let global_key = format!("{}_API_KEY", provider_id.to_uppercase());
    if let Ok(key) = get_secret(&global_key) {
        return Ok(key);
    }
    
    Err(format!("No API key found for agent {} or provider {}", agent_id, provider_id))
}

// ─── Tauri Commands (take owned Strings for IPC deserialization) ────────────

#[tauri::command]
pub fn store_secret_cmd(key: String, value: String) -> Result<(), String> {
    store_secret(&key, &value)
}

#[tauri::command]
pub fn store_batch_secrets_cmd(secrets: std::collections::HashMap<String, String>) -> Result<(), String> {
    let mut vault = get_vault();
    for (key, value) in secrets {
        vault.insert(key, value);
    }
    save_vault(&vault)?;
    Ok(())
}

#[tauri::command]
pub fn get_secret_cmd(key: String) -> Result<String, String> {
    get_secret(&key)
}

#[tauri::command]
pub fn delete_secret_cmd(key: String) -> Result<(), String> {
    delete_secret_internal(&key)
}

/// Check if auto-discovery has already been performed (first-run check)
pub fn has_auto_discovered() -> bool {
    get_secret("_auto_discovery_completed").is_ok()
}

/// Mark auto-discovery as completed to prevent repeated scanning
pub fn mark_auto_discovery_complete() -> Result<(), String> {
    store_secret("_auto_discovery_completed", "true")
}

/// Auto-discovery of API keys by scanning common shell config files on macOS.
///
/// SECURITY: This function reads plaintext secrets from shell config files
/// and migrates them to the secure macOS Keychain. It should only be called
/// once during initial setup, and users should be explicitly informed that
/// plaintext keys will be read from their config files.
#[tauri::command]
pub fn auto_discover_keys_cmd() -> Result<std::collections::HashMap<String, String>, String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    // SECURITY: Log warning about plaintext key scanning
    tracing::warn!("AUTO-DISCOVERY: Scanning shell config files for plaintext API keys. This is a one-time setup operation.");

    let mut discovered = std::collections::HashMap::new();
    let home = dirs::home_dir().ok_or("Could not find home directory")?;

    let paths_to_check = vec![
        home.join(".zshrc"),
        home.join(".bash_profile"),
        home.join(".bashrc"),
        home.join(".env"),
    ];

    let target_keys = vec![
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",   // current xAI env var name
        "GROK_API_KEY",  // legacy xAI env var name (some users still have this)
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "PRIVACY_API_KEY",
    ];

    for path in paths_to_check {
        if path.exists() {
            if let Ok(file) = File::open(&path) {
                let reader = BufReader::new(file);
                for line in reader.lines().flatten() {
                    let trimmed = line.trim();
                    if trimmed.starts_with('#') { continue; }

                    for key in &target_keys {
                        // match `export KEY=value` or `KEY=value`
                        if trimmed.contains(key) && trimmed.contains('=') {
                            let parts: Vec<&str> = trimmed.split('=').collect();
                            if parts.len() >= 2 {
                                let mut val = parts[1..].join("=");
                                // strip quotes if any
                                val = val.trim_matches('"').trim_matches('\'').to_string();

                                // Skip empty values
                                if val.is_empty() {
                                    continue;
                                }

                                // Map env var name → vault key name
                                let vault_key = *key;

                                // Don't overwrite a key already in vault
                                if get_secret(vault_key).is_err() {
                                    discovered.insert(vault_key.to_string(), val);
                                    tracing::info!("AUTO-DISCOVERY: Found {} in config files", vault_key);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if !discovered.is_empty() {
        tracing::warn!("AUTO-DISCOVERY: Found {} plaintext secrets. Recommend deleting them from config files after migration.", discovered.len());
    }

    Ok(discovered)
}

/// Remove plaintext API keys from shell config files after migration to keychain.
///
/// This function safely removes API key definitions from .bashrc, .bash_profile,
/// .zshrc, and .env files. It performs a simple pattern match to find and remove
/// lines containing the key definition.
pub fn cleanup_plaintext_keys(keys_to_remove: Vec<String>) -> Result<Vec<String>, String> {
    use std::fs::{File, OpenOptions};
    use std::io::{BufRead, BufReader, Write};

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let mut removed_files = Vec::new();

    let paths_to_check = vec![
        home.join(".zshrc"),
        home.join(".bash_profile"),
        home.join(".bashrc"),
        home.join(".env"),
    ];

    for path in paths_to_check {
        if !path.exists() {
            continue;
        }

        // Read the file
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);
        let mut lines: Vec<String> = reader.lines().collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let original_len = lines.len();

        // Filter out lines containing the keys to remove
        lines.retain(|line| {
            let trimmed = line.trim();
            // Skip comment lines
            if trimmed.starts_with('#') {
                return true;
            }
            // Remove lines that match any of the keys to remove
            for key in &keys_to_remove {
                if trimmed.contains(key) && trimmed.contains('=') {
                    tracing::info!("Removing plaintext {} from {}", key, path.display());
                    return false;
                }
            }
            true
        });

        // Write back only if something was removed
        if lines.len() < original_len {
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .map_err(|e| e.to_string())?;

            for line in lines {
                writeln!(file, "{}", line).map_err(|e| e.to_string())?;
            }

            removed_files.push(path.to_string_lossy().to_string());
            tracing::info!("Cleaned up plaintext keys from {}", path.display());
        }
    }

    // Mark auto-discovery as completed to prevent repeated scanning
    let _ = mark_auto_discovery_complete();

    Ok(removed_files)
}

#[tauri::command]
pub fn get_web_credentials_cmd() -> Result<Vec<serde_json::Value>, String> {
    let vault = get_vault();
    let mut creds = Vec::new();
    for (key, _val) in vault {
        if key.starts_with("web_") {
            let parts: Vec<&str> = key.splitn(3, '_').collect();
            if parts.len() == 3 {
                creds.push(serde_json::json!({
                    "domain": parts[1],
                    "username": parts[2]
                }));
            }
        }
    }
    Ok(creds)
}
