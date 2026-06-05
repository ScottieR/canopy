/// Rate limiting for expensive operations
/// Prevents brute force attacks, DoS, and system overload
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::errors::{CanopyError, Result};

/// Rate limit bucket for tracking operation counts over time
#[derive(Clone, Debug)]
struct RateLimitBucket {
    /// Number of operations allowed in the time window
    quota: u32,

    /// Duration of the time window
    window: Duration,

    /// When the current window started
    window_start: Instant,

    /// Count of operations in current window
    count: u32,
}

impl RateLimitBucket {
    fn new(quota: u32, window: Duration) -> Self {
        RateLimitBucket {
            quota,
            window,
            window_start: Instant::now(),
            count: 0,
        }
    }

    /// Check if operation is allowed under rate limit
    fn check_and_update(&mut self) -> bool {
        let now = Instant::now();

        // Reset window if time has passed
        if now.duration_since(self.window_start) > self.window {
            self.window_start = now;
            self.count = 0;
        }

        // Check quota
        if self.count < self.quota {
            self.count += 1;
            true
        } else {
            false
        }
    }

    /// Get remaining quota in current window
    fn remaining(&self) -> u32 {
        self.quota.saturating_sub(self.count)
    }
}

/// Rate limiter for per-user or per-resource operations
pub struct RateLimiter {
    /// Map of (user_id or resource_id) -> bucket
    buckets: Arc<Mutex<HashMap<String, RateLimitBucket>>>,

    /// Number of operations allowed per window
    quota: u32,

    /// Duration of rate limit window
    window: Duration,
}

impl RateLimiter {
    /// Create a new rate limiter
    pub fn new(quota: u32, window: Duration) -> Self {
        RateLimiter {
            buckets: Arc::new(Mutex::new(HashMap::new())),
            quota,
            window,
        }
    }

    /// Check if operation is allowed for the given key (user_id, agent_id, etc.)
    pub fn check(&self, key: &str) -> Result<()> {
        let mut buckets = self.buckets.lock().unwrap();

        let bucket = buckets
            .entry(key.to_string())
            .or_insert_with(|| RateLimitBucket::new(self.quota, self.window));

        if bucket.check_and_update() {
            Ok(())
        } else {
            let remaining = Duration::from_secs(
                self.window
                    .as_secs()
                    .saturating_sub(bucket.window_start.elapsed().as_secs()),
            );
            Err(CanopyError::RateLimit)
        }
    }

    /// Get remaining quota for a key (for diagnostics)
    pub fn remaining(&self, key: &str) -> u32 {
        let buckets = self.buckets.lock().unwrap();
        buckets
            .get(key)
            .map(|b| b.remaining())
            .unwrap_or(self.quota)
    }

    /// Reset all buckets (for testing)
    #[cfg(test)]
    fn reset(&self) {
        let mut buckets = self.buckets.lock().unwrap();
        buckets.clear();
    }
}

/// Global rate limiters for different operations
pub mod limiters {
    use super::*;
    use lazy_static::lazy_static;

    lazy_static! {
        /// Agent commands: 10 per second per agent
        pub static ref AGENT_COMMAND_LIMITER: RateLimiter =
            RateLimiter::new(10, Duration::from_secs(1));

        /// Voice transcription: 30 per minute per user
        pub static ref VOICE_TRANSCRIBE_LIMITER: RateLimiter =
            RateLimiter::new(30, Duration::from_secs(60));

        /// Payment evaluation: 5 per minute per user
        pub static ref PAYMENT_EVAL_LIMITER: RateLimiter =
            RateLimiter::new(5, Duration::from_secs(60));

        /// File I/O operations: 100 per minute per user
        pub static ref FILE_IO_LIMITER: RateLimiter =
            RateLimiter::new(100, Duration::from_secs(60));

        /// Docker exec operations: 50 per minute per user
        pub static ref DOCKER_EXEC_LIMITER: RateLimiter =
            RateLimiter::new(50, Duration::from_secs(60));

        /// OAuth token operations: 10 per minute per user (prevent brute force)
        pub static ref OAUTH_LIMITER: RateLimiter =
            RateLimiter::new(10, Duration::from_secs(60));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limit_allows_within_quota() {
        let limiter = RateLimiter::new(3, Duration::from_secs(1));

        // First 3 should succeed
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_ok());

        // 4th should fail
        assert!(limiter.check("user-1").is_err());
    }

    #[test]
    fn test_rate_limit_per_key() {
        let limiter = RateLimiter::new(2, Duration::from_secs(1));

        // Each user gets their own quota
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_err()); // user-1 is limited

        // user-2 still has quota
        assert!(limiter.check("user-2").is_ok());
        assert!(limiter.check("user-2").is_ok());
        assert!(limiter.check("user-2").is_err()); // user-2 is limited
    }

    #[test]
    fn test_rate_limit_remaining() {
        let limiter = RateLimiter::new(5, Duration::from_secs(1));

        assert_eq!(limiter.remaining("user-1"), 5);
        limiter.check("user-1").ok();
        assert_eq!(limiter.remaining("user-1"), 4);
        limiter.check("user-1").ok();
        assert_eq!(limiter.remaining("user-1"), 3);
    }

    #[test]
    fn test_rate_limit_reset_after_window() {
        let limiter = RateLimiter::new(1, Duration::from_millis(100));

        // Fill quota
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_err());

        // Wait for window to pass
        std::thread::sleep(Duration::from_millis(110));

        // Quota should reset
        assert!(limiter.check("user-1").is_ok());
    }

    #[test]
    fn test_rate_limiter_return_error_type() {
        let limiter = RateLimiter::new(1, Duration::from_secs(1));

        limiter.check("user-1").ok();
        match limiter.check("user-1") {
            Err(CanopyError::RateLimit) => (), // Expected
            other => panic!("Expected RateLimit error, got: {:?}", other),
        }
    }
}
