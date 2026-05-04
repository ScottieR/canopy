import glob
import re

with open('src/App.tsx', 'r') as f:
    app_text = f.read()

app_text = app_text.replace('export export function Toggle', 'export function Toggle')
app_text = app_text.replace('const ServiceRow = ({', 'export const ServiceRow = ({')
app_text = app_text.replace('interface GenerativeResult {', 'export interface GenerativeResult {')
app_text = app_text.replace('export export interface GenerativeResult', 'export interface GenerativeResult')

with open('src/App.tsx', 'w') as f:
    f.write(app_text)

files = glob.glob('src/pages/**/*.tsx', recursive=True) + glob.glob('src/components/shared/*.tsx', recursive=True)

for file in files:
    with open(file, 'r') as f:
        content = f.read()

    # Remove Tooltip
    content = content.replace(' Tooltip,', '')
    content = content.replace(', Tooltip', '')
    
    # Fix IdentityTab missing imports
    if file.endswith('IdentityTab.tsx'):
        content = content.replace(
            'import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../../store/worldStore";',
            'import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../../store/worldStore";\nimport { Canvas } from "@react-three/fiber";\nimport { OrbitControls } from "@react-three/drei";'
        )
        content = content.replace(
            'import { Toggle, ServiceRow, glass, GenerativeResult } from "../../App";',
            'import { Toggle, ServiceRow, glass, GenerativeResult, ACCESSORIES, PASTEL_COLORS, TerrariumBase, GLBAgent, SafeBillboard } from "../../App";'
        )
    
    with open(file, 'w') as f:
        f.write(content)

print("Fixed exports and IdentityTab imports.")
