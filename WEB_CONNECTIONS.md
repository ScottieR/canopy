# Web-Hosted Connection Token Capture — canopy-admin contract

This document specifies what **canopy-admin** (the separate Cloud Run backend repo)
needs to implement to support Canopy desktop's web-hosted API-key capture flow. It is
the counterpart to `src-tauri/src/web_connections.rs` in this repo, which is already
implemented and merged. **Nothing in this file should be built in the Canopy/Tauri
repo** — it's a spec for the canopy-admin side.

## Why this exists

Today, when an agent needs a provider API key mid-conversation, Canopy asks the user to
open a companion window inside the desktop app via a `canopy://` deep link. That works
great when the user is at their desktop, but falls over when they're replying from Slack
on a phone: the deep link only resolves if the desktop app happens to be reachable from
that device, which — especially iPad/iPhone → desktop — is unreliable.

This flow replaces the deep link with a plain `https://` page the user can open on any
device, no desktop reachability required. The key is still never visible to canopy-admin
or the agent — it's encrypted in the browser to the specific Canopy install's public key
before it's ever sent over the wire, and only that install can decrypt it.

## What the Canopy desktop side already does

1. Generates a UUID v4 `token`.
2. Generates (once per install, cached in the macOS Keychain) an X25519 keypair. Only
   the public key ever leaves the machine.
3. POSTs the token + metadata + its public key to `POST /api/connections/pending`.
4. Shows the user a Slack message with a plain link to `{base}/connect/{token}`.
5. Polls `GET /api/connections/pending?agent_id=` every 5 seconds.
6. When a token shows up as completed, decrypts the delivered ciphertext locally with
   its private key and stores the plaintext key in the Keychain vault. The raw key is
   never logged and never sent back to the agent.

## Endpoints canopy-admin needs to implement

### `POST /api/connections/pending`

Called by the Canopy desktop app to register a new capture request.

Request body:

```json
{
  "token": "5a1e1e0a-...-uuidv4",
  "agentId": "agent-abc123",
  "providerName": "Seats.aero",
  "secretName": "SEATS_AERO_API_KEY",
  "tokenUrl": "https://seats.aero/account",
  "instructions": "Sign in to your Seats.aero Pro account, open the Developer tab, and copy your API Key.",
  "placeholder": "sk_...",
  "publicKey": "base64-encoded-32-byte-X25519-public-key",
  "expiresAt": "2026-08-16T12:34:56.789+00:00"
}
```

Notes:
- `tokenUrl`, `instructions` may be `null`. `secretName`/`placeholder` are always present.
- `providerName` is 1–200 chars; `instructions` is capped at 600 chars server-side by
  Canopy, but canopy-admin should not trust that and should re-cap/sanitize on its own
  before rendering it as HTML on the `/connect/{token}` page (it's agent-authored text).
- `publicKey` is 32 raw bytes, base64-standard-encoded. It's re-sent with every request
  (not fetched separately) — there's no separate "get this install's key" endpoint.
- Store the row with `status: "pending"`. Reject (400) if `expiresAt` is more than ~20
  minutes in the future or already in the past — Canopy always sends `+15 minutes`, so a
  request outside a small tolerance window suggests clock skew or a bad actor.

Response: any 2xx. Canopy desktop doesn't parse a body from this call, only the status
code — a token that fails to register never gets shown to the user (the Slack message
falls back to the legacy `canopy://` deep link automatically).

### `GET /connect/{token}` — the capture page

A public (no auth) web page. On load:

1. Look up `token`. If missing, already completed, or past `expiresAt`, render an
   "This link has expired or was already used" state — do not render a form.
2. Otherwise render: `providerName`, `instructions` (as plain text — **never** as raw
   HTML; it's agent-authored input), a single text input pre-filled with `placeholder`
   as its placeholder attribute, and a submit button. If `tokenUrl` is present, show it
   as "Where do I find this?" linking out.
3. On submit, **before** sending anything over the network:
   - Generate a fresh ephemeral X25519 keypair (new for every submission — never reuse
     one across page loads or tokens).
   - Compute the ECDH shared secret between the ephemeral private key and the stored
     `publicKey` for this token.
   - Derive a 32-byte AEAD key via HKDF-SHA256 over the shared secret, with **no salt**
     and info string `"canopy-web-connections-v1"` (ASCII bytes, exact match required —
     this is a domain-separation tag, not a secret).
   - Generate a random 12-byte nonce.
   - Encrypt the plaintext key with ChaCha20-Poly1305 (IETF variant, 96-bit nonce,
     matches the `chacha20poly1305` Rust crate's default construction) using that key
     and nonce. The resulting ciphertext includes the 16-byte Poly1305 tag appended, per
     the standard AEAD output convention.
4. POST the result to `/api/connections/complete/{token}` (below). Never POST the
   plaintext key anywhere, and never log it client-side either (no `console.log`, no
   analytics, no error-reporting breadcrumbs containing the input value).

Suggested browser-side crypto libraries: neither X25519 nor ChaCha20-Poly1305 is
supported everywhere via native WebCrypto (`SubtleCrypto`) yet — use a small audited JS
library such as `@noble/curves` (X25519) + `@noble/ciphers` (ChaCha20-Poly1305), or
libsodium.js, rather than hand-rolling either primitive.

### `POST /api/connections/complete/{token}`

Called by the `/connect/{token}` page on submit.

Request body:

```json
{
  "ciphertext": "base64",
  "nonce": "base64, must decode to exactly 12 bytes",
  "ephemeralPublicKey": "base64, must decode to exactly 32 bytes"
}
```

Behavior:
- 404/410 if the token doesn't exist, was already completed, or is past `expiresAt` —
  re-validate the TTL server-side, don't just trust that the page wouldn't have rendered
  a form for an expired token.
- On success, mark the row `status: "completed"` and store the three fields above
  alongside it (still just ciphertext to canopy-admin — it cannot decrypt this). Respond
  200 with a small JSON ack (e.g. `{"status":"ok"}`) so the page can show a success
  state ("Connected! You can close this window — Canopy will pick it up shortly.").
- A token can only be completed once. A second POST to an already-completed token should
  404/409, not overwrite.

### `GET /api/connections/pending?agent_id=<id>`

Polled by the Canopy desktop app every 5 seconds.

Response:

```json
{
  "completed": [
    {
      "token": "5a1e1e0a-...",
      "ciphertext": "base64",
      "nonce": "base64",
      "ephemeralPublicKey": "base64"
    }
  ]
}
```

Behavior:
- Only include rows where `agentId` matches the query param **and** `status ==
  "completed"`. Never include `status: "pending"` rows here — those aren't ready yet and
  contain no ciphertext.
- **This GET is destructive**: once a completed row is included in a response, delete it
  (or otherwise make it permanently unreturnable) as part of serving that response. Do
  not wait for a separate acknowledgment call — there isn't one. This means if the
  desktop's HTTP client never receives the response (a network blip mid-transfer), that
  one capture is lost and the user has to redo the flow from a fresh `[request_connection:
  api_key?...]` — that's an accepted, intentionally rare failure mode: it fails closed
  (no lingering exposure) rather than open.
- Also sweep `pending` (never-completed) rows past their `expiresAt` on some cadence —
  a cron/scheduled function, or lazily on each request. They should never be completable
  after expiry regardless.

## Data handling requirements

- **At-rest encryption**: use your platform's standard disk/database encryption
  (Cloud SQL, Firestore, etc. all do this by default) for the `pending_connections`
  table. This is defense-in-depth only — the stored `ciphertext` is already useless to
  anyone without the specific Canopy install's private key, which never leaves that
  machine.
- **TTL**: 15 minutes from `expiresAt` as sent by Canopy. Enforce it on both the
  `/connect/{token}` page (don't render a form for an expired token) and the `complete`
  endpoint (re-validate server-side — the page render check is a UX nicety, not the
  security boundary).
- **Deletion after pickup**: rows are deleted (not just marked) once returned by the
  polling GET, per above. Also delete pending (never-completed) rows once their TTL
  passes, even if never picked up.
- **Never log the plaintext key** anywhere in canopy-admin — you should never have it in
  the first place (that's the point of the encryption), but this also covers:
  `providerName`/`instructions`/`placeholder` are agent-authored and safe to log for
  debugging; `ciphertext`/`nonce`/`ephemeralPublicKey` are safe to log (they're useless
  without the private key); nothing else related to this feature should ever contain a
  raw secret value.
- **No auth on `/connect/{token}` or `/api/connections/complete/{token}`**: the token
  itself (128 bits of randomness, UUID v4) is the credential. Don't add a login wall —
  the whole point is the user can complete this from a browser that isn't signed into
  anything. Standard rate-limiting on the complete endpoint (e.g. by IP) is reasonable
  to blunt brute-force token guessing, though at 15-minute TTL and UUID v4 entropy this
  is a defense-in-depth measure, not the primary protection.

## Reference: the exact Rust implementation this must interoperate with

See `src-tauri/src/web_connections.rs` in this repo for the authoritative encrypt/decrypt
implementation (the `decrypt_delivered_secret` function and its round-trip test). Keep
this document's crypto description in sync with that file if either changes — the two
sides must agree on: X25519 for ECDH, HKDF-SHA256 with no salt and info
`"canopy-web-connections-v1"`, and ChaCha20-Poly1305 (IETF, 12-byte nonce) for the AEAD
step.
