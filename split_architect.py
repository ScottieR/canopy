import json

with open('extracted_components.json', 'r') as f:
    data = json.load(f)

common_imports = """import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO } from "../../store/worldStore";
import { Toggle, Tooltip, ServiceRow } from "../../App";

"""

tabs = ['ConnectionsTab', 'TerminalPane', 'OverviewTab', 'IdentityTab', 
  'PersonalityTab', 'PermissionsTab', 'MemoryTab', 'SpendTab', 'ActivityTab', 'ChatTab']

for tab in tabs:
    if tab in data:
        text = data[tab]['text'].strip()
        if not text.startswith('export'):
            content = common_imports + "export " + text
        else:
            content = common_imports + text
            
        with open(f'src/pages/ArchitectView/{tab}.tsx', 'w') as f:
            f.write(content)

# Now write ArchitectView/index.tsx
av_content = common_imports
for tab in tabs:
    av_content += f"import {{ {tab} }} from './{tab}';\n"
av_content += "\n"
text = data['ArchitectView']['text'].strip()
if not text.startswith('export'):
    av_content += "export " + text
else:
    av_content += text

with open('src/pages/ArchitectView/index.tsx', 'w') as f:
    f.write(av_content)

print("Created files.")
