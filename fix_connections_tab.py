with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'r') as f:
    content = f.read()

# Fix checkDynamicStatuses key check
old_check = """      const key = c.id.toUpperCase() + "_TOKEN";
      try {
        const tok = await invoke("get_secret_cmd", { key });"""

new_check = """      let key = c.id.toUpperCase() + "_TOKEN";
      if (c.id === 'calendar') key = 'GCAL_ACCESS_TOKEN';
      if (c.id === 'drive') key = 'GDRIVE_ACCESS_TOKEN';
      try {
        const tok = await invoke("get_secret_cmd", { key });"""

content = content.replace(old_check, new_check)

# Add checkDynamicStatuses call after start_google_oauth
old_oauth = """                         if (res && res.access_token) {
                            await invoke('store_secret_cmd', { key: c.id === 'calendar' ? 'GCAL_ACCESS_TOKEN' : 'GDRIVE_ACCESS_TOKEN', value: res.access_token });
                         }"""

new_oauth = """                         if (res && res.access_token) {
                            await invoke('store_secret_cmd', { key: c.id === 'calendar' ? 'GCAL_ACCESS_TOKEN' : 'GDRIVE_ACCESS_TOKEN', value: res.access_token });
                            checkDynamicStatuses();
                         }"""

content = content.replace(old_oauth, new_oauth)

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'w') as f:
    f.write(content)

print("Fixed ConnectionsTab Google OAuth handling")
