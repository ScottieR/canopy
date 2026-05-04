import glob

files = glob.glob('src/pages/**/*.tsx', recursive=True) + glob.glob('src/components/**/*.tsx', recursive=True)

for file in files:
    with open(file, 'r') as f:
        content = f.read()

    # Revert accidental replacements
    content = content.replace('(enabled: boolean);', '(enabled);')
    content = content.replace('setSlackEnabled(enabled: boolean)', 'setSlackEnabled(enabled)')
    content = content.replace('setIMsgEnabled(enabled: boolean)', 'setIMsgEnabled(enabled)')
    content = content.replace('setDynamicEnabled(prev => ({ ...prev, [c.id]: enabled: boolean }))', 'setDynamicEnabled(prev => ({ ...prev, [c.id]: enabled }))')
    
    # Just to be sure, any remaining enabled: boolean without arrow
    import re
    content = re.sub(r'\(enabled: boolean\)(?! *=>)', r'(enabled)', content)
    
    with open(file, 'w') as f:
        f.write(content)

print("Fixed syntax errors.")
