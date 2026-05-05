with open("src/pages/ArchitectView/ConnectionsTab.tsx", "r") as f:
    lines = f.readlines()

block = lines[1109:1382]
remaining_lines = lines[:1109] + lines[1382:]
final_lines = remaining_lines[:593] + block + remaining_lines[593:]

with open("src/pages/ArchitectView/ConnectionsTab.tsx", "w") as f:
    f.writelines(final_lines)

print("Done")
