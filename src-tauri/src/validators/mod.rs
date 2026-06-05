/// Centralized input validation framework
/// All user inputs validated through this module using whitelist approach
/// (allow specific characters) rather than blacklist (block bad characters).
pub mod agent;
pub mod budget;
pub mod integrations;
pub mod keys;

use crate::errors::{CanopyError, Result};

/// ValidationError for detailed validation context
#[derive(Debug, Clone)]
pub enum ValidationError {
    InvalidFormat(String),
    TooShort(String),
    TooLong(String),
    InvalidCharacters(String),
    OutOfRange(String),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::InvalidFormat(msg) => write!(f, "Invalid format: {}", msg),
            ValidationError::TooShort(msg) => write!(f, "Too short: {}", msg),
            ValidationError::TooLong(msg) => write!(f, "Too long: {}", msg),
            ValidationError::InvalidCharacters(msg) => write!(f, "Invalid characters: {}", msg),
            ValidationError::OutOfRange(msg) => write!(f, "Out of range: {}", msg),
        }
    }
}

impl From<ValidationError> for CanopyError {
    fn from(err: ValidationError) -> Self {
        CanopyError::Validation(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validation_error_display() {
        let err = ValidationError::InvalidFormat("must be numeric".into());
        assert_eq!(err.to_string(), "Invalid format: must be numeric");
    }
}
