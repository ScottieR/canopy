import json

with open('extracted_components.json', 'r') as f:
    data = json.load(f)

with open('src/App.tsx', 'r') as f:
    app_text = f.read()

# Sort components by start index descending so we can safely delete from the end backwards
comps = list(data.values())
comps.sort(key=lambda x: x['start'], reverse=True)

new_text = app_text
for comp in comps:
    start = comp['start']
    end = comp['end']
    new_text = new_text[:start] + new_text[end:]

imports_to_add = """
import { ArchitectView } from './pages/ArchitectView';
import { ArchiveView } from './pages/ArchiveView';
import { UserProfileView } from './pages/UserProfileView';
import { DiagnosticsView } from './pages/DiagnosticsView';
import { CanopyView } from './pages/CanopyView';
import { TopNav } from './components/shared/TopNav';
"""

# Insert imports after the last import in App.tsx
import_idx = new_text.rfind('import ')
if import_idx != -1:
    end_of_line = new_text.find('\n', import_idx)
    new_text = new_text[:end_of_line+1] + imports_to_add + new_text[end_of_line+1:]
else:
    new_text = imports_to_add + new_text

with open('src/App.tsx', 'w') as f:
    f.write(new_text)

print("Updated App.tsx")
