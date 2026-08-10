//! Tier 4 — Chrome cookie extraction for authenticated fetches.
//!
//! Only reached after explicit, per-domain user consent (see
//! `web_tools::fetch_authenticated_page_impl` and the `webauth:<domain>` permission_id
//! handled in `jit_server::resolve_permission_request`). This module does not decide
//! whether access is allowed — it is the low-level "read this one domain's cookies out
//! of Chrome" primitive the already-gated caller uses.
//!
//! Implements Chromium's macOS OSCrypt cookie encryption: AES-128-CBC with a static
//! space-padded IV, keyed by PBKDF2-HMAC-SHA1 over the "Chrome Safe Storage" password
//! stored in the macOS Keychain (salt "saltysalt", 1003 iterations, 16-byte key). This
//! matches `os_crypt_mac.mm` in the Chromium source and has not been verified against a
//! live Chrome profile in this environment — the decrypt routine itself is covered by a
//! round-trip unit test below, but end-to-end extraction against a real Keychain entry
//! and a real Cookies database should be smoke-tested before this ships.

use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};

type Aes128CbcDec = cbc::Decryptor<Aes128>;

const PBKDF2_ITERATIONS: u32 = 1003;
const PBKDF2_SALT: &[u8] = b"saltysalt";
const PBKDF2_KEY_LEN: usize = 16;
/// 16 ASCII spaces — Chromium's macOS OSCrypt uses a fixed IV, not a random one, because
/// the key itself is already per-installation (derived from a Keychain-stored secret).
const CBC_IV: [u8; 16] = [0x20; 16];

#[derive(Debug, Clone)]
pub struct ChromeCookie {
    pub name: String,
    pub value: String,
}

fn chrome_safe_storage_key() -> Result<[u8; PBKDF2_KEY_LEN], String> {
    let password = keyring::Entry::new("Chrome Safe Storage", "Chrome")
        .and_then(|e| e.get_password())
        .or_else(|_| {
            keyring::Entry::new("Chrome Safe Storage", "Google Chrome")
                .and_then(|e| e.get_password())
        })
        .map_err(|e| {
            format!(
                "could not read the 'Chrome Safe Storage' Keychain item (is Chrome installed \
                 and has it been run at least once on this Mac?): {e}"
            )
        })?;

    let mut key = [0u8; PBKDF2_KEY_LEN];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), PBKDF2_SALT, PBKDF2_ITERATIONS, &mut key);
    Ok(key)
}

/// Decrypts one Chromium `encrypted_value` cookie blob. Only handles the macOS `v10`/`v11`
/// prefix format; values in any other format (plaintext, or a version this wasn't written
/// against) are rejected rather than guessed at.
fn decrypt_cookie_value(key: &[u8; PBKDF2_KEY_LEN], encrypted: &[u8]) -> Result<String, String> {
    if encrypted.len() < 3 || !matches!(&encrypted[0..3], b"v10" | b"v11") {
        return Err("cookie value is not in the expected macOS v10/v11 format".to_string());
    }
    let mut buf = encrypted[3..].to_vec();
    let decryptor = Aes128CbcDec::new(key.into(), &CBC_IV.into());
    let plain = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("cookie decryption failed: {e}"))?;
    String::from_utf8(plain.to_vec()).map_err(|e| format!("decrypted cookie was not valid UTF-8: {e}"))
}

/// Reads all cookies Chrome has stored for `host` (exact match) or `.{host}` (Chrome's
/// domain-wide cookie key format) — deliberately NOT a subdomain-wildcard match, per the
/// Tier 4 consent model: approving `notion.so` must not hand over cookies for some
/// unrelated `evil.notion.so.attacker.example` host string, and Chrome's own dotted-key
/// format only ever means "this exact registrable domain" anyway.
///
/// Copies the SQLite file (and any `-wal`/`-shm` sidecars) to a temp directory first —
/// Chrome holds the live file open, and a direct read can race a concurrent write.
pub fn read_cookies_for_host(host: &str) -> Result<Vec<ChromeCookie>, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let cookies_db = home.join("Library/Application Support/Google/Chrome/Default/Cookies");
    if !cookies_db.exists() {
        return Err(format!(
            "Chrome cookies database not found at {} — is Chrome installed?",
            cookies_db.display()
        ));
    }
    let cookies_dir = cookies_db
        .parent()
        .ok_or_else(|| "could not resolve Chrome profile directory".to_string())?;

    let tmp_dir = std::env::temp_dir().join(format!("canopy-chrome-cookies-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("could not create temp dir: {e}"))?;
    let tmp_db = tmp_dir.join("Cookies");
    let copy_result = std::fs::copy(&cookies_db, &tmp_db)
        .map_err(|e| format!("could not copy Chrome cookies database: {e}"));
    for suffix in ["-wal", "-shm"] {
        let side = cookies_dir.join(format!("Cookies{suffix}"));
        if side.exists() {
            let _ = std::fs::copy(&side, tmp_dir.join(format!("Cookies{suffix}")));
        }
    }
    if let Err(e) = copy_result {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    let extraction = extract_cookies_from_db(&tmp_db, host);
    let _ = std::fs::remove_dir_all(&tmp_dir);
    extraction
}

fn extract_cookies_from_db(db_path: &std::path::Path, host: &str) -> Result<Vec<ChromeCookie>, String> {
    let key = chrome_safe_storage_key()?;
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("could not open copied cookies database: {e}"))?;
    let dotted = format!(".{host}");
    let mut stmt = conn
        .prepare("SELECT name, encrypted_value FROM cookies WHERE host_key = ?1 OR host_key = ?2")
        .map_err(|e| format!("cookie query prep failed: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![host, dotted], |row| {
            let name: String = row.get(0)?;
            let encrypted: Vec<u8> = row.get(1)?;
            Ok((name, encrypted))
        })
        .map_err(|e| format!("cookie query failed: {e}"))?;

    let mut cookies = Vec::new();
    for row in rows {
        let (name, encrypted) = row.map_err(|e| format!("cookie row read failed: {e}"))?;
        match decrypt_cookie_value(&key, &encrypted) {
            Ok(value) => cookies.push(ChromeCookie { name, value }),
            Err(e) => tracing::debug!(
                "read_cookies_for_host: could not decrypt cookie '{}' for {}: {}",
                name,
                host,
                e
            ),
        }
    }

    if cookies.is_empty() {
        return Err(format!(
            "no readable cookies found for '{host}' in Chrome's Default profile — the user may not \
             be signed in there, or Chrome may be using a non-default profile"
        ));
    }
    Ok(cookies)
}

pub fn cookie_header(cookies: &[ChromeCookie]) -> String {
    cookies
        .iter()
        .map(|c| format!("{}={}", c.name, c.value))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::BlockEncryptMut;

    /// Verifies the decrypt routine against a value this test encrypts itself with the
    /// same key/IV convention — the strongest check available without a live Chrome
    /// Keychain entry and Cookies database in this environment.
    #[test]
    fn round_trips_a_v10_ciphertext() {
        let key = [0x42u8; PBKDF2_KEY_LEN];
        let plaintext = b"session=abc123";
        let mut buf = plaintext.to_vec();
        buf.resize(((buf.len() / 16) + 1) * 16, 0);
        let pt_len = plaintext.len();

        let encryptor = cbc::Encryptor::<Aes128>::new(&key.into(), &CBC_IV.into());
        let ct = encryptor.encrypt_padded_mut::<Pkcs7>(&mut buf, pt_len).unwrap();

        let mut encrypted = b"v10".to_vec();
        encrypted.extend_from_slice(ct);

        let decrypted = decrypt_cookie_value(&key, &encrypted).unwrap();
        assert_eq!(decrypted, "session=abc123");
    }

    #[test]
    fn rejects_values_without_a_v10_v11_prefix() {
        let key = [0u8; PBKDF2_KEY_LEN];
        assert!(decrypt_cookie_value(&key, b"not-a-chrome-cookie-blob").is_err());
        assert!(decrypt_cookie_value(&key, b"v9somethingelse").is_err());
    }

    #[test]
    fn cookie_header_joins_name_value_pairs() {
        let cookies = vec![
            ChromeCookie { name: "a".into(), value: "1".into() },
            ChromeCookie { name: "b".into(), value: "2".into() },
        ];
        assert_eq!(cookie_header(&cookies), "a=1; b=2");
    }
}
