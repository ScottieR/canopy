import re

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'r') as f:
    lines = f.readlines()

def get_block(start_marker, end_marker=None):
    start_idx = -1
    for i, line in enumerate(lines):
        if start_marker in line:
            start_idx = i
            break
    if start_idx == -1:
        print(f"Start marker not found: {start_marker}")
        return []
    
    if end_marker:
        end_idx = -1
        for i in range(start_idx + 1, len(lines)):
            if end_marker in lines[i]:
                end_idx = i
                break
        if end_idx == -1:
            print(f"End marker not found: {end_marker}")
            return []
        return lines[start_idx:end_idx]
    else:
        return lines[start_idx:]

header = lines[:425]

llm = get_block("{/* Advanced Provider Configuration */}", "{/* Info banner */}")
info = get_block("{/* Info banner */}", "{/* Agent's own email */}")
agent_email = get_block("{/* Agent's own email */}", "{/* Slack */}")
slack = get_block("{/* Slack */}", "{/* Gmail */}")
gmail = get_block("{/* Gmail */}", "{/* Google Calendar */}")
gcal = get_block("{/* Google Calendar */}", "{/* iMessage */}")
imessage = get_block("{/* iMessage */}", "{/* Web Accounts removed to avoid duplication */}")
web_acc = get_block("{/* Web Accounts removed to avoid duplication */}", "{/* File System */}")
fs = get_block("{/* File System */}", "{/* ── Suggested Services ── */}")
suggested = get_block("{/* ── Suggested Services ── */}", "{/* ── Plugin Directory ── */}")
plugin_dir = get_block("{/* ── Plugin Directory ── */}", "{/* Web Credentials */}")
web_creds = get_block("{/* Web Credentials */}", "{/* Capabilities & Skills */}")
footer = get_block("{/* Capabilities & Skills */}")

def mk_header(title, desc):
    return [
        f'      <div style={{{{ marginTop: 32, marginBottom: 16, paddingTop: 32, borderTop: "1px solid var(--border-subtle)" }}}}>\n',
        f'        <div style={{{{ fontSize: 18, fontWeight: 700, color: "var(--text-main)" }}}}>{title}</div>\n',
        f'        <div style={{{{ fontSize: 14, color: "var(--text-sub)", marginTop: 4 }}}}>{desc}</div>\n',
        f'      </div>\n'
    ]

new_lines = []
new_lines.extend(header)

# GROUP 1: Communication Channels
new_lines.extend(mk_header("Communication Channels", "Allow your agent to read and send messages across platforms."))
new_lines.extend(info)
new_lines.extend(slack)
new_lines.extend(imessage)
new_lines.extend(gmail)

# GROUP 2: Web Access & Standard OpenClaw Permissions
new_lines.extend(mk_header("Web Access & Data Sources", "Grant access to the web, documents, and standard capabilities."))
new_lines.extend(web_creds)
new_lines.extend(plugin_dir)
new_lines.extend(suggested)
new_lines.extend(gcal)
new_lines.extend(fs)

# GROUP 3: Advanced Agent-Specific Configuration
new_lines.extend(mk_header("Agent-Specific Configuration", "Advanced overrides for dedicated emails and custom API keys."))
new_lines.extend(agent_email)
new_lines.extend(llm)
new_lines.extend(web_acc)

new_lines.extend(footer)

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'w') as f:
    f.writelines(new_lines)

print("Done reordering!")
