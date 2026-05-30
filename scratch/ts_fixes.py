import os

with open("src/App.tsx", "r") as f:
    app_ts = f.read()
app_ts = app_ts.replace('c.type === "project"', 'c.type === "forum"')
with open("src/App.tsx", "w") as f:
    f.write(app_ts)

with open("src/pages/ArchitectView/ChatTab.tsx", "r") as f:
    chat_ts = f.read()
chat_ts = chat_ts.replace('activeConv?.type === "project"', 'activeConv?.type === "forum"')
with open("src/pages/ArchitectView/ChatTab.tsx", "w") as f:
    f.write(chat_ts)

with open("src/pages/ArchitectView/ThreadsRail.tsx", "r") as f:
    threads_ts = f.read()

# Replace "project" with "forum" for the 'type' field
threads_ts = threads_ts.replace('type: "project"', 'type: "forum"')
threads_ts = threads_ts.replace('conv.type === "project"', 'conv.type === "forum"')

# Add createdAt
threads_ts = threads_ts.replace('lastActiveAt: lastActiveAt,', 'createdAt: (f as any).createdAt || Date.now(),\n          lastActiveAt: lastActiveAt,')

with open("src/pages/ArchitectView/ThreadsRail.tsx", "w") as f:
    f.write(threads_ts)

