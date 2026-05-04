import glob
import re

files = glob.glob('src/pages/**/*.tsx', recursive=True)

for file in files:
    with open(file, 'r') as f:
        content = f.read()

    # Fix GenerativeResult
    content = content.replace(', GenerativeResult', '')
    if '../../App' in content:
        content = content.replace('import { Toggle', 'import { GenerativeResult } from "../../components/GenerativeStudio";\nimport { Toggle')
    elif '../App' in content:
        content = content.replace('import { Toggle', 'import { GenerativeResult } from "../components/GenerativeStudio";\nimport { Toggle')

    # Fix missing things in OverviewTab
    if file.endswith('OverviewTab.tsx'):
        content = content.replace('import { Toggle', 'import { Canvas } from "@react-three/fiber";\nimport { OrbitControls } from "@react-three/drei";\nimport { Edit2 } from "lucide-react";\nimport { LobsterIcon } from "../../App";\nimport { GLBAgent, SafeBillboard } from "../../App";\nimport { Toggle')

    with open(file, 'w') as f:
        f.write(content)

# Fix LobsterIcon, GLBAgent, SafeBillboard in App.tsx
with open('src/App.tsx', 'r') as f:
    app_text = f.read()
app_text = app_text.replace('const LobsterIcon =', 'export const LobsterIcon =')
app_text = app_text.replace('function GLBAgent', 'export function GLBAgent')
app_text = app_text.replace('function SafeBillboard', 'export function SafeBillboard')
with open('src/App.tsx', 'w') as f:
    f.write(app_text)

print("Fixed final imports.")
