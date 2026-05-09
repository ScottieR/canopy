/// Integration tests for rate limiting system
/// Tests that limits are enforced and windows reset properly

#[cfg(test)]
mod rate_limiting_tests {
    use canopy_lib::rate_limiter::RateLimiter;
    use canopy_lib::errors::CanopyError;
    use std::time::Duration;
    use std::thread;

    #[test]
    fn test_rate_limit_allows_within_quota() {
        let limiter = RateLimiter::new(5, Duration::from_secs(1));

        // First 5 requests should succeed
        for i in 1..=5 {
            assert!(
                limiter.check("user-1").is_ok(),
                "Request {} should be allowed",
                i
            );
        }
    }

    #[test]
    fn test_rate_limit_blocks_over_quota() {
        let limiter = RateLimiter::new(3, Duration::from_secs(1));

        // First 3 succeed
        limiter.check("user-1").unwrap();
        limiter.check("user-1").unwrap();
        limiter.check("user-1").unwrap();

        // 4th fails with RateLimit error
        match limiter.check("user-1") {
            Err(CanopyError::RateLimit) => (),  // Expected
            other => panic!("Expected RateLimit error, got: {:?}", other),
        }
    }

    #[test]
    fn test_rate_limit_per_user() {
        let limiter = RateLimiter::new(2, Duration::from_secs(1));

        // User 1 gets 2 requests
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_err());

        // User 2 gets their own quota of 2
        assert!(limiter.check("user-2").is_ok());
        assert!(limiter.check("user-2").is_ok());
        assert!(limiter.check("user-2").is_err());

        // User 3 also gets 2
        assert!(limiter.check("user-3").is_ok());
        assert!(limiter.check("user-3").is_ok());
        assert!(limiter.check("user-3").is_err());
    }

    #[test]
    fn test_rate_limit_per_resource() {
        let limiter = RateLimiter::new(3, Duration::from_secs(1));

        // Each agent gets its own quota
        assert!(limiter.check("agent-1").is_ok());
        assert!(limiter.check("agent-1").is_ok());
        assert!(limiter.check("agent-1").is_ok());
        assert!(limiter.check("agent-1").is_err());  // Agent 1 is limited

        // Agent 2 still has quota
        assert!(limiter.check("agent-2").is_ok());
        assert!(limiter.check("agent-2").is_ok());
        assert!(limiter.check("agent-2").is_ok());
        assert!(limiter.check("agent-2").is_err());  // Agent 2 is limited
    }

    #[test]
    fn test_rate_limit_resets_after_window() {
        let limiter = RateLimiter::new(2, Duration::from_millis(200));

        // Fill quota
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_ok());
        assert!(limiter.check("user-1").is_err());  // Limited

        // Wait for window to reset
        thread::sleep(Duration::from_millis(210));

        // Quota should be reset, next request should succeed
        assert!(
            limiter.check("user-1").is_ok(),
            "Request should succeed after window reset"
        );
    }

    #[test]
    fn test_rate_limit_remaining_quota() {
        let limiter = RateLimiter::new(5, Duration::from_secs(1));

        assert_eq!(limiter.remaining("user-1"), 5);
        limiter.check("user-1").ok();
        assert_eq!(limiter.remaining("user-1"), 4);
        limiter.check("user-1").ok();
        assert_eq!(limiter.remaining("user-1"), 3);
        limiter.check("user-1").ok();
        assert_eq!(limiter.remaining("user-1"), 2);
    }

    #[test]
    fn test_rate_limit_error_type() {
        let limiter = RateLimiter::new(1, Duration::from_secs(1));

        limiter.check("user-1").ok();

        let result = limiter.check("user-1");
        assert!(matches!(result, Err(CanopyError::RateLimit)));
    }

    #[test]
    fn test_multiple_limiters_independent() {
        let limiter1 = RateLimiter::new(2, Duration::from_secs(1));
        let limiter2 = RateLimiter::new(3, Duration::from_secs(1));

        // Fill limiter1 quota
        limiter1.check("user-1").ok();
        limiter1.check("user-1").ok();
        assert!(limiter1.check("user-1").is_err());

        // limiter2 should be independent
        limiter2.check("user-1").ok();
        limiter2.check("user-1").ok();
        limiter2.check("user-1").ok();
        assert!(limiter2.check("user-1").is_err());
    }

    #[test]
    fn test_rate_limit_global_limiters_exist() {
        // Verify global limiters are accessible and work
        use canopy_lib::rate_limiter::limiters;

        // These should not panic
        assert!(limiters::AGENT_COMMAND_LIMITER.check("agent-test").is_ok());
        assert!(limiters::VOICE_TRANSCRIBE_LIMITER.check("user-test").is_ok());
        assert!(limiters::PAYMENT_EVAL_LIMITER.check("user-test").is_ok());
        assert!(limiters::FILE_IO_LIMITER.check("user-test").is_ok());
        assert!(limiters::DOCKER_EXEC_LIMITER.check("user-test").is_ok());
        assert!(limiters::OAUTH_LIMITER.check("user-test").is_ok());
    }

    #[test]
    fn test_rate_limit_stress_test() {
        let limiter = RateLimiter::new(100, Duration::from_secs(1));

        // Make 100 requests - all should succeed
        for i in 0..100 {
            assert!(
                limiter.check("user-stress").is_ok(),
                "Request {} should succeed",
                i
            );
        }

        // 101st should fail
        assert!(limiter.check("user-stress").is_err());
    }

    #[test]
    fn test_rate_limit_concurrent_users() {
        let limiter = RateLimiter::new(5, Duration::from_secs(1));

        // Simulate concurrent requests from multiple users
        let users = vec!["user-1", "user-2", "user-3", "user-4", "user-5"];

        for _ in 0..5 {
            for user in &users {
                assert!(
                    limiter.check(user).is_ok(),
                    "All 5 requests from {} should succeed",
                    user
                );
            }
        }

        // Each user should now be limited
        for user in &users {
            assert!(
                limiter.check(user).is_err(),
                "User {} should be rate limited",
                user
            );
        }
    }
}
