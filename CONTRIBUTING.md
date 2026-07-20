# Development notes for authorized contributors

Canopy is an active macOS-first portfolio project. The public evaluation license does not grant permission to modify or create derivative works, and unsolicited pull requests are not currently accepted. These notes apply to collaborators who have received separate written authorization. Authorized changes should be small, reviewable, and preserve Canopy's local-first and per-agent isolation guarantees.

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
- Do not add desktop calls to general server-funded LLM endpoints. The sole exception is the bounded `/api/canopy-helper/bootstrap` first-run route: one current onboarding request and its minimal setup state, with no history, credentials, logs, agent records, or workspace content. Eddy must switch to the user's provider as soon as one is connected; agent inference always uses the user's provider or an on-device model.
- Add regression tests for credential scope, shell/path handling, IPC allowlists, and authorization changes.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Pull requests

Explain the user-visible outcome, testing performed, and any privacy or migration implications. Keep refactors behavior-preserving unless the pull request explicitly documents a product change. Do not mix generated artifacts or unrelated formatting into functional changes.
