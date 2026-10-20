//! Single source of truth for an agent's *actual* OpenClaw tool surface.
//!
//! Before this module existed, three places each derived "what can this agent do"
//! from `AgentCapabilities` independently: `sync_agent_skills` (which writes
//! `agents.list[i]` in openclaw.json), `build_app_capabilities_md` and
//! `write_permissions_md`. They drifted: APP_CAPABILITIES.md told agents that code
//! execution and file read/write were DISABLED while `exec`/`read`/`write` were live
//! (nothing ever restricted those tools), advertised `gog` as web search (it is
//! OpenClaw's Google Workspace CLI skill, and it isn't even installed), and
//! PERMISSIONS.md pointed agents at "dedicated Google Drive tools" that never exist.
//!
//! Now `AgentToolSurface::for_agent` computes the exact per-agent config patch
//! (`skills` + `tools.deny`), and the generated docs read their ENABLED/DISABLED
//! lines from the same struct, so a doc claim can only change together with config.

use std::collections::BTreeSet;

/// Tools registered by OpenClaw's bundled `file-transfer` plugin. Every one of them
/// is dispatched via `node.invoke` to a *paired node* — a Canopy agent container never
/// has one, so each call fails with "no paired nodes available". The plugin is
/// `enabledByDefault`, so we deny its tools per agent rather than let agents burn turns
/// on them. Workspace files are reachable through `read`/`write`/`edit` and `exec`.
pub(crate) const NODE_ONLY_FILE_TOOLS: [&str; 4] =
    ["dir_list", "dir_fetch", "file_fetch", "file_write"];

/// OpenClaw's built-in web tools (`group:web`). Gated by the "Search Engine" (`gog`)
/// capability — the UI describes that toggle as "Query the web for information".
pub(crate) const BUILTIN_WEB_TOOLS: [&str; 3] = ["web_search", "x_search", "web_fetch"];

/// Workspace file tools. Never denied: the agent must be able to read its own
/// PERMISSIONS.md / APP_*.md and write artifacts into its (host bind-mounted)
/// workspace. `file_read` / `file_write` capabilities govern *host folder grants*.
pub(crate) const WORKSPACE_FILE_TOOLS: [&str; 4] = ["read", "write", "edit", "apply_patch"];

/// Shell. Never denied: every Canopy JIT bridge call (request_permission, file
/// export, /web/*) is a `curl` issued through `exec`, so denying it would also cut
/// the agent off from asking for more access. The `coding` capability is therefore
/// advisory policy for *what* the agent runs, and the docs say so explicitly.
pub(crate) const SHELL_TOOLS: [&str; 2] = ["exec", "process"];

/// How a connected Canopy integration is actually reachable from inside the agent's
/// container. Drives both the skills allowlist and the PERMISSIONS.md wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IntegrationReach {
    /// A chat channel (OpenClaw channel + skill). Messages from it are routed to the
    /// agent and replies go back through it.
    Channel {
        skill: &'static str,
        label: &'static str,
    },
    /// A bundled OpenClaw skill that wraps a CLI.
    CliSkill {
        skill: &'static str,
        label: &'static str,
        bin: &'static str,
    },
    /// A saved website login for the managed browser (WebVault auto-fill).
    WebLogin { domain: String },
    /// Canopy installs a short-lived OAuth token in `.canopy/` and the agent calls the
    /// provider REST API with `exec` + curl.
    TokenFileRest { label: &'static str },
    /// Connected in Canopy, but there is no tool, skill, plugin or bridge route the
    /// agent can call for it. Docs must say so rather than invent a tool.
    NoAgentTool {
        label: &'static str,
        reason: &'static str,
    },
}

pub(crate) fn integration_reach(id: &str) -> IntegrationReach {
    if let Some(rest) = id.strip_prefix("web_") {
        // Saved web logins are stored as `web_<domain>_<account>`.
        let domain = rest.split('_').next().unwrap_or(rest).to_string();
        return IntegrationReach::WebLogin { domain };
    }
    match id {
        "slack" => IntegrationReach::Channel {
            skill: "slack",
            label: "Slack",
        },
        "telegram" => IntegrationReach::Channel {
            skill: "telegram",
            label: "Telegram",
        },
        "discord" => IntegrationReach::Channel {
            skill: "discord",
            label: "Discord",
        },
        "github" => IntegrationReach::CliSkill {
            skill: "github",
            label: "GitHub",
            bin: "gh",
        },
        "google_photos" => IntegrationReach::TokenFileRest {
            label: "Google Photos",
        },
        "drive" | "drive_read" | "drive_write" | "drive_granular" => {
            IntegrationReach::NoAgentTool {
                label: "Google Drive / Docs / Sheets",
                reason:
                    "Canopy holds the Drive OAuth grant on the host, but no Drive tool, skill or \
                     JIT bridge route exposes it inside your container yet",
            }
        }
        "imessage" => IntegrationReach::NoAgentTool {
            label: "iMessage",
            reason:
                "iMessage lives in the user's Mac Messages database, which Canopy reads on the \
                     host; there is no tool or bridge route that lets you list, read or send \
                     iMessages from your container",
        },
        "email" | "gmail" | "email_read" | "email_write" => IntegrationReach::NoAgentTool {
            label: "Gmail",
            reason: "Canopy holds the Gmail OAuth grant on the host, but no Gmail tool is \
                     registered in your container",
        },
        "calendar" | "cal" | "calendar_read" | "calendar_write" | "googleCalendar" => {
            IntegrationReach::NoAgentTool {
                label: "Google Calendar",
                reason: "Canopy holds the Calendar OAuth grant on the host, but no Calendar tool \
                         is registered in your container",
            }
        }
        "apple_photos" => IntegrationReach::NoAgentTool {
            label: "Apple Photos",
            reason: "the Photos library is on the host Mac and is not mounted into your container",
        },
        _ => IntegrationReach::NoAgentTool {
            label: "this integration",
            reason: "no dedicated tool for it is registered in your container",
        },
    }
}

/// The per-agent OpenClaw surface Canopy writes into `agents.list[i]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentToolSurface {
    /// `agents.list[i].skills` — OpenClaw's per-agent skill allowlist.
    pub skills: Vec<String>,
    /// `agents.list[i].tools.deny` — tools removed from the model's tool list.
    pub tool_deny: Vec<String>,
}

impl AgentToolSurface {
    /// `workspace_skills` are skill names found under the agent's own
    /// `<workspace>/skills/*/SKILL.md`. They must be in the allowlist or OpenClaw
    /// filters out the agent's own skills (`blockedByAgentFilter`).
    pub(crate) fn for_agent(agent: &crate::models::Agent, workspace_skills: &[String]) -> Self {
        let caps = &agent.capabilities;
        let mut skills: Vec<String> = Vec::new();
        let mut push = |s: &str| {
            if !skills.iter().any(|existing| existing == s) {
                skills.push(s.to_string());
            }
        };
        for (name, on) in [
            ("browser", caps.browser),
            ("proxy", caps.proxy),
            ("vision", caps.vision),
            ("canvas", caps.canvas),
            ("coding", caps.coding),
            ("gog", caps.gog),
            ("summarize", caps.summarize),
            ("genui", caps.genui),
            ("memory-core", caps.memory_write),
        ] {
            if on {
                push(name);
            }
        }
        // Integration IDs → OpenClaw skill/channel names (legacy mapping kept verbatim so
        // the allowlist does not change for existing agents).
        for i in &agent.integrations {
            if i.starts_with("web_") {
                continue;
            }
            let mapped = match i.as_str() {
                "calendar" | "cal" | "calendar_read" | "calendar_write" => "googleCalendar",
                "email" => "gmail",
                "drive" => "googleDrive",
                other => other,
            };
            push(mapped);
        }
        for s in workspace_skills {
            push(s);
        }

        let mut deny: BTreeSet<String> =
            NODE_ONLY_FILE_TOOLS.iter().map(|s| s.to_string()).collect();
        if !caps.browser {
            deny.insert("browser".into());
        }
        if !caps.canvas {
            deny.insert("canvas".into());
        }
        if !caps.gog {
            deny.extend(BUILTIN_WEB_TOOLS.iter().map(|s| s.to_string()));
        }

        Self {
            skills,
            tool_deny: deny.into_iter().collect(),
        }
    }

    pub(crate) fn tool_available(&self, tool: &str) -> bool {
        !self.tool_deny.iter().any(|t| t == tool)
    }

    pub(crate) fn browser_available(&self) -> bool {
        self.tool_available("browser")
    }

    pub(crate) fn builtin_web_available(&self) -> bool {
        BUILTIN_WEB_TOOLS.iter().all(|t| self.tool_available(t))
    }

    pub(crate) fn canvas_available(&self) -> bool {
        self.tool_available("canvas")
    }

    pub(crate) fn shell_available(&self) -> bool {
        SHELL_TOOLS.iter().all(|t| self.tool_available(t))
    }

    pub(crate) fn workspace_files_available(&self) -> bool {
        WORKSPACE_FILE_TOOLS.iter().all(|t| self.tool_available(t))
    }

    /// Node script fragment applied to `c.agents.list[i]` (as `a`). Replaces
    /// `skills` and `tools.deny`, preserving any other `tools` keys.
    pub(crate) fn node_patch_js(&self) -> String {
        let skills = serde_json::to_string(&self.skills).unwrap_or_else(|_| "[]".into());
        let deny = serde_json::to_string(&self.tool_deny).unwrap_or_else(|_| "[]".into());
        format!(
            "a.skills={skills};\
             a.tools=(a.tools&&typeof a.tools==='object')?a.tools:{{}};\
             a.tools.deny={deny};\
             if(a.tools.deny.length===0)delete a.tools.deny;\
             if(Object.keys(a.tools).length===0)delete a.tools;"
        )
    }
}

/// Skill names under `<workspace>/skills/*/SKILL.md`, taken from the frontmatter
/// `name:` field when present, else the directory name.
pub(crate) fn discover_workspace_skill_names(workspace: &std::path::Path) -> Vec<String> {
    let mut names = BTreeSet::new();
    let Ok(entries) = std::fs::read_dir(workspace.join("skills")) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(raw) = std::fs::read_to_string(dir.join("SKILL.md")) else {
            continue;
        };
        let from_frontmatter = raw
            .strip_prefix("---")
            .and_then(|rest| rest.split("\n---").next())
            .and_then(|fm| {
                fm.lines().find_map(|l| {
                    l.trim()
                        .strip_prefix("name:")
                        .map(|v| v.trim().trim_matches('"').trim_matches('\'').to_string())
                })
            })
            .filter(|n| !n.is_empty());
        let name =
            from_frontmatter.or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()));
        if let Some(name) = name {
            if name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            {
                names.insert(name);
            }
        }
    }
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Agent, AgentCapabilities, AgentPersonality, AgentStats, AgentStatus};

    fn agent(caps: AgentCapabilities, integrations: &[&str]) -> Agent {
        Agent {
            id: "agent-boots".into(),
            name: "Boots".into(),
            role: "STR Manager".into(),
            emoji: "agent".into(),
            color: "#3c6663".into(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Boots".into(),
                ..Default::default()
            },
            capabilities: caps,
            integrations: integrations.iter().map(|s| s.to_string()).collect(),
            visual_identity: None,
            memories: vec![],
            created_at: chrono::Utc::now(),
            stats: AgentStats::default(),
        }
    }

    fn inputs(jit_port: u16) -> crate::openclaw::PermissionsDocInputs {
        crate::openclaw::PermissionsDocInputs {
            jit_port,
            allowed_domains: vec![],
            saved_login_domains: vec![],
            provider_keys: vec!["google"],
            google_photos_token_installed: false,
        }
    }

    /// The live 2026-08-26 Boots configuration that produced contradictory docs.
    fn boots_caps() -> AgentCapabilities {
        AgentCapabilities {
            coding: false,
            file_read: false,
            file_write: false,
            browser: true,
            gog: true,
            vision: true,
            canvas: true,
            ..AgentCapabilities::default()
        }
    }

    fn everything_off() -> AgentCapabilities {
        AgentCapabilities {
            browser: false,
            gog: false,
            canvas: false,
            coding: false,
            summarize: false,
            memory_write: false,
            ..AgentCapabilities::default()
        }
    }

    fn everything_on() -> AgentCapabilities {
        AgentCapabilities {
            browser: true,
            gog: true,
            canvas: true,
            coding: true,
            file_read: true,
            file_write: true,
            web_search: true,
            web_browse: true,
            web_auth: true,
            ..AgentCapabilities::default()
        }
    }

    fn status_line<'a>(doc: &'a str, label: &str) -> &'a str {
        doc.lines()
            .find(|l| l.starts_with(&format!("- **{}: ", label)))
            .unwrap_or_else(|| panic!("no capability line for {label:?} in:\n{doc}"))
    }

    fn assert_status(doc: &str, label: &str, enabled: bool) {
        let line = status_line(doc, label);
        let want = if enabled { "ENABLED**" } else { "DISABLED**" };
        assert!(
            line.contains(want),
            "{label}: expected {want} (config says {enabled}), got: {line}"
        );
    }

    #[test]
    fn docs_agree_with_openclaw_config_across_permission_combinations() {
        let combos: Vec<(&str, AgentCapabilities, Vec<&str>)> = vec![
            (
                "boots-2026-08-26",
                boots_caps(),
                vec![
                    "drive_read",
                    "imessage",
                    "web_my.hospitable.com_x@y.z",
                    "slack",
                ],
            ),
            ("defaults", AgentCapabilities::default(), vec![]),
            (
                "everything-off",
                everything_off(),
                vec!["email_read", "googleCalendar"],
            ),
            (
                "everything-on",
                everything_on(),
                vec!["drive_granular", "github", "slack"],
            ),
        ];
        for (name, caps, integrations) in combos {
            let a = agent(caps, &integrations);
            let surface = AgentToolSurface::for_agent(&a, &[]);

            // Config invariants.
            for tool in NODE_ONLY_FILE_TOOLS {
                assert!(
                    !surface.tool_available(tool),
                    "{name}: {tool} must be denied"
                );
            }
            for tool in WORKSPACE_FILE_TOOLS.iter().chain(SHELL_TOOLS.iter()) {
                assert!(
                    surface.tool_available(tool),
                    "{name}: {tool} must never be denied"
                );
            }
            let js = surface.node_patch_js();
            assert!(
                js.contains(&serde_json::to_string(&surface.tool_deny).unwrap()),
                "{name}: patch must carry the deny list"
            );
            assert!(
                js.contains(&serde_json::to_string(&surface.skills).unwrap()),
                "{name}: patch must carry the skills"
            );

            // APP_CAPABILITIES.md reads its statuses from the same surface.
            let caps_md = crate::openclaw::render_app_capabilities_md(&a, &surface, "");
            assert_status(
                &caps_md,
                "Browser (`browser` tool)",
                !surface.tool_deny.contains(&"browser".to_string()),
            );
            assert_status(
                &caps_md,
                "Web search & fetch (`web_search` / `web_fetch` tools)",
                !surface.tool_deny.contains(&"web_search".to_string()),
            );
            assert_status(
                &caps_md,
                "Canvas (`canvas` tool)",
                !surface.tool_deny.contains(&"canvas".to_string()),
            );
            assert_status(
                &caps_md,
                "Workspace files (`read` / `write` / `edit`)",
                true,
            );
            assert!(
                !caps_md.contains("Code execution: DISABLED"),
                "{name}: exec is never removed, so it must not be reported DISABLED"
            );
            assert!(
                !caps_md.contains("Web search (gog)"),
                "{name}: gog is not web search"
            );
            assert!(
                caps_md.contains("bind-mounted from the Canopy host"),
                "{name}"
            );
            assert_eq!(
                caps_md
                    .matches("## Your Workspace & Handing Files to the User")
                    .count(),
                1,
                "{name}: single export spot"
            );

            // PERMISSIONS.md tool-surface lines agree with the deny list.
            let perms = crate::openclaw::render_permissions_md(&a, &surface, &inputs(18802));
            let line_for = |prefix: &str| {
                perms
                    .lines()
                    .find(|l| l.contains(prefix))
                    .unwrap_or_else(|| panic!("{name}: missing {prefix}"))
                    .to_string()
            };
            for (prefix, tool) in [
                ("Browser — `browser`", "browser"),
                ("Built-in web — ", "web_search"),
                ("Canvas — `canvas`", "canvas"),
            ] {
                let available = surface.tool_available(tool);
                let line = line_for(prefix);
                assert_eq!(line.contains("NOT available"), !available, "{name}: {line}");
            }
            assert!(line_for("`dir_list`").contains("NOT available"));
            assert!(!perms.contains("dedicated Google Drive tools"), "{name}");
            assert!(
                !perms.contains("dedicated MCP tools are automatically provided"),
                "{name}"
            );
        }
    }

    #[test]
    fn integrations_without_tools_are_described_honestly() {
        let a = agent(boots_caps(), &["drive_read", "imessage", "slack"]);
        let surface = AgentToolSurface::for_agent(&a, &[]);
        let perms = crate::openclaw::render_permissions_md(&a, &surface, &inputs(18802));
        assert!(perms.contains("no Google Drive tool in your tool list"));
        assert!(perms.contains("no iMessage tool in your tool list"));
        assert!(
            perms.contains("open the link in your managed browser"),
            "browser fallback offered when browser is on"
        );
        assert!(perms.contains("`slack` — Slack channel"));
        assert!(!perms.contains("via the background MCP bridge"));

        // With no browser and no web_auth there is no working Drive path at all.
        let blind = agent(everything_off(), &["drive"]);
        let blind_perms = crate::openclaw::render_permissions_md(
            &blind,
            &AgentToolSurface::for_agent(&blind, &[]),
            &inputs(18802),
        );
        assert!(blind_perms.contains("no working path to Drive content"));
    }

    #[test]
    fn permissions_use_flavor_port_and_document_request_timeout() {
        let a = agent(AgentCapabilities::default(), &[]);
        let surface = AgentToolSurface::for_agent(&a, &[]);
        let perms = crate::openclaw::render_permissions_md(&a, &surface, &inputs(18796));
        assert!(perms.contains("host.docker.internal:18796/request_permission"));
        assert!(perms.contains("host.docker.internal:18796/generate_web_connection_token"));
        assert!(
            !perms.contains("18802"),
            "dev flavor must not see the prod port"
        );
        assert!(perms.contains("HTTP 408"));

        let protocols = crate::openclaw::render_canopy_protocols(18796);
        assert!(!protocols.contains("{{CANOPY_JIT_PORT}}"));
        assert!(!protocols.contains("18802"));
    }

    #[test]
    fn workspace_skills_join_the_allowlist() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("skills").join("tot-filing");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: tot-filing\ndescription: x\n---\nbody",
        )
        .unwrap();
        let names = discover_workspace_skill_names(dir.path());
        assert_eq!(names, vec!["tot-filing".to_string()]);
        let a = agent(boots_caps(), &[]);
        assert!(AgentToolSurface::for_agent(&a, &names)
            .skills
            .contains(&"tot-filing".to_string()));
    }

    #[test]
    fn saved_web_login_integration_maps_to_domain() {
        assert_eq!(
            integration_reach("web_my.hospitable.com_someone@example.com"),
            IntegrationReach::WebLogin {
                domain: "my.hospitable.com".into()
            }
        );
    }
}
