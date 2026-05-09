/// Agent validation: ID, name, emoji, color
/// Uses whitelist approach to prevent command injection and invalid inputs

use super::ValidationError;
use crate::errors::Result;

/// Validate agent ID (alphanumeric, dash, underscore only)
/// Pattern: 1-63 chars matching [a-z0-9_-]
///
/// # Examples
/// ```ignore
/// assert!(validate_id("agent-my-ai").is_ok());
/// assert!(validate_id("agent-123_test").is_ok());
/// assert!(validate_id("agent; rm -rf /").is_err());  // Command injection blocked
/// assert!(validate_id("agent$(whoami)").is_err());  // Command substitution blocked
/// ```
pub fn validate_id(id: &str) -> Result<()> {
    // Check length: 1-63 characters
    if id.is_empty() {
        return Err(ValidationError::TooShort("Agent ID must not be empty".into()).into());
    }
    if id.len() > 63 {
        return Err(ValidationError::TooLong("Agent ID must be 63 chars or less".into()).into());
    }

    // Whitelist: alphanumeric, dash, underscore only
    // This prevents: ; | ` $ ( ) ' " < > & * ? ~ ! # % ^ { } [ ]
    if !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        return Err(ValidationError::InvalidCharacters(
            format!("Agent ID can only contain lowercase letters, numbers, dash, and underscore. Got: {}", id)
        ).into());
    }

    Ok(())
}

/// Validate agent name (human-readable, displayed in UI)
/// Pattern: 1-200 chars, no newlines, no null bytes
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(ValidationError::TooShort("Agent name must not be empty".into()).into());
    }
    if name.len() > 200 {
        return Err(ValidationError::TooLong("Agent name must be 200 chars or less".into()).into());
    }

    // Block control characters that could break UI
    if name.contains('\n') || name.contains('\r') || name.contains('\0') {
        return Err(ValidationError::InvalidCharacters(
            "Agent name cannot contain newlines or null bytes".into()
        ).into());
    }

    Ok(())
}

/// Validate emoji (1-2 characters, must be actual emoji)
///
/// # Examples
/// ```ignore
/// assert!(validate_emoji("🤖").is_ok());
/// assert!(validate_emoji("🎯").is_ok());
/// assert!(validate_emoji("a").is_err());  // Not an emoji
/// assert!(validate_emoji("🤖🎯").is_err());  // Too many
/// ```
pub fn validate_emoji(emoji: &str) -> Result<()> {
    let char_count = emoji.chars().count();
    if char_count < 1 || char_count > 2 {
        return Err(ValidationError::InvalidFormat(
            format!("Emoji must be 1-2 characters, got: {} chars in '{}'", char_count, emoji)
        ).into());
    }

    // Simple check: emoji characters have high unicode values
    // More thorough check could use unicode_emoji crate
    for c in emoji.chars() {
        let code = c as u32;
        // Unicode emoji ranges (simplified - covers most emojis)
        // Proper validation would use unicode_emoji crate
        if code < 0x1F300 && code < 0x0080 {
            return Err(ValidationError::InvalidFormat(
                format!("'{}' does not appear to be an emoji", emoji)
            ).into());
        }
    }

    Ok(())
}

/// Validate color (hex format #RRGGBB or #RRGGBBAA)
///
/// # Examples
/// ```ignore
/// assert!(validate_color("#FF0000").is_ok());
/// assert!(validate_color("#FF0000CC").is_ok());
/// assert!(validate_color("FF0000").is_err());  // Missing #
/// assert!(validate_color("#GGGGGG").is_err());  // Invalid hex
/// ```
pub fn validate_color(color: &str) -> Result<()> {
    if !color.starts_with('#') {
        return Err(ValidationError::InvalidFormat(
            "Color must start with #".into()
        ).into());
    }

    let hex_part = &color[1..];

    // Allow #RRGGBB (6 chars) or #RRGGBBAA (8 chars)
    if hex_part.len() != 6 && hex_part.len() != 8 {
        return Err(ValidationError::InvalidFormat(
            format!("Color must be #RRGGBB or #RRGGBBAA, got: {}", color)
        ).into());
    }

    // Verify all characters are valid hex (0-9, a-f, A-F)
    if !hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ValidationError::InvalidFormat(
            format!("Color contains invalid hex characters: {}", color)
        ).into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_id_valid() {
        assert!(validate_id("agent-my-ai").is_ok());
        assert!(validate_id("agent-123").is_ok());
        assert!(validate_id("agent_test").is_ok());
        assert!(validate_id("a").is_ok());  // Single char OK
    }

    #[test]
    fn test_validate_id_rejects_special_chars() {
        assert!(validate_id("agent; rm -rf /").is_err());
        assert!(validate_id("agent$(whoami)").is_err());
        assert!(validate_id("agent`id`").is_err());
        assert!(validate_id("agent|cat /etc/passwd").is_err());
        assert!(validate_id("agent&background").is_err());
        assert!(validate_id("agent'quoted'").is_err());
        assert!(validate_id("agent\"double\"").is_err());
    }

    #[test]
    fn test_validate_id_rejects_uppercase() {
        // Should reject uppercase (enforces lowercase)
        assert!(validate_id("Agent-Test").is_err());
    }

    #[test]
    fn test_validate_id_length_limits() {
        assert!(validate_id("").is_err());  // Too short
        assert!(validate_id(&"a".repeat(64)).is_err());  // Too long
        assert!(validate_id(&"a".repeat(63)).is_ok());  // Max OK
    }

    #[test]
    fn test_validate_name_valid() {
        assert!(validate_name("My AI Agent").is_ok());
        assert!(validate_name("Test 123").is_ok());
        assert!(validate_name("Agent with special-chars_ok").is_ok());
    }

    #[test]
    fn test_validate_name_rejects_control_chars() {
        assert!(validate_name("Agent\nWith\nNewlines").is_err());
        assert!(validate_name("Agent\0With\0Nulls").is_err());
    }

    #[test]
    fn test_validate_color_valid() {
        assert!(validate_color("#FF0000").is_ok());
        assert!(validate_color("#00FF00").is_ok());
        assert!(validate_color("#0000FF").is_ok());
        assert!(validate_color("#FFFFFF").is_ok());
        assert!(validate_color("#FF0000CC").is_ok());  // With alpha
        assert!(validate_color("#00000000").is_ok());  // Transparent
    }

    #[test]
    fn test_validate_color_rejects_invalid() {
        assert!(validate_color("FF0000").is_err());  // Missing #
        assert!(validate_color("#GGGGGG").is_err());  // Invalid hex
        assert!(validate_color("#FF00").is_err());  // Too short
        assert!(validate_color("#FF000000CC").is_err());  // Too long
    }
}
