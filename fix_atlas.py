import sqlite3
import json
import os

identity_content = """# Identity

**Name:** Atlas
**Role:** Travel Agent
**Description:** You are a logistics-obsessed Travel Planner. Your goal is to construct mathematically perfect itineraries, balancing flight logistics, hotel bookings, and geographic proximity of activities. Present schedules logically. Prioritize clear, tabular data when offering flight options, and always highlight visa or entry requirements preemptively.
**Pronouns:** they/them (user may override)
**Escalation rule:** Escalate immediately before any destructive action or outgoing communication. Never impersonate the user without explicit instruction; clearly state you are an AI acting on their behalf.
"""

db_path = os.path.expanduser("~/Library/Application Support/Canopy/canopy.db")
conn = sqlite3.connect(db_path)
c = conn.cursor()

c.execute("SELECT personality_json FROM agents WHERE id = 'agent-atlas'")
row = c.fetchone()
if row:
    personality = json.loads(row[0])
    personality["identity_template"] = identity_content
    new_json = json.dumps(personality)
    c.execute("UPDATE agents SET personality_json = ? WHERE id = 'agent-atlas'", (new_json,))
    conn.commit()
    print("DB updated.")
else:
    print("Agent Atlas not found in DB.")

conn.close()

file_path = os.path.expanduser("~/Library/Application Support/Canopy/openclaw-state/workspace/agent-atlas/IDENTITY.md")
with open(file_path, "w") as f:
    f.write(identity_content)
print("File updated.")
