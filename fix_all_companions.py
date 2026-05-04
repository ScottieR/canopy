import re

def update_companion(filename, open_url_logic, extra_imports=""):
    with open(f"src/components/Companion/{filename}", 'r') as f:
        content = f.read()

    # Ensure open is imported
    if "from '@tauri-apps/plugin-shell'" not in content and 'from "@tauri-apps/plugin-shell"' not in content:
        content = content.replace('import { invoke } from "@tauri-apps/api/core";', 'import { invoke } from "@tauri-apps/api/core";\nimport { open } from "@tauri-apps/plugin-shell";\n' + extra_imports)

    # Insert the open logic into the existing useEffect
    # Wait, all of them have this:
    #   useEffect(() => {
    #     setTimeout(() => setIsVisible(true), 300);
    #   }, []);
    # So we can replace `setTimeout(() => setIsVisible(true), 300);` with the new logic.

    new_logic = f"setTimeout(() => setIsVisible(true), 300);\n    setTimeout(() => {{\n      {open_url_logic}\n    }}, 500);"

    content = content.replace("setTimeout(() => setIsVisible(true), 300);", new_logic)

    with open(f"src/components/Companion/{filename}", 'w') as f:
        f.write(content)

slack_manifest_logic = """
      const manifest = {
        display_information: { name: agentName || "Agent", description: "Canopy Agent", background_color: "#3c6663" },
        features: {
          app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
          bot_user: { display_name: agentName || "Agent", always_online: true }
        },
        oauth_config: {
          scopes: { bot: ["chat:write", "channels:history", "channels:read", "groups:history", "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "users:read", "app_mentions:read", "reactions:read", "commands"] },
          pkce_enabled: false
        },
        settings: {
          event_subscriptions: { bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "reaction_added", "reaction_removed"] },
          interactivity: { is_enabled: true },
          org_deploy_enabled: false,
          socket_mode_enabled: true,
          token_rotation_enabled: false,
          is_mcp_enabled: false
        }
      };
      const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
      open(url).catch(console.error);
"""

update_companion('SlackCompanion.tsx', slack_manifest_logic)
update_companion('DiscordCompanion.tsx', 'open("https://discord.com/developers/applications").catch(console.error);')
update_companion('TelegramCompanion.tsx', 'open("https://t.me/botfather").catch(console.error);')
update_companion('GithubCompanion.tsx', 'open("https://github.com/settings/tokens/new").catch(console.error);')

print("Fixed companions.")
