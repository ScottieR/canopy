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
    entry.delete_password().map_err(|e| e.to_string())?;
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

/// Auto-discovery of API keys by scanning common shell config files on macOS.
#[tauri::command]
pub fn auto_discover_keys_cmd() -> Result<std::collections::HashMap<String, String>, String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};
    
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
        "GROK_API_KEY"
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
                        if trimmed.contains(key) {
                            let parts: Vec<&str> = trimmed.split('=').collect();
                            if parts.len() >= 2 {
                                let mut val = parts[1..].join("=");
                                // strip quotes if any
                                val = val.trim_matches('"').trim_matches('\'').to_string();
                                
                                // map internal name
                                let provider = match *key {
                                    "OPENAI_API_KEY" => "openai",
                                    "ANTHROPIC_API_KEY" => "anthropic",
                                    "GEMINI_API_KEY" => "gemini",
                                    "GROK_API_KEY" => "grok",
                                    _ => continue,
                                };
                                
                                discovered.insert(provider.to_string(), val);
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(discovered)
}
