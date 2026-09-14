//! Conductor/worker orchestration state.
//!
//! An agent with the `orchestration` capability runs as a thin, persistent "conductor"
//! that triages incoming requests and, for genuinely parallelizable or long-running
//! work, spawns disposable OpenClaw worker subagents (`sessions_spawn`, isolated
//! context) instead of doing everything inline. This module owns the Canopy-side half
//! of that pattern:
//!
//! - A topic registry (`task -> worker ids + status + summary`) persisted to disk so it
//!   survives Canopy restarts. The conductor itself is designed to hold only this
//!   registry, never full worker transcripts — see `render_restart_context`, which is
//!   what gets injected into the conductor's first message after a restart.
//! - Per-worker timeout enforcement (`runTimeoutSeconds`), independent of whatever
//!   timeout OpenClaw itself enforces, so a hung worker can't wedge the topic forever.
//! - A cross-check against OpenClaw's own session status before trusting a worker's
//!   self-reported "completed" state — see `confirm_worker_terminal`.
//!
//! Two OpenClaw runtime bugs shaped the design:
//! - **#49572**: the announce callback that delivers a spawned worker's result to its
//!   parent only survives one LLM turn. A conductor that does yield -> spawn -> yield
//!   across multiple turns can lose results. This module doesn't try to route results
//!   through that live channel at all — timeouts and restart recovery both go through
//!   the durable conversation transcript / persisted state instead, which the conductor
//!   re-reads on its next turn regardless of how many turns have passed.
//! - **#46719**: a worker marked "completed" can still have running children. Treat a
//!   worker's own status as provisional; call `confirm_worker_terminal` before treating
//!   a "completed" result as final.
//!
//! State lives at `~/Library/Application Support/Canopy/conductor-state/{agent_id}/state.json`
//! — a standalone file rather than a SQLite column, mirroring the per-agent web
//! allowlist in `browser_manager.rs`, so this feature never needed a DB migration and
//! deleting an agent's data directory cleans its conductor state up for free.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Mirrors `agents.defaults.runTimeoutSeconds` in openclaw.json (see docker.rs). Kept
/// as a fallback for callers that don't have a per-worker override handy.
pub const DEFAULT_WORKER_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Running,
    Completed,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerEntry {
    pub worker_id: String,
    pub status: WorkerStatus,
    /// Structured summary the worker returned — never the full transcript. Full output
    /// lives on the shared filesystem; this is a pointer to it, not the content.
    pub summary: Option<String>,
    pub artifact_path: Option<String>,
    pub spawned_at_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicEntry {
    pub topic_id: String,
    pub task: String,
    /// Topic-level rollup of `workers` — Running while any worker is Running, else the
    /// worst outcome among Failed / TimedOut / Completed.
    pub status: WorkerStatus,
    pub workers: Vec<WorkerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConductorState {
    #[serde(default)]
    pub topics: HashMap<String, TopicEntry>,
}

fn state_path_for(agent_id: &str) -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| {
        d.join("Canopy")
            .join("conductor-state")
            .join(agent_id)
            .join("state.json")
    })
}

/// Tolerant of a missing or malformed file — a fresh/corrupt state is just an empty
/// registry, not an error the caller needs to handle.
pub fn load_state(agent_id: &str) -> ConductorState {
    state_path_for(agent_id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(agent_id: &str, state: &ConductorState) -> std::io::Result<()> {
    let path = state_path_for(agent_id).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "could not resolve data dir")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, body)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn rollup_status(workers: &[WorkerEntry]) -> WorkerStatus {
    if workers.iter().any(|w| w.status == WorkerStatus::Running) {
        WorkerStatus::Running
    } else if workers.iter().any(|w| w.status == WorkerStatus::Failed) {
        WorkerStatus::Failed
    } else if workers.iter().any(|w| w.status == WorkerStatus::TimedOut) {
        WorkerStatus::TimedOut
    } else {
        WorkerStatus::Completed
    }
}

/// Record a freshly spawned worker under `topic_id`, creating the topic if it's new.
pub fn register_worker(agent_id: &str, topic_id: &str, task: &str, worker_id: &str) {
    let mut state = load_state(agent_id);
    let topic = state
        .topics
        .entry(topic_id.to_string())
        .or_insert_with(|| TopicEntry {
            topic_id: topic_id.to_string(),
            task: task.to_string(),
            status: WorkerStatus::Running,
            workers: Vec::new(),
        });
    topic.status = WorkerStatus::Running;
    topic.workers.push(WorkerEntry {
        worker_id: worker_id.to_string(),
        status: WorkerStatus::Running,
        summary: None,
        artifact_path: None,
        spawned_at_unix: now_unix(),
    });
    let _ = save_state(agent_id, &state);
}

/// Record a worker's terminal result and roll the owning topic's status up.
pub fn record_worker_result(
    agent_id: &str,
    topic_id: &str,
    worker_id: &str,
    status: WorkerStatus,
    summary: Option<String>,
    artifact_path: Option<String>,
) {
    let mut state = load_state(agent_id);
    let Some(topic) = state.topics.get_mut(topic_id) else {
        return;
    };
    if let Some(worker) = topic.workers.iter_mut().find(|w| w.worker_id == worker_id) {
        worker.status = status;
        worker.summary = summary;
        worker.artifact_path = artifact_path;
    }
    topic.status = rollup_status(&topic.workers);
    let _ = save_state(agent_id, &state);
}

/// Count workers currently `Running` across every topic — backs the UI's active-worker
/// badge.
pub fn active_worker_count(agent_id: &str) -> usize {
    load_state(agent_id)
        .topics
        .values()
        .flat_map(|t| &t.workers)
        .filter(|w| w.status == WorkerStatus::Running)
        .count()
}

/// Render the saved topic registry as a compact context block to seed the conductor's
/// first message after a Canopy restart, so it recovers what it was doing instead of
/// silently losing track of in-flight or recently finished workers. Returns `None` when
/// there is nothing worth injecting (fresh agent, empty registry).
pub fn render_restart_context(agent_id: &str) -> Option<String> {
    let state = load_state(agent_id);
    if state.topics.is_empty() {
        return None;
    }
    let mut lines =
        vec!["[Conductor restart context — topic registry recovered from disk]".to_string()];
    for topic in state.topics.values() {
        lines.push(format!(
            "- topic `{}` [{:?}]: {}",
            topic.topic_id, topic.status, topic.task
        ));
        for worker in &topic.workers {
            let summary = worker.summary.as_deref().unwrap_or("(no summary yet)");
            lines.push(format!(
                "  - worker `{}` [{:?}]: {}",
                worker.worker_id, worker.status, summary
            ));
        }
    }
    Some(lines.join("\n"))
}

/// Cross-check a worker's true liveness against OpenClaw's own session status before
/// treating a self-reported "completed" result as final — workaround for OpenClaw bug
/// #46719, where a worker can report completed while a child session it spawned is
/// still running. Callers should gate "is this worker actually done" on this rather
/// than on the worker's own status field alone.
pub async fn confirm_worker_terminal(
    db: &crate::db::Database,
    agent_id: &str,
    worker_session_key: &str,
) -> bool {
    match crate::openclaw::session_status(db, agent_id, worker_session_key).await {
        Ok(status) => !status.eq_ignore_ascii_case("running"),
        // Can't verify — don't block a topic forever on an unreachable runtime; treat
        // as terminal and let the caller's own result (or a later timeout) resolve it.
        Err(_) => true,
    }
}

/// Enforce a per-worker timeout: after `timeout_secs`, if the worker is still `Running`
/// in the persisted registry, mark it `TimedOut` and drop a durable note in the agent's
/// own conversation history. Deliberately does NOT try to push into a live announce
/// callback (OpenClaw bug #49572 means that channel only survives one LLM turn) — the
/// durable transcript is what the conductor actually reads on its next turn, restart or
/// not.
pub fn spawn_worker_timeout_enforcement(
    app_handle: tauri::AppHandle,
    agent_id: String,
    topic_id: String,
    worker_id: String,
    timeout_secs: u64,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(timeout_secs)).await;

        let mut state = load_state(&agent_id);
        let Some(topic) = state.topics.get_mut(&topic_id) else {
            return;
        };
        let Some(worker) = topic.workers.iter_mut().find(|w| w.worker_id == worker_id) else {
            return;
        };
        if worker.status != WorkerStatus::Running {
            return; // already resolved before the timer fired
        }
        worker.status = WorkerStatus::TimedOut;
        let partial_path = worker.artifact_path.clone();
        topic.status = rollup_status(&topic.workers);
        let _ = save_state(&agent_id, &state);

        let db = app_handle.state::<crate::db::Database>();
        if let Ok(conv_id) = db.get_or_create_conversation(&agent_id) {
            let path_note = partial_path.unwrap_or_else(|| "(none written)".to_string());
            let _ = db.insert_message(
                &conv_id,
                "system",
                &format!(
                    "⏱️ Worker `{}` (topic `{}`) timed out after {}s. Partial results: {}",
                    worker_id, topic_id, timeout_secs, path_note
                ),
            );
        }
    });
}

/// Active worker counts for every agent with the `orchestration` capability enabled —
/// backs the fleet-view badge. Agents without the capability, or with no workers
/// running, are simply absent from the map.
#[tauri::command]
pub async fn get_active_worker_counts(
    db: tauri::State<'_, crate::db::Database>,
) -> Result<HashMap<String, usize>, String> {
    let agents = db.list_agents().map_err(|e| e.to_string())?;
    let mut counts = HashMap::new();
    for agent in agents {
        if !agent.capabilities.orchestration {
            continue;
        }
        let count = active_worker_count(&agent.id);
        if count > 0 {
            counts.insert(agent.id, count);
        }
    }
    Ok(counts)
}
