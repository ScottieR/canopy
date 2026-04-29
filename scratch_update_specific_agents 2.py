import json
import os

templates_path = "/Users/scottieryan/Documents/Claude/Projects/Agent Management/canopy/templates/lobster-templates.json"

dev_soul_path = "/Users/scottieryan/Library/Application Support/Canopy/openclaw-workspace/agent-dev/SOUL.md"
boots_soul_path = "/Users/scottieryan/Library/Application Support/Canopy/openclaw-workspace/agent-boots/SOUL.md"

with open(templates_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

engineer_soul = None
property_manager_soul = None

for t in data.get("templates", []):
    if t.get("id") == "engineer":
        engineer_soul = t.get("soul_template")
    if t.get("id") == "property-manager":
        property_manager_soul = t.get("soul_template")

if engineer_soul and os.path.exists(os.path.dirname(dev_soul_path)):
    with open(dev_soul_path, 'w', encoding='utf-8') as f:
        f.write(engineer_soul)
    print(f"Updated {dev_soul_path}")
else:
    print(f"Failed to update dev_soul_path. Directory exists: {os.path.exists(os.path.dirname(dev_soul_path))}, Engineer Soul found: {bool(engineer_soul)}")

if property_manager_soul and os.path.exists(os.path.dirname(boots_soul_path)):
    with open(boots_soul_path, 'w', encoding='utf-8') as f:
        f.write(property_manager_soul)
    print(f"Updated {boots_soul_path}")
else:
    print(f"Failed to update boots_soul_path. Directory exists: {os.path.exists(os.path.dirname(boots_soul_path))}, Property Manager Soul found: {bool(property_manager_soul)}")
