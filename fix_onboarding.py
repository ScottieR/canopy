import re

with open('src/pages/OnboardingWizard.tsx', 'r') as f:
    content = f.read()

# 1. Add Draft Loading + extract checkConnections
# Find the start of OnboardingWizard
start_idx = content.find('export function OnboardingWizard() {')

draft_logic = """
  // --- Draft Persistence ---
  const loadDraft = () => {
    try {
      const d = localStorage.getItem('canopy_onboarding_draft');
      return d ? JSON.parse(d) : null;
    } catch { return null; }
  };
  const draft = loadDraft();
"""

state_replacements = [
    ('const [step, setStep] = useState(-1);', 'const [step, setStep] = useState(draft?.step !== undefined ? draft.step : -1);'),
    ('const [selectedRole, setSelectedRole] = useState<string | null>(null);', 'const [selectedRole, setSelectedRole] = useState<string | null>(draft?.selectedRole || null);'),
    ('const [agentName, setAgentName] = useState("");', 'const [agentName, setAgentName] = useState(draft?.agentName || "");'),
    ('const [plugins, setPlugins] = useState<Record<string, boolean>>({ slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false });', 'const [plugins, setPlugins] = useState<Record<string, boolean>>(draft?.plugins || { slack: false, imessage: false, email: false, calendar: false, folders: false, photos: false });'),
    ('const [selectedRobe, setSelectedRobe] = useState<string | null>(null);', 'const [selectedRobe, setSelectedRobe] = useState<string | null>(draft?.selectedRobe || null);'),
    ('const [visualAccessories, setVisualAccessories] = useState<string[]>([]);', 'const [visualAccessories, setVisualAccessories] = useState<string[]>(draft?.visualAccessories || []);')
]

for old, new in state_replacements:
    content = content.replace(old, new)

# Insert draft_logic right after the start
content = content.replace('export function OnboardingWizard() {', 'export function OnboardingWizard() {\n' + draft_logic)

# Insert useEffect to save draft
draft_save_effect = """
  useEffect(() => {
    if (step >= 0) {
      localStorage.setItem('canopy_onboarding_draft', JSON.stringify({
        step, agentName, selectedRole, plugins, selectedRobe, visualAccessories
      }));
    }
  }, [step, agentName, selectedRole, plugins, selectedRobe, visualAccessories]);

"""
content = content.replace('  // Check workspace-level service connections on mount', draft_save_effect + '  // Check workspace-level service connections on mount')

# Refactor checkConnections
old_check_conn = """  // Check workspace-level service connections on mount
  useEffect(() => {
    (async () => {
      try {
        const s = await invoke<{ connected: boolean }>("check_slack_connection");
        setWsSlackConnected(s?.connected ?? false);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: "GMAIL_ACCESS_TOKEN" });
        setWsGmailConnected(!!tok && tok.length > 10);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: "GCAL_ACCESS_TOKEN" });
        setWsCalConnected(!!tok && tok.length > 10);
      } catch {}

      try {
        const profile = await invoke<any>("get_user_profile");
        if (profile) {
            setUserName(profile.name || "");

        }
      } catch {}
    })();
  }, []);"""

new_check_conn = """  const checkConnections = async () => {
      try {
        const s = await invoke<{ connected: boolean }>("check_slack_connection");
        setWsSlackConnected(s?.connected ?? false);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: "GMAIL_ACCESS_TOKEN" });
        setWsGmailConnected(!!tok && tok.length > 10);
      } catch {}
      try {
        const tok = await invoke<string>("get_secret_cmd", { key: "GCAL_ACCESS_TOKEN" });
        setWsCalConnected(!!tok && tok.length > 10);
      } catch {}
      try {
        const profile = await invoke<any>("get_user_profile");
        if (profile) setUserName(profile.name || "");
      } catch {}
  };

  useEffect(() => {
    checkConnections();
    const handleUpdate = () => checkConnections();
    window.addEventListener("slack-updated", handleUpdate);
    window.addEventListener("refresh_integrations", handleUpdate);
    return () => {
      window.removeEventListener("slack-updated", handleUpdate);
      window.removeEventListener("refresh_integrations", handleUpdate);
    };
  }, []);

  const handleSetupIntegration = async (key: string) => {
    if (key === 'slack' || key === 'discord' || key === 'telegram' || key === 'github') {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const nameMap: any = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', github: 'GitHub' };
        new WebviewWindow('companion_' + key + '_' + Date.now(), {
          url: `/index.html?companion=${key}&agentName=${encodeURIComponent(agentName || 'Agent')}`,
          title: `Setup ${nameMap[key]}`,
          width: 420,
          height: 760,
          x: window.screen.availWidth - 440,
          y: 50,
          alwaysOnTop: true,
          decorations: true,
        });
    } else if (key === 'email' || key === 'calendar') {
        try {
          const result = await invoke<{ access_token?: string }>("start_google_oauth", {
            scopes: [key === 'email' ? 'email' : 'calendar'],
            readOnly: false,
          });
          if (result.access_token) {
            await invoke("store_secret_cmd", { key: key === 'email' ? "GMAIL_ACCESS_TOKEN" : "GCAL_ACCESS_TOKEN", value: result.access_token });
            checkConnections();
            setPlugins(prev => ({ ...prev, [key]: true }));
          }
        } catch (e) { console.error("OAuth failed:", e); }
    } else if (key === 'imessage') {
        try {
          await invoke("start_imessage_watcher", { appHandle: null }).catch(() => {});
          const granted = await invoke<boolean>("check_full_disk_access");
          if (!granted) {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
          }
          checkConnections();
        } catch (e) {}
    }
  };
"""
content = content.replace(old_check_conn, new_check_conn)

# 2. Fix the onClick handler
content = content.replace('onClick={() => setActiveView("integrations")}', 'onClick={() => handleSetupIntegration(key)}')

# 3. Clear draft when agent is finalized
finalize_code = """        // Finished!
        setStep(10);"""
new_finalize_code = """        // Finished!
        localStorage.removeItem('canopy_onboarding_draft');
        setStep(10);"""
content = content.replace(finalize_code, new_finalize_code)

# Let's also clear draft if user hits Exit/Close in the wizard explicitly, but keeping it simple for now is okay.

with open('src/pages/OnboardingWizard.tsx', 'w') as f:
    f.write(content)

print("Updated OnboardingWizard.tsx with drafts and inline setup.")
