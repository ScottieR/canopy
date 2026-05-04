import json
import sqlite3
import os

db_path = os.path.expanduser('~/Library/Application Support/Canopy/canopy.db')
conn = sqlite3.connect(db_path)
c = conn.cursor()

c.execute("SELECT id, name, role, personality_json FROM agents")
agents = c.fetchall()

workspace_dir = os.path.expanduser('~/Library/Application Support/Canopy/openclaw-state/workspace')

for agent_id, name, role, personality_json in agents:
    personaName = name if name else "Agent"
    
    if not role or role == "Custom":
        identity_template = f"You are {personaName}. Your primary objective is to execute instructions cleanly and effectively. Maintain a helpful and analytical tone."
    else:
        identity_template = f"You are {personaName}, an expert acting in the capacity of a {role}. As a specialized agent, you must execute your duties meticulously, draw upon your deep domain knowledge, and provide structured, high-signal outputs. Avoid conversational fluff."
    
    # Update SQLite DB
    personality = json.loads(personality_json)
    personality['identity_template'] = identity_template
    
    c.execute("UPDATE agents SET personality_json = ? WHERE id = ?", (json.dumps(personality), agent_id))
    
    # Update filesystem
    agent_dir = os.path.join(workspace_dir, agent_id)
    if not os.path.exists(agent_dir):
        continue
        
    # Write IDENTITY.md
    with open(os.path.join(agent_dir, 'IDENTITY.md'), 'w') as f:
        f.write(identity_template)

conn.commit()
conn.close()

print("Agent identities reverted to Onboarding Wizard defaults")
