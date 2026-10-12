// app-analytics kit v8: shared by every app. Only APP, APP_EVENTS and ROUTE_PATTERNS are this app's to edit.
/**
 * The event contract shared by the browser tracker and the collector.
 *
 * Built to be copied as-is into each of the apps on scottieryan.com: the
 * standard events (`pageview`, `engage`, `share_*`) mean the same thing
 * everywhere, so every app's stats come out in the same shape. App-specific
 * events are listed in APP_EVENTS.
 */

export const APP = "canopy";

/** Recorded for every app, by the tracker itself (pageview, engage) or by the app (shares). */
export const STANDARD_EVENTS = [
  "pageview", // a route was shown
  "engage", // active time on the route just left: props.ms
  "share_created", // the person sent or copied a link: props.kind, props.method, props.share (the link's id)
  "share_offered", // a link was put on screen without being asked for, such as a QR code on a hand-off page: props.kind, props.method, props.share
  "share_opened", // a page loaded from a shared link (?via=<kind>&s=<id>), recorded by the tracker: props.kind, props.share
  "app_installed", // first launch from the Home Screen, recorded by the tracker: props.carried (it kept the id of the browser it was added from)
  "device_merged", // this browser took on the id a link to yourself carried, recorded by the tracker: props.from (the id it had before)
] as const;

/** This app's own milestones (snake_case, object_verb, past tense). See the skill's references/events.md. */
export const APP_EVENTS = [
  "onboarding_step_completed", // a step of the add-agent wizard was finished: props.step ("discovery" | "powerup")
  "agent_created", // an agent was deployed, or an existing one imported: props.role (a suggested persona, else "custom"), props.imported
  "reply_received", // an agent answered a message the person sent, the first value moment: props.starter (it was the onboarding starter task)
  "forum_created", // a multi-agent forum was started: props.agents (how many)
  "forum_completed", // a forum's run finished with its deliverable
  "connection_added", // an integration or provider key was connected from Skills & Access: props.type (the connector's id)
  "companion_paired", // an agent was shared to a companion device: props.profile, props.experience
  "artifact_published", // a forum deliverable was published as a public share page
] as const;

/**
 * Dynamic routes, so stats group pages by route rather than by record
 * (/r/[code], not every shared reading). Paths that match none fall back to
 * replacing UUID and numeric segments with [id].
 */
// Canopy's screens are named by the app (start.ts viewPath) and never carry an agent or forum id, so there are none.
export const ROUTE_PATTERNS: readonly string[] = [];

/** A route pattern as a regular expression: /r/[code] → ^/r/[^/]+/?$. The same source works in JavaScript and in Postgres. */
export const routeSource = (pattern: string): string =>
  `^${pattern.replace(/[.+?^${}()|\\]/g, "\\$&").replace(/\\?\[[^\]]+\\?\]/g, "[^/]+")}/?$`;

/**
 * The query parameter a device id travels in when it has to cross to storage the tracker can't reach: into a
 * Home Screen app through the manifest's start_url, or to another browser through a link to yourself. The
 * tracker reads it on arrival and takes it out of the address.
 */
export const DEVICE_PARAM = "aid";

/** The request header the browser can send its device id in, so the server can count model costs per user (deviceHeader, deviceFrom) */
export const DEVICE_HEADER = "x-analytics-device";

export type EventName = (typeof STANDARD_EVENTS)[number] | (typeof APP_EVENTS)[number];
export const EVENT_NAMES: ReadonlySet<string> = new Set([...STANDARD_EVENTS, ...APP_EVENTS]);

/** app = the normal experience; guest = acting for someone else; kiosk = a locked shared device */
export type Mode = "app" | "guest" | "kiosk";

/** Flat, small, non-identifying values only: never names, free text, emails or other personal details. */
export type Props = Record<string, string | number | boolean>;

export interface ClientEvent {
  name: EventName;
  /** Milliseconds since the epoch, from the device clock */
  t: number;
  /** Route pattern, e.g. /readings/[id]; never the query string or #fragment */
  path: string;
  props?: Props;
}

export interface Batch {
  /** Random id kept on the device: one per browser storage, not per person */
  device: string;
  /** Rotates after 30 minutes without activity */
  session: string;
  mode: Mode;
  /** Launched from the Home Screen */
  standalone: boolean;
  /** External referrer host and utm_* for the session's landing page */
  referrer?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  /** The owner's own device (?track=me): true marks it, false unmarks it, absent says nothing */
  me?: boolean;
  events: ClientEvent[];
}
