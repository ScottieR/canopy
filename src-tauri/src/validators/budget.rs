/// Budget validation: amounts, limits, categories
/// Ensures financial constraints are respected
use super::ValidationError;
use crate::errors::Result;

/// Validate budget amount in cents
/// Range: 1 to 100,000,000 (represents $1.00 to $1,000,000.00)
pub fn validate_amount(cents: i64) -> Result<()> {
    if cents <= 0 {
        return Err(ValidationError::OutOfRange(format!(
            "Amount must be positive, got: {} cents",
            cents
        ))
        .into());
    }

    // Max: 1 billion cents = $10,000,000
    if cents > 1_000_000_000 {
        return Err(ValidationError::OutOfRange(format!(
            "Amount must be $10,000,000 or less, got: ${:.2}",
            cents as f64 / 100.0
        ))
        .into());
    }

    Ok(())
}

/// Validate daily spending limit
/// Must be positive and less than monthly limit (if provided)
pub fn validate_daily_limit(daily_cents: i64, monthly_cents: Option<i64>) -> Result<()> {
    if daily_cents <= 0 {
        return Err(ValidationError::OutOfRange(format!(
            "Daily limit must be positive, got: {} cents",
            daily_cents
        ))
        .into());
    }

    // Check against monthly limit if provided
    if let Some(monthly) = monthly_cents {
        if daily_cents > monthly {
            return Err(ValidationError::OutOfRange(format!(
                "Daily limit (${:.2}) cannot exceed monthly limit (${:.2})",
                daily_cents as f64 / 100.0,
                monthly as f64 / 100.0
            ))
            .into());
        }
    }

    Ok(())
}

/// Validate monthly spending limit
pub fn validate_monthly_limit(monthly_cents: i64, daily_cents: Option<i64>) -> Result<()> {
    if monthly_cents <= 0 {
        return Err(ValidationError::OutOfRange(format!(
            "Monthly limit must be positive, got: {} cents",
            monthly_cents
        ))
        .into());
    }

    // Check against daily limit if provided
    if let Some(daily) = daily_cents {
        if monthly_cents < daily {
            return Err(ValidationError::OutOfRange(format!(
                "Monthly limit (${:.2}) must be at least as much as daily limit (${:.2})",
                monthly_cents as f64 / 100.0,
                daily as f64 / 100.0
            ))
            .into());
        }
    }

    Ok(())
}

/// Validate budget category name
/// 1-50 chars, alphanumeric, dash, underscore, space
pub fn validate_category(category: &str) -> Result<()> {
    if category.is_empty() {
        return Err(ValidationError::TooShort("Category must not be empty".into()).into());
    }

    if category.len() > 50 {
        return Err(ValidationError::TooLong("Category must be 50 chars or less".into()).into());
    }

    // Whitelist: alphanumeric, dash, underscore, space
    if !category
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ')
    {
        return Err(ValidationError::InvalidCharacters(
            "Category can only contain letters, numbers, dash, underscore, and space".into(),
        )
        .into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_amount_valid() {
        assert!(validate_amount(100).is_ok()); // $1.00
        assert!(validate_amount(1_000_000).is_ok()); // $10,000.00
        assert!(validate_amount(1).is_ok()); // 1 cent minimum
    }

    #[test]
    fn test_validate_amount_invalid() {
        assert!(validate_amount(0).is_err()); // Zero
        assert!(validate_amount(-100).is_err()); // Negative
        assert!(validate_amount(1_000_000_001).is_err()); // Over max
    }

    #[test]
    fn test_validate_daily_limit() {
        assert!(validate_daily_limit(1_000, None).is_ok());
        assert!(validate_daily_limit(1_000, Some(10_000)).is_ok());
        assert!(validate_daily_limit(10_000, Some(10_000)).is_ok()); // Equal OK
    }

    #[test]
    fn test_validate_daily_limit_exceeds_monthly() {
        assert!(validate_daily_limit(10_000, Some(5_000)).is_err());
    }

    #[test]
    fn test_validate_monthly_limit() {
        assert!(validate_monthly_limit(10_000, None).is_ok());
        assert!(validate_monthly_limit(10_000, Some(5_000)).is_ok());
        assert!(validate_monthly_limit(5_000, Some(5_000)).is_ok()); // Equal OK
    }

    #[test]
    fn test_validate_monthly_less_than_daily() {
        assert!(validate_monthly_limit(5_000, Some(10_000)).is_err());
    }

    #[test]
    fn test_validate_category_valid() {
        assert!(validate_category("API Calls").is_ok());
        assert!(validate_category("data-processing").is_ok());
        assert!(validate_category("api_calls_123").is_ok());
    }

    #[test]
    fn test_validate_category_rejects_special_chars() {
        assert!(validate_category("api@calls").is_err());
        assert!(validate_category("api;rm").is_err());
        assert!(validate_category("api$var").is_err());
    }

    #[test]
    fn test_validate_category_length() {
        assert!(validate_category("").is_err()); // Empty
        assert!(validate_category(&"a".repeat(51)).is_err()); // Too long
        assert!(validate_category(&"a".repeat(50)).is_ok()); // Max OK
    }
}
