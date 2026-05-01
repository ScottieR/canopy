# Browser Test: Canopy World & TopNav

## Objective
Verify the navigation elements in the TopNav and interactions within the 3D Canopy View.

## Prerequisites
- The application should be running in development mode (`npm run dev`).
- The test starts on the main Canopy view (the activeView is `canopy`), ideally after an agent has been created.

## Steps

1. **Verify Top Navigation Bar**
   - Look for the top navigation bar with tabs: **"Canopy"**, **"Agents"**, **"Archive"**, and **"Integrations"**.
   - Verify the search input field with the placeholder "Search agents...".

2. **Verify Search Functionality**
   - Click the search input field.
   - Type the name of an existing agent.
   - Verify that a dropdown appears showing the searched agent.
   - Click on the agent in the dropdown.
   - Verify that the active view changes to the Architect view (or "Agents" tab).

3. **Verify Settings and Profile Navigations**
   - Click the **"Canopy"** tab to return to the 3D world view.
   - Look for the profile icon (top right).
   - Click the profile icon.
   - Verify that the User Profile View is shown.
   - Click the **"Canopy"** tab to return.
   - Look for the diagnostics icon (top right, shaped like a heartbeat/activity).
   - Click the diagnostics icon.
   - Verify that the System Diagnostics view is shown.

4. **Verify 3D World Interactions**
   - Return to the Canopy view.
   - Find the agent roster overlay (usually a list of agents on the left side).
   - Hover over an agent's name in the list.
   - Verify that the agent is highlighted or the cursor changes.
   - Click on an agent in the 3D Canvas or from the roster list.
   - Verify that clicking an agent transitions the view to the Architect view.

## Expected Outcome
- The TopNav accurately switches views between Canopy, Agents, Archive, Integrations, Profile, and Diagnostics.
- Search successfully filters and navigates to specific agents.
- Interacting with the 3D scene correctly selects an agent and opens its configuration.
