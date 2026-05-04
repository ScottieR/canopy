with open('src/components/Companion/SlackCompanion.tsx', 'r') as f:
    content = f.read()

# Fix SlackCompanion to store tokens globally if no agentId
old_store = """        await invoke("store_batch_secrets_cmd", { 
          secrets: {
            [`agent_${agentId}_slack_app_token`]: slackAppToken,
            [`agent_${agentId}_slack_bot_token`]: slackBotToken
          }
        });"""

new_store = """        await invoke("store_batch_secrets_cmd", { 
          secrets: agentId ? {
            [`agent_${agentId}_slack_app_token`]: slackAppToken,
            [`agent_${agentId}_slack_bot_token`]: slackBotToken
          } : {
            "slack-app-token": slackAppToken,
            "slack-bot-token": slackBotToken
          }
        });"""

content = content.replace(old_store, new_store)

with open('src/components/Companion/SlackCompanion.tsx', 'w') as f:
    f.write(content)

with open('src/pages/OnboardingWizard.tsx', 'r') as f:
    wizard = f.read()

# Fix companion-finished listener to update UI
old_listener = """          if (type === "slack") {
            // Slack completion from the companion guide means the bot token is saved.
            // We do NOT try to collect the pairing code here — pairing requires the agent
            // to already be registered in OpenClaw and the listener to be running, which
            // can't happen until after create_agent completes. The user will finish pairing
            // from the Connections tab after the agent is created.
          } else if (key) {"""

new_listener = """          if (type === "slack") {
            setWsSlackConnected(true);
            setPlugins(prev => ({ ...prev, slack: true }));
          } else if (key) {"""

wizard = wizard.replace(old_listener, new_listener)

with open('src/pages/OnboardingWizard.tsx', 'w') as f:
    f.write(wizard)

print("Fixed state updates.")
