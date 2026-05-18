import sqlite3
import json
import os

db_path = os.path.expanduser("~/Library/Application Support/Canopy/canopy.db")
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()
cursor.execute("SELECT id, role, capabilities_json FROM agents")

for row in cursor.fetchall():
    agent_id = row['id']
    role = row['role']
    caps = json.loads(row['capabilities_json'])
    
    # Defaults we want to ensure
    missing = False
    
    # If they do web stuff, they usually need proxy to bypass bots
    if caps.get('browser'):
        if not caps.get('proxy'):
            caps['proxy'] = True
            missing = True
            
    # Role specific additions
    if role in ["Interior Designer", "Fashion Stylist", "Kids Coordinator", "Artist", "Media Advisor"]:
        if not caps.get('vision'): caps['vision'] = True; missing = True
        if not caps.get('canvas'): caps['canvas'] = True; missing = True
        if not caps.get('browser'): caps['browser'] = True; missing = True
        if not caps.get('proxy'): caps['proxy'] = True; missing = True
        
    if role in ["Accountant", "Engineer", "Developer", "Architect", "Business Strategist", "Strategist", "Researcher"]:
        if not caps.get('coding'): caps['coding'] = True; missing = True
        if not caps.get('browser'): caps['browser'] = True; missing = True
        if not caps.get('proxy'): caps['proxy'] = True; missing = True
        if not caps.get('summarize'): caps['summarize'] = True; missing = True
        
    if role in ["STR Manager", "Travel Agent"]:
        if not caps.get('browser'): caps['browser'] = True; missing = True
        if not caps.get('proxy'): caps['proxy'] = True; missing = True
        
    if missing:
        cursor.execute("UPDATE agents SET capabilities_json = ? WHERE id = ?", (json.dumps(caps), agent_id))
        print(f"Updated {agent_id} ({role}) capabilities.")
        
conn.commit()
conn.close()
print("Done fixing permissions.")
