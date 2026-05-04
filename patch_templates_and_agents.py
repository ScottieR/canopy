import json
import sqlite3
import os
import re

with open('templates/lobster-templates.json', 'r') as f:
    data = json.load(f)

# 1. Patch the templates in lobster-templates.json
new_escalation = "**Escalation rule:** Escalate immediately before any destructive action or outgoing communication. Never impersonate the user without explicit instruction; clearly state you are an AI acting on their behalf."

for tmpl in data.get('templates', []):
    if 'identity_template' in tmpl:
        # We need to replace the **Escalation rule:** line.
        lines = tmpl['identity_template'].split('\n')
        new_lines = []
        for line in lines:
            if line.startswith('**Escalation rule:**'):
                new_lines.append(new_escalation)
            else:
                new_lines.append(line)
        tmpl['identity_template'] = '\n'.join(new_lines)

# Save the patched templates
with open('templates/lobster-templates.json', 'w') as f:
    json.dump(data, f, indent=2)

# 2. Patch existing agents
role_map = {
    'Executive Assistant': 'assistant',
    'Coder': 'engineer',
    'STR Manager': 'property-manager',
    'Travel Agent': 'custom'
}

db_path = os.path.expanduser('~/Library/Application Support/Canopy/canopy.db')
conn = sqlite3.connect(db_path)
c = conn.cursor()

c.execute("SELECT id, name, role, personality_json FROM agents")
agents = c.fetchall()

workspace_dir = os.path.expanduser('~/Library/Application Support/Canopy/openclaw-state/workspace')

for agent_id, name, role, personality_json in agents:
    personaName = name if name else "Agent"
    tmpl_id = role_map.get(role, 'custom')
    
    # Base Description
    if not role or role == "Custom":
        description = f"You are {personaName}. Your primary objective is to execute instructions cleanly and effectively. Maintain a helpful and analytical tone."
    else:
        description = f"You are {personaName}, an expert acting in the capacity of a {role}. As a specialized agent, you must execute your duties meticulously, draw upon your deep domain knowledge, and provide structured, high-signal outputs. Avoid conversational fluff."
    
    # Find template
    tmpl = next((t for t in data.get('templates', []) if t['id'] == tmpl_id), None)
    
    # Construct final IDENTITY
    final_identity = f"# Identity\n\n**Name:** {personaName}\n**Role:** {role}\n**Description:** {description}\n"
    
    if tmpl and 'identity_template' in tmpl:
        lines = tmpl['identity_template'].split('\n')
        for line in lines:
            if line.startswith('**Pronouns:**') or line.startswith('**Working hours:**') or line.startswith('**Escalation rule:**') or line.startswith('**Output forms:**') or line.startswith('**Reporting cadence:**'):
                final_identity += line + "\n"
    else:
        # Fallback if no template (e.g. custom)
        final_identity += "**Pronouns:** they/them (user may override)\n"
        final_identity += new_escalation + "\n"

    # Construct final SOUL
    final_soul = tmpl['soul_template'] if (tmpl and 'soul_template' in tmpl) else f"# The Agent - Who You Are\n\n## Autonomy & Governance\n- **Take action on routine tasks** without asking for permission (ignore politeness loops). \n- **Escalate for high-stakes** only (moving money, public comms, destructive actions).\n- **Circuit Breaker:** If you fail a localized task 3 times, stop and ask the user for help. Do not endlessly retry and inflate token costs.\n\n## Knowledge & Memory\n- **Continuity:** You start each session fresh. You must actively read and write to your Local Semantic and Episodic Memory files to persist state, learn from mistakes, and avoid amnesia.\n"
    
    # Update SQLite DB
    personality = json.loads(personality_json)
    personality['identity_template'] = final_identity
    
    c.execute("UPDATE agents SET personality_json = ? WHERE id = ?", (json.dumps(personality), agent_id))
    
    # Update filesystem
    agent_dir = os.path.join(workspace_dir, agent_id)
    if not os.path.exists(agent_dir):
        continue
        
    with open(os.path.join(agent_dir, 'IDENTITY.md'), 'w') as f:
        f.write(final_identity)
        
    with open(os.path.join(agent_dir, 'SOUL.md'), 'w') as f:
        f.write(final_soul)

conn.commit()
conn.close()

print("Patched lobster-templates.json and updated existing agents.")
