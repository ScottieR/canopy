import json
import sqlite3
import os

with open('templates/lobster-templates.json', 'r') as f:
    templates = json.load(f)

# Map role to template id
role_map = {
    'Executive Assistant': 'assistant',
    'Coder': 'engineer',
    'STR Manager': 'property-manager',
    'Travel Agent': 'custom'
}

db_path = os.path.expanduser('~/Library/Application Support/Canopy/canopy.db')
conn = sqlite3.connect(db_path)
c = conn.cursor()

c.execute("SELECT id, role, personality_json FROM agents")
agents = c.fetchall()

workspace_dir = os.path.expanduser('~/Library/Application Support/Canopy/openclaw-state/workspace')

for agent_id, role, personality_json in agents:
    tmpl_id = role_map.get(role, 'custom')
    
    # Find template
    tmpl = next((t for t in templates['templates'] if t['id'] == tmpl_id), None)
    if not tmpl:
        continue
        
    identity_template = tmpl.get('identity_template', f"# Identity\\n\\n**Role:** {role}\\n**Pronouns:** they/them (user may override)\\n")
    
    # Update SQLite DB: identity_template = identity_template, custom_instructions = ""
    personality = json.loads(personality_json)
    custom_instructions = personality.get('custom_instructions', '').strip()
    
    personality['identity_template'] = identity_template
    personality['custom_instructions'] = ''
    
    c.execute("UPDATE agents SET personality_json = ? WHERE id = ?", (json.dumps(personality), agent_id))
    
    # Update filesystem
    agent_dir = os.path.join(workspace_dir, agent_id)
    if not os.path.exists(agent_dir):
        continue
        
    # Write IDENTITY.md
    with open(os.path.join(agent_dir, 'IDENTITY.md'), 'w') as f:
        f.write(identity_template)
        
    # Migrate PREFERENCES.md to USER.md
    prefs_path = os.path.join(agent_dir, 'PREFERENCES.md')
    user_path = os.path.join(agent_dir, 'USER.md')
    
    if os.path.exists(prefs_path):
        with open(prefs_path, 'r') as f:
            prefs_content = f.read().strip()
            
        if prefs_content:
            user_content = ""
            if os.path.exists(user_path):
                with open(user_path, 'r') as f:
                    user_content = f.read()
                    
            if prefs_content not in user_content:
                with open(user_path, 'a') as f:
                    f.write(f"\n\n# PREFERENCES\n{prefs_content}\n")
        
        os.remove(prefs_path)

conn.commit()
conn.close()

print("Agent identities updated and PREFERENCES collapsed into USER.md")
