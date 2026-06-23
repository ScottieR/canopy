use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::errors::{CanopyError, Result};
use crate::models::{Agent, AgentCapabilities};
use crate::rate_limiter::RateLimiter;

pub const MAX_HOST_CONTROL_SESSION_SECS: u64 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerControlPlane {
    Disabled,
    Container,
    Host,
}

pub fn control_plane(capabilities: &AgentCapabilities) -> ComputerControlPlane {
    if !capabilities.computer_control {
        ComputerControlPlane::Disabled
    } else if capabilities.host_control {
        ComputerControlPlane::Host
    } else {
        ComputerControlPlane::Container
    }
}

pub fn validate_capabilities(agent: &Agent, capabilities: &AgentCapabilities) -> Result<()> {
    if capabilities.host_control && !capabilities.computer_control {
        return Err(CanopyError::Validation(
            "Host computer control cannot be enabled unless computer control is also enabled."
                .into(),
        ));
    }

    if capabilities.computer_control && !capabilities.screen_record {
        return Err(CanopyError::Validation(
            "Computer control requires screen recording so actions can be audited and bounded."
                .into(),
        ));
    }

    if capabilities.host_control && !agent.isolated {
        return Err(CanopyError::Unauthorized(
            "Host computer control is only allowed for isolated agents.".into(),
        ));
    }

    Ok(())
}

#[derive(Clone, Debug)]
struct HostControlSession {
    expires_at: Instant,
}

#[derive(Clone, Default)]
pub struct HostControlSessionRegistry {
    sessions: Arc<Mutex<HashMap<String, HostControlSession>>>,
}

impl HostControlSessionRegistry {
    pub fn begin_session(&self, agent_id: &str, requested_secs: u64) -> u64 {
        let granted_secs = requested_secs.clamp(1, MAX_HOST_CONTROL_SESSION_SECS);
        let expires_at = Instant::now() + Duration::from_secs(granted_secs);
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(agent_id.to_string(), HostControlSession { expires_at });
        granted_secs
    }

    pub fn is_active(&self, agent_id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        match sessions.get(agent_id) {
            Some(session) if Instant::now() < session.expires_at => true,
            Some(_) => {
                sessions.remove(agent_id);
                false
            }
            None => false,
        }
    }
}

#[derive(Clone, Default)]
pub struct EmergencyStopRegistry {
    flags: Arc<Mutex<HashMap<String, bool>>>,
}

impl EmergencyStopRegistry {
    pub fn engage(&self, agent_id: &str) {
        let mut flags = self.flags.lock().unwrap();
        flags.insert(agent_id.to_string(), true);
    }

    pub fn clear(&self, agent_id: &str) {
        let mut flags = self.flags.lock().unwrap();
        flags.remove(agent_id);
    }

    pub fn is_engaged(&self, agent_id: &str) -> bool {
        let flags = self.flags.lock().unwrap();
        flags.get(agent_id).copied().unwrap_or(false)
    }

    pub fn ensure_not_engaged(&self, agent_id: &str) -> Result<()> {
        if self.is_engaged(agent_id) {
            Err(CanopyError::Unauthorized(
                "Computer control emergency stop is engaged for this agent.".into(),
            ))
        } else {
            Ok(())
        }
    }
}

pub fn check_ui_action_allowed(
    limiter: &RateLimiter,
    emergency_stop: &EmergencyStopRegistry,
    agent_id: &str,
) -> Result<()> {
    emergency_stop.ensure_not_engaged(agent_id)?;
    limiter.check(agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentPersonality, AgentStats, AgentStatus};
    use chrono::Utc;

    fn test_agent(isolated: bool) -> Agent {
        Agent {
            id: "agent-control".into(),
            name: "Control Agent".into(),
            role: "assistant".into(),
            emoji: "C".into(),
            color: "#3c6663".into(),
            status: AgentStatus::Active,
            isolated,
            paused: false,
            container_id: None,
            personality: AgentPersonality::default(),
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        }
    }

    #[test]
    fn host_plane_requires_both_flags() {
        let mut caps = AgentCapabilities::default();
        caps.computer_control = true;
        assert_eq!(control_plane(&caps), ComputerControlPlane::Container);

        caps.host_control = true;
        assert_eq!(control_plane(&caps), ComputerControlPlane::Host);
    }

    #[test]
    fn computer_control_requires_screen_recording() {
        let agent = test_agent(true);
        let mut caps = AgentCapabilities::default();
        caps.computer_control = true;
        caps.screen_record = false;

        let err = validate_capabilities(&agent, &caps)
            .unwrap_err()
            .to_string();
        assert!(err.contains("requires screen recording"));
    }

    #[test]
    fn host_control_requires_isolation() {
        let agent = test_agent(false);
        let mut caps = AgentCapabilities::default();
        caps.computer_control = true;
        caps.screen_record = true;
        caps.host_control = true;

        let err = validate_capabilities(&agent, &caps)
            .unwrap_err()
            .to_string();
        assert!(err.contains("isolated agents"));
    }

    #[test]
    fn host_control_requires_computer_control_flag() {
        let agent = test_agent(true);
        let mut caps = AgentCapabilities::default();
        caps.screen_record = true;
        caps.host_control = true;

        let err = validate_capabilities(&agent, &caps)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Host computer control cannot be enabled"));
    }

    #[test]
    fn emergency_stop_blocks_actions() {
        let limiter = RateLimiter::new(5, Duration::from_secs(1));
        let stop = EmergencyStopRegistry::default();
        stop.engage("agent-control");

        let err = check_ui_action_allowed(&limiter, &stop, "agent-control")
            .unwrap_err()
            .to_string();
        assert!(err.contains("emergency stop"));
    }

    #[test]
    fn ui_action_rate_limit_applies_after_stop_check() {
        let limiter = RateLimiter::new(1, Duration::from_secs(60));
        let stop = EmergencyStopRegistry::default();

        assert!(check_ui_action_allowed(&limiter, &stop, "agent-control").is_ok());
        let err = check_ui_action_allowed(&limiter, &stop, "agent-control")
            .unwrap_err()
            .to_string();
        assert!(err.contains("Rate limit exceeded"));
    }

    #[test]
    fn host_control_sessions_are_capped() {
        let sessions = HostControlSessionRegistry::default();
        let granted = sessions.begin_session("agent-control", 999);

        assert_eq!(granted, MAX_HOST_CONTROL_SESSION_SECS);
        assert!(sessions.is_active("agent-control"));
    }
}
