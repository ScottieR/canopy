import re

with open('src/App.tsx', 'r') as f:
    app = f.read()
app = app.replace('class SafeBillboard', 'export class SafeBillboard')
with open('src/App.tsx', 'w') as f:
    f.write(app)

# IdentityTab.tsx
with open('src/pages/ArchitectView/IdentityTab.tsx', 'r') as f:
    id_tab = f.read()
id_tab = id_tab.replace('TerrariumBase, GLBAgent, ', '')
id_tab = id_tab.replace('import { Toggle', 'import { TerrariumBase } from "../../components/World/WorldScene";\nimport { GLBAgent } from "../../components/World/GLBAgent";\nimport { Toggle')
with open('src/pages/ArchitectView/IdentityTab.tsx', 'w') as f:
    f.write(id_tab)

# OverviewTab.tsx
with open('src/pages/ArchitectView/OverviewTab.tsx', 'r') as f:
    ov_tab = f.read()
ov_tab = ov_tab.replace('import { GLBAgent, SafeBillboard } from "../../App";', 'import { GLBAgent } from "../../components/World/GLBAgent";\nimport { SafeBillboard } from "../../App";')
with open('src/pages/ArchitectView/OverviewTab.tsx', 'w') as f:
    f.write(ov_tab)

print("Fixed imports from App.tsx.")
