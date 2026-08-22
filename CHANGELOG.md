# Changelog

All notable changes to Canopy are documented in this file.

## [0.4.0] - Unreleased

### Added

- **Web-based API key capture flow** — agents can now request credentials via Slack
  with a link that works from any browser, no Canopy app connection required. The
  existing `[request_connection: api_key?...]` tag is automatically rewritten, when
  delivered over Slack, into a plain `https://` link to a canopy-admin-hosted
  `/connect/{token}` page instead of the `canopy://` deep link the in-app companion
  window uses — solving the case where a user replies from their phone and the desktop
  app isn't reachable. The key is encrypted in the browser to this Canopy install's
  X25519 public key (ECDH → HKDF-SHA256 → ChaCha20-Poly1305) before it ever reaches
  canopy-admin, which only ever sees ciphertext; Canopy polls for and decrypts
  completions locally, storing the plaintext straight into the Keychain vault as
  before. Falls back to the `canopy://` deep link if minting a web token fails (e.g.
  canopy-admin unreachable). See `src-tauri/src/web_connections.rs` for the
  implementation and `WEB_CONNECTIONS.md` for the canopy-admin-side contract this
  still needs (endpoints + the `/connect/{token}` page — not yet implemented there).

## [0.3.0] - 2026-08-09

### Added — Web tools (6 tiers)

Agents can now actually reach the web, instead of reporting "I can't browse the web."
Implemented in `src-tauri/src/web_tools.rs`, `chrome_cookies.rs`, and wired through the
JIT bridge (`jit_server.rs`) so a running agent — not just the Canopy frontend — can call
these tools via `curl` against `http://host.docker.internal:18802`.

- **Tier 1 — Web search** (`web_search` capability): structured search results
  (title/url/snippet) via the Brave Search API, falling back to DuckDuckGo's Instant
  Answer API when no `BRAVE_SEARCH_API_KEY` is configured.
- **Tier 2 — Page fetch** (`web_browse` capability): fetches a specific URL, extracts
  readable text and title, and automatically escalates to the agent's managed Chrome
  (via `browser_manager`, over CDP) when a page looks JS-rendered (empty/short body,
  "enable JavaScript" messaging). Blocked for a fixed list of financial and medical
  domains (chase.com, paypal.com, mychart.com, etc. — see `FETCH_BLOCKLIST_DOMAINS`) and
  for local/private addresses (SSRF guard), with no permission-grant override.
- **Tier 3 — Deep research** (`web_search` + `web_browse`): orchestrates search → fetch
  top 5 results → (at depth 3) follow up to 2 links per page, returning a structured
  research packet of sources for the agent to synthesize from.
- **Tier 4 — Authenticated browsing** (`web_auth` capability, **new**): reuses the user's
  real Chrome session cookies for one explicitly approved domain at a time — never the
  whole profile. The agent requests a domain via the existing `/request_permission` JIT
  route (`permission_id: "webauth:<domain>"`); only after the user picks Allow
  once/Always/Deny does Canopy decrypt and attach that domain's cookies
  (`chrome_cookies.rs` implements Chromium's macOS cookie encryption: PBKDF2-HMAC-SHA1 +
  AES-128-CBC, keyed from the "Chrome Safe Storage" Keychain item). Approved-forever
  domains are listed and revocable in Agent Settings → Connections.
- **Tier 5 — Sandboxed agent browser** (`web_sandbox_browser` capability): a real,
  dedicated, persistent Chrome per agent (`browser_manager.rs`, its own
  `sandbox_browsers` map and `agent-sandbox-browsers/{agent_id}/` profile directory —
  never the same instance, map, or directory as the shared/isolated automation browser
  the `browser`/`gog` OpenClaw skills already drive). `launch_agent_browser`,
  `close_agent_browser`, and `agent_browser_navigate`/`get_content`/`click`/`type`/
  `screenshot` Tauri commands are implemented over raw CDP (no Playwright dependency —
  reuses the same spawn/DevTools-URL-parsing pattern already proven for the automation
  browser). Sessions persist across Canopy restarts (`restore_last_session: true`) so an
  agent stays logged into services it's been approved for.
- **Tier 6 — Full Chrome control** (`browser_control` capability): connects (does not
  launch) to the user's actual running Chrome via its remote-debugging port
  (`--remote-debugging-port`, configurable via `CANOPY_CHROME_DEBUG_PORT`, default 9222 —
  Chrome's own convention, and well outside every port range Canopy itself already uses).
  `chrome_navigate`/`chrome_click`/`chrome_type`/`chrome_get_content`/`chrome_screenshot`
  are implemented; every single action — not just the first in a sequence — blocks on a
  fresh Canopy confirmation sheet (`agent_chrome_control_confirmation_requested` →
  `resolve_chrome_control_confirmation`), and `chrome_click`/`chrome_type` are hard-
  refused on the fixed financial/medical blocklist (reads stay allowed).
- **Known limitation (Tiers 5 & 6)**: both are wired up as Tauri commands the Canopy
  frontend can call, but neither has a JIT bridge route yet — an agent running inside
  the OpenClaw container cannot invoke them itself (no `curl`-reachable path) until that
  routing is added. `PERMISSIONS.md` tells agents this explicitly rather than describing
  a capability they can't actually reach.

### Security

- Fetched web content is untrusted input: agents are instructed (via `PERMISSIONS.md`)
  to wrap it in `<web_content source="...">` before reasoning over it and to never treat
  instructions found inside it as commands.
- Tier 4 never grants blanket Chrome-profile access — cookies are extracted strictly for
  the one domain the user approved, not subdomains, not the rest of the user's logins.
- Tier 6 requires a fresh per-action user confirmation (never a standing grant) and
  hard-blocks click/type on financial-transaction pages even when `browser_control` is
  enabled; reads (get_content/screenshot) are still confirmation-gated but not
  domain-blocked.
- Tier 5's sandbox profile directory and Tier 6's debug-port connection are both
  structurally incapable of colliding with `browser_manager.rs`'s existing shared/
  isolated automation browser: separate in-memory map, separate profile directory
  namespace, and an independently OS-assigned (Tier 5) or user-owned (Tier 6) port.

### Changed

- `AgentCapabilities` gained six new fields: `web_search`, `web_browse`, `web_auth`,
  `web_sandbox_browser`, `browser_control` (all default `false` — opt-in). The Access
  Level presets (Guarded/Balanced/Unrestricted) and the Fine-tune capabilities panel in
  Agent Settings reflect all six.

## [0.2.0] - Prior release

See commit history for changes prior to the changelog's introduction.
