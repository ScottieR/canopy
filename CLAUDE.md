## Usage analytics

This app has the app-analytics kit (`src/lib/analytics/` here for the tracker; the collector, stats, `flows.ts` and model-cost recording are in the `canopy-admin` repo under `analytics/` and `analytics-routes.js`). Whenever a feature or flow is added, changed or removed, update the analytics in the same change: events (`events.ts`, which must stay identical in both repos), funnels, key features and activation (`canopy-admin/analytics/flows.ts`), screen names (`viewPath` in `start.ts`), shares (`trackedLink`), and `recordAiUsage` on any new server-funded model API call in `canopy-admin/server.js`. Use the `app-analytics` skill ("Keep it current"). Files marked "shared by every app" change only through that skill.

This is separate from the older opt-in telemetry (`fireActivationEvent` / `reportTelemetryEvent` in `src/store/worldStore.ts`), which is unchanged.
