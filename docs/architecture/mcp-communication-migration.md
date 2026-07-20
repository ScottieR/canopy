# MCP Communication Migration Plan

Last updated: July 18, 2026

## Goal

Move Canopy's integration and tooling layer toward an MCP-based architecture without rewriting the trusted local runtime, keychain, or session engine.

For communication connectors, the near-term target is:

1. Make every communication connector a first-class bridge record in Canopy.
2. Standardize connector metadata, permissions, and scope under MCP-style bridge semantics.
3. Keep existing connector transports working while we progressively swap transport/runtime paths to MCP servers.

## What Stays Native

These remain Canopy/Tauri-native even after MCP adoption:

- keychain and secret storage
- host OS permissions and local privacy prompts
- thread/session lifecycle, resumability, and cancellation
- local filesystem / computer-control safety rails
- per-agent ownership checks and tenancy enforcement

## What Moves To MCP

These should migrate to MCP-hosted tooling over time:

- Slack
- Gmail / Google email
- iMessage bridge surface
- Telegram
- Discord
- WhatsApp
- Twilio / SMS
- future external communication channels

## Migration Shape

### Phase 0: Foundation

- Treat communication connectors as MCP-style bridges in the database.
- Give each connector a durable bridge record with:
  - bridge type
  - permissions
  - scope / allowlist
  - push semantics
  - enabled state
- Sync these bridge records whenever:
  - integrations change
  - connector credentials change
  - connector allowlists change

### Phase 1: Host-Side MCP Registry

- Add a Canopy-owned MCP registry for installed / active servers.
- Map bridge records to MCP server descriptors.
- Surface recommended, bundled, and full tool lists from that registry.

### Phase 2: Communication Connector Adapters

- Slack: move from direct OpenClaw channel config to an MCP adapter with allowlisted channels and send/read tools.
- Gmail: expose read/send/search as MCP tools plus mailbox resources.
- iMessage: wrap current watcher + read path as an MCP adapter.
- Telegram / Discord: bridge current bot credentials and config into MCP descriptors first, then replace the runtime channel path.

### Phase 3: Long-Running MCP Task Alignment

- Map Canopy thread runs to MCP Tasks-style execution:
  - queued / running / input_required / completed / cancelled
  - checkpoints
  - resumability
  - hard cancellation

### Phase 4: External Host Interop

- Allow Canopy-managed MCP servers to be consumed by external hosts like Claude Desktop or Codex.
- Add remote / private-host support only after local host semantics are stable.

## First Execution Slice

This implementation pass focuses on communication connectors only.

### In Scope Now

- MCP-style bridge synchronization for:
  - Slack
  - Gmail
  - iMessage
  - Telegram
  - Discord
- preserving existing custom runtime behavior while normalizing bridge state
- adding the backend hooks so integration toggles and connector config changes keep bridge state current

### Explicitly Not In Scope Yet

- replacing Slack/Gmail runtime execution with standalone MCP servers
- new UI for bridge catalogs or tool bundles
- external host connectivity
- evals / admin scoring loops

## Connector Mapping

### Slack

- Bridge type: `slack`
- Permissions: read + write
- Scope: allowed channels
- Push: true
- Current runtime: OpenClaw channel config
- Migration note: preserve existing channel allowlist bridge record and converge runtime later

### Gmail

- Bridge type: `gmail`
- Permissions:
  - `email_read` => read only
  - `email_write` => read + write
- Scope: mailbox mode and future label filters
- Push: false initially
- Current runtime: OpenClaw Google plugin / token injection

### iMessage

- Bridge type: `imessage`
- Permissions: read by default, write when send path is promoted
- Scope: allowed threads
- Push: true
- Current runtime: existing background watcher + local DB read path

### Telegram

- Bridge type: `telegram`
- Permissions: read + write
- Scope: bot delivery metadata, future allowlisted chats
- Push: true
- Current runtime: OpenClaw single-bot channel path

### Discord

- Bridge type: `discord`
- Permissions: read + write
- Scope: guild metadata, future allowlisted channels
- Push: true
- Current runtime: OpenClaw single-bot channel path

## Success Criteria For This Slice

- communication connectors are no longer invisible special cases
- bridge records reflect actual Canopy integration intent
- scope metadata is preserved across toggles and reconnects
- later MCP runtime migration can build on bridge records instead of reverse-engineering the UI and keychain state again
