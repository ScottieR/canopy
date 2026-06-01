const fs = require('fs');
const file = 'src/store/worldStore.ts';
let content = fs.readFileSync(file, 'utf8');

const newInterfaces = `
export interface SecurityAlert {
    id: string;
    agent_id: string;
    timestamp: string;
    severity: string;
    description: string;
    resolved: boolean;
}

export interface SystemWarning {
    id: string;
    agent_id: string;
    timestamp: string;
    warning_type: string;
    message: string;
    resolved: boolean;
}
`;

if (!content.includes('SystemWarning')) {
    content = content.replace('export interface InboxItem {', newInterfaces + '\nexport interface InboxItem {');
}

const newState = `
  securityAlerts: SecurityAlert[];
  systemWarnings: SystemWarning[];
  setSecurityAlerts: (alerts: SecurityAlert[]) => void;
  setSystemWarnings: (warnings: SystemWarning[]) => void;
  resolveSystemWarningState: (id: string) => void;
  resolveSecurityAlertState: (id: string) => void;
`;

if (!content.includes('securityAlerts: SecurityAlert[]')) {
    content = content.replace('pendingDecisions: PendingDecision[];', newState + '\n  pendingDecisions: PendingDecision[];');
}

const newImpl = `
  securityAlerts: [],
  systemWarnings: [],
  setSecurityAlerts: (alerts) => set({ securityAlerts: alerts }),
  setSystemWarnings: (warnings) => set({ systemWarnings: warnings }),
  resolveSystemWarningState: (id) => set((state) => ({ systemWarnings: state.systemWarnings.filter(w => w.id !== id) })),
  resolveSecurityAlertState: (id) => set((state) => ({ securityAlerts: state.securityAlerts.filter(a => a.id !== id) })),
`;

if (!content.includes('setSecurityAlerts: (alerts)')) {
    content = content.replace('pendingDecisions: [],', newImpl + '\n  pendingDecisions: [],');
}

fs.writeFileSync(file, content);
console.log("worldStore.ts patched");
