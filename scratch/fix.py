import os

with open("src-tauri/src/docker.rs", "r") as f:
    content = f.read()

merge_fn = """
fn merge_json(a: &mut serde_json::Value, b: &serde_json::Value) {
    match (a, b) {
        (&mut serde_json::Value::Object(ref mut a_obj), serde_json::Value::Object(b_obj)) => {
            for (k, v) in b_obj {
                merge_json(a_obj.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (a_val, b_val) => {
            *a_val = b_val.clone();
        }
    }
}
"""

content = content.replace("pub fn preflight_sanitize_and_merge_config", merge_fn + "\n" + "pub fn preflight_sanitize_and_merge_config")

with open("src-tauri/src/docker.rs", "w") as f:
    f.write(content)

with open("src-tauri/src/openclaw.rs", "r") as f:
    openclaw_content = f.read()

import re
# We need to replace the call to crate::docker::preflight_write_isolated_openclaw_json
# with crate::docker::preflight_sanitize_and_merge_config
# It looks like:
# crate::docker::preflight_write_isolated_openclaw_json(
#     &state_dir,
#     crate::model_constants::GATEWAY_INTERNAL_TOKEN
# );
replacement = """
                let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").is_ok();
                let has_openai = crate::keychain::get_secret("OPENAI_API_KEY").is_ok();
                let has_gemini = crate::keychain::get_secret("GEMINI_API_KEY").is_ok();
                crate::docker::preflight_sanitize_and_merge_config(
                    &state_dir,
                    true,
                    crate::model_constants::GATEWAY_INTERNAL_TOKEN,
                    has_anthropic,
                    has_openai,
                    has_gemini
                );
"""
openclaw_content = re.sub(
    r'crate::docker::preflight_write_isolated_openclaw_json\([\s\S]*?\);',
    replacement.strip(),
    openclaw_content
)

with open("src-tauri/src/openclaw.rs", "w") as f:
    f.write(openclaw_content)

