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
import { AgentData, useWorldStore, AGENT_TYPE_INFO } from "../store/worldStore";
import { Toggle, Tooltip, ServiceRow } from "../App";

"""

pages = ['ArchiveView', 'UserProfileView', 'DiagnosticsView', 'CanopyView']

for page in pages:
    if page in data:
        text = data[page]['text'].strip()
        if not text.startswith('export'):
            content = common_imports + "export " + text
        else:
            content = common_imports + text
            
        with open(f'src/pages/{page}.tsx', 'w') as f:
            f.write(content)

# TopNav
topnav_imports = common_imports.replace('"../store/worldStore"', '"../../store/worldStore"').replace('"../App"', '"../../App"')
if 'TopNav' in data:
    text = data['TopNav']['text'].strip()
    if not text.startswith('export'):
        content = topnav_imports + "export " + text
    else:
        content = topnav_imports + text
        
    with open('src/components/shared/TopNav.tsx', 'w') as f:
        f.write(content)

print("Created pages and TopNav.")
