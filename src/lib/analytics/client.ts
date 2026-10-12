// app-analytics kit v8: shared by every app. Change it through the app-analytics skill, not by hand.
// Desktop (Tauri) port. The webview has no server of its own, so three things differ from the web kit:
// the collector is another origin (startAnalytics takes its address, and batches go by fetch, since a
// cross-origin beacon would need credentialed CORS); there is no address bar, so the app's own settings
// switch opts a device out (setTracking) where the web has ?track=off; and screens are named by the app
// (pageview("/home")), since the webview's own path never changes.

import { DEVICE_HEADER, DEVICE_PARAM, ROUTE_PATTERNS, routeSource, type Batch, type ClientEvent, type EventName, type Mode, type Props } from "./events";

/**
 * First-party, cookieless usage tracking. A random device id in localStorage
 * gives unique users, DAU/MAU and retention; a session id that rotates after
 * 30 idle minutes gives sessions; active time per page (visible, and touched
 * in the last minute) gives engagement. Events are batched and sent to our
 * own /api/e, with a beacon when the page is hidden so nothing is lost when
 * iOS freezes a tab.
 *
 * Never sent: the #fragment (share links may keep personal data there), the
 * query string, or anything a person typed.
 *
 * Shared links are made with trackedLink(), which adds ?via=<kind>&s=<id>. A
 * page loaded from one records share_opened by itself, with that id, so share
 * landing pages need no code and every open can be traced back to its sender.
 *
 * One person should be one id, but a Home Screen app has storage of its own,
 * apart from the browser it was added from, and so does every other browser.
 * So the id travels where it can: in the web manifest's start_url, so an
 * installed app opens as the same user (carryToInstall, with installManifest
 * on the server), and in a link to yourself such as a backup (trackedLink
 * with self). It arrives as ?aid=<id> and is taken out of the address at once.
 *
 * Opt a device out (your own phone, say) with ?track=off; back on with ?track=on.
 * An opt-out travels into a Home Screen app the same way.
 *
 * Or mark it as yours with ?track=me (or markAsMe() from the app): it's still
 * tracked, so you can see how your own shares do, and the stats can be read
 * with or without your devices. ?track=on unmarks it. A Home Screen app added
 * from a marked browser keeps its id, so it stays marked.
 */

let endpoint = "/api/e";
const DEVICE_KEY = "analytics.device.v1";
const SESSION_KEY = "analytics.session.v1";
const OPTOUT_KEY = "analytics.optout.v1";
/** "1": this device is the owner's; "0": it was, and the server hasn't heard it isn't yet */
const ME_KEY = "analytics.me.v1";
const INSTALLED_KEY = "analytics.installed.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Time stops counting toward engagement after this long without input */
const ACTIVE_IDLE_MS = 60 * 1000;
const FLUSH_MS = 5000;

let started = false;
let disabled = false;
let getMode: () => Mode = () => "app";
const queue: ClientEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let memoryDevice: string | null = null;
let memorySession: { id: string; last: number } | null = null;
let landing: Pick<Batch, "referrer" | "utm"> = {};
/** An id that arrived in the address while this browser already had another: held until the app says they're one person */
let pendingDevice: string | null = null;

// Engagement on the current page
let currentPath: string | null = null;
let activeMs = 0;
let activeSince: number | null = null;
let lastInput = 0;

const now = () => Date.now();

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or full: the in-memory fallback carries on */
  }
}
function storageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}

function deviceId(): string {
  let id = storageGet(DEVICE_KEY) ?? memoryDevice;
  if (!id) {
    id = crypto.randomUUID();
    storageSet(DEVICE_KEY, id);
  }
  memoryDevice = id;
  return id;
}

/**
 * Headers for the app's own requests to routes that call a paid model API, so
 * the cost can be counted per user: fetch("/api/reading", { headers: { ...deviceHeader() } }).
 * Empty when this device has opted out. Never send it to another origin.
 */
export function deviceHeader(): Record<string, string> {
  if (typeof window === "undefined" || disabled || storageGet(OPTOUT_KEY) === "1") return {};
  return { [DEVICE_HEADER]: deviceId() };
}

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/**
 * What to do with a device id that arrived in the address (?aid=). Storage with no id of its own takes it
 * on: that's a Home Screen app's first launch, or a backup opened in a new browser. A browser that already
 * has a different id keeps it, and the carried one is held until the app confirms they're the same person
 * (adoptCarriedDevice), because two histories are only merged on purpose.
 */
export function carriedDevice(search: string, stored: string | null): { carried: string | null; adopt: string | null; pending: string | null } {
  const raw = new URLSearchParams(search).get(DEVICE_PARAM);
  const carried = raw && UUID.test(raw) ? raw.toLowerCase() : null;
  if (!carried || carried === stored) return { carried, adopt: null, pending: null };
  return stored ? { carried, adopt: null, pending: carried } : { carried, adopt: carried, pending: null };
}

/**
 * The manifest's address with this browser's id added (or its opt-out, when `device` is null), for the
 * server to put into start_url. Null when the manifest is on another origin: the id never goes there.
 */
export function manifestWithDevice(href: string, page: string, device: string | null): string | null {
  const url = new URL(href, page);
  if (url.origin !== new URL(page).origin) return null;
  url.searchParams.delete(DEVICE_PARAM);
  url.searchParams.delete("track");
  if (device) url.searchParams.set(DEVICE_PARAM, device);
  else url.searchParams.set("track", "off");
  return url.pathname + url.search;
}

const OWN_LINK = "data-analytics-manifest";

/**
 * Gives the page a manifest link of this browser's own, whose start_url carries the id, and keeps it the
 * first one in <head>: the browser reads the first manifest link when the person adds the app to their
 * Home Screen. The page's own link is left exactly as the framework rendered it, since the framework
 * owns that element and would add another if it changed.
 */
function carryToInstall() {
  if (navigator.webdriver === true) return;
  try {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="manifest"]'));
    let own = links.find((l) => l.hasAttribute(OWN_LINK));
    const page = links.find((l) => !l.hasAttribute(OWN_LINK));
    const plain = page?.getAttribute("href");
    const href = plain ? manifestWithDevice(plain, location.href, storageGet(OPTOUT_KEY) === "1" ? null : deviceId()) : null;
    if (!page || !href) {
      own?.remove();
      return;
    }
    if (!own) {
      own = document.createElement("link");
      own.setAttribute("rel", "manifest");
      own.setAttribute(OWN_LINK, "");
    }
    const credentials = page.getAttribute("crossorigin");
    if (credentials !== null && own.getAttribute("crossorigin") !== credentials) own.setAttribute("crossorigin", credentials);
    if (own.getAttribute("href") !== href) own.setAttribute("href", href);
    if (links[0] !== own) document.head.prepend(own);
  } catch {
    /* an address that doesn't parse: the page keeps its plain link */
  }
}

/** Takes a parameter out of the address bar without reloading, keeping the rest of the query and the #fragment */
function dropFromAddress(param: string) {
  try {
    const url = new URL(location.href);
    url.searchParams.delete(param);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* the address stays as it was */
  }
}

/**
 * The address carried someone's id (a backup link, say) but this browser already had its own, so nothing
 * changed. Call this once the app knows they're the same person, for example when what the link restores
 * belongs to whoever is already here. This browser then carries on under the carried id, and the id it
 * leaves behind is recorded so the stats stop counting it as someone else. Returns whether it merged.
 */
export function adoptCarriedDevice(): boolean {
  if (!started || disabled || !pendingDevice) return false;
  const from = deviceId();
  const to = pendingDevice;
  pendingDevice = null;
  storageSet(DEVICE_KEY, to);
  memoryDevice = to;
  // A session belongs to one id: whatever hasn't been sent yet goes out under the new one, in a session of its own
  memorySession = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing stored */
  }
  enqueue("device_merged", { from });
  carryToInstall();
  return true;
}

const SHARE_ID = /^[a-z0-9]{8,16}$/;

/** A link that is about to be shared, with the id that ties it to whoever opens it */
export interface TrackedLink {
  /** The link to give out: the address with ?via=<kind>&s=<id> added before any #fragment */
  url: string;
  kind: string;
  /** Random, and meaningless outside the stats. Null on a device that has opted out. */
  id: string | null;
  /** The person sent it: the share sheet finished, they copied it, or they chose to show its QR code. Records share_created. */
  sent(method: string): void;
  /** It was put on screen without being asked for, such as a QR code on a hand-off page. Records share_offered, once. */
  shown(method: string): void;
}

/**
 * Makes the link for one share. Every link the app gives out goes through this,
 * so each carries its kind and its own id:
 *
 *   const link = trackedLink("reading", `${location.origin}/r/${code}#${data}`);
 *   await navigator.share({ url: link.url }).then(() => link.sent("share_sheet"), () => {});
 *
 * Make a new one for each share. The same link sent two ways (texted, then copied) calls sent() twice.
 *
 * `self` is for a link people send to themselves: a backup, "continue on my other phone". It also carries
 * this device's id, so the browser that opens it carries on as the same user, and it stays out of the
 * who-brought-whom numbers. Never set it on a link meant for someone else.
 */
export function trackedLink(kind: string, url: string, options: { self?: boolean } = {}): TrackedLink {
  const off = typeof window === "undefined" || storageGet(OPTOUT_KEY) === "1" || navigator.webdriver === true;
  const id = off ? null : Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join("");
  const hash = url.indexOf("#");
  const [address, fragment] = hash < 0 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  const query = address.indexOf("?");
  const params = new URLSearchParams(query < 0 ? "" : address.slice(query + 1));
  params.set("via", kind);
  if (id) params.set("s", id);
  if (id && options.self) params.set(DEVICE_PARAM, deviceId());
  const props = { kind, ...(id && { share: id }), ...(options.self && { self: true }) };
  let offered = false;
  return {
    url: `${query < 0 ? address : address.slice(0, query)}?${params}${fragment}`,
    kind,
    id,
    sent: (method) => track("share_created", { ...props, method }),
    shown: (method) => {
      if (offered) return;
      offered = true;
      track("share_offered", { ...props, method });
    },
  };
}

/** The current session, rotated after 30 idle minutes. Shared by every tab. */
function sessionId(): { id: string; fresh: boolean } {
  let stored: { id: string; last: number } | null = memorySession;
  try {
    const raw = storageGet(SESSION_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    /* corrupt: start a new one */
  }
  const t = now();
  const fresh = !stored || t - stored.last > SESSION_IDLE_MS;
  const id = fresh ? crypto.randomUUID() : stored!.id;
  memorySession = { id, last: t };
  storageSet(SESSION_KEY, JSON.stringify(memorySession));
  return { id, fresh };
}

const routeMatchers = ROUTE_PATTERNS.map((pattern) => ({ pattern, re: new RegExp(routeSource(pattern)) }));

/** /readings/0f8c…-uuid → /readings/[id], so pages group by route, not by record. */
export function routePattern(pathname: string): string {
  const declared = routeMatchers.find((m) => m.re.test(pathname));
  if (declared) return declared.pattern;
  const parts = pathname.split("/").map((seg) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) || seg.length > 40 ? "[id]" : seg,
  );
  const path = parts.join("/").replace(/\/+$/, "");
  return (path || "/").slice(0, 120);
}

function captureLanding() {
  let referrer: string | undefined;
  try {
    const host = document.referrer ? new URL(document.referrer).host : "";
    if (host && host !== location.host) referrer = host.slice(0, 100);
  } catch {
    /* unparseable referrer */
  }
  const params = new URLSearchParams(location.search);
  const pick = (k: string) => params.get(k)?.slice(0, 60) || undefined;
  const utm = { source: pick("utm_source"), medium: pick("utm_medium"), campaign: pick("utm_campaign") };
  landing = { referrer, utm: utm.source || utm.medium || utm.campaign ? utm : undefined };
}

function enqueue(name: EventName, props?: Props, path = currentPath ?? routePattern(location.pathname)) {
  if (disabled) return;
  queue.push({ name, t: now(), path, ...(props && { props }) });
  flushTimer ??= setTimeout(() => flush(), FLUSH_MS);
}

export function flush(beacon = false) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (disabled || !queue.length) return;
  const events = queue.splice(0, 50);
  const { id, fresh } = sessionId();
  const me = storageGet(ME_KEY);
  const batch: Batch = {
    device: deviceId(),
    session: id,
    mode: getMode(),
    standalone: isStandalone(),
    ...(fresh ? landing : {}),
    ...(me === "1" ? { me: true } : me === "0" ? { me: false } : {}),
    events,
  };
  // An unmarking is said once
  if (me === "0") storageRemove(ME_KEY);
  landing = {};
  const body = JSON.stringify(batch);
  // A beacon survives the page being hidden or unloaded; fetch keepalive is the fallback
  if (beacon && endpoint.startsWith("/") && navigator.sendBeacon?.(endpoint, new Blob([body], { type: "application/json" }))) return;
  void fetch(endpoint, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true, credentials: "omit" }).catch(() => {});
  if (queue.length) flushTimer = setTimeout(() => flush(), FLUSH_MS);
}

/* ---- engagement: active time on the current page ---- */

function pause() {
  if (activeSince !== null) activeMs += Math.min(now(), lastInput + ACTIVE_IDLE_MS) - activeSince;
  activeSince = null;
}

function resume() {
  if (document.visibilityState !== "visible") return;
  // Time since the last input past the idle limit doesn't count
  if (activeSince !== null && now() - lastInput > ACTIVE_IDLE_MS) pause();
  lastInput = now();
  activeSince ??= lastInput;
}

/** Record the active time on the page being left, then reset for the next one. */
function endPage() {
  pause();
  if (currentPath && activeMs >= 1000) enqueue("engage", { ms: Math.round(activeMs) }, currentPath);
  activeMs = 0;
}

/** Call on every route change with the new pathname. */
export function pageview(pathname: string) {
  if (!started) return;
  carryToInstall();
  const path = routePattern(pathname);
  if (path === currentPath) return;
  endPage();
  currentPath = path;
  resume();
  enqueue("pageview", undefined, path);
}

/**
 * Marks this device as the owner's, or unmarks it, as ?track=me and ?track=on
 * do: for an app's own "this is me" switch. A marked device is tracked.
 */
export function markAsMe(on: boolean) {
  if (typeof window === "undefined") return;
  if (on) {
    storageRemove(OPTOUT_KEY);
    storageSet(ME_KEY, "1");
    disabled = navigator.webdriver === true;
  } else if (storageGet(ME_KEY) === "1") storageSet(ME_KEY, "0");
  // The server hears it with the next batch of events
}

/** Whether this device is marked as the owner's */
export const isMe = () => typeof window !== "undefined" && storageGet(ME_KEY) === "1";

/** Record an app event. Props must be small and never identify anyone. */
export function track(name: EventName, props?: Props) {
  if (!started || disabled) return;
  enqueue(name, props);
}

/** Whether this device sends anything: false once it has opted out */
export const isTracking = () => typeof window !== "undefined" && storageGet(OPTOUT_KEY) !== "1";

/**
 * The app's own opt-out switch, for an app with no address bar to type ?track=off into. Off: nothing more
 * is recorded or sent, and what was waiting to go is dropped. On: tracking carries on from here.
 */
export function setTracking(on: boolean) {
  if (typeof window === "undefined") return;
  if (on) storageRemove(OPTOUT_KEY);
  else storageSet(OPTOUT_KEY, "1");
  disabled = !on || navigator.webdriver === true;
  if (disabled) {
    queue.length = 0;
    currentPath = null;
    activeMs = 0;
    activeSince = null;
  } else if (started) listen();
}

let listening = false;
/** Watches input and visibility for active time, and sends what's waiting when the window is hidden. Once. */
function listen() {
  if (listening) return;
  listening = true;
  for (const type of ["pointerdown", "keydown", "scroll", "touchstart", "wheel"]) {
    addEventListener(type, resume, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // The tab may never come back: count the time so far and send it now
      endPage();
      flush(true);
    } else {
      resume();
    }
  });
  addEventListener("pagehide", () => {
    endPage();
    flush(true);
  });
}

export function startAnalytics(options: { mode: () => Mode; endpoint?: string }) {
  if (started || typeof window === "undefined") return;
  started = true;
  getMode = options.mode;
  if (options.endpoint) endpoint = options.endpoint;

  const toggle = new URLSearchParams(location.search).get("track");
  if (toggle === "off") storageSet(OPTOUT_KEY, "1");
  if (toggle === "on" || toggle === "me") storageRemove(OPTOUT_KEY);
  if (toggle === "me") storageSet(ME_KEY, "1");
  if (toggle === "on" && storageGet(ME_KEY) === "1") storageSet(ME_KEY, "0");
  // Out of the address at once, so a copied link never marks or opts out whoever opens it
  if (toggle) dropFromAddress("track");
  const optedOut = storageGet(OPTOUT_KEY) === "1";
  disabled = optedOut || navigator.webdriver === true;

  // An id that came with the address: read it, then take it out so it's never bookmarked or passed on
  const stored = storageGet(DEVICE_KEY);
  const { carried, adopt, pending } = carriedDevice(location.search, stored);
  if (new URLSearchParams(location.search).has(DEVICE_PARAM)) dropFromAddress(DEVICE_PARAM);
  if (navigator.webdriver === true) return;
  if (adopt && !optedOut) {
    storageSet(DEVICE_KEY, adopt);
    memoryDevice = adopt;
  }

  // Keep the manifest link carrying this browser's id (or its opt-out) for whenever the app is added to the Home Screen
  carryToInstall();
  try {
    new MutationObserver(carryToInstall).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  } catch {
    /* no observer: pageview() keeps it right on every route change */
  }
  if (disabled) return;
  pendingDevice = pending;

  captureLanding();
  // The first launch from the Home Screen: it brought the browser's id, or its storage is brand new. A Home
  // Screen app from before installs were recorded has an id already and brought none, so it stays quiet.
  if (isStandalone() && storageGet(INSTALLED_KEY) !== "1") {
    storageSet(INSTALLED_KEY, "1");
    if (storageGet(INSTALLED_KEY) === "1" && (carried || !stored)) enqueue("app_installed", { carried: !!carried }, routePattern(location.pathname));
  }
  // Read before the app can strip it (history.replaceState); once per page load
  const via = new URLSearchParams(location.search).get("via");
  const share = new URLSearchParams(location.search).get("s");
  if (via) {
    const kind = /^[a-z0-9_-]{1,30}$/i.test(via) ? via : "unknown";
    enqueue("share_opened", { kind, ...(share && SHARE_ID.test(share) && { share }) }, routePattern(location.pathname));
  }
  listen();
}
