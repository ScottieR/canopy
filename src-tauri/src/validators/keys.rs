/// API key format validation
/// Prevents invalid/malformed keys from being stored

use super::ValidationError;
use crate::errors::Result;

/// Validate OpenAI API key format
/// Pattern: Must start with "sk-" and be at least 40 characters
pub fn validate_openai_key(key: &str) -> Result<()> {
    if !key.starts_with("sk-") {
        return Err(ValidationError::InvalidFormat(
            "OpenAI key must start with 'sk-'".into()
        ).into());
    }

    if key.len() < 40 {
        return Err(ValidationError::InvalidFormat(
            format!("OpenAI key is too short (minimum 40 chars, got: {} chars)", key.len())
        ).into());
    }

    Ok(())
}

/// Validate Anthropic API key format
/// Pattern: Minimum 32 characters (format varies)
pub fn validate_anthropic_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Anthropic key cannot be empty".into()
        ).into());
    }

    if key.len() < 32 {
        return Err(ValidationError::InvalidFormat(
            format!("Anthropic key is too short (minimum 32 chars, got: {} chars)", key.len())
        ).into());
    }

    Ok(())
}

/// Validate Google Gemini API key format
/// Pattern: Alphanumeric and some special chars, typically 39 chars
pub fn validate_gemini_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Gemini key cannot be empty".into()
        ).into());
    }

    if key.len() < 30 {
        return Err(ValidationError::InvalidFormat(
            format!("Gemini key is too short (minimum 30 chars, got: {} chars)", key.len())
        ).into());
    }

    Ok(())
}

/// Validate xAI/Grok API key format
/// Pattern: Alphanumeric, typically 30+ characters
pub fn validate_xai_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "xAI key cannot be empty".into()
        ).into());
    }

    if key.len() < 20 {
        return Err(ValidationError::InvalidFormat(
            format!("xAI key is too short (minimum 20 chars, got: {} chars)", key.len())
        ).into());
    }

    Ok(())
}

/// Validate Privacy.com API key format
/// Pattern: Alphanumeric, typically 30+ characters
pub fn validate_privacy_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Privacy.com key cannot be empty".into()
        ).into());
    }

    if key.len() < 20 {
        return Err(ValidationError::InvalidFormat(
            format!("Privacy.com key is too short (minimum 20 chars, got: {} chars)", key.len())
        ).into());
    }

    Ok(())
}

/// Validate Slack OAuth client secret format
/// Pattern: Must be non-empty, typically 30+ characters
pub fn validate_slack_secret(secret: &str) -> Result<()> {
    if secret.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Slack secret cannot be empty".into()
        ).into());
    }

    if secret.len() < 20 {
        return Err(ValidationError::InvalidFormat(
            format!("Slack secret is too short (minimum 20 chars, got: {} chars)", secret.len())
        ).into());
    }

    Ok(())
}

/// Validate Google OAuth client secret format
/// Pattern: Must be non-empty, typically 20+ characters
pub fn validate_google_secret(secret: &str) -> Result<()> {
    if secret.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Google secret cannot be empty".into()
        ).into());
    }

    if secret.len() < 10 {
        return Err(ValidationError::InvalidFormat(
            format!("Google secret is too short (minimum 10 chars, got: {} chars)", secret.len())
        ).into());
    }

    Ok(())
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
        assert!(validate_openai_key("invalid-key").is_err());  // Wrong prefix
        assert!(validate_openai_key("sk-short").is_err());  // Too short
    }

    #[test]
    fn test_validate_anthropic_key() {
        assert!(validate_anthropic_key(&"a".repeat(32)).is_ok());
        assert!(validate_anthropic_key(&"a".repeat(31)).is_err());  // Too short
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
