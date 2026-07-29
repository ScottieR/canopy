# Onboarding Browser Test — Three-Beat Flow (updated July 28, 2026)

Covers the conversational onboarding shipped per
`IMPLEMENTATION_PLAN_ONBOARDING_POLISH_2026-07-28.md`. Run against a fresh
profile (clear `canopy_onboarding_draft`, `canopy_initial_setup_complete`,
`canopy_onboarding_config` in localStorage). For live-agent paths, run
canopy-admin locally with `ANTHROPIC_API_KEY` set; repeat the beat-3 section
once with the admin server stopped to verify the script fallback.

## Beat 1 — Meet Eddie / meet your draft

1. Progress header shows exactly **3 beats**: "Meet Eddie · Meet your agent · Give them power". No fourth dot.
2. Type a need (e.g. "help tutor my three boys in math") → draft reveal panel appears with portrait, editable name, and the **interview chat** ("{Name} has a question for you") showing an opening question instantly.
3. Answer the interview once → agent asks a follow-up (live) or degrades gracefully (offline copy). Max 3 questions, then "Identity notes saved ✓".
4. Open the studio later and confirm the Identity notes toggle contains a "What you know about your human:" section with your answers.
5. Swap role via an alternate pill → interview restarts in the new persona.
6. "Skip to power up" lands directly on the beat-3 conversation.

## Beat 2 — Studio

1. Personality is COLLAPSED by default behind "Identity notes ▸"; expands/edits/collapses cleanly.
2. Mouse-wheel over the close-up canvas scrolls the page — it must NOT zoom. The −/•/+ buttons resize the agent. Rotate by drag still works.
3. No chat pane in the studio (moved to beat 1). CTA "Give {Name} power →" → beat-3 conversation.

## Beat 3 — The power-up conversation (step 3.7)

1. **No dead clicks:** the mission message appears and auto-advances (~1s) into the first real ask WITHOUT clicking "Let's do it". Detected-brain confirmations also auto-advance.
2. **Chips sit under the last agent message**, inside the conversation flow — not detached at the bottom.
3. **← Back** returns to the studio. Draft survives.
4. **Setup-plan rail** (window ≥1000px): lists channel, suggested connections, routines, brain, launch. Current item marked ●; accepting marks ✓; declining marks – with strikethrough + "add anytime later".
5. Channel ask chips: Telegram opens the companion window; Slack/mobile acknowledge and defer to post-deploy pairing; "Later" gets a graceful in-voice skip.
6. Connection ask shows the **template sensitivity warning card** (e.g. File access → "Pick a specific folder"). Accept opens setup; nothing ever launches without a click.
7. Free text at any point gets a sensible response (live agent replies in-voice; script mode routes to chips or acknowledges gracefully). Never a stuck state.
8. "Prefer a checklist?" opens the full connections screen; its toggles LAUNCH real setup when enabled; "Back to the conversation" returns to the chat.
9. Close ask: "Put me to work →" → deploy screen (engine gate modal if engine not ready — verify Retry/Save exits). "Review everything first" → checklist.
10. **Fallback:** stop canopy-admin mid-conversation → next turn silently continues via the deterministic script (no error screen).

## Post-deploy checks

1. Agent's workspace `USER.md` contains "## Learned during onboarding" with the interview facts; `SOUL.md` contains the identity notes and the "Your files are living documents" section.
2. Starter task runs and references the discovery input.
3. In the deployed agent's chat, a `[request_connection:]` tag from the agent renders an **approval card** ("{Name} wants to connect X") — the companion window opens only on "Approve & open setup".

## Regression sweep

- Every button on every screen either acts or explains what's pending — no dead controls (BlinkClaw import button removed; Photos no longer fake-connects).
- Draft resume: quit at each beat, relaunch, confirm resume lands sensibly (old step 3/4/5 drafts land in the conversation).
- Add-agent flow (existing user) still works end to end.

## Expected outcome

Fresh Mac → typed one sentence → interviewed by a named, voiced draft → dressed it → tailored asks with real choices only → deployed with a first task, in under 8 minutes with zero dead ends.
