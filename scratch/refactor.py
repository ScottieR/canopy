import os

with open("src-tauri/src/docker.rs", "r") as f:
    content = f.read()

# 1. We replace the `fn preflight_write_openclaw_json` up to the end of `pub fn preflight_write_isolated_openclaw_json` with our new function.
import re

start_marker = "fn preflight_write_openclaw_json(data_dir: &PathBuf, token: &str) {"
end_marker = "pub fn preflight_write_isolated_openclaw_json(state_dir: &std::path::Path, token: &str) {"
# find the end of preflight_write_isolated_openclaw_json
# It ends with:
#     match serde_json::to_string_pretty(&cfg).map(|s| std::fs::write(&config_path, s)) {
#         Ok(Ok(_)) => tracing::info!("preflight_write_isolated_openclaw_json: ensured baseline config at {:?}", config_path),
#         Ok(Err(e)) => tracing::warn!("preflight_write_isolated_openclaw_json: could not write {:?}: {}", config_path, e),
#         Err(e) => tracing::warn!("preflight_write_isolated_openclaw_json: serialization error: {}", e),
#     }
# }

new_fn = """pub fn preflight_sanitize_and_merge_config(state_dir: &std::path::Path, is_isolated: bool, token: &str) {
    let config_path = state_dir.join("openclaw.json");

    // ── 1. Delete OpenClaw's backup configs to prevent "size-drop" anomaly ──────
    if let Ok(entries) = std::fs::read_dir(state_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let is_backup = name.starts_with("openclaw.json.bak")
                    || name.starts_with("openclaw.json.clobbered")
                    || name.starts_with("openclaw.json.last-good")
                    || name.starts_with(".openclaw-last-good");
                if is_backup {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    // ── 2. Build from Scratch (Whitelist Preservation) ─────────────────────────
    let mut cfg = match std::fs::read_to_string(&config_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(existing) => {
                let mut base = serde_json::json!({});
                // Preserve crucial state to avoid anomaly loops and keep integrations
                if let Some(meta) = existing.get("meta") { base["meta"] = meta.clone(); }
                if let Some(channels) = existing.get("channels") { base["channels"] = channels.clone(); }
                if let Some(bindings) = existing.get("bindings") { base["bindings"] = bindings.clone(); }
                
                // For plugins, preserve the enabled flags of specific integrations
                if let Some(plugins) = existing.pointer("/plugins/entries") {
                    if let Some(slack) = plugins.get("slack") { base["plugins"]["entries"]["slack"] = slack.clone(); }
                    if let Some(google) = plugins.get("google") { base["plugins"]["entries"]["google"] = google.clone(); }
                }

                // For isolated containers, we must preserve their agents.list and full plugins
                if is_isolated {
                    if let Some(agents_list) = existing.pointer("/agents/list") {
                        base["agents"]["list"] = agents_list.clone();
                    }
                    if let Some(plugins) = existing.get("plugins") {
                        base["plugins"] = plugins.clone();
                    }
                }
                base
            }
            Err(_) => serde_json::json!({}),
        },
        Err(_) => serde_json::json!({}),
    };

    // ── 3. Forceful Sanitization (Protects against known OpenClaw bugs) ─────────
    if let Some(gw) = cfg.get_mut("gateway").and_then(|g| g.as_object_mut()) {
        gw.remove("bonjour");
    }

    if let Some(channels) = cfg.get_mut("channels").and_then(|c| c.as_object_mut()) {
        if let Some(slack) = channels.get_mut("slack").and_then(|s| s.as_object_mut()) {
            slack.remove("botToken");
            slack.remove("appToken");
        }
    }

    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").is_ok();
    let has_openai = crate::keychain::get_secret("OPENAI_API_KEY").is_ok();
    let has_gemini = crate::keychain::get_secret("GEMINI_API_KEY").is_ok();
    let default_model = crate::model_constants::default_model_from_available_keys(has_anthropic, has_openai, has_gemini);
    
    cfg["agents"]["defaults"]["model"] = serde_json::json!({ "primary": default_model });
    cfg["agents"]["defaults"]["models"][default_model] = serde_json::json!({});
    cfg["agents"]["defaults"]["skills"] = serde_json::json!(["gog", "summarize"]);

    // ── 4. Build Required Baseline ─────────────────────────────────────────────
    let mut required_baseline = serde_json::json!({
        "gateway": {
            "auth": {
                "mode": "token",
                "token": token
            },
            "mode": "local",
            "port": 18789
        }
    });

    // ── 5. Context-Aware Injections (Main Gateway Only) ────────────────────────
    if !is_isolated {
        required_baseline["agents"]["defaults"]["memorySearch"] = serde_json::json!({
            "enabled": true,
            "provider": "chroma",
            "remote": {
                "baseUrl": "http://canopy-chroma:8000"
            }
        });

        required_baseline["plugins"]["entries"]["browser"]["enabled"] = serde_json::json!(true);
        required_baseline["browser"] = serde_json::json!({
            "noSandbox": true,
            "attachOnly": true,
            "cdpUrl": format!("http://host.docker.internal:{}", crate::browser_manager::SHARED_BRIDGE_PORT),
            "defaultProfile": "openclaw"
        });

        required_baseline["plugins"]["entries"]["talk-voice"]["enabled"] = serde_json::json!(true);
        required_baseline["plugins"]["entries"]["google"]["enabled"] = serde_json::json!(true);
        required_baseline["plugins"]["entries"]["device-pair"]["enabled"] = serde_json::json!(false);
        required_baseline["plugins"]["entries"]["phone-control"]["enabled"] = serde_json::json!(false);

        cfg["agents"]["list"] = serde_json::json!([]);
    }

    // ── 6. Graceful Deep Merge ─────────────────────────────────────────────────
    merge_json(&mut cfg, &required_baseline);

    // ── 7. Write back ──────────────────────────────────────────────────────────
    let _ = std::fs::create_dir_all(state_dir);
    if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
        let _ = std::fs::write(&config_path, updated);
        tracing::info!("preflight_sanitize_and_merge_config (isolated={}): ensured safe baseline config at {:?}", is_isolated, config_path);
    }
}
"""

start_idx = content.find(start_marker)
# Find the end of `preflight_write_isolated_openclaw_json`
import re
end_match = re.search(r'pub fn preflight_write_isolated_openclaw_json.*?serialization error: \{\}", e\),\n    \}\n}', content, re.DOTALL)
if not end_match:
    print("Could not find end match")
    exit(1)

content = content[:start_idx] + new_fn + content[end_match.end():]

# Now let's remove the backup deletion in `start_gateway_internal`
backup_del_start = content.find('// ── Delete OpenClaw\'s backup configs to prevent "size-drop" anomaly ──────')
backup_del_end = content.find('// ── Save agents.list BEFORE preflight overwrites openclaw.json')
if backup_del_start != -1 and backup_del_end != -1:
    content = content[:backup_del_start] + content[backup_del_end:]

# Replace the preflight call
content = content.replace(
    'preflight_write_openclaw_json(&data_dir, crate::model_constants::GATEWAY_INTERNAL_TOKEN);',
    'preflight_sanitize_and_merge_config(&state_dir, false, crate::model_constants::GATEWAY_INTERNAL_TOKEN);'
)

with open("src-tauri/src/docker.rs", "w") as f:
    f.write(content)

