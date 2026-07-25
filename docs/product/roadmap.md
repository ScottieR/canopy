# Canopy Agent Roadmap

This document tracks work that has been researched and/or completed by the agent team. All agents should refer to this file to understand the current capabilities, architectural decisions, and upcoming milestones.

## Completed Work
- **Forum Platform Evolution**: Transitioned to a Hybrid Canvas/Dashboard UI for multi-agent forums. (Refer to `forum_experience.patch`).

## Active Research & Architectural Planning

### Security & Authentication Architecture (Universal Zero-Credential Flow)
- **Status**: Implementation Started
- **Owner**: Patch (Mechanic)
- **Description**: Evolving the Canopy Auth flow to completely prevent agents from requesting raw credentials in chat, properly handling external channels (like Slack), and supporting dynamic custom OAuth.
- **Key Decisions**:
  - **Zero Credential Policy**: Added a strict system prompt directive in `CANOPY_PROTOCOLS.md` ordering agents to never request passwords, API keys, or OAuth tokens directly.
  - **Cross-Platform Auth Flow (Slack Interception)**: Updated the `[request_auth: domain.com]` protocol. Instead of relying on local OS modals, when the Canopy Slack bot detects this tag or a JIT bridge request, it will replace the text with a Slack Block Kit interactive button that deep-links the user to a secure Canopy WebVault or native app view (`canopy://auth?domain=...`).
  - **Dynamic OAuth / Custom Connections**: To handle unknown services (like Airbnb) without hardcoding new integrations, we are designing a "Custom API Connection" UI. Agents can direct users to configure a custom OAuth provider in the Integrations panel. The agent will supply the required scopes and token URL, and Canopy will perform the handshake, returning a managed token to a dynamic MCP tool.

### Intelligent Dynamic Model Routing
- **Status**: Research & Planning
- **Owner**: Patch (Developer)
- **Description**: An under-the-hood smart router that dynamically selects the optimal model based on task complexity, cost limits, and latency budgets (e.g., routing simple UI iterations to Gemini Flash/Haiku and heavy architecture refactors to Claude Opus 4.7).
- **Key Decisions**:
  - Hide decision complexity from the end user (moving away from manual model sliders).
  - Adopt **Predictive Complexity Scoring**: Use a lightweight classifier/embedder to evaluate query complexity and route to the most efficient model.
  - Explore **Cascading**: Execute fast/cheap models first, leveraging verification steps or confidence scores, and gracefully fallback to heavier models only when necessary.
- **Associated Documentation**:
  - `TOOLS.md` (Current Fusion Routing baseline)

### Agent Recipe Library ("Stealable" Workflows)
- **Status**: Research & Discovery
- **Owner**: Patch (Developer)
- **Description**: A native UI for users to easily share, discover, and one-click import pre-configured agent templates (playbooks). Includes system prompts, tool permissions, and default routing logic to promote fast workflow adoption.

### Native QA & User-Sim Subagents
- **Status**: Implementation Started (Heartbeat)
- **Owner**: Patch (Mechanic)
- **Description**: Automated subagents that act as users to interact with, analyze, and stress-test Canopy product flows.
- **Key Decisions**:
  - Set up a continuous QA loop via heartbeat tasks.
  - The subagent red-teams the latest UI/UX flows against current industry capabilities/patterns and suggests UX improvements and fixes prior to code commits.
- **Associated Documentation**:
  - `HEARTBEAT.md` (Active heartbeat cron job configured)

### Spatial Computing & 3D Scene Generation
- **Status**: Phase 1 (Static Generation) Drafted, Phase 2 (Live Canvas) In Progress
- **Owner**: Patch (Mechanic)
- **Description**: Connecting Canopy agents to 3D generation capabilities (Generative AI APIs like Luma/Meshy, and Headless Engines like Blender) via Model Context Protocol (MCP) to automatically create spatial assets for Apple Vision Pro and Meta Quest.
- **Key Decisions**:
  - Capability will be *ambient and auto-available*, triggering automatically based on user intent (e.g., asking for visualization, 3D layouts, Vision Pro).
  - Primary output formats: `.usdz` (Apple) and `.glb` (Meta/WebXR).
- **Phases**:
  - **Phase 1 (Static Output):** Generate `.usdz` or `.glb` files and send them to the user via the export bridge. (Docs drafted)
  - **Phase 2 (Live Spatial Canvas):** Build a WebXR R3F canvas with LiveKit voice and WebSocket telemetry so users can explore and talk to the agent to modify the 3D scene in real-time. (Currently building)
- **Associated Documentation**: 
  - `spatial-mcp-architecture.md` (Architecture breakdown)
  - `skills/spatial-generation/SKILL.md` (Agent instructions for detecting and formatting 3D intents)

### Model Fusion / Mixture of Agents (MoA) Engine
- **Status**: Research & Planning
- **Owner**: Patch (Developer)
- **Description**: Implementing a Model Fusion Engine to leverage "Mixture of Agents" (model stitching) to significantly boost logic and coding performance while keeping costs lower than standard Opus runs.
- **Key Decisions**:
  - Integrate "Fusion Routing" for under-the-hood tasks: Spawn 3x Gemini Flash/Haiku instances in parallel for complex architecture/coding tasks, then use Opus or Gemini Pro to synthesize the result into a final solution.
  - Apply "Self-Fusion" (Alloying) for code reviews and QA, running concurrent fast models to critique code before finalizing.
  - Expose this in the Forum UI: Display the multi-agent "Panel" streaming side-by-side (e.g., Backend, Security, UX perspectives) followed by the "Synthesizer" streaming the final artifact in the Canvas.
- **Associated Documentation**:
  - `canopy/DESIGN_MOA_FORUM.md` (Implementation plan for the Forum UI visualization)

### Visual Fusion Routing (DAG UI)
- **Status**: Potential Exploration (Hold)
- **Description**: Expose a visual DAG (node graph) in the UI to watch sub-agents fan-out, debate, and synthesize in real-time.
- **Notes**: On hold. Might be too technical as currently conceived. Need to explore designing this in a cool, user-friendly way before implementation.

### Agent-Specific Generative UI Dashboards
- **Status**: Research & Discovery
- **Owner**: Patch (Mechanic)
- **Description**: Each agent maintains its own dedicated UI/Dashboard tailored to its persona (e.g., EA shows schedule/to-dos; Dev shows Jira/GitHub/Bugs; Travel shows trips/alerts). The UI adapts based on user preferences and agent learning.
- **Key Decisions**:
  - **UX Placement**: Dual-Pane "Chat + Canvas" layout. The left pane remains the conversational stream, while the right pane holds the agent's persistent Dashboard. Switching agents swaps both the context and the Dashboard.
  - **Architecture**: React Server-Driven UI (SDUI). Agents emit structured JSON that maps to a shared library of React components (Cards, Lists, Charts, Kanban).
  - **State Management**: Each agent maintains a `dashboard_config.json` in its workspace memory. State is pushed to the client via WebSockets upon initialization or when the agent updates it.
  - **Adaptability**: Agents are equipped with an `update_dashboard` tool to restructure the UI dynamically when the user requests changes or when the agent infers a better layout based on usage.
- **Associated Documentation**:
  - `canopy/DESIGN_GENUI_DASHBOARDS.md` (To be created)
