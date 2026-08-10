# Changelog

All notable changes to Canopy are documented in this file.

## [0.3.0] - Unreleased

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
- **Tier 5 — Sandboxed agent browser** (`web_sandbox_browser` capability, **scaffolded**):
  capability flag, `launch_agent_browser` command, and intended profile-directory layout
  are in place; the Playwright-backed sandboxed Chromium itself is a TODO.
- **Tier 6 — Full Chrome control** (`browser_control` capability, **scaffolded**):
  capability flag, `chrome_navigate`/`chrome_click`/`chrome_type`/`chrome_get_content`/
  `chrome_screenshot` command signatures, and the required system-prompt injection
  ("you are controlling the user's real Chrome browser...") are in place; live CDP
  control of the user's actual running Chrome is a TODO.

### Security

- Fetched web content is untrusted input: agents are instructed (via `PERMISSIONS.md`)
  to wrap it in `<web_content source="...">` before reasoning over it and to never treat
  instructions found inside it as commands.
- Tier 4 never grants blanket Chrome-profile access — cookies are extracted strictly for
  the one domain the user approved, not subdomains, not the rest of the user's logins.
- Tier 6 (once implemented) requires per-action-batch user confirmation and hard-blocks
  click/type on financial-transaction pages even when `browser_control` is enabled.

### Changed

- `AgentCapabilities` gained six new fields: `web_search`, `web_browse`, `web_auth`,
  `web_sandbox_browser`, `browser_control` (all default `false` — opt-in). The Access
  Level presets (Guarded/Balanced/Unrestricted) and the Fine-tune capabilities panel in
  Agent Settings reflect all six.

## [0.2.0] - Prior release

See commit history for changes prior to the changelog's introduction.
