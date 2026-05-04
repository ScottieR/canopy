import re

# 1. App.tsx
with open('src/App.tsx', 'r') as f:
    app = f.read()

app = app.replace('export export function ProgressBar', 'export function ProgressBar')

# Some of these might be const or function, so let's just make sure they are exported.
if 'function GLBAgent' in app and 'export function GLBAgent' not in app:
    app = app.replace('function GLBAgent', 'export function GLBAgent')
if 'const GLBAgent =' in app and 'export const GLBAgent =' not in app:
    app = app.replace('const GLBAgent =', 'export const GLBAgent =')

if 'function SafeBillboard' in app and 'export function SafeBillboard' not in app:
    app = app.replace('function SafeBillboard', 'export function SafeBillboard')
if 'const SafeBillboard =' in app and 'export const SafeBillboard =' not in app:
    app = app.replace('const SafeBillboard =', 'export const SafeBillboard =')

if 'function TerrariumBase' in app and 'export function TerrariumBase' not in app:
    app = app.replace('function TerrariumBase', 'export function TerrariumBase')
if 'const TerrariumBase =' in app and 'export const TerrariumBase =' not in app:
    app = app.replace('const TerrariumBase =', 'export const TerrariumBase =')

if 'function CanopyScene' in app and 'export function CanopyScene' not in app:
    app = app.replace('function CanopyScene', 'export function CanopyScene')
if 'const CanopyScene =' in app and 'export const CanopyScene =' not in app:
    app = app.replace('const CanopyScene =', 'export const CanopyScene =')

with open('src/App.tsx', 'w') as f:
    f.write(app)

# 3. IdentityTab.tsx
with open('src/pages/ArchitectView/IdentityTab.tsx', 'r') as f:
    id_tab = f.read()
if 'HABITATS' not in id_tab.split('} from "../../App"')[0]:
    id_tab = id_tab.replace('} from "../../App";', ', HABITATS } from "../../App";')
with open('src/pages/ArchitectView/IdentityTab.tsx', 'w') as f:
    f.write(id_tab)

# 4. ArchitectView/index.tsx
with open('src/pages/ArchitectView/index.tsx', 'r') as f:
    arch = f.read()
if 'import { LobsterIcon' not in arch:
    arch = arch.replace('import { ArchiveView }', 'import { LobsterIcon } from "../../App";\nimport { ArchiveView }')
with open('src/pages/ArchitectView/index.tsx', 'w') as f:
    f.write(arch)

# 5. CanopyView.tsx
with open('src/pages/CanopyView.tsx', 'r') as f:
    canopy = f.read()
if 'import { CanopyScene' not in canopy:
    canopy = canopy.replace('import { Toggle }', 'import { CanopyScene, LobsterIcon } from "../App";\nimport { Toggle }')
if 'import { OrbitControls' not in canopy:
    canopy = canopy.replace('import { Canvas', 'import { Canvas } from "@react-three/fiber";\nimport { OrbitControls } from "@react-three/drei";\nimport { Canvas') # hacky but works since we already did it wrong before maybe
    canopy = canopy.replace('import { Canvas } from "@react-three/fiber";\nimport { OrbitControls } from "@react-three/drei";\nimport { Canvas } from "@react-three/fiber";', 'import { Canvas } from "@react-three/fiber";\nimport { OrbitControls } from "@react-three/drei";')
with open('src/pages/CanopyView.tsx', 'w') as f:
    f.write(canopy)

print("Applied final fixes.")
