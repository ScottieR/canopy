import re

# 1. App.tsx exports
with open('src/App.tsx', 'r') as f:
    app = f.read()

app = app.replace('export export const LobsterIcon', 'export const LobsterIcon')
app = app.replace('const ACCESSORIES =', 'export const ACCESSORIES =')
app = app.replace('const PASTEL_COLORS =', 'export const PASTEL_COLORS =')
app = app.replace('function TerrariumBase', 'export function TerrariumBase')
app = app.replace('const HABITATS =', 'export const HABITATS =')
app = app.replace('function CanopyScene', 'export function CanopyScene')
app = app.replace('export export function GLBAgent', 'export function GLBAgent')
app = app.replace('export export function SafeBillboard', 'export function SafeBillboard')

with open('src/App.tsx', 'w') as f:
    f.write(app)

# 2. TopNav.tsx
with open('src/components/shared/TopNav.tsx', 'r') as f:
    nav = f.read()
nav = nav.replace('import { Toggle, ServiceRow, glass, GenerativeResult } from "../../App";', 'import { Toggle, ServiceRow, glass } from "../../App";\nimport { GenerativeResult } from "../GenerativeStudio";')
with open('src/components/shared/TopNav.tsx', 'w') as f:
    f.write(nav)

# 3. IdentityTab.tsx
with open('src/pages/ArchitectView/IdentityTab.tsx', 'r') as f:
    id_tab = f.read()
id_tab = id_tab.replace('import { Toggle', 'import { Canvas } from "@react-three/fiber";\nimport { OrbitControls } from "@react-three/drei";\nimport { Toggle')
id_tab = id_tab.replace('import { Toggle, ServiceRow, glass } from "../../App";', 'import { Toggle, ServiceRow, glass, ACCESSORIES, PASTEL_COLORS, TerrariumBase, GLBAgent, SafeBillboard, HABITATS } from "../../App";')
id_tab = id_tab.replace('accessories.map((path,', 'accessories.map((path: any,')
id_tab = id_tab.replace('PASTEL_COLORS.map(c =>', 'PASTEL_COLORS.map((c: any) =>')
id_tab = id_tab.replace('HABITATS.map(h =>', 'HABITATS.map((h: any) =>')
with open('src/pages/ArchitectView/IdentityTab.tsx', 'w') as f:
    f.write(id_tab)

# 4. ArchitectView/index.tsx
with open('src/pages/ArchitectView/index.tsx', 'r') as f:
    arch = f.read()
if 'LobsterIcon' not in arch:
    arch = arch.replace('import { ArchiveView }', 'import { LobsterIcon } from "../../App";\nimport { ArchiveView }')
with open('src/pages/ArchitectView/index.tsx', 'w') as f:
    f.write(arch)

# 5. CanopyView.tsx
with open('src/pages/CanopyView.tsx', 'r') as f:
    canopy = f.read()
if 'CanopyScene' not in canopy:
    canopy = canopy.replace('import { Toggle', 'import { CanopyScene, LobsterIcon } from "../App";\nimport { Toggle')
with open('src/pages/CanopyView.tsx', 'w') as f:
    f.write(canopy)

# 6. UserProfileView.tsx
with open('src/pages/UserProfileView.tsx', 'r') as f:
    usr = f.read()
usr = usr.replace('import { AgentData, useWorldStore', 'import { AgentData, useWorldStore, UserProfile')
with open('src/pages/UserProfileView.tsx', 'w') as f:
    f.write(usr)

print("Fixed the last TS errors.")
