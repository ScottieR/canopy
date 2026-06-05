/// Central error type for Canopy Platform
/// Replaces Result<T, String> with Result<T, CanopyError> for better error context
/// and consistency across all modules.
use std::fmt;

#[derive(Debug, Clone)]
pub enum CanopyError {
    /// Configuration-related errors (missing settings, invalid config files)
    Configuration(String),

    /// Keychain/credential storage errors
    Keychain(String),

    /// Docker/OrbStack command errors
    Docker(String),

    /// Input validation errors (invalid agent ID, budget amount, etc.)
    Validation(String),

    /// Resource not found (agent doesn't exist, channel not found, etc.)
    NotFound(String),

    /// User not authorized to perform operation
    Unauthorized(String),

    /// Database operation errors
    Database(String),

    /// Network/HTTP request errors
    Request(String),

    /// Rate limit exceeded
    RateLimit,

    /// Operation timed out
    Timeout,

    /// File I/O errors
    FileIO(String),

    /// JSON serialization/deserialization errors
    Serialization(String),

    /// Authentication/OAuth errors
    Authentication(String),

    /// Payment processing errors
    Payment(String),

    /// Generic error with context
    Internal(String),
}

impl fmt::Display for CanopyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanopyError::Configuration(msg) => write!(f, "Configuration error: {}", msg),
            CanopyError::Keychain(msg) => write!(f, "Keychain error: {}", msg),
            CanopyError::Docker(msg) => write!(f, "Docker error: {}", msg),
            CanopyError::Validation(msg) => write!(f, "Validation error: {}", msg),
            CanopyError::NotFound(msg) => write!(f, "Not found: {}", msg),
            CanopyError::Unauthorized(msg) => write!(f, "Unauthorized: {}", msg),
            CanopyError::Database(msg) => write!(f, "Database error: {}", msg),
            CanopyError::Request(msg) => write!(f, "Request error: {}", msg),
            CanopyError::RateLimit => write!(f, "Rate limit exceeded"),
            CanopyError::Timeout => write!(f, "Operation timed out"),
            CanopyError::FileIO(msg) => write!(f, "File I/O error: {}", msg),
            CanopyError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
            CanopyError::Authentication(msg) => write!(f, "Authentication error: {}", msg),
            CanopyError::Payment(msg) => write!(f, "Payment error: {}", msg),
            CanopyError::Internal(msg) => write!(f, "Internal error: {}", msg),
        }
    }
}

impl std::error::Error for CanopyError {}

/// Convenience Result type using CanopyError
pub type Result<T> = std::result::Result<T, CanopyError>;

// Implement From conversions for common error types

impl From<rusqlite::Error> for CanopyError {
    fn from(err: rusqlite::Error) -> Self {
        CanopyError::Database(err.to_string())
    }
}

impl From<std::io::Error> for CanopyError {
    fn from(err: std::io::Error) -> Self {
        CanopyError::FileIO(err.to_string())
    }
}

impl From<serde_json::Error> for CanopyError {
    fn from(err: serde_json::Error) -> Self {
        CanopyError::Serialization(err.to_string())
    }
}

impl From<reqwest::Error> for CanopyError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            CanopyError::Timeout
        } else {
            CanopyError::Request(err.to_string())
        }
    }
}

impl From<String> for CanopyError {
    fn from(err: String) -> Self {
        CanopyError::Internal(err)
    }
}

impl From<&str> for CanopyError {
    fn from(err: &str) -> Self {
        CanopyError::Internal(err.to_string())
    }
}

// Tauri command error serialization
impl serde::Serialize for CanopyError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = CanopyError::Validation("invalid agent ID".into());
        assert_eq!(err.to_string(), "Validation error: invalid agent ID");
    }

    #[test]
    fn test_rate_limit_error() {
        let err = CanopyError::RateLimit;
        assert_eq!(err.to_string(), "Rate limit exceeded");
    }

    #[test]
    fn test_timeout_error() {
        let err = CanopyError::Timeout;
        assert_eq!(err.to_string(), "Operation timed out");
    }

    #[test]
    fn test_from_string() {
        let err: CanopyError = "test error".into();
        assert_eq!(err.to_string(), "Internal error: test error");
    }
}
