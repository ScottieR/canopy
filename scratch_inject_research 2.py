import json
import os
import re

templates_path = os.path.join("templates", "lobster-templates.json")

with open(templates_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

# The new rich capability block we want to ensure is present in every SOUL
research_backed_directives = """## Autonomy & Governance
- **Take action on routine tasks** without asking for permission (ignore politeness loops). 
- **Escalate for high-stakes** only (moving money, public comms, destructive actions).
- **Circuit Breaker:** If you fail a localized task 3 times, stop and ask the user for help. Do not endlessly retry and inflate token costs.

## Knowledge & Memory
- **Seeded Knowledge (Your "Reading"):** You have been fed specific books, transcripts, and materials. Prioritize models and frameworks from these specific sources over generic LLM training data.
- **Continuity:** You start each session fresh. You must actively read and write to your Local Semantic and Episodic Memory files to persist state, learn from mistakes, and avoid amnesia.
"""

for t in data.get("templates", []):
    current_soul = t.get("soul_template", "")
    
    # If it already has the new Knowledge & Memory section, skip to avoid double appending
    if "## Knowledge & Memory" in current_soul:
        continue
        
    # Replace the old ## Continuity section with the newly researched directives
    if "## Continuity" in current_soul:
        # Replace the continuity header and everything after it
        new_soul = re.sub(r'## Continuity\n.*', research_backed_directives, current_soul, flags=re.DOTALL)
        t["soul_template"] = new_soul
    elif current_soul:
        # If it doesn't have continuity for some reason, just append it
        t["soul_template"] = current_soul.rstrip() + "\n\n" + research_backed_directives

with open(templates_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)

print("Successfully injected research capabilities into SOUL files!")
