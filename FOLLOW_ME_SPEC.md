# Follow Me — Screen Capture / Co-Working Feature Spec

Status: draft for engineering handoff
Owner: TBD
Depends on: `screen_record` agent capability (already modeled, currently unenforced)

## 0. Grounding: what already exists

Before designing anything new, it's worth being precise about what Canopy already has in
place, because most of the hard design decisions (gating model, transport shape, audit
pattern) already have a precedent elsewhere in the codebase. Follow Me should extend these,
not invent parallel systems.

**The capability already exists but is inert.** `AgentCapabilities` in
`src-tauri/src/models.rs:219-222` already has `computer_control`, `host_control`, and
`screen_record: bool` fields, all defaulting to `false` (`models.rs:250-253`). The frontend
mirrors this in `src/store/worldStore.ts:57-67` and lists `screen_record` as a real toggle
("Screen Recording — Receive screenshots or accessibility snapshots for observation,
auditing, and teaching flows", `worldStore.ts:363`). It's exposed in onboarding
(`src/pages/OnboardingWizard.tsx:811`), the access-tier presets
(`src/pages/ArchitectView/accessTiers.ts`), and the risk-tier UI in
`src/pages/ArchitectView/ConnectionsTab.tsx:1228-1240`. Notably, **no access tier turns it
on by default** — Guarded, Balanced, and even Unrestricted all set `screen_record: false`
(`accessTiers.ts:91,123,150`). This is intentional per-agent opt-in and Follow Me should
preserve that.

**Validation rules already exist.** `src-tauri/src/computer_control.rs` enforces:
`computer_control` requires `screen_record` (line 34-39: "Computer control requires screen
recording so actions can be audited and bounded"), and `host_control` requires both
`computer_control` and `agent.isolated` (line 42-46). This gives us a precedent for a
`screen_capture.rs` module structured the same way: pure validation functions, a rate
limiter, an `EmergencyStopRegistry`-style kill switch, and a session registry for anything
time-boxed (`HostControlSessionRegistry`, capped at `MAX_HOST_CONTROL_SESSION_SECS = 180`).

**The agent is told about `screen_record` today, but it's a no-op.** `openclaw.rs:9175-9180`
generates a block for `PERMISSIONS.md` that just says "Enabled. Screenshots or accessibility
snapshots may be provided for observation and audit." — there is no code path that actually
produces a screenshot and gets it to the agent. Follow Me is that code path.

**A live frame-streaming pattern already exists, just for the browser, not the desktop.**
`browser_manager.rs`'s `stream_browser_visuals` (line 2541) polls Chrome DevTools Protocol's
`Page.captureScreenshot` (jpeg, quality 50, line 2632-2633) and emits `browser_stream_frame`
Tauri events with a base64 payload. The frontend counterpart,
`src/components/BrowserPopout.tsx`, calls `start_browser_stream` / `stop_browser_stream` on
mount/unmount (refcounted subscribers server-side, so the capture loop only runs while a UI
surface is actually looking) and renders `data:image/jpeg;base64,${frame}` directly. This
refcounting detail matters — an earlier version of this code ran an unconditional 2 FPS
screenshot loop for the browser's entire lifetime and it was a "prime suspect for the
white-screen-after-idle crash" (`browser_manager.rs:34-37`). Watch Mode in this spec must not
repeat that mistake.

**Sending an image to an agent already has a working path.** `ChatTab.tsx` maintains an
`attachments: {name, dataUrl}[]` array on the composer (line 631), uploads each one via
`invoke("upload_workspace_file", { agentId, filename, base64Data })` at send time (line
1302), and renders inline image attachments both for the user's own messages and for
tool-delivered ones (`AttachmentThumbnail`, line 327; image-attachment detection at line
1727-1736 checks `dataUrl?.startsWith("data:image")`). This is the exact shape Follow Me
should reuse — a capture becomes another entry in `attachments` on the next
`send_message_internal_with_context` call (`openclaw.rs:2864`), no new attachment plumbing
needed on the model/message side.

**There is a known-broken prior attempt at desktop capture.** `lib.rs:627-633`,
`capture_viewport`, is explicitly marked `// FIXME: tauri WebviewWindow capture_image() is
missing or needs a different plugin.` It only ever captured Canopy's own drawing-overlay
viewport, not the user's screen, and it doesn't work reliably even for that. Do not build on
top of it — Follow Me needs a real macOS-native capture path (Section 2).

**There's an existing container↔host request channel that is a good model for "agent asks,
human decides."** `jit_server.rs` runs an authenticated local HTTP server
(bearer-token-checked, `authenticate_agent_request`) that a containerized agent calls out to.
Two routes are directly relevant precedent:
- `/request_attention` (line 250, `handle_attention_request` at line 574) — fire-and-forget,
  emits `agent_attention_requested`, no blocking.
- `/request_permission` (`handle_permission_request`, line 612) — blocks on a `oneshot`
  channel keyed by request id in `PENDING_PERMISSION_REQUESTS`, emits
  `agent_permission_requested`, and the user resolves it via `once` / `session` / `forever` /
  `deny` (comment block at line 587-609 documents the semantics precisely).

Follow Me's capture trigger is different in one important way: it originates on the **host**
side (the user's own screen, driven from the main Tauri process), not from inside the
agent's Docker container (`docker.rs`, `bollard` client in `Cargo.toml`). So it does not need
to go through `jit_server.rs` at all — it's a same-process Tauri command, closer in shape to
`start_browser_stream` than to `/request_permission`. But the *confirmation UX* for anything
that needs a live human decision (e.g., first-time allowlist setup) should reuse the
`request_permission` once/session/forever/deny vocabulary users already know from other
capability grants.

**Per-agent allowlists already have a storage precedent.** Both
`workspace_manager::update_agent_allowed_directories` and
`browser_manager::update_agent_allowed_domains` (`browser_manager.rs:2381-2430`) follow the
same shape: validate the agent id, normalize/dedupe the list, write it to a per-agent JSON
file, and restart/invalidate whatever depends on it. The per-app screen-capture allowlist
(Section 3) should follow this exact pattern rather than inventing a new settings store.

**Audit logging already has a typed action enum and metadata-only storage.**
`src-tauri/src/audit.rs` defines `AuditAction` (`AgentCreated`, `PermissionGranted`,
`VoiceSessionStarted`, etc., lines 10-40) backed by `AuditEntry`/`AuditSummary` in `db.rs`.
Follow Me needs one or two new variants here — see Section 7.

**No screen-capture crate exists yet.** `Cargo.toml` has no `xcap`, `screencapturekit`,
`core-graphics`, or `objc2` dependency. This is genuinely new surface area — see Section 2
for the recommended approach and why.

---

## 1. Overview & Use Cases

Follow Me lets a Canopy agent see the user's screen, on the user's terms, so it can act as a
co-working partner instead of a chat window that has to be told everything in words.

- **Co-working Q&A** — "what's this error?", "why is this build failing", "how would you
  lay this out?" — answered against what's actually on screen instead of a pasted screenshot.
- **Workflow teaching** — the agent observes a repeated sequence of app/window switches
  across a Teach Mode session and proposes turning it into a reusable workflow.
- **Proactive audit / automation suggestions** — "I've noticed you do X manually a few times
  a week — want me to handle that?", surfaced from patterns in the local (never uploaded)
  session log.
- **Dual-plane co-working layout** — agent panel on one monitor/side, work surface on the
  other, with the agent maintaining live context of what's on the work side.

None of this should ever feel like ambient surveillance. The defaults (Section 4) bias hard
toward explicit, visible, user-initiated capture, matching how `screen_record` is already
off-by-default even on the Unrestricted access tier.

## 2. Architecture

### 2.1 Capture layer

**Recommendation: ScreenCaptureKit via a small native bridge, not a cross-platform crate.**

The spec's original ask (per-window or per-monitor selection, not full-screen-always) maps
directly onto ScreenCaptureKit's `SCContentSharingPicker` — Apple's own system-native
window/monitor picker UI, introduced in macOS 14. Using it buys two things that matter a lot
here:
1. The user gets the *OS's* picker, not one Canopy has to build and keep secure — no risk of
   Canopy mis-attributing which window it captured.
2. macOS's Screen Recording TCC permission prompt is triggered and explained by the system,
   not by Canopy asking for a blanket "let this app record your screen" grant up front out of
   context.

There is no mature, maintained Rust binding for `SCContentSharingPicker` today. The pragmatic
path is a small Swift command-line helper (or an `objc2` + `objc2-screen-capture-kit`
bridge — those crates exist and are maintained, unlike a full high-level wrapper) that:
- Exposes "list shareable content" (windows + displays, with titles/app bundle ids and
  thumbnail data) over stdin/stdout JSON, analogous to how `docker.rs` already shells out to
  `bollard`/Docker rather than reimplementing the Docker API.
- Exposes "capture one frame from source X at quality Y" returning JPEG bytes.
- Is invoked from Rust via `tokio::process::Command`, matching the existing pattern of
  spawning helper processes elsewhere in `src-tauri` (e.g. the OpenClaw CLI invocations in
  `openclaw.rs`).

This is real, non-trivial new surface area — budget a spike (Phase 1, Section 6) to confirm
the `objc2-screen-capture-kit` bindings cover what's needed before committing to the Swift-helper
fallback.

**Do not build on `capture_viewport`** (`lib.rs:632`) — it's Tauri's own window capture, marked
broken, and even if fixed it only captures Canopy's own window, not arbitrary
apps/monitors.

**Explicitly reject**: full-screen-always capture, and any approach that captures before the
system permission dialog has been granted (ScreenCaptureKit will simply return black frames
or an error pre-grant — treat that as "not yet enabled," not a bug to route around).

### 2.2 Trigger model

Three modes, escalating in how much the agent sees without being asked (Section 4 covers the
UI):

- **On-demand (default)**: one capture, taken at the moment the user hits send, only when the
  Follow Me toggle is on for that conversation. This is a single `capture_screen_source` call,
  not a stream — no persistent capture loop, no refcounting needed.
- **Watch mode (opt-in)**: a background capture every 5s while the toggle is active,
  mirroring the refcounted-subscriber design of `stream_browser_visuals` /
  `start_browser_stream` / `stop_browser_stream` exactly, including the lesson learned from
  the white-screen-after-idle incident: the loop must hold a handle tied to UI-surface
  lifetime and must hard-stop when the last subscriber unmounts, not rely on a timeout.
  Watch mode frames are *processed into the local session log* (Section 5) — they are not
  sent to the LLM API unless the user asks something that references recent screen context.
- **Teach mode (opt-in, explicit session)**: same underlying capture as watch mode, but
  paired with the agent narrating observations and asking clarifying questions in real time,
  and a hard start/stop boundary the user controls (a session, not a toggle left on).

### 2.3 Privacy filter

A pre-send pass, run in Rust before any capture leaves the process boundary in either
direction (attached to a message, or written into the session log):
- Regex-based detection for common credential shapes (API key prefixes like `sk-`, `ghp_`,
  `AKIA`, JWT-looking three-segment base64, password-manager-style masked dot fields) run
  against any OCR'd text in frame (only needed if/when OCR is added — v1 can skip OCR and
  rely on the allowlist/blocklist below, since blurring text we can't read isn't possible).
- App/window-level blocking (Section 3) is the primary defense, not text-pattern matching —
  regexes will always be incomplete. Treat the privacy filter as defense-in-depth, not the
  main gate.

### 2.4 Transport

Reuse the existing attachment path end-to-end instead of adding a new one:
- `capture_screen_source` returns a base64 JPEG.
- Frontend pushes it into the same `attachments: {name, dataUrl}` array `ChatTab.tsx`
  already sends (line 631, 1289), tagged e.g. `follow-me-capture-<timestamp>.jpg`.
- It flows through `upload_workspace_file` and `send_message_internal_with_context` exactly
  like a user-attached image does today — no new fields on the message model, no new
  parsing on the OpenClaw/vision side. The agent needs `vision` capability to make sense of
  it (already surfaced via `caps.vision` in `openclaw.rs:1955-1956` and the `PERMISSIONS.md`
  vision block at line 5227) — Follow Me's capability check should require both
  `screen_record` and `vision` be enabled, similar to how `computer_control` already requires
  `screen_record`.

### 2.5 Storage

- Ephemeral only for the actual pixels: captured in Rust memory as JPEG bytes, base64-encoded
  for the one IPC/HTTP hop, then dropped. Never written to disk, never cached.
- Watch-mode's session log (Section 5) stores structured *observations* (app name, window
  title, timestamp, a coarse action label), never raw frames.
- Audit log (Section 7) stores metadata only, following the existing `AuditEntry` pattern —
  timestamp, app name, source type (window/display), dimensions, trigger (`on_demand` /
  `watch_mode` / `teach_mode` / `manual`). No image bytes, ever, in SQLite.

## 3. Security Model

### 3.1 Per-app allowlist / blocklist

Stored per-agent using the exact pattern already used for browser domains
(`browser_manager::update_agent_allowed_domains`) and workspace directories
(`workspace_manager::update_agent_allowed_directories`): a normalized, deduped list written
to a per-agent JSON file, validated by agent id shape, checked before any capture proceeds.

- **Default-deny for a fixed blocklist**, not user-configurable off: Mail, Messages,
  Keychain Access, 1Password (and other password-manager bundle ids), Banking-category apps
  if identifiable, and System Settings' own Privacy panes. Enforced by matching the captured
  source's bundle identifier (ScreenCaptureKit's `SCRunningApplication.bundleIdentifier`)
  against a hard-coded list in `screen_capture.rs`, checked *before* the frame is captured,
  not after.
- **User-editable allowlist on top of that** for anything not on the hard blocklist — same
  "off unless explicitly turned on" posture as `screen_record` itself.
- System credential surfaces (Touch ID sheets, `NSSavePanel`/`NSOpenPanel` with an
  authentication field, the macOS keychain unlock prompt) render as their own separate
  windows at the OS level — since capture is per-window/per-display via
  `SCContentSharingPicker`, these are excluded automatically unless the user explicitly picks
  a display source that includes them, which is a monitor-level, not app-level, risk to call
  out in Section 8.

### 3.2 Capture indicator

A persistent, unmissable, non-dismissible-while-active visual signal, not just a log entry —
this is the single most load-bearing trust mechanism in the whole feature. A colored ring or
badge on the agent panel (same visual language as the existing `BrowserPopout` LIVE/WAITING
dot at `BrowserPopout.tsx` bottom, lines ~88-95) that:
- Flashes for ~2s on every on-demand capture.
- Stays solidly lit for the duration of watch mode / teach mode — not just a flash, since
  those modes capture repeatedly without a new user action each time.

### 3.3 Prompt injection defense

Any text an agent derives from a screen capture (via vision, or later OCR) is untrusted
input, exactly like page content fetched by the browser tool already is treated
(`SECURITY.md:27` explicitly scopes "prompt injection wholly contained within an agent's
authorized workspace" as expected/handled, not a vulnerability by itself — the actual
boundary is action, not exposure). Concretely:
- Text visible in a capture can inform what the agent *says*, never what it *does*
  unilaterally. Any action derived from screen content (clicking something, running a
  command, sending a message) must still go through Canopy's existing action-confirmation
  surfaces — the `request_permission` once/session/forever/deny flow for capability grants,
  and ordinary tool-call confirmation for everything else. Follow Me does not introduce a new
  bypass path; it must not be given implicit trust just because a human's screen was the
  source.
- This should be stated explicitly in the `PERMISSIONS.md` block Follow Me adds (extending
  `openclaw.rs`'s existing `screen_record_block`, line 9175), so the agent's own system
  prompt carries the same rule the Rust layer enforces.

### 3.4 Audit log

Every capture event — on-demand, watch-mode tick, teach-mode tick, or a manual "capture now"
— is logged via the existing `AuditAction`/`AuditAudit` machinery in `audit.rs`/`db.rs`, with
metadata only (Section 2.5). Surfaced in Canopy settings via a simple list view, same place a
user would already look for capability/permission history.

## 4. UI/UX Design

### 4.1 Setup

One-time "Enable Follow Me" flow, reached from the same place `screen_record` is already
surfaced today (`ConnectionsTab.tsx`'s capability list / the onboarding high-risk toggles in
`OnboardingWizard.tsx:811`):
1. Turning on `screen_record` (+ `vision`, enforced together per 2.4) for the agent, using
   the existing `update_agent_capabilities` command (`openclaw.rs:2191`) — no new command
   needed for the toggle itself.
2. A native macOS prompt (via the ScreenCaptureKit bridge) to grant Canopy the system Screen
   Recording permission, the same category of flow as `open_full_disk_access_settings` /
   `open_photos_privacy_settings` in `imessage.rs:739-758` — if the OS permission isn't
   granted yet, deep-link to `System Settings → Privacy & Security → Screen Recording` rather
   than trying to trigger it silently.
3. Allowlist setup (Section 3.1) — pick which apps/windows are shareable; blocklist is fixed
   and shown as informational, not editable.

### 4.2 Session modes

- **On-demand (default)** — a toggle in the chat composer area, next to the existing
  attachment control in `ChatTab.tsx`. Off by default every session (does not persist as "on"
  across app restarts, to avoid surprise).
- **Watch mode (opt-in)** — same toggle, long-press or secondary state; visibly distinct from
  on-demand (label difference below).
- **Teach mode (opt-in, explicit)** — not a toggle, a distinct "Start Teaching a Workflow"
  entry point that begins a bounded session with its own start/stop UI, not left ambiently on.

### 4.3 Visual affordances

- Composer toggle: "👁 Follow me" (off) / "👁 Following" (on-demand active) / "👁‍🗨 Watching"
  (watch mode active) — three distinct states, not a binary.
- Capture indicator described in 3.2.
- **"What I see" preview** — clicking the indicator (or a persistent small thumbnail near it)
  shows exactly the last frame that was sent, using the same inline-image rendering
  `ChatTab.tsx` already does for attachments (`AttachmentThumbnail`, line 327) — the user
  should never have to wonder what the agent actually received.

## 5. Workflow Teaching & Proactive Suggestions

- During watch/teach mode, Canopy keeps a local, on-device session log of observed
  app/window sequences (structured events, not frames — Section 2.5). This can live in
  SQLite via `db.rs`, scoped per-agent, and should be purgeable from the same settings surface
  as the audit log.
- After 3+ repetitions of a similar sequence, the agent surfaces a suggestion in-chat: "I've
  seen you do X → Y → Z a few times — want me to turn that into a command?" This is a
  suggestion the user acts on, never an automatically-created automation.
- Accepted suggestions become structured "workflow" objects (steps + trigger app/window
  context), stored in SQLite, editable/nameable/activatable from a new Workflows panel. Out of
  scope for Phase 1-2 (see Section 6); this is Phase 3+.

## 6. Implementation Plan (phased)

**Phase 1 — On-demand capture, end to end**
- Spike: confirm `objc2-screen-capture-kit` covers "list shareable content" +
  "single-frame capture" + system permission check; fall back to a Swift helper binary if not.
- New `src-tauri/src/screen_capture.rs`: capability validation (`screen_record` + `vision`
  both required — mirrors `computer_control.rs`'s `validate_capabilities`), a
  `ScreenCaptureRateLimiter` (reuse `rate_limiter::RateLimiter`), hard-coded app blocklist
  check.
- Tauri commands: `get_screen_sources`, `capture_screen_source` (see Section 7).
- Wire capture output into `ChatTab.tsx`'s existing `attachments` array at send time, gated
  by the new composer toggle.
- Capture indicator (3.2), "What I see" preview (4.3).
- Privacy filter pass (2.3) — blocklist enforcement only in Phase 1; regex text-pattern
  matching can wait for OCR/watch-mode in a later phase since on-demand has no OCR yet.
- Extend `PERMISSIONS.md` generation in `openclaw.rs` to describe Follow Me concretely,
  replacing the current placeholder `screen_record_block` text.

**Phase 2 — Allowlist + audit UI**
- `set_screen_capture_allowlist` / allowlist storage, following
  `update_agent_allowed_domains`'s exact file-based pattern.
- New `AuditAction` variant(s) in `audit.rs`; settings-page audit log viewer.
- System Screen Recording permission onboarding flow (4.1 step 2).

**Phase 3 — Watch mode + proactive suggestions**
- Refcounted capture loop modeled on `stream_browser_visuals` /
  `start_browser_stream`/`stop_browser_stream`, with the same lifecycle discipline (loop dies
  with the last subscriber — no bare timers).
- Local session-log schema in `db.rs`; pattern-detection for repeated sequences; in-chat
  suggestion surfacing.

**Phase 4 — Teach mode**
- Bounded, explicit-start/stop recording session UI.
- Agent narration + clarifying questions during the session.
- Workflow object model, Workflows panel (name/edit/activate).

## 7. New Rust commands needed

All `#[tauri::command]` async fns, following the existing module-per-concern layout
(`screen_capture.rs` new, registered in `lib.rs`'s `invoke_handler` list alongside the other
`openclaw::update_agent_*` / `browser_manager::*` commands):

- `get_screen_sources() -> Result<Vec<ScreenSource>, String>` — enumerates capturable
  windows/displays (id, title, owning app bundle id, thumbnail base64), pre-filtered to strip
  hard-blocklisted apps before they ever reach the frontend.
- `capture_screen_source(agent_id: String, source_id: String) -> Result<String, String>` —
  runs the blocklist/allowlist check for `agent_id`, captures one frame, runs the privacy
  filter, returns base64 JPEG. Rate-limited per agent (reuse `RateLimiter`).
- `set_screen_capture_allowlist(agent_id: String, sources: Vec<String>) -> Result<(), String>`
  — same normalize/dedupe/persist/agent-id-validate shape as
  `update_agent_allowed_domains`.
- `get_capture_audit_log(agent_id: String, limit: u32) -> Result<Vec<AuditEntry>, String>` —
  thin wrapper over the existing audit query path in `db.rs`, filtered to capture-related
  `AuditAction` variants.
- `start_watch_mode(agent_id: String, source_id: String, interval_secs: u64) -> Result<(), String>`
  / `stop_watch_mode(agent_id: String) -> Result<(), String>` — refcounted subscriber model
  per Section 2.2/6 Phase 3, mirroring `start_browser_stream`/`stop_browser_stream`; emits
  `follow_me_frame` events (payload shape mirrors `browser_stream_frame`:
  `{ agent_id, frame }`) to any subscribed UI surface, but frames are only forwarded to the
  session-log processor, not auto-attached to messages.
- `open_screen_recording_privacy_settings() -> Result<(), String>` — deep-links to
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`, same
  pattern as `open_full_disk_access_settings`/`open_photos_privacy_settings`
  (`imessage.rs:739-758`).

No changes needed to `AgentCapabilities`, `send_message_internal_with_context`, or the
attachment model on the message/DB side — Phase 1 rides entirely on existing infrastructure
there.

## 8. Risks & Mitigations

- **Prompt injection from screen content** — mitigated by treating all screen-derived text as
  untrusted context per 3.3; no new action-bypass path is introduced.
- **Accidental credential exposure** — primary mitigation is the hard app blocklist (3.1),
  which doesn't depend on reading/parsing the frame; the regex privacy filter (2.3) is
  explicitly secondary/defense-in-depth, not the main control.
- **Monitor-level capture defeating the blocklist** — capturing a whole display (not a single
  window) can still surface a blocklisted app if it happens to be visible on that display.
  Mitigate by defaulting the source picker to window-level, and surfacing a clear warning
  when a user picks a full-display source ("this may include other visible apps").
- **Native capture bridge complexity/maintenance** — the ScreenCaptureKit bridge is genuinely
  new, unfamiliar surface area (no existing crate in `Cargo.toml` touches this). Budget the
  Phase 1 spike explicitly; don't let it get compressed into "just add a crate."
- **Repeat of the white-screen-after-idle failure mode** — Watch mode's capture loop must
  copy the refcounted-subscriber lifecycle from `stream_browser_visuals`
  exactly (`browser_manager.rs:34-37` documents why the naive version broke); do not ship an
  unconditional interval timer.
- **Performance** — ScreenCaptureKit is hardware-accelerated; JPEG-compress before any IPC
  hop, same quality tradeoff already made for browser streaming (`quality: 50`,
  `browser_manager.rs:2633`) as a starting point, tunable per mode (watch mode can go lower
  quality than on-demand since it's not shown to the user directly).
- **User trust erosion from ambient capture** — mitigated by the three-state toggle (4.3)
  never defaulting to watch mode, the non-dismissible capture indicator (3.2), and the
  always-accessible "what I see" preview and audit log — the user should never have to take
  Canopy's word for what was captured.
