file = 'src/pages/ArchitectView/ConnectionsTab.tsx'
with open(file, 'r') as f:
    content = f.read()

content = content.replace('enabled => {', '(enabled: boolean) => {')
content = content.replace('enabled => set', '(enabled: boolean) => set')
content = content.replace('enabled => toggle', '(enabled: boolean) => toggle')

# Add missing lucide-react icons
import re
icons_to_add = ['Link', 'Github', 'MessageCircle', 'Cloud']
for icon in icons_to_add:
    if icon not in content.split('from "lucide-react"')[0]:
        content = content.replace('from "lucide-react";', f', {icon} }} from "lucide-react";')

with open(file, 'w') as f:
    f.write(content)

print("Fixed icons and enabled params.")
