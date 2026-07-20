# Public release checklist

Use this checklist before changing the repository from private to public. A public repository exposes the complete reachable Git history, GitHub Actions logs, commit author metadata, release artifacts, and any files that were merely deleted in later commits.

## Release blockers

- [ ] **Confirm the historical pull-request ref is purged.** GitHub Support must remove the remaining read-only `refs/pull/1/head` ref and associated cached views from the earlier secret cleanup. Do not make the repository public until Support confirms completion.
- [ ] **Choose and add a license.** Without a `LICENSE` file, viewers can read the source but do not receive permission to copy, modify, or redistribute it. Select the intended terms before describing Canopy as open source.
- [ ] **Review every GitHub Actions run and artifact.** Visibility changes make historical workflow logs public. Delete any run, log, or artifact that contains private environment details or credentials.
- [ ] **Verify a fresh clone.** On a clean macOS account or machine, follow only the README and confirm onboarding, agent creation, provider-key entry, one agent response, and app restart.
- [ ] **Run the complete release gate.** Confirm frontend tests/build, Rust check/tests/audit, and a full-history Gitleaks scan all pass on the exact commit that will become public.

## Hosted-service safety

- [x] **Protect server-funded LLM routes.** General helper and generation routes require admin authentication. First-run Eddy uses only the narrow, rate-limited onboarding bootstrap route, then switches automatically to the user's provider (or Ollama when selected).
- [ ] **Keep admin-only routes authenticated.** Reconfirm that all catalog mutation, model sync, release, and studio-generation routes reject requests without `ADMIN_API_KEY`.
- [ ] **Review public data contracts.** Confirm catalog responses and telemetry schemas contain no private customer, operator, agent, or infrastructure data.
- [ ] **Test failure behavior.** Exhausted quotas or an unavailable hosted control plane should produce a clear degraded mode and must not prevent local data access.

## Intellectual property and presentation

- [x] **Inventory visual and 3D assets.** See `docs/asset-provenance.md`; unused and duplicate legacy GLBs were removed.
- [ ] **Review templates and reading lists.** Verify that bundled text and excerpts are original, permissively licensed, public domain, or short enough to be lawful metadata/reference material.
- [ ] **Add current product media.** Capture two or three screenshots or a short GIF showing the Canopy view, an agent page, and a Forum. Do not use old concept art as if it were current UI.
- [x] **Remove repository archaeology.** Obsolete fixer scripts, duplicate numbered files, generated schemas/build output, logs, scratch programs, and superseded assets were removed; current specifications live under `docs/`.
- [ ] **Review personal metadata.** Confirm that names and email addresses in commit authorship, documents, examples, screenshots, and test fixtures are acceptable to publish.

## GitHub settings after publication

- [ ] Recreate a branch ruleset for `master`; GitHub disables push rulesets when changing a private repository to public.
- [ ] Require the security/regression workflow before merging.
- [ ] Enable private vulnerability reporting and subscribe to security-alert notifications.
- [ ] Confirm secret scanning, push protection, the dependency graph, Dependabot alerts, and Dependabot security updates are enabled.
- [ ] Disable unused repository features and restrict GitHub Actions permissions to read-only by default.
- [ ] Add a concise repository description, homepage, and topics such as `tauri`, `rust`, `react`, `typescript`, `ai-agents`, and `local-first`.
- [ ] Review the public repository page in a signed-out browser and test the clone/run path one final time.

## Final command gate

```bash
npm ci --ignore-scripts
npm audit --audit-level=high
npm run typecheck
npm test -- --run
npm run build

cd src-tauri
cargo check --locked
cargo test --locked
cargo audit

cd ..
gitleaks git . --config=.gitleaks.toml --no-banner --redact
```

Record the commit SHA and results in the release notes so the reviewed tree is the tree that becomes public.
