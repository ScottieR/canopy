/// API key format validation
/// Prevents invalid/malformed keys from being stored
use super::ValidationError;
use crate::errors::Result;

fn validate_opaque_secret(name: &str, key: &str, minimum_length: usize) -> Result<()> {
    if key.len() < minimum_length {
        return Err(ValidationError::InvalidFormat(format!(
            "{} is too short (minimum {} chars, got: {} chars)",
            name,
            minimum_length,
            key.len()
        ))
        .into());
    }
    if key.len() > 512 || !key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err(ValidationError::InvalidFormat(format!(
            "{} must contain only non-whitespace ASCII characters and be at most 512 chars",
            name
        ))
        .into());
    }
    Ok(())
}

/// Validate OpenAI API key format
/// Pattern: Must start with "sk-" and be at least 40 characters
pub fn validate_openai_key(key: &str) -> Result<()> {
    if !key.starts_with("sk-") {
        return Err(
            ValidationError::InvalidFormat("OpenAI key must start with 'sk-'".into()).into(),
        );
    }

    validate_opaque_secret("OpenAI key", key, 40)
}

/// Validate Anthropic API key format
/// Pattern: Minimum 32 characters (format varies)
pub fn validate_anthropic_key(key: &str) -> Result<()> {
    validate_opaque_secret("Anthropic key", key, 32)
}

/// Validate Google Gemini API key format
/// Pattern: Alphanumeric and some special chars, typically 39 chars
pub fn validate_gemini_key(key: &str) -> Result<()> {
    validate_opaque_secret("Gemini key", key, 30)
}

/// Validate xAI/Grok API key format
/// Pattern: Alphanumeric, typically 30+ characters
pub fn validate_xai_key(key: &str) -> Result<()> {
    validate_opaque_secret("xAI key", key, 20)
}

/// Validate Privacy.com API key format
/// Pattern: Alphanumeric, typically 30+ characters
pub fn validate_privacy_key(key: &str) -> Result<()> {
    validate_opaque_secret("Privacy.com key", key, 20)
}

/// Validate Slack OAuth client secret format
/// Pattern: Must be non-empty, typically 30+ characters
pub fn validate_slack_secret(secret: &str) -> Result<()> {
    validate_opaque_secret("Slack secret", secret, 20)
}

/// Validate Google OAuth client secret format
/// Pattern: Must be non-empty, typically 20+ characters
pub fn validate_google_secret(secret: &str) -> Result<()> {
    validate_opaque_secret("Google secret", secret, 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_openai_key_valid() {
        assert!(validate_openai_key("sk-proj-1234567890abcdefghijklmnopqrstuvwxyz").is_ok());
        assert!(validate_openai_key("sk-abcdefghijklmnopqrstuvwxyz0123456789a").is_ok());
    }

    #[test]
    fn test_validate_openai_key_invalid() {
        assert!(validate_openai_key("invalid-key").is_err()); // Wrong prefix
        assert!(validate_openai_key("sk-short").is_err()); // Too short
    }

    #[test]
    fn test_validate_anthropic_key() {
        assert!(validate_anthropic_key(&"a".repeat(32)).is_ok());
        assert!(validate_anthropic_key(&"a".repeat(31)).is_err()); // Too short
    }

    #[test]
    fn test_validate_gemini_key() {
        assert!(validate_gemini_key(&"a".repeat(30)).is_ok());
        assert!(validate_gemini_key("short").is_err());
    }

    #[test]
    fn test_validate_xai_key() {
        assert!(validate_xai_key(&"a".repeat(20)).is_ok());
        assert!(validate_xai_key("short").is_err());
    }

    #[test]
    fn api_keys_reject_header_injection_whitespace_and_unbounded_values() {
        assert!(validate_openai_key(&format!("sk-{}\nInjected: yes", "a".repeat(40))).is_err());
        assert!(validate_anthropic_key(&format!("{} secret", "a".repeat(32))).is_err());
        assert!(validate_gemini_key(&format!("{}\r", "a".repeat(30))).is_err());
        assert!(validate_xai_key(&"a".repeat(513)).is_err());
    }

    #[test]
    fn test_validate_slack_secret() {
        assert!(validate_slack_secret(&"a".repeat(20)).is_ok());
        assert!(validate_slack_secret("short").is_err());
    }

    #[test]
    fn test_validate_google_secret() {
        assert!(validate_google_secret(&"a".repeat(10)).is_ok());
        assert!(validate_google_secret("short").is_err());
    }
}
