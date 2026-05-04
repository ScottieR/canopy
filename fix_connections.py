import re

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'r') as f:
    content = f.read()

# 1. Add calendarMode state
if "const [calendarMode, setCalendarMode]" not in content:
    content = content.replace(
        "const [emailMode, setEmailMode] = useState<\"none\" | \"read\" | \"write\" | \"dedicated\">(\"none\");",
        "const [emailMode, setEmailMode] = useState<\"none\" | \"read\" | \"write\" | \"dedicated\">(\"none\");\n  const [calendarMode, setCalendarMode] = useState<\"none\" | \"read\" | \"write\">(\"none\");"
    )

# 2. Update the effect that initializes emailMode to also initialize calendarMode
init_effect_old = """    if (agent.integrations.includes("email_dedicated")) {
      setEmailMode("dedicated");
    } else if (agent.integrations.includes("email_write")) {
      setEmailMode("write");
    } else if (agent.integrations.includes("email_read")) {
      setEmailMode("read");
    } else {
      setEmailMode("none");
    }"""

init_effect_new = """    if (agent.integrations.includes("email_dedicated")) {
      setEmailMode("dedicated");
    } else if (agent.integrations.includes("email_write")) {
      setEmailMode("write");
    } else if (agent.integrations.includes("email_read")) {
      setEmailMode("read");
    } else {
      setEmailMode("none");
    }
    
    if (agent.integrations.includes("calendar_write")) {
      setCalendarMode("write");
    } else if (agent.integrations.includes("calendar_read")) {
      setCalendarMode("read");
    } else if (agent.integrations.includes("calendar")) {
      setCalendarMode("write"); // legacy fallback
    } else {
      setCalendarMode("none");
    }"""

content = content.replace(init_effect_old, init_effect_new)

# 3. Filter calendar from dynamic connectors
content = content.replace(
    "!['slack', 'gmail', 'imessage', 'filesystem'].includes(c.id)",
    "!['slack', 'gmail', 'imessage', 'filesystem', 'calendar'].includes(c.id)"
)

# 4. Add the Custom Calendar block right after the Email block
email_block_end = """        </div>
      </ServiceRow>"""

calendar_block = """
      {/* Google Calendar */}
      <ServiceRow
        icon={<Calendar size={18} color="#4285F4" />}
        name="Google Calendar"
        subtitle="Allow agent to view and schedule events on your Google Calendar"
        connected={calConnected}
        enabled={calendarMode !== "none"}
        onToggle={async (v) => {
          setCalendarMode(v ? "read" : "none");
          await toggleIntegration("calendar_read", v, ["calendar_write", "calendar"]);
        }}
        onSetup={async () => {
          try {
            const invoke = (window as any).__TAURI_INTERNALS__?.invoke || (async () => {});
            const res: any = await invoke('start_google_oauth', { scopes: ['calendar'], readOnly: calendarMode === "read" });
            if (res && res.access_token) {
              await invoke('store_secret_cmd', { key: 'GCAL_ACCESS_TOKEN', value: res.access_token });
              checkDynamicStatuses();
            }
          } catch (e) { console.error(e); }
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)" }}>Access level</div>
          {(["read", "write"] as const).map(m => (
            <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
              <input type="radio" name={`cal-mode-${agent.id}`} checked={calendarMode === m} onChange={async () => {
                setCalendarMode(m);
                await toggleIntegration(`calendar_${m}`, true, ["calendar_read", "calendar_write", "calendar"].filter(x => x !== `calendar_${m}`));
              }} style={{ accentColor: "#3c6663" }} />
              <span style={{ color: "var(--text-main)", fontWeight: calendarMode === m ? 600 : 400 }}>
                {m === "read" ? "Read-only — monitor schedule and conflicts" : "Read + Write — can create and modify events"}
              </span>
            </label>
          ))}
        </div>
      </ServiceRow>"""

# Find the location of the end of the email block.
# Actually, the email block ends with </ServiceRow>. 
# Let's find the iMessage block and insert before it, or right after Email.
# The email block is followed by {/* iMessage */}.
content = content.replace("      {/* iMessage */}", calendar_block + "\n\n      {/* iMessage */}")

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'w') as f:
    f.write(content)

print("ConnectionsTab patched")
