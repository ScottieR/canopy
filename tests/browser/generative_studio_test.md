# Browser Test: Generative Studio (Accessory Manager)

## Objective
Verify the functionality of the Generative Studio for creating and managing 3D accessories for agents.

## Prerequisites
- The application should be running in development mode (`npm run dev`).
- The test starts from the Architect View of a specific agent (e.g., clicking an agent from Canopy view), and navigating to the Identity tab where the Accessory Manager is typically linked, or accessing it directly if it has a global route.

## Steps

1. **Navigate to Generative Studio**
   - Click the **"Identity"** tab in the Architect View sidebar.
   - Look for an "Accessory Manager" or "Generative Studio" button/link.
   - Click the button to open the Generative Studio overlay/view.

2. **Verify Studio Layout**
   - Assert the presence of a prompt input field (e.g., "Describe a new accessory...").
   - Assert the presence of the 3D preview canvas.
   - Verify the list of existing/generated accessories.

3. **Verify Generation Flow**
   - Type a prompt into the input field (e.g., "A wizard hat with purple stars").
   - Click the **"Generate"** button.
   - Verify that a loading state or generation progress indicator appears.
   - Wait for the generation to complete and verify that the new item appears in the list or the 3D preview updates.

4. **Verify Accessory Attachment**
   - Select an accessory from the list of generated items.
   - Verify that the 3D preview shows the agent wearing the accessory.
   - Adjust the positional sliders (X, Y, Z offsets) or scale if available.
   - Click **"Save to Loadout"** or **"Apply Accessory"**.

5. **Verify Persistence**
   - Close the Generative Studio.
   - Verify that the agent in the Architect View Identity tab now shows the newly applied accessory in its visual loadout.

## Expected Outcome
- The Generative Studio UI renders correctly.
- Prompt inputs trigger the generation flow without errors.
- Generated accessories can be previewed, positioned, and saved to an agent's loadout successfully.
