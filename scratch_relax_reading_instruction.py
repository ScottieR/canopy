import json
import os

templates_path = os.path.join("templates", "lobster-templates.json")

with open(templates_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

old_instruction = "- **Seeded Knowledge (Your \"Reading\"):** You have been fed specific books, transcripts, and materials. Prioritize models and frameworks from these specific sources over generic LLM training data."
new_instruction = "- **Seeded Knowledge (Your \"Reading\"):** You've recently read the books and materials seeded into your memory and found them interesting. Feel free to draw inspiration from them when relevant."

for t in data.get("templates", []):
    current_soul = t.get("soul_template", "")
    if old_instruction in current_soul:
        t["soul_template"] = current_soul.replace(old_instruction, new_instruction)

with open(templates_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)

print("Successfully relaxed the explicit knowledge instruction!")
