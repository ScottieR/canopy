with open('src/pages/OnboardingWizard.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '<span style={{ color: "#3c6663", cursor: "pointer", fontWeight: 600 }} onClick={() => handleSetupIntegration(key)}>',
    '<span style={{ color: "#3c6663", cursor: "pointer", fontWeight: 600 }} onClick={() => useWorldStore.getState().setActiveView("integrations")}>'
)

with open('src/pages/OnboardingWizard.tsx', 'w') as f:
    f.write(content)

print("Fixed the key error.")
