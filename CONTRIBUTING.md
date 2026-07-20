# Contributing to Canopy

Canopy is an active macOS-first portfolio project. Contributions should be small, reviewable, and preserve its local-first and per-agent isolation guarantees.

## Development setup

Follow the [README quick start](README.md#quick-start), then run the release gate before opening a pull request:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test -- --run
npm run build

cd src-tauri
cargo fmt --check
cargo check --locked
cargo test --locked
```

## Security boundaries

- Never commit populated `.env` files or runtime credentials.
- Never make one agent inherit another agent's credentials or integrations.
- Keep privileged operations behind narrow Tauri commands with validation.
- Do not add desktop calls to server-funded LLM endpoints. Eddy and agent inference must use the user's provider directly or an on-device model.
- Add regression tests for credential scope, shell/path handling, IPC allowlists, and authorization changes.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Pull requests

Explain the user-visible outcome, testing performed, and any privacy or migration implications. Keep refactors behavior-preserving unless the pull request explicitly documents a product change. Do not mix generated artifacts or unrelated formatting into functional changes.
