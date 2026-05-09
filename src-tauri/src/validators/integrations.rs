/// Integration/channel validation for Slack, Discord, Telegram, etc.

use super::ValidationError;
use crate::errors::Result;

/// Validate Slack channel ID format
/// Pattern: Must start with 'C' followed by 8+ alphanumeric characters
/// Example: "C1234567890ABCDEF" (typical: 11 chars)
pub fn validate_slack_channel_id(channel_id: &str) -> Result<()> {
    if !channel_id.starts_with('C') {
        return Err(ValidationError::InvalidFormat(
            "Slack channel ID must start with 'C'".into()
        ).into());
    }

    let id_part = &channel_id[1..];
    if id_part.len() < 8 {
        return Err(ValidationError::InvalidFormat(
            format!("Slack channel ID too short (expected 9+ chars, got: {} chars)", channel_id.len())
        ).into());
    }

    // Channel ID should be alphanumeric (uppercase)
    if !id_part.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ValidationError::InvalidFormat(
            "Slack channel ID contains invalid characters (must be alphanumeric)".into()
        ).into());
    }

    Ok(())
}

/// Validate Slack user ID format
/// Pattern: Must start with 'U' followed by 8+ alphanumeric characters
pub fn validate_slack_user_id(user_id: &str) -> Result<()> {
    if !user_id.starts_with('U') {
        return Err(ValidationError::InvalidFormat(
            "Slack user ID must start with 'U'".into()
        ).into());
    }

    let id_part = &user_id[1..];
    if id_part.len() < 8 {
        return Err(ValidationError::InvalidFormat(
            format!("Slack user ID too short (expected 9+ chars, got: {} chars)", user_id.len())
        ).into());
    }

    if !id_part.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ValidationError::InvalidFormat(
            "Slack user ID contains invalid characters".into()
        ).into());
    }

    Ok(())
}

/// Validate Telegram chat ID format
/// Pattern: Numeric, can be negative (group chats)
/// Range: Typical 7-10 digits, but can be larger
pub fn validate_telegram_chat_id(chat_id: &str) -> Result<()> {
    if chat_id.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Telegram chat ID cannot be empty".into()
        ).into());
    }

    // Allow negative sign and digits only
    let valid_chars = if chat_id.starts_with('-') {
        &chat_id[1..]
    } else {
        chat_id
    };

    if !valid_chars.chars().all(|c| c.is_ascii_digit()) {
        return Err(ValidationError::InvalidFormat(
            "Telegram chat ID must be numeric (optionally with leading minus)".into()
        ).into());
    }

    Ok(())
}

/// Validate Discord server ID format
/// Pattern: Numeric, typically 18-20 digits
pub fn validate_discord_server_id(server_id: &str) -> Result<()> {
    if server_id.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Discord server ID cannot be empty".into()
        ).into());
    }

    if !server_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(ValidationError::InvalidFormat(
            "Discord server ID must be numeric".into()
        ).into());
    }

    if server_id.len() < 15 {
        return Err(ValidationError::InvalidFormat(
            format!("Discord server ID too short (expected 15+ digits, got: {} digits)", server_id.len())
        ).into());
    }

    Ok(())
}

/// Validate Discord channel ID format (same as server ID)
pub fn validate_discord_channel_id(channel_id: &str) -> Result<()> {
    validate_discord_server_id(channel_id)
}

/// Validate GitHub username/org format
/// Pattern: 1-39 characters, alphanumeric and hyphen/underscore
pub fn validate_github_username(username: &str) -> Result<()> {
    if username.is_empty() {
        return Err(ValidationError::TooShort(
            "GitHub username cannot be empty".into()
        ).into());
    }

    if username.len() > 39 {
        return Err(ValidationError::TooLong(
            "GitHub username must be 39 characters or less".into()
        ).into());
    }

    // Allow alphanumeric, hyphen, underscore
    if !username.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '-' || c == '_'
    }) {
        return Err(ValidationError::InvalidCharacters(
            "GitHub username can only contain alphanumeric characters, hyphens, and underscores".into()
        ).into());
    }

    // Cannot start or end with hyphen
    if username.starts_with('-') || username.ends_with('-') {
        return Err(ValidationError::InvalidFormat(
            "GitHub username cannot start or end with a hyphen".into()
        ).into());
    }

    Ok(())
}

/// Validate webhook URL format
/// Pattern: Must be valid HTTPS URL
pub fn validate_webhook_url(url: &str) -> Result<()> {
    if url.is_empty() {
        return Err(ValidationError::InvalidFormat(
            "Webhook URL cannot be empty".into()
        ).into());
    }

    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(ValidationError::InvalidFormat(
            "Webhook URL must start with http:// or https://".into()
        ).into());
    }

    // Simple length check
    if url.len() > 2048 {
        return Err(ValidationError::TooLong(
            "Webhook URL is too long (max 2048 characters)".into()
        ).into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_slack_channel_id_valid() {
        assert!(validate_slack_channel_id("C1234567890").is_ok());
        assert!(validate_slack_channel_id("C12345678").is_ok());
    }

    #[test]
    fn test_validate_slack_channel_id_invalid() {
        assert!(validate_slack_channel_id("U1234567890").is_err());  // Wrong prefix
        assert!(validate_slack_channel_id("C1234567").is_err());  // Too short
        assert!(validate_slack_channel_id("C12345@789").is_err());  // Invalid char
    }

    #[test]
    fn test_validate_slack_user_id_valid() {
        assert!(validate_slack_user_id("U1234567890").is_ok());
    }

    #[test]
    fn test_validate_slack_user_id_invalid() {
        assert!(validate_slack_user_id("C1234567890").is_err());  // Wrong prefix
    }

    #[test]
    fn test_validate_telegram_chat_id_valid() {
        assert!(validate_telegram_chat_id("123456789").is_ok());
        assert!(validate_telegram_chat_id("-123456789").is_ok());  // Negative (group)
    }

    #[test]
    fn test_validate_telegram_chat_id_invalid() {
        assert!(validate_telegram_chat_id("abc123").is_err());
        assert!(validate_telegram_chat_id("--123").is_err());  // Double negative
    }

    #[test]
    fn test_validate_discord_server_id_valid() {
        assert!(validate_discord_server_id("123456789012345678").is_ok());
    }

    #[test]
    fn test_validate_discord_server_id_invalid() {
        assert!(validate_discord_server_id("12345").is_err());  // Too short
        assert!(validate_discord_server_id("abc123").is_err());  // Non-numeric
    }

    #[test]
    fn test_validate_github_username_valid() {
        assert!(validate_github_username("octocat").is_ok());
        assert!(validate_github_username("my-username").is_ok());
        assert!(validate_github_username("my_username").is_ok());
    }

    #[test]
    fn test_validate_github_username_invalid() {
        assert!(validate_github_username("-invalid").is_err());  // Starts with hyphen
        assert!(validate_github_username("invalid-").is_err());  // Ends with hyphen
        assert!(validate_github_username("invalid@user").is_err());  // Invalid char
    }

    #[test]
    fn test_validate_webhook_url_valid() {
        assert!(validate_webhook_url("https://example.com/webhook").is_ok());
        assert!(validate_webhook_url("http://localhost:3000/hook").is_ok());
    }

    #[test]
    fn test_validate_webhook_url_invalid() {
        assert!(validate_webhook_url("example.com/webhook").is_err());  // No protocol
        assert!(validate_webhook_url("ftp://example.com").is_err());  // Wrong protocol
    }
}
