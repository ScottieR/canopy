# Spatial MCP Architecture

## Overview
This document outlines the architecture for integrating Spatial Computing (3D Scene Generation) capabilities into Canopy agents. By leveraging the Model Context Protocol (MCP), agents will be able to generate, manipulate, and export 3D scenes in standard spatial formats (USDZ and glTF/GLB) for native consumption on Apple Vision Pro and Meta Quest headsets.

## Formats
- **USDZ:** Apple's preferred format for ARKit and VisionOS. Best for Apple Vision Pro delivery.
- **glTF / GLB:** WebXR and Meta's preferred format. Best for cross-platform rendering and Oculus headsets.

## MCP Tiers & Approaches

To support a wide range of tasks, from simple object generation to complex architectural layouts, the Spatial MCP will support three modes of operation:

### 1. Generative 3D APIs (Fastest & Simplest)
- **Use Case:** "Generate a mid-century modern chair in 3D."
- **Integration:** MCP connects to external generative APIs (e.g., Luma AI, Spline, Meshy).
- **Agent Workflow:** Agent sends a semantic prompt to the MCP tool, which returns a hosted `.usdz` and `.glb` URL.
- **Best For:** Single objects, organic shapes, rapid prototyping.

### 2. Headless 3D Engines (Precise & Procedural)
- **Use Case:** "Generate a 10x10ft barn layout with specific wall placements."
- **Integration:** MCP wraps the Blender Python API or SketchUp API running headlessly.
- **Agent Workflow:** Agent generates and executes Python scripts via the MCP to construct precise geometry, apply materials, and export to standard spatial formats.
- **Best For:** Architecture, precise layouts, multi-object scenes.

### 3. Programmatic WebXR Canvas (Interactive)
- **Use Case:** "Create an interactive 3D data visualization."
- **Integration:** MCP allows the agent to write React Three Fiber (R3F) or Three.js code directly into a Canopy canvas capable of WebXR rendering.
- **Agent Workflow:** Agent writes and updates R3F components, which are rendered on the frontend.
- **Best For:** Interactive components, data visualization, web-native experiences.

## Triggering & Agent Routing
- Agents will NOT require a manual toggle to use this capability. It will be ambient and auto-available.
- **Tool Descriptions:** The Spatial MCP tools will be heavily optimized with descriptive tags (e.g., "Use this for 3D, AR, VR, Apple Vision Pro, Oculus, spatial layout").
- **Skills System:** A dedicated `spatial-generation` skill will instruct agents on how to format outputs based on the user's platform (e.g., directly linking USDZ files for VisionOS users).

## Security & Sandbox Constraints
- Generated scripts (for headless Blender/SketchUp) run inside an isolated sandbox.
- Generated assets are temporarily written to the agent's `/workspace` and delivered to the user via the Secure File Export Bridge before being purged.

### Phase 2: Interactive Spatial Canvas (Live Update & Voice)
**Overview:** Move beyond static `.usdz` / `.glb` generation into real-time shared state. This enables users wearing an Apple Vision Pro or Meta Quest to speak to the agent and see the 3D scene update dynamically around them.

**1. The Environment: WebXR Canopy Canvas**
- Build a React Three Fiber (`@react-three/fiber`) environment supporting WebXR (`@react-three/xr`).
- Users navigate to the Canopy web URL on their headset and enter the immersive AR/VR session.

**2. Low-Latency Voice (The Walkie-Talkie)**
- Integrate a WebRTC/LiveKit audio stream.
- Provide a continuous voice session, bypassing the standard typing interaction loop for a conversational interface.

**3. Spatial Awareness (Telemetry)**
- Send continuous lightweight telemetry (user coordinates, gaze vector, hovered object) from the headset back to the agent via WebSocket.
- Agent gets contextual awareness (e.g., "Change *that* wall to blue").

**4. Real-Time Scene Patching (MCP Update Tool)**
- Create an MCP `patch_scene` tool.
- Instead of regenerating the entire scene, the agent sends tiny JSON payloads (e.g., `{ action: "swap_mesh", target: "chair_1", file: "new_chair.glb" }`).
- The WebXR canvas instantly patches the scene state.
