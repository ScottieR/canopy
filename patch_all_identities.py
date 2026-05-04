import json
import sqlite3
import os

with open('templates/lobster-templates.json', 'r') as f:
    templates = json.load(f)

with open('shared/agents.json', 'r') as f:
    agents_info = json.load(f)

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
db_agents = c.fetchall()

workspace_dir = os.path.expanduser('~/Library/Application Support/Canopy/openclaw-state/workspace')

for agent_id, name, role, personality_json in db_agents:
    if agent_id == "agent-atlas":
        continue # Skip Atlas as it was manually fixed
        
    personaName = name if name else "Agent"
    tmpl_id = role_map.get(role, 'custom')
    
    info = agents_info.get(role, {})
    description = info.get('description', f"A custom {role} agent.")
    
    # Find template to extract the bottom fields (Pronouns, Escalation rule, etc)
    tmpl = next((t for t in templates['templates'] if t['id'] == tmpl_id), None)
    
    final_identity = f"# Identity\n\n**Name:** {personaName}\n**Role:** {role}\n**Description:** {description}\n"
    
    if tmpl and 'identity_template' in tmpl:
        # Extract lines after "**Role:**"
        lines = tmpl['identity_template'].split('\n')
        for line in lines:
            if line.startswith('**Pronouns:**') or line.startswith('**Working hours:**') or line.startswith('**Escalation rule:**') or line.startswith('**Output forms:**'):
                final_identity += line + "\n"
    
    # Update SQLite DB
    personality = json.loads(personality_json)
    personality['identity_template'] = final_identity
    
    c.execute("UPDATE agents SET personality_json = ? WHERE id = ?", (json.dumps(personality), agent_id))
    
    # Update filesystem
    agent_dir = os.path.join(workspace_dir, agent_id)
    if not os.path.exists(agent_dir):
        continue
        
    # Write IDENTITY.md
    with open(os.path.join(agent_dir, 'IDENTITY.md'), 'w') as f:
        f.write(final_identity)

conn.commit()
conn.close()

print("Agent identities fixed using agents.json descriptions")
