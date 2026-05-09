/// Application state carrying user context through Tauri commands
/// Enables authorization checks and audit logging

use std::sync::Arc;
use tauri::State;

/// Application state passed to all Tauri commands
/// Contains user context for authorization and audit purposes
#[derive(Clone, Debug)]
pub struct AppState {
    /// Current user identifier (TODO: implement user authentication)
    pub user_id: String,

    /// Whether current user is an admin (can perform privileged operations)
    pub is_admin: bool,

    /// Application version for compatibility checks
    pub app_version: String,

    /// Whether the app is running in development mode (enables debug features)
    pub dev_mode: bool,
}

impl AppState {
    /// Create a new AppState for the current session
    ///
    /// TODO: user_id should come from authentication system
    /// For now, defaults to system user
    pub fn new() -> Self {
        AppState {
            user_id: std::env::var("USER")
                .unwrap_or_else(|_| "local-user".to_string()),
            is_admin: false,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            dev_mode: cfg!(debug_assertions),
        }
    }

    /// Create admin AppState for privileged operations
    #[cfg(debug_assertions)]
    pub fn admin() -> Self {
        AppState {
            is_admin: true,
            ..Self::new()
        }
    }

    /// Check if user is authorized for operation
    pub fn is_authorized(&self, required_admin: bool) -> bool {
        if required_admin {
            self.is_admin
        } else {
            true  // All users can perform non-admin operations
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_state_creation() {
        let state = AppState::new();
        assert!(!state.is_admin);
        assert!(!state.user_id.is_empty());
    }

    #[test]
    fn test_authorization_check() {
        let state = AppState::new();
        assert!(state.is_authorized(false));  // Non-admin ops allowed
        assert!(!state.is_authorized(true));  // Admin ops denied for non-admin
    }

    #[test]
    #[cfg(debug_assertions)]
    fn test_admin_state() {
        let admin_state = AppState::admin();
        assert!(admin_state.is_admin);
        assert!(admin_state.is_authorized(true));
    }
}
