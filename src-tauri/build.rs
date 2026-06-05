use std::{env, fs, path::PathBuf};

fn main() {
    if let Some(api_url) = load_vite_api_url() {
        println!("cargo:rustc-env=CANOPY_API_URL={}", api_url);
    }

    tauri_build::build()
}

fn load_vite_api_url() -> Option<String> {
    if let Ok(value) = env::var("VITE_API_URL") {
        let trimmed = value.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").ok()?);
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let mode_files = if profile == "release" {
        vec![
            manifest_dir.join("../.env.production.local"),
            manifest_dir.join("../.env.production"),
        ]
    } else {
        vec![
            manifest_dir.join("../.env.development.local"),
            manifest_dir.join("../.env.development"),
        ]
    };

    let env_files = mode_files
        .into_iter()
        .chain([
            manifest_dir.join("../.env.local"),
            manifest_dir.join("../.env"),
        ]);

    for env_file in env_files {
        let contents = match fs::read_to_string(&env_file) {
            Ok(contents) => contents,
            Err(_) => continue,
        };

        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            if let Some(value) = trimmed.strip_prefix("VITE_API_URL=") {
                let cleaned = value.trim().trim_matches('"').trim_matches('\'');
                if !cleaned.is_empty() {
                    return Some(cleaned.trim_end_matches('/').to_string());
                }
            }
        }
    }
    None
}
