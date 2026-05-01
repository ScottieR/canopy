# Browser Test: Onboarding Wizard

## Objective
Verify that a new user can successfully navigate the entire Canopy application Onboarding flow, from the welcome screen to final agent deployment.

## Prerequisites
- The application should be running in development mode (`npm run dev`).
- The test starts on the default onboarding route (or whenever `activeView` is `onboarding`).

## Steps

1. **Verify Welcome Screen (Step 0)**
   - Look for the text "Meet your new team".
   - Assert the 3D Canvas is visible.
   - Click the **"Create New Agent"** button to proceed.

2. **Verify User Profile Setup (Step 0.5)**
   - Look for the text "Who are you?".
   - Type "Test User" into the Name input field.
   - Type "I work from 9-5 PM PST" into the Context/Working Hours text area.
   - Click the **"Continue"** button.

3. **Verify Role Selection (Step 1)**
   - Look for the text "Select an Agent Role".
   - Verify that there is a grid of selectable roles (e.g., Assistant, Accountant, Coder).
   - Click on the **"Assistant"** role card.
   - Click the **"Next"** button.

4. **Verify Agent Customization (Step 2)**
   - Look for the text "Agent Customization".
   - Type "TestAssistant" into the "Name your agent" input field.
   - Verify that the personality prompt area is pre-filled based on the Assistant role.
   - Click the **"Next"** button.

5. **Verify Intelligence Engine Setup (Step 3)**
   - Look for the text "Intelligence Engine".
   - Verify that an LLM Provider is automatically selected (e.g., Google Gemini or OpenAI).
   - Click "Enter key manually" if presented.
   - Type `test_api_key_123` into the API Key input field.
   - Click the **"Next"** button.

6. **Verify Capabilities & Plugins (Step 4)**
   - Look for the text "Capabilities & Capabilities".
   - Toggle on the "Scheduled Tasks" or "Local Directory" permission.
   - Click the **"Next"** button.

7. **Verify Final Deployment (Step 6)**
   - Look for the final confirmation button (e.g., "Deploy Agent" or "Create Agent").
   - Click the **"Create Agent"** button.
   - Wait for the transition to the main Canopy View.

## Expected Outcome
- The user is successfully navigated to the 3D `canopy` view.
- "TestAssistant" appears in the active agents list.
