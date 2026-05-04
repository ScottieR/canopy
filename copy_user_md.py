import os
import shutil

workspace_dir = os.path.expanduser('~/Library/Application Support/Canopy/openclaw-state/workspace')
sloane_user_md = os.path.join(workspace_dir, 'sloane', 'USER.md')

if not os.path.exists(sloane_user_md):
    print("Sloane's USER.md not found!")
    exit(1)

copied_to = []
for item in os.listdir(workspace_dir):
    item_path = os.path.join(workspace_dir, item)
    if os.path.isdir(item_path) and item != 'sloane' and item != '.git' and item != '.openclaw' and item != 'state':
        dest_path = os.path.join(item_path, 'USER.md')
        shutil.copy2(sloane_user_md, dest_path)
        copied_to.append(item)

print(f"Copied Sloane's USER.md to: {', '.join(copied_to)}")
