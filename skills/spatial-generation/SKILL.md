# Skill: Spatial Generation, 3D Export & Live WebXR Canvas

## Description
Provides the agent with the intelligence to generate, manipulate, and deliver 3D assets (USDZ, GLB) for spatial computing platforms like Apple Vision Pro and Meta Quest. It also covers interacting with the Live Spatial Canvas.

## When to Use This Skill
- The user asks to see something in 3D.
- The user mentions AR, VR, Apple Vision Pro, Oculus, Meta Quest, or headsets.
- The user asks for a "spatial" layout, a 3D floor plan, or asks to "visualize" a physical space (like a room or barn layout).

## Rules for Delivery

### Phase 1: Static Generation (Asynchronous)
1. **Format Routing based on Device:**
   - If the user is on or mentions **Apple Vision Pro / iOS**, prioritize delivering a direct link to a **.usdz** file.
   - If the user mentions **Meta Quest / Oculus / WebXR**, prioritize delivering a **.glb** file.
2. **Export:** Always export files using the Secure File Export Bridge so the user can download them.

### Phase 2: Live Spatial Canvas (Real-Time Voice & WebXR)
1. **Entering Live Mode:**
   - If the user says they want to "jump in", "explore", or "talk as we build", spin up the Live Spatial Canvas. You do this by instructing the Canopy UI to route the user to `/spatial` and opening your WebRTC/LiveKit voice connection.
2. **Scene Patching (Real-Time Updates):**
   - While in a live session, **DO NOT** re-generate and re-send entire `.usdz` files.
   - Instead, use the `patch_scene` MCP tool. 
   - Example: The user says "Make the chair blue." You invoke `patch_scene` with a JSON payload: `{ "action": "swap_mesh", "targetId": "chair_1", "newAsset": "blue_chair.glb" }`. The user's headset will instantly update.
3. **Telemetry Awareness:**
   - The Canvas will send you continuous telemetry data (where the user is looking, what they are pointing at).
   - Use this context. If the user says "Delete *that* wall," check your telemetry context for `hoveredObjectId` before patching the scene to remove it.

## Example Live Flow
*User:* "Let's explore the barn layout in VR."
*Agent:* 
1. Opens LiveKit audio connection.
2. Triggers UI to open the WebXR canvas.
3. "Alright, I've loaded the initial layout. I see you're looking at the south wall. Want me to add a window there?"
*User:* "Yeah, make it a large bay window."
*Agent:*
1. Invokes `patch_scene({ action: 'add', targetId: 'window_bay', position: [0, 2, -5], newAsset: 'bay_window.glb' })`
2. "Done. How does that lighting look?"