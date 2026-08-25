// ─── Web-hosted connection token capture ──────────────────────────────────────
//
// Lets an agent ask the user for a provider API key over Slack without the
// desktop app needing to be reachable from the user's phone at capture time
// (the `canopy://` deep-link companion flow requires that, and iPad/iPhone ->
// desktop connectivity is unreliable). Instead:
//
//   1. This module mints a short-lived UUID token and hands canopy-admin (the
//      Cloud Run backend) everything it needs to render a `/connect/{token}`
//      web page: provider name, instructions, placeholder, and this instance's
//      X25519 public key.
//   2. The user opens that page on any browser and pastes the key. The page
//      encrypts it to our public key before it ever reaches canopy-admin, so
//      canopy-admin (and anyone who can read its database) sees ciphertext
//      only — the key is confidential to this specific Canopy install.
//   3. `start_web_connections_poll_daemon` polls canopy-admin every 5s for
//      completions, decrypts locally with our private key, and stores the
//      plaintext straight into the Keychain vault. The raw key is never
//      logged, never echoed back to the agent, and never round-trips through
//      chat.
//
// See `WEB_CONNECTIONS.md` at the repo root for the canopy-admin side of this
// contract (the two endpoints and the `/connect/{token}` page it needs to
// serve) — that half is out of scope for this repo.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use chrono::{Duration as ChronoDuration, Utc};
use hkdf::Hkdf;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::State;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::db::{Database, PendingConnectionRecord};
use crate::validators;

const TTL_MINUTES: i64 = 15;
const DEFAULT_PLACEHOLDER: &str = "Paste your API key here";
const INSTRUCTIONS_MAX_LENGTH: usize = 600;
const PROVIDER_NAME_MAX_LENGTH: usize = 200;

// Not exposed through the Tauri IPC allowlist (validate_secret_key_for_ipc rejects
// anything outside its own prefix/suffix list) — this key never leaves the Rust side.
const INSTANCE_SECRET_KEY: &str = "internal_web_connections_x25519_secret";

// HKDF context string binding the derived AEAD key to this protocol, so the same
// ECDH shared secret can't be reused/confused with any other X25519 usage in the app.
const HKDF_INFO: &[u8] = b"canopy-web-connections-v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebConnectionToken {
    pub token: String,
    pub url: String,
    pub expires_at: String,
}

/// What the `/connect/{token}` page submits to canopy-admin, and what we read back
/// on poll. `ciphertext`/`nonce`/`ephemeral_public_key` are all base64 (standard).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletedConnection {
    token: String,
    ciphertext: String,
    nonce: String,
    ephemeral_public_key: String,
}

#[derive(Debug, Deserialize)]
struct PendingConnectionsResponse {
    #[serde(default)]
    completed: Vec<CompletedConnection>,
}

fn sanitize_secret_name(raw: &str) -> String {
    let mut out = String::new();
    let mut pending_sep = false;
    for c in raw.trim().chars() {
        if c.is_ascii_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('_');
            }
            out.push(c.to_ascii_uppercase());
            pending_sep = false;
        } else {
            pending_sep = true;
        }
    }
    out
}

/// Mirrors `buildApiKeyCompanionRequest` in `src/utils/connectionRequests.ts` — keep
/// the two in sync so a key requested via chat and one requested via Slack land under
/// the same Keychain name.
fn derive_secret_name(provider_name: &str, explicit: Option<&str>) -> Option<String> {
    let base = explicit
        .map(sanitize_secret_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| sanitize_secret_name(provider_name));
    if base.is_empty() {
        return None;
    }
    if base.ends_with("_API_KEY") || base.ends_with("_TOKEN") || base.ends_with("_KEY") {
        Some(base)
    } else {
        Some(format!("{base}_API_KEY"))
    }
}

fn validate_token_url(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if parsed.scheme() == "http" || parsed.scheme() == "https" {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn clamp_instructions(raw: Option<String>) -> Option<String> {
    raw.map(|s| {
        s.trim()
            .chars()
            .take(INSTRUCTIONS_MAX_LENGTH)
            .collect::<String>()
    })
    .filter(|s| !s.is_empty())
}

// ─── Instance keypair ──────────────────────────────────────────────────────────

fn get_or_create_instance_secret() -> Result<StaticSecret, String> {
    if let Ok(hex_key) = crate::keychain::get_secret(INSTANCE_SECRET_KEY) {
        if let Ok(bytes) = hex::decode(&hex_key) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Ok(StaticSecret::from(arr));
            }
        }
    }
    let secret = StaticSecret::random_from_rng(OsRng);
    crate::keychain::store_secret(INSTANCE_SECRET_KEY, &hex::encode(secret.to_bytes()))
        .map_err(|e| format!("keychain: {e}"))?;
    Ok(secret)
}

fn get_or_create_instance_public_key_b64() -> Result<String, String> {
    let secret = get_or_create_instance_secret()?;
    let public = PublicKey::from(&secret);
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        public.as_bytes(),
    ))
}

/// ECIES-style decrypt: ECDH(our static secret, sender's ephemeral public key) ->
/// HKDF-SHA256 -> ChaCha20-Poly1305. Never logs the plaintext it returns.
fn decrypt_delivered_secret(
    ciphertext_b64: &str,
    nonce_b64: &str,
    ephemeral_public_key_b64: &str,
) -> Result<String, String> {
    let our_secret = get_or_create_instance_secret()?;
    decrypt_delivered_secret_with(
        &our_secret,
        ciphertext_b64,
        nonce_b64,
        ephemeral_public_key_b64,
    )
}

/// Same as [`decrypt_delivered_secret`] but takes the instance secret as a parameter
/// instead of reading it from the Keychain — split out so tests can exercise the
/// actual crypto without a real (slow, occasionally interactive-prompting on an
/// unsigned dev build) Keychain round trip.
fn decrypt_delivered_secret_with(
    our_secret: &StaticSecret,
    ciphertext_b64: &str,
    nonce_b64: &str,
    ephemeral_public_key_b64: &str,
) -> Result<String, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;

    let ephemeral_bytes = engine
        .decode(ephemeral_public_key_b64)
        .map_err(|_| "invalid ephemeral public key encoding".to_string())?;
    let ephemeral_arr: [u8; 32] = ephemeral_bytes
        .try_into()
        .map_err(|_| "ephemeral public key must be 32 bytes".to_string())?;
    let ephemeral_public = PublicKey::from(ephemeral_arr);

    let shared = our_secret.diffie_hellman(&ephemeral_public);

    let hk = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let mut aead_key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut aead_key)
        .map_err(|_| "key derivation failed".to_string())?;

    let nonce_bytes = engine
        .decode(nonce_b64)
        .map_err(|_| "invalid nonce encoding".to_string())?;
    if nonce_bytes.len() != 12 {
        return Err("nonce must be 12 bytes".to_string());
    }
    let ciphertext = engine
        .decode(ciphertext_b64)
        .map_err(|_| "invalid ciphertext encoding".to_string())?;

    let cipher = ChaCha20Poly1305::new((&aead_key).into());
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| "decryption failed".to_string())?;

    String::from_utf8(plaintext).map_err(|_| "decrypted payload was not valid UTF-8".to_string())
}

// ─── canopy-admin base URL ─────────────────────────────────────────────────────

fn connections_base_url() -> String {
    crate::admin_api_base_url().to_string()
}

// ─── Token generation ──────────────────────────────────────────────────────────

/// Core implementation, callable from both the Tauri command (desktop IPC) and the
/// JIT bridge route (agents running inside the OpenClaw Docker container reach this
/// over `host.docker.internal:18802/generate_web_connection_token` — Tauri IPC isn't
/// reachable from inside the container).
pub async fn generate_web_connection_token_impl(
    db: &Database,
    agent_id: &str,
    provider_name: &str,
    token_url: Option<String>,
    instructions: Option<String>,
    placeholder: Option<String>,
    secret_key: Option<String>,
) -> Result<WebConnectionToken, String> {
    validators::agent::validate_id(agent_id).map_err(|e| e.to_string())?;

    let provider_name = provider_name.trim();
    if provider_name.is_empty() || provider_name.chars().count() > PROVIDER_NAME_MAX_LENGTH {
        return Err("providerName must be 1-200 characters".to_string());
    }

    let secret_name = derive_secret_name(provider_name, secret_key.as_deref())
        .ok_or_else(|| "could not derive a secret name from providerName".to_string())?;
    let token_url = validate_token_url(token_url);
    let instructions = clamp_instructions(instructions);
    let placeholder = placeholder
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PLACEHOLDER.to_string());

    let public_key_b64 = get_or_create_instance_public_key_b64()?;

    let token = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let expires_at = now + ChronoDuration::minutes(TTL_MINUTES);
    let base = connections_base_url();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let response = client
        .post(format!("{base}/api/connections/pending"))
        .json(&serde_json::json!({
            "token": token,
            "agentId": agent_id,
            "providerName": provider_name,
            "secretName": secret_name,
            "tokenUrl": token_url,
            "instructions": instructions,
            "placeholder": placeholder,
            "publicKey": public_key_b64,
            "expiresAt": expires_at.to_rfc3339(),
        }))
        .send()
        .await
        .map_err(|e| format!("connections_pending_failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "connections_pending_rejected: HTTP {status} {body}"
        ));
    }

    let record = PendingConnectionRecord {
        token: token.clone(),
        agent_id: agent_id.to_string(),
        provider_name: provider_name.to_string(),
        secret_name,
        token_url,
        instructions,
        placeholder,
        created_at: now.to_rfc3339(),
        expires_at: expires_at.to_rfc3339(),
    };
    db.insert_pending_connection(&record)
        .map_err(|e| format!("local pending_connections insert failed: {e}"))?;

    Ok(WebConnectionToken {
        url: format!("{base}/connect/{token}"),
        token,
        expires_at: record.expires_at,
    })
}

#[tauri::command]
pub async fn generate_web_connection_token(
    db: State<'_, Database>,
    agent_id: String,
    provider_name: String,
    token_url: Option<String>,
    instructions: Option<String>,
    placeholder: Option<String>,
    secret_key: Option<String>,
) -> Result<WebConnectionToken, String> {
    generate_web_connection_token_impl(
        &db,
        &agent_id,
        &provider_name,
        token_url,
        instructions,
        placeholder,
        secret_key,
    )
    .await
}

// ─── Background polling ─────────────────────────────────────────────────────────

/// Polls canopy-admin every 5s for tokens this instance is waiting on that have been
/// completed, decrypts the delivered key, and stores it in the vault. See
/// `health_monitor::start_health_monitor_daemon` for the same daemon-spawn shape.
pub fn start_web_connections_poll_daemon(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            poll_pending_connections(&app_handle).await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

async fn poll_pending_connections(app_handle: &tauri::AppHandle) {
    use std::collections::HashSet;
    use tauri::{Emitter, Manager};

    let db = app_handle.state::<Database>();

    if let Err(e) = db.delete_expired_pending_connections(&Utc::now().to_rfc3339()) {
        tracing::warn!("web_connections: failed to sweep expired tokens: {e}");
    }

    let pending = match db.list_pending_connections() {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("web_connections: failed to list pending tokens: {e}");
            return;
        }
    };
    if pending.is_empty() {
        return;
    }

    let base = connections_base_url();
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    let agent_ids: HashSet<&str> = pending.iter().map(|p| p.agent_id.as_str()).collect();

    for agent_id in agent_ids {
        let response = match client
            .get(format!("{base}/api/connections/pending"))
            .query(&[("agent_id", agent_id)])
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!("web_connections: poll failed for {agent_id}: {e}");
                continue;
            }
        };
        if !response.status().is_success() {
            continue;
        }
        let parsed: PendingConnectionsResponse = match response.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };

        for completed in parsed.completed {
            let Some(local) = pending.iter().find(|p| p.token == completed.token) else {
                continue;
            };

            match decrypt_delivered_secret(
                &completed.ciphertext,
                &completed.nonce,
                &completed.ephemeral_public_key,
            ) {
                Ok(plaintext) => {
                    let vault_key = format!("agent_{}_{}", local.agent_id, local.secret_name);
                    if let Err(e) = crate::keychain::store_secret(&vault_key, &plaintext) {
                        // Do not log `plaintext` — only the error and identifying metadata.
                        tracing::error!(
                            "web_connections: failed to store delivered key for {}: {e}",
                            local.agent_id
                        );
                        continue;
                    }
                    let _ = db.delete_pending_connection(&completed.token);
                    tracing::info!(
                        "web_connections: captured {} key for agent {}",
                        local.provider_name,
                        local.agent_id
                    );
                    let _ = app_handle.emit(
                        "web-connection-completed",
                        serde_json::json!({
                            "agentId": local.agent_id,
                            "providerName": local.provider_name,
                            "secretName": local.secret_name,
                        }),
                    );
                }
                Err(e) => {
                    tracing::error!(
                        "web_connections: failed to decrypt delivered key for {}: {e}",
                        local.agent_id
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_secret_names_like_the_frontend() {
        assert_eq!(sanitize_secret_name("Seats.aero"), "SEATS_AERO");
        assert_eq!(sanitize_secret_name("  My Cool API  "), "MY_COOL_API");
        assert_eq!(sanitize_secret_name(""), "");
    }

    #[test]
    fn derives_secret_names_with_api_key_suffix() {
        assert_eq!(
            derive_secret_name("Seats.aero", None),
            Some("SEATS_AERO_API_KEY".to_string())
        );
        assert_eq!(
            derive_secret_name("Ignored", Some("CUSTOM_TOKEN")),
            Some("CUSTOM_TOKEN".to_string())
        );
        assert_eq!(derive_secret_name("   ", None), None);
    }

    #[test]
    fn rejects_non_http_token_urls() {
        assert_eq!(validate_token_url(Some("javascript:alert(1)".into())), None);
        assert_eq!(validate_token_url(Some("canopy://companion".into())), None);
        assert_eq!(
            validate_token_url(Some("https://seats.aero/account".into())),
            Some("https://seats.aero/account".to_string())
        );
    }

    #[test]
    fn clamps_instructions_length() {
        let long = "a".repeat(1000);
        let clamped = clamp_instructions(Some(long)).unwrap();
        assert_eq!(clamped.len(), INSTRUCTIONS_MAX_LENGTH);
        assert_eq!(clamp_instructions(Some("   ".into())), None);
    }

    #[test]
    fn ecies_roundtrip_recovers_plaintext() {
        // Simulates what the `/connect/{token}` page does client-side: ECDH with an
        // ephemeral keypair against our published public key, HKDF, then AEAD-encrypt.
        // Uses a synthetic instance secret (not the real Keychain) so this test is fast
        // and deterministic — see decrypt_delivered_secret_with's doc comment.
        let our_secret = StaticSecret::random_from_rng(OsRng);
        let our_public = PublicKey::from(&our_secret);

        let ephemeral_secret = StaticSecret::random_from_rng(OsRng);
        let ephemeral_public = PublicKey::from(&ephemeral_secret);
        let shared = ephemeral_secret.diffie_hellman(&our_public);

        let hk = Hkdf::<Sha256>::new(None, shared.as_bytes());
        let mut aead_key = [0u8; 32];
        hk.expand(HKDF_INFO, &mut aead_key).unwrap();

        let cipher = ChaCha20Poly1305::new((&aead_key).into());
        let nonce_bytes = [7u8; 12];
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                b"sk_live_super_secret".as_ref(),
            )
            .unwrap();

        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let decrypted = decrypt_delivered_secret_with(
            &our_secret,
            &engine.encode(&ciphertext),
            &engine.encode(nonce_bytes),
            &engine.encode(ephemeral_public.as_bytes()),
        )
        .unwrap();
        assert_eq!(decrypted, "sk_live_super_secret");
    }
}

#[cfg(test)]
mod js_interop_check {
    use super::*;

    /// Golden-vector regression test: this ciphertext/nonce/ephemeral-key triple was
    /// produced by the *actual* `encryptToInstance` in canopy-admin's
    /// `src/connect-widget/main.ts` — the same code the browser runs — by importing
    /// that module directly under Node (it exports the function and only calls
    /// `main()` when a DOM exists). Regenerate with the snippet in WEB_CONNECTIONS.md
    /// if the construction ever legitimately changes.
    ///
    /// The recipient keypair below was generated throwaway for this vector alone. It
    /// has never been a real Canopy instance key, guards nothing, and decrypts only
    /// the dummy string asserted at the bottom — which is why it is safe to commit to
    /// a public repo.
    ///
    /// If this test fails after a change to the crypto here (curve, HKDF info string,
    /// AEAD choice, byte layout), canopy-admin's widget needs the matching change.
    /// The two sides live in different repos and have no other way to catch a protocol
    /// drift between them — the failure mode this guards is silent: keys encrypted by
    /// the browser that this install can no longer decrypt.
    #[test]
    fn decrypts_ciphertext_produced_by_the_real_js_widget() {
        let secret_hex = "c4638699ecd18d89305520e93dc674921b452c540dbd9af524416fc444382e6f";
        let secret_bytes: [u8; 32] = hex::decode(secret_hex).unwrap().try_into().unwrap();
        let secret = StaticSecret::from(secret_bytes);

        let plaintext = decrypt_delivered_secret_with(
            &secret,
            "tXiDeu4hDwUMxzfiqYJDkGIE1DyxHITNI3LuVmm3Oj0FTmbDuzU8IkBD87chWhwN",
            "V1O4aJsz7/AavyLM",
            "Jq5H2seM7t3PTq9vDpPKQDxYzp3/STeRWkCj1afYrAs=",
        )
        .expect("decrypt should succeed against real JS-produced ciphertext");

        assert_eq!(plaintext, "sk_live_test_12345_interop_check");
    }
}
