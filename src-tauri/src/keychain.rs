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
        "XAI_API_KEY",   // current xAI env var name
        "GROK_API_KEY",  // legacy xAI env var name (some users still have this)
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
                                
                                // Map env var name → short provider id used by ProvidersVault.
                                // Both XAI_API_KEY and GROK_API_KEY map to "grok" so ProvidersVault
                                // stores them as XAI_API_KEY via getKeyName("grok").
                                let provider = match *key {
                                    "OPENAI_API_KEY"    => "openai",
                                    "ANTHROPIC_API_KEY" => "anthropic",
                                    "GEMINI_API_KEY"    => "gemini",
                                    "XAI_API_KEY"       => "grok",
                                    "GROK_API_KEY"      => "grok",
                                    _ => continue,
                                };

                                // Don't overwrite a key already discovered (XAI wins over GROK)
                                if !discovered.contains_key(provider) {
                                    discovered.insert(provider.to_string(), val);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(discovered)
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
