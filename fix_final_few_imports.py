import re

# Fix App.tsx exports
with open('src/App.tsx', 'r') as f:
    app_text = f.read()
app_text = app_text.replace('function ProgressBar', 'export function ProgressBar')
with open('src/App.tsx', 'w') as f:
    f.write(app_text)

# OverviewTab.tsx
with open('src/pages/ArchitectView/OverviewTab.tsx', 'r') as f:
    content = f.read()
content = content.replace('import { Toggle, ServiceRow', 'import { ProgressBar } from "../../App";\nimport { ChatTab } from "./ChatTab";\nimport { Toggle, ServiceRow')
content = content.replace('from "lucide-react";', ', AlertTriangle, ChevronUp, ChevronDown } from "lucide-react";')
with open('src/pages/ArchitectView/OverviewTab.tsx', 'w') as f:
    f.write(content)

# PersonalityTab.tsx
with open('src/pages/ArchitectView/PersonalityTab.tsx', 'r') as f:
    content = f.read()
content = content.replace('import { Toggle', 'import { MemoryTab } from "./MemoryTab";\nimport { Toggle')
with open('src/pages/ArchitectView/PersonalityTab.tsx', 'w') as f:
    f.write(content)

# CanopyView.tsx
with open('src/pages/CanopyView.tsx', 'r') as f:
    content = f.read()
content = content.replace('import { Toggle', 'import { Canvas } from "@react-three/fiber";\nimport { OrthographicCamera } from "@react-three/drei";\nimport * as THREE from "three";\nimport { Toggle')
content = content.replace('({ gl }) =>', '({ gl }: any) =>')
with open('src/pages/CanopyView.tsx', 'w') as f:
    f.write(content)

print("Fixed final few imports.")
