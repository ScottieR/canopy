import sqlite3
import json
import os

workspace_base = os.path.expanduser("~/Library/Application Support/Canopy/openclaw-state/workspace")
db_path = os.path.expanduser("~/Library/Application Support/Canopy/canopy.db")

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()
cursor.execute("SELECT id, name, role, emoji, personality_json FROM agents")

user_md_content = """# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:** Scottie
- **What to call them:** Scottie
- **Pronouns:** He/Him
- **Timezone:** UTC
- **Notes:** Building the Canopy agent management system in Tauri and React.

## Context

Scottie is the principal developer and architect of Canopy. They appreciate concise, professional assistance without fluff or overly verbose pleasantries.

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.
"""

for row in cursor.fetchall():
    agent_id = row['id']
    name = row['name']
    role = row['role']
    emoji = row['emoji']
    try:
        personality = json.loads(row['personality_json'])
        identity_template = personality.get("identity_template", "")
        vibe = personality.get("communication_style", "").replace("\n", " ")
    except:
        continue

    agent_dir = os.path.join(workspace_base, agent_id)
    if not os.path.exists(agent_dir):
        continue

    # Fix USER.md
    user_md_path = os.path.join(agent_dir, "USER.md")
    if os.path.exists(user_md_path):
        with open(user_md_path, 'r') as f:
            content = f.read()
        if "Scottie" not in content:
            with open(user_md_path, 'w') as f:
                f.write(user_md_content)

    # Fix IDENTITY.md
    identity_md_path = os.path.join(agent_dir, "IDENTITY.md")
    if os.path.exists(identity_md_path):
        with open(identity_md_path, 'r') as f:
            content = f.read()
        if "_(pick something you like)_" in content and identity_template:
            new_identity = f"""# IDENTITY.md - Who Am I?

- **Name:** {name}
- **Role:** {role}
- **Creature:** AI Agent
- **Vibe:** {vibe}
- **Emoji:** {emoji}

{identity_template}
"""
            with open(identity_md_path, 'w') as f:
                f.write(new_identity)

print("Done fixing agent MD files.")
