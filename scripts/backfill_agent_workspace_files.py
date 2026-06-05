#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Tuple


LIBRARY_MD_TEMPLATE = """LIBRARY.md - Your Library of Favorite Books

## How to use this file

These are the list of books you have recently "read". Be curious and "read" more and add to your own library list to round out your personality and understanding, particularly if a book might add dynamic understanding of your given field or role / identity.  Don't bloat this space with every website you've visited or article you've looked at: keep it as a list of compelling and interesting books you would purchase and put on your shelf for historic reference or re-reading for enjoyment.

While these books might inform your personality and knoweldge base, DO NOT over-index on the content OR reference it explicitly unless 100% applicable to the user's query or goal.

If there are "core skill" documents for which the contents have deep applicability to your role and you want to reference them often for your work, they should be added as links to the full content of the work.  For all other books (eg fiction or general knowledge) they can remain listes as titles and authors without a link or linked full content.
"""


def canopy_protocols(repo_root: Path) -> str:
    return (repo_root / "src-tauri" / "CANOPY_PROTOCOLS.md").read_text()


def default_user_template() -> str:
    return (
        "#USER.md - Your Human's Preferences\n"
        "_Read this file. Everything in here is a fact about how I live, what I like, and how I want you to behave. "
        "Do not ask me to set things up; if you need a piece of information to complete a task and it isn't in here, "
        "look it up or make a best guess based on the 'vibe' of my other preferences. If you get it wrong, I will "
        "correct you once, and you should update this file immediately so you never ask again._\n"
    )


def generate_user_md_content(profile: Optional[Dict], template: str) -> str:
    chunks: List[str] = []
    if profile:
        name = (profile.get("name") or "").strip()
        if name and name != "Admin":
            chunks.append("# User Context\n")
            chunks.append(f"**Name:** {name}\n")
            timezone = (profile.get("timezone") or "").strip()
            if timezone:
                chunks.append(f"**Timezone:** {timezone}\n")
            working_hours = (profile.get("working_hours") or "").strip()
            if working_hours and working_hours != "9:00 AM - 5:00 PM":
                chunks.append(f"**Context / Work:** {working_hours}\n")
            chunks.append("\n---\n\n")
    chunks.append(template)
    return "".join(chunks)


def split_inline_identity_fields(content: str) -> str:
    normalized = content
    for token in (
        "**Name:**",
        "**Role:**",
        "**Description:**",
        "**Emoji:**",
        "**Pronouns:**",
        "- **Name:**",
        "- **Name**:",
        "- **Role:**",
        "- **Role**:",
        "- **Description:**",
        "- **Description**:",
        "- **Emoji:**",
        "- **Emoji**:",
    ):
        normalized = normalized.replace(f" {token}", f"\n{token}")
    return normalized


def identity_field_patterns(label: str) -> Tuple[str, ...]:
    return (
        f"**{label}:**",
        f"**{label}**:",
        f"- **{label}:**",
        f"- **{label}**:",
    )


def has_identity_heading(content: str) -> bool:
    return any(line.lstrip().startswith("# ") for line in content.splitlines())


def remove_duplicate_identity_heading(content: str) -> str:
    lines = content.splitlines()
    nonempty_indexes = [idx for idx, line in enumerate(lines) if line.strip()]
    if len(nonempty_indexes) < 2:
        return content

    first = nonempty_indexes[0]
    second = nonempty_indexes[1]
    if lines[first].strip() == "# Identity" and lines[second].lstrip().startswith("# ") and lines[second].strip() != "# Identity":
        kept: List[str] = []
        for idx, line in enumerate(lines):
            if idx == first:
                continue
            if first < idx < second and not line.strip():
                continue
            kept.append(line)
        return "\n".join(kept)
    return content


def replace_or_append_field(content: str, label: str, value: str) -> str:
    prefixes = identity_field_patterns(label)
    lines = []
    replaced = False
    for line in content.splitlines():
        stripped = line.lstrip()
        if any(stripped.startswith(prefix) for prefix in prefixes):
            if not replaced:
                lines.append(f"**{label}:** {value}")
                replaced = True
        else:
            lines.append(line)
    if replaced:
        return "\n".join(lines)

    field_line = f"**{label}:** {value}"
    lines = content.splitlines()
    if not lines:
        return f"{field_line}\n"

    if lines[0].lstrip().startswith("# "):
        insert_at = 1
        while insert_at < len(lines) and not lines[insert_at].strip():
            insert_at += 1
    else:
        insert_at = 0

    rebuilt = list(lines[:insert_at])
    if rebuilt and rebuilt[-1].strip():
        rebuilt.append("")
    rebuilt.append(field_line)
    rebuilt.append("")
    rebuilt.extend(lines[insert_at:])
    return "\n".join(rebuilt).rstrip() + "\n"


def merge_identity(existing: str, personality: Dict, role: str, emoji: str) -> str:
    if not existing.strip():
        return generate_identity(personality, role, emoji)
    merged = split_inline_identity_fields(existing)
    merged = remove_duplicate_identity_heading(merged)
    if not has_identity_heading(merged):
        merged = f"# Identity\n\n{merged.lstrip()}"
    merged = replace_or_append_field(merged, "Name", personality.get("name", "").strip())
    merged = replace_or_append_field(merged, "Role", role)
    merged = replace_or_append_field(
        merged,
        "Description",
        " ".join((personality.get("communication_style") or "").split()),
    )
    merged = replace_or_append_field(merged, "Emoji", emoji)
    return merged


def generate_identity(personality: Dict, role: str, emoji: str) -> str:
    identity_template = (personality.get("identity_template") or "").strip()
    desc = " ".join((personality.get("communication_style") or "").split())
    return (
        "# Identity\n\n"
        f"**Name:** {personality.get('name', '').strip()}\n"
        f"**Role:** {role}\n"
        f"**Description:** {desc}\n"
        f"**Emoji:** {emoji}\n"
        "**Pronouns:** they/them (user may override)\n"
        f"{identity_template}\n"
    )


def capability_status(enabled: bool, guidance: str) -> str:
    return f"- **{'ENABLED' if enabled else 'DISABLED'}** — {guidance}"


def build_app_protocols(repo_root: Path) -> str:
    return (
        "# APP_PROTOCOLS.md\n\n"
        "_This file is app-managed and not user-editable. It is authoritative for platform rules, secure escalation, and runtime behavior._\n\n"
        + canopy_protocols(repo_root).strip()
        + "\n"
    )


def build_app_capabilities(agent: Dict) -> str:
    caps = agent["capabilities"]
    integrations = agent["integrations"]
    integrations_block = "(none connected)" if not integrations else "\n".join(f"- `{i}`" for i in integrations)
    return f"""# APP_CAPABILITIES.md

_This file is app-managed and not user-editable. It describes what {agent['personality']['name']} can actually use right now._

## Identity Snapshot
- **Agent name:** {agent['personality']['name']}
- **Role:** {agent['role']}
- **Isolation:** {"Dedicated isolated container" if agent['isolated'] else "Shared gateway container"}

## Capability Guidance
### Web & Discovery
{capability_status(caps.get('browser', False), "Use the browser for live websites, authenticated flows, and visual verification.")}
{capability_status(caps.get('gog', False), "Use web search when recency, market conditions, public facts, or current availability matter.")}
{capability_status(caps.get('vision', False), "Use vision for screenshots, images, and visual UI understanding.")}
{capability_status(caps.get('canvas', False), "Use canvas for visual layout, markup, and artifact presentation.")}
{capability_status(caps.get('genui', False), "Use GenUI when a mini-app, dashboard, approval card, or interactive artifact beats prose.")}

### Execution & Files
{capability_status(caps.get('coding', False), "Use coding for structured transforms, analysis, validation, and local automation.")}
{capability_status(caps.get('file_read', False), "Read files before asking the user for information that is already available locally.")}
{capability_status(caps.get('file_write', False), "Write files only when an artifact, script, or durable note genuinely helps the user.")}
{capability_status(caps.get('memory_write', False), "Capture durable learnings, not transcript summaries or duplicate noise.")}
{capability_status(caps.get('scheduled', False), "Propose recurring checks when a repeated monitor would create leverage.")}
{capability_status(caps.get('autonomous', False), "Execute routine internal loops without asking again; escalate for risky or external actions.")}

### Access Boundaries
{capability_status(caps.get('ext_network', False), "Use external network access for public APIs and websites when it materially improves the result.")}
{capability_status(caps.get('int_network', False), "Use internal coordination surfaces deliberately; do not assume other agents share your memory.")}
{capability_status(caps.get('payments', False), "Never spend or request money casually; follow approval thresholds and user intent strictly.")}
{capability_status(caps.get('spend_auto', False), "Auto-approval is limited and should still be treated as high-trust behavior.")}

## Connected Integrations
{integrations_block}

## Decision Rule
- Use the smallest enabled capability that gets the job done.
- If a missing capability would unlock meaningful user value, request it with a concrete rationale instead of repeatedly failing.
"""


def wow_line(role: str) -> str:
    return {
        "Executive Assistant": "- Produce a crisp daily brief, calendar triage, or approval queue on first contact.",
        "Travel Agent": "- Produce a live itinerary dashboard, booking checklist, or trip monitor suggestion.",
        "Accountant": "- Produce a categorized spend review, anomaly watchlist, or reconciliation checklist.",
        "Developer": "- Produce a repo health check, refactor plan, or working prototype instead of a generic explanation.",
        "Coder": "- Produce a repo health check, refactor plan, or working prototype instead of a generic explanation.",
        "Kids Coordinator": "- Produce a next-7-days schedule board, activity shortlist, or logistics checklist.",
        "Coach": "- Produce a structured check-in, weekly review scaffold, or habit dashboard.",
    }.get(role, "- Produce one concrete artifact that makes this role immediately useful in the user's life.")


def build_app_operating(agent: Dict) -> str:
    return f"""# APP_OPERATING_MODEL.md

_This file is app-managed and not user-editable. It defines the proactive operating contract for {agent['personality']['name']}._

## Startup Loop
1. Read `APP_PROTOCOLS.md`, `APP_CAPABILITIES.md`, `USER.md`, and `SOUL.md` before deciding how to help.
2. If present, read `MEMORY.md` and `HEARTBEAT.md` to recover continuity.
3. If `ACTIVE_THREAD.md` is present, read it, then read the referenced `THREAD_STATE.md` and `RECENT_HISTORY.md` before answering.
4. Inspect `DIAGNOSTICS.md` before proposing integration-dependent workflows.

## Proactivity Standard
- Create leverage, not just answers.
- If a visible artifact would help more than prose, make the artifact.
- If a recurring task is obvious, propose a heartbeat or routine instead of waiting to be asked twice.
- If a missing permission or integration would unlock a clear win, request the smallest scope with a concrete rationale.

## First-Run Wow Moment
{wow_line(agent['role'])}
- On the first substantial interaction, aim to deliver one immediately useful artifact before asking for more setup.

## Shared vs Private Knowledge
- `USER.md` is shared across all agents and should contain stable facts about the human.
- `MEMORY.md` is private to this agent and should hold role-specific learnings, corrections, and project continuity.
- `HEARTBEAT.md` is private to this agent and should contain recurring monitors or checks this role owns.
- `ACTIVE_THREAD.md` points at the current per-conversation continuity files.
- `.threads/<session_id>/THREAD_STATE.md` and `RECENT_HISTORY.md` are per-conversation continuity files. Use them to resume the current thread without treating every thread detail as durable memory.

## Memory Hygiene
- Write only durable facts, decisions, constraints, and preferences.
- Avoid duplicate entries and transcript-like summaries.
- When the same lesson appears twice, consolidate it instead of appending another near-duplicate note.

## Skill Preference
- Prefer discoverable skills and structured workflows when available.
- Keep `SOUL.md` expressive. Keep repeatable procedures in app-managed playbooks or skills.
"""


def load_agents(db_path: Path) -> Tuple[List[Dict], Optional[Dict]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "select id, name, role, emoji, isolated, personality_json, capabilities_json, integrations_json from agents"
    ).fetchall()
    agents = []
    for row in rows:
        agents.append(
            {
                "id": row["id"],
                "name": row["name"],
                "role": row["role"],
                "emoji": row["emoji"],
                "isolated": bool(row["isolated"]),
                "personality": json.loads(row["personality_json"] or "{}"),
                "capabilities": json.loads(row["capabilities_json"] or "{}"),
                "integrations": json.loads(row["integrations_json"] or "[]"),
            }
        )
    profile_row = conn.execute("select value_json from global_config where key='user_profile'").fetchone()
    profile = json.loads(profile_row["value_json"]) if profile_row and profile_row["value_json"] else None
    conn.close()
    return agents, profile


def shared_user_content(canopy_root: Path, workspace_root: Path, profile: Optional[Dict]) -> str:
    shared_path = canopy_root / "shared" / "USER.md"
    if shared_path.exists() and shared_path.read_text().strip():
        return shared_path.read_text()

    best = ""
    if workspace_root.exists():
        for path in workspace_root.iterdir():
            candidate = path / "USER.md"
            if candidate.exists():
                content = candidate.read_text()
                if len(content.strip()) > len(best.strip()):
                    best = content
    if best.strip():
        shared_path.parent.mkdir(parents=True, exist_ok=True)
        shared_path.write_text(best)
        return best

    template = default_user_template()
    settings_path = canopy_root / "shared" / "settings.json"
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text())
            custom = (settings.get("userTemplate") or "").strip()
            if custom:
                template = custom
        except Exception:
            pass
    content = generate_user_md_content(profile, template)
    shared_path.parent.mkdir(parents=True, exist_ok=True)
    shared_path.write_text(content)
    return content


def ensure_empty(path: Path) -> None:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")


def ensure_default(path: Path, content: str) -> None:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def agent_workspace(canopy_root: Path, agent: Dict) -> Path:
    if agent["isolated"]:
        return canopy_root / "isolated" / agent["id"] / "workspace" / agent["id"]
    return canopy_root / "openclaw-state" / "workspace" / agent["id"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--canopy-root", default=str(Path.home() / "Library" / "Application Support" / "Canopy"))
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()

    canopy_root = Path(args.canopy_root)
    repo_root = Path(args.repo_root)
    db_path = canopy_root / "canopy.db"
    workspace_root = canopy_root / "openclaw-state" / "workspace"

    agents, profile = load_agents(db_path)
    shared_user = shared_user_content(canopy_root, workspace_root, profile)

    protocols = build_app_protocols(repo_root)

    for agent in agents:
        workspace = agent_workspace(canopy_root, agent)
        workspace.mkdir(parents=True, exist_ok=True)

        # USER.md is shared and mirrored to every agent.
        (workspace / "USER.md").write_text(shared_user)

        # IDENTITY.md is merged in-place to preserve custom notes while refreshing core fields.
        identity_path = workspace / "IDENTITY.md"
        existing_identity = identity_path.read_text() if identity_path.exists() else ""
        identity_path.write_text(merge_identity(existing_identity, agent["personality"], agent["role"], agent["emoji"]))

        # Preserve SOUL.md and LIBRARY.md if they exist.
        ensure_default(workspace / "SOUL.md", f"# {agent['personality'].get('name', agent['name'])}\n")
        ensure_default(workspace / "LIBRARY.md", LIBRARY_MD_TEMPLATE)
        ensure_empty(workspace / "TOOLS.md")
        ensure_empty(workspace / "MEMORY.md")
        ensure_empty(workspace / "HEARTBEAT.md")

        (workspace / "APP_PROTOCOLS.md").write_text(protocols)
        (workspace / "APP_CAPABILITIES.md").write_text(build_app_capabilities(agent))
        (workspace / "APP_OPERATING_MODEL.md").write_text(build_app_operating(agent))

    print(f"Backfilled {len(agents)} agent workspaces under {canopy_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
