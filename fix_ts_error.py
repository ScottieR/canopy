with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'r') as f:
    content = f.read()

content = content.replace("setGlobalConnections(prev => ({ ...prev, slack: true }));", "setSlackConnected(true);")

with open('src/pages/ArchitectView/ConnectionsTab.tsx', 'w') as f:
    f.write(content)

print("Fixed TS errors")
