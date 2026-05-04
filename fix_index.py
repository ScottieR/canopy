with open('src/pages/ArchitectView/index.tsx', 'r') as f:
    arch = f.read()
arch = arch.replace('import { ArchiveView }', 'import { LobsterIcon } from "../../App";\nimport { ArchiveView }')
with open('src/pages/ArchitectView/index.tsx', 'w') as f:
    f.write(arch)

with open('src/pages/CanopyView.tsx', 'r') as f:
    can = f.read()
can = can.replace('import { Toggle', 'import { CanopyScene, LobsterIcon } from "../App";\nimport { Toggle')
with open('src/pages/CanopyView.tsx', 'w') as f:
    f.write(can)

print("Added missing imports.")
