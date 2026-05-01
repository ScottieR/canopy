# Browser Test: Architect View

## Objective
Verify that the Architect View properly renders the agent's configuration tabs and allows users to modify the agent's settings.

## Prerequisites
- The application should be running in development mode (`npm run dev`).
- The test starts by selecting an active agent from the Canopy View, transitioning the view to Architect mode.

## Steps

1. **Verify Architect Sidebar**
   - Assert the sidebar is visible on the left side.
   - Verify the presence of the following tab links: "Overview", "Chat", "Activity", "Identity", "Personality", "Memory", "Spend", "Connections", and "Permissions".

2. **Verify Overview Tab**
   - Click the **"Overview"** tab in the sidebar.
   - Verify the agent's status, token usage, uptime, and energy level are displayed.

3. **Verify Identity Tab**
   - Click the **"Identity"** tab.
   - Verify the "Agent Naming & Role" and "Visual Identity" sections are present.
   - Change the agent's name in the input field.
   - Click the **"Save Profile"** button and verify success.

4. **Verify Personality Tab**
   - Click the **"Personality"** tab.
   - Check if the Markdown editor containing the agent's system prompt (SOUL) is loaded.
   - Add a small text modification to the prompt.
   - Click **"Save Instructions"** (if present) and verify success.

5. **Verify Permissions Tab**
   - Click the **"Permissions"** tab.
   - Toggle one of the permissions (e.g., "Web Browser" or "File System Read") off and then back on.
   - Verify the state of the toggle updates accordingly.

6. **Verify Memory & Spend Tabs**
   - Click the **"Memory"** tab.
   - Verify the list of core memories or the interface to add a memory exists.
   - Click the **"Spend"** tab.
   - Verify the virtual card and recent transaction history are displayed.

7. **Verify Chat & Activity Tabs**
   - Click the **"Chat"** tab.
   - Type a test message into the chat input.
   - Press Enter or click the send button and verify the message appears in the chat log.
   - Click the **"Activity"** tab.
   - Verify that the agent's recent logs or task history are displayed.

## Expected Outcome
- All tabs load successfully without crashing.
- Forms allow data entry and correctly reflect state changes.
- The UI properly handles modifications (e.g., toggling permissions or sending chat messages).
