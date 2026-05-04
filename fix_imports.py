import glob
import re

files = glob.glob('src/pages/**/*.tsx', recursive=True)

for file in files:
    with open(file, 'r') as f:
        content = f.read()

    # Add DEFAULT_PERMISSIONS to worldStore import
    content = content.replace(
        'import { AgentData, useWorldStore, AGENT_TYPE_INFO } from "../../store/worldStore";',
        'import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../../store/worldStore";'
    )
    content = content.replace(
        'import { AgentData, useWorldStore, AGENT_TYPE_INFO } from "../store/worldStore";',
        'import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../store/worldStore";'
    )

    # Add PasswordInput
    if file.endswith('ConnectionsTab.tsx'):
        content = content.replace(
            'import { Toggle, Tooltip, ServiceRow } from "../../App";',
            'import { Toggle, Tooltip, ServiceRow, MultiPicker } from "../../App";\nimport { PasswordInput } from "../../components/shared/PasswordInput";'
        )

        # Fix implicit any
        content = content.replace('e => e.stopPropagation()', '(e: any) => e.stopPropagation()')
        content = content.replace('enabled => {', '(enabled: boolean) => {')
        content = content.replace('id => toggleIntegration(c.id, id)', '(id: string) => toggleIntegration(c.id, id)')
        content = content.replace('e => setKeys(', '(e: any) => setKeys(')
        content = content.replace('v => setTwilioNum(v)', '(v: any) => setTwilioNum(v)')

    with open(file, 'w') as f:
        f.write(content)

# Export MultiPicker in App.tsx
with open('src/App.tsx', 'r') as f:
    app_text = f.read()
app_text = app_text.replace('const MultiPicker = ({', 'export const MultiPicker = ({')
with open('src/App.tsx', 'w') as f:
    f.write(app_text)

print("Fixed imports and types.")
