# Security policy

## Project status

Canopy is an active portfolio preview. It is not yet intended for production use with high-stakes data, unattended financial actions, or credentials that cannot be promptly revoked.

Security fixes are applied to the latest commit on `master`; older commits and preview builds are not supported separately.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include secrets, personal data, exploit details, or private logs in an issue or discussion.

After the repository is public, use **Security → Advisories → Report a vulnerability** on GitHub. Include:

- the affected commit or app version;
- the component and platform involved;
- concise reproduction steps;
- the security impact and required preconditions;
- logs or proof of concept with all credentials and personal data removed.

You should receive an acknowledgement within five business days. Please allow time to investigate and coordinate a fix before public disclosure.

## Scope

Useful reports include credential-boundary failures, cross-agent data access, command or path injection, unsafe Tauri IPC exposure, sandbox escapes, authentication bypasses, sensitive-data transmission outside the documented privacy boundary, and abuse paths that can spend hosted provider credentials.

Reports about model output quality, prompt injection wholly contained within an agent's authorized workspace, provider outages, or unsupported operating systems are usually product issues rather than security vulnerabilities unless they cross a trust boundary.

## Handling secrets

Canopy runtime credentials belong in the macOS Keychain-backed vault. Never commit provider keys, OAuth secrets, signing keys, GitHub tokens, production admin keys, database URLs, or populated `.env` files. If a real credential reaches Git history, revoke it first, remove it from every reachable ref, and contact GitHub Support when pull-request refs or cached views remain.

Agents and onboarding flows must not collect raw secrets conversationally. Passwords, API keys, OAuth codes, access tokens, refresh tokens, client secrets, cookies, and `.env` contents should only move through the secure companion / bridge flows and the Keychain-backed vault, never through agent chat, workspace files, or memory files.

For custom OAuth providers, the companion flow may store provider metadata plus already-issued access or refresh tokens in agent-scoped Keychain entries referenced by the bridge configuration. The agent should request the secure flow; it should never receive or persist the secret material directly.
