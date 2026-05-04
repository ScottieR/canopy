import glob
import re

files = glob.glob('src/pages/**/*.tsx', recursive=True) + glob.glob('src/components/shared/*.tsx', recursive=True)

for file in files:
    with open(file, 'r') as f:
        content = f.read()

    # Add glass and GenerativeResult to App imports
    content = content.replace(
        'import { Toggle, Tooltip, ServiceRow, MultiPicker } from "../../App";',
        'import { Toggle, Tooltip, ServiceRow, MultiPicker, glass, GenerativeResult } from "../../App";'
    )
    content = content.replace(
        'import { Toggle, Tooltip, ServiceRow } from "../../App";',
        'import { Toggle, Tooltip, ServiceRow, glass, GenerativeResult } from "../../App";'
    )
    content = content.replace(
        'import { Toggle, Tooltip, ServiceRow } from "../App";',
        'import { Toggle, Tooltip, ServiceRow, glass, GenerativeResult } from "../App";'
    )

    # Add ChatMessage to worldStore
    content = content.replace(
        'import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../../store/worldStore";',
        'import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";'
    )
    
    # Import ChatTab in ActivityTab
    if file.endswith('ActivityTab.tsx'):
        content = content.replace(
            'import { Toggle, Tooltip, ServiceRow, glass, GenerativeResult } from "../../App";',
            'import { Toggle, Tooltip, ServiceRow, glass, GenerativeResult } from "../../App";\nimport { ChatTab } from "./ChatTab";'
        )

    # Fix implicit any with regex
    content = re.sub(r'async \(enabled\) =>', r'async (enabled: boolean) =>', content)
    content = re.sub(r'\b\(enabled\) =>', r'(enabled: boolean) =>', content)
    content = re.sub(r'\b\(v\) =>', r'(v: any) =>', content)
    content = re.sub(r'\b\(part, i\) =>', r'(part: any, i: number) =>', content)
    
    if file.endswith('ConnectionsTab.tsx'):
        content = re.sub(r'\b\(enabled\)', r'(enabled: boolean)', content) # Just to be safe
    
    with open(file, 'w') as f:
        f.write(content)

print("Fixed imports globally.")
