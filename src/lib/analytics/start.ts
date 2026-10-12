// app-analytics kit v8: Canopy's stand-in for the kit's <Analytics /> component. Only viewPath() and the
// collector's address are this app's to edit.
import { useWorldStore } from "../../store/worldStore";
import { isTracking, pageview, setTracking, startAnalytics } from "./client";

/** The collector lives on the admin server (canopy-admin/analytics-routes.js): the desktop app has no server of its own. */
const ENDPOINT = `${import.meta.env.VITE_API_URL || "http://localhost:3001"}/api/e`;

type View = ReturnType<typeof useWorldStore.getState>;

/**
 * The screen as a path, so the stats group time and visits by screen. The webview's own address never
 * changes, and no agent or forum id is ever part of this: /architect/overview, not which agent.
 */
export function viewPath(state: Pick<View, "activeView" | "architectTab">): string | null {
  const view = state.activeView;
  if (view === "loading") return null;
  // Two ids, one screen
  if (view === "vault") return "/integrations";
  if (view === "architect") return `/architect/${state.architectTab === "permissions" ? "connections" : state.architectTab || "overview"}`;
  return `/${view}`;
}

function recordView() {
  const path = viewPath(useWorldStore.getState());
  if (path) pageview(path);
}

/**
 * Starts usage tracking and records a pageview on every screen change. Call once, from the main window
 * only: the companion, browser and mini-app windows load the same bundle and would each look like a visit.
 */
export function startCanopyAnalytics() {
  startAnalytics({ mode: () => "app", endpoint: ENDPOINT });
  recordView();
  useWorldStore.subscribe((state, previous) => {
    if (state.activeView !== previous.activeView || state.architectTab !== previous.architectTab) recordView();
  });
}

/** The Profile switch: on by default, and off means nothing more is recorded or sent from this device. */
export function setProductAnalytics(on: boolean) {
  setTracking(on);
  if (on) recordView();
}

export { isTracking as productAnalyticsOn };
