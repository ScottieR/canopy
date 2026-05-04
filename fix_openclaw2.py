import re

with open('src-tauri/src/openclaw.rs', 'r') as f:
    content = f.read()

# Update sync_agent_skills
sync_old = """                            if skill_name == "calendar" || skill_name == "cal" {
                                skill_name = "googleCalendar".to_string();"""

sync_new = """                            if skill_name == "calendar" || skill_name == "cal" || skill_name == "calendar_read" || skill_name == "calendar_write" {
                                skill_name = "googleCalendar".to_string();"""

if "skill_name == \"calendar_read\"" not in content:
    content = content.replace(sync_old, sync_new)

with open('src-tauri/src/openclaw.rs', 'w') as f:
    f.write(content)

print("openclaw.rs patched")
