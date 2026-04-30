# Connector Companion Pattern

This document serves as the architectural standard for implementing manual credential or configuration flows (such as pasting tokens or API keys) within the Canopy application.

**Do not use inline text inputs inside `IntegrationsView` or `ConnectionsTab`.** All manual configuration must use the "Companion Window" pattern.

## Why the Companion Pattern?
1. **Premium UX**: It creates a distraction-free, guided tutorial window that can float on top of the browser while the user follows setup steps (e.g., getting a Discord Bot token).
2. **Native OS Feel**: Tauri webview windows feel like native macOS configuration wizards.
3. **Decoupled Architecture**: It removes cluttered inline React state (`showTelegramInput`, `telegramToken`, `isLoading`) from the main view components.

## How to Implement a New Connector

### 1. Update `connectors.json`
In `shared/connectors.json`, define your connector and ensure `"needsCompanion": true`.
```json
{
  "id": "linear",
  "name": "Linear",
  "subtitle": "Connect a Linear Personal API Key",
  "icon": "box",
  "isGlobal": true,
  "isVisible": true,
  "needsCompanion": true
}
```

### 2. Create the Companion Component
Create `src/components/Companion/{ConnectorName}Companion.tsx` (e.g., `LinearCompanion.tsx`).
Use `GithubCompanion` or `SlackCompanion` as a boilerplate. Key requirements:
- **Tauri Drag Region**: Include `data-tauri-drag-region` on the container and header so the window can be moved.
- **Close Button**: Implement a manual `getCurrentWindow().close()` button.
- **Guided Steps**: Provide step-by-step UI (e.g., "Step 1: Go to Linear settings", "Step 2: Copy Token").
- **Secure Storage**: Use Tauri's `invoke("store_secret_cmd", { key, value })` to save the token directly to the macOS Keychain.
- **Global Refresh**: After saving, emit a global DOM event `window.dispatchEvent(new Event("refresh_integrations"))` so the main application instantly reflects the connected state.
- **Self-Destruct**: Close the companion window upon success using `setTimeout` and `getCurrentWindow().close()`.

### 3. Register the Route
In `src/main.tsx`, import your companion and add it to the router ternary:
```tsx
import { LinearCompanion } from "./components/Companion/LinearCompanion";

// ... inside ReactDOM.render ...
{companionType === "linear" ? (
  <LinearCompanion />
) : ... }
```

### 4. Hook up Global View (If Applicable)
If your connector is global, it will be rendered in `src/components/IntegrationsView.tsx`.
Use the `launchCompanion` helper instead of inline state:
```tsx
<ServiceCard
  icon={<Box size={20} />}
  name="Linear"
  description="Connect a Linear API Key"
  status={linearStatus}
  agentCount={agentCount("linear")}
  onConnect={() => launchCompanion("linear", "Linear")}
/>
```

*Note: Per-agent connections dynamically loop over `connectors.json` in `App.tsx` and will automatically launch the companion if `needsCompanion` is true. You don't need to write manual launch code for them!*
