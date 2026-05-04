import re

with open('src/pages/OnboardingWizard.tsx', 'r') as f:
    content = f.read()

# Replace the state definitions in the draft logic
# Wait, my script added:
# const [selectedRobe, setSelectedRobe] = useState<string | null>(draft?.selectedRobe || null);
# const [visualAccessories, setVisualAccessories] = useState<string[]>(draft?.visualAccessories || []);
# Let's remove those lines, and add customIdentity instead.

content = content.replace('const [selectedRobe, setSelectedRobe] = useState<string | null>(draft?.selectedRobe || null);', '')
content = content.replace('const [visualAccessories, setVisualAccessories] = useState<string[]>(draft?.visualAccessories || []);', '')

# Replace customIdentity definition
content = content.replace(
    'const [customIdentity, setCustomIdentity] = useState<{ baseModelUrl: string | null; accessories: string[]; dynamicColors?: any } | null>(null);',
    'const [customIdentity, setCustomIdentity] = useState<{ baseModelUrl: string | null; accessories: string[]; dynamicColors?: any } | null>(draft?.customIdentity || null);'
)

# Update useEffect dependencies and localStorage setter
content = content.replace(
    'step, agentName, selectedRole, plugins, selectedRobe, visualAccessories',
    'step, agentName, selectedRole, plugins, customIdentity'
)

with open('src/pages/OnboardingWizard.tsx', 'w') as f:
    f.write(content)

print("Fixed draft TS errors.")
