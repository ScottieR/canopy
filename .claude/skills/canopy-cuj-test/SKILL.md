---
name: canopy-cuj-test
description: Run a real, hands-on-keyboard end-to-end test of a critical user journey (CUJ) in the running Canopy desktop app — actually clicking through the UI and talking to a real agent, not just reading code. Use this whenever the user describes something they want tested in Canopy ("test the onboarding flow", "have an agent try to connect Slack and see what breaks", "walk through creating an agent and see where it gets confusing", "does X actually work end to end", "find the friction in Y"), asks what's broken or missing in a flow, or wants a UX/product review of part of the app. Always produces two separate outputs — real bugs/gaps found while testing, and non-blocking UX/product improvement ideas from a second reviewing pass — and never writes code to fix anything until the user explicitly says which findings to act on.
---

# Canopy CUJ Test

Two phases, done by two different actors, on purpose — don't collapse them into one pass:

1. **Tester** (you, the main session, hands-on-keyboard via computer-use): actually drives
   the running Canopy app through the journey the user described, step by step, and logs
   every place it breaks, confuses, stalls, or falls short of what was asked — including
   whether the underlying AI agent inside Canopy actually does what the user asked it to,
   not just whether the UI rendered. This is real testing, not code review — if you find
   yourself reasoning from `src/` instead of from what's on screen, you're doing it wrong.
2. **Observer** (a spawned subagent with a senior product/design persona, reviewing your
   transcript afterward, not driving the app itself): looks at the same recorded journey
   purely for UX and product opportunities — could this be fewer steps, clearer copy, a
   faster path to the user's first real value. It does not re-litigate bugs the tester
   already found, and it does not propose code — only ideas for a human to accept or
   discard.

Both phases end in a report, never in code changes. Only after the user picks specific
findings to act on do you touch `src/`/`src-tauri/` — and when you do, use the normal
workflow (`scripts/worktree/new-task.sh`, a PR through the existing pipeline), not a
direct edit to whatever's currently checked out.

This skill was hand-written rather than run through the full skill-creator eval loop
(parallel benchmark runs, description-trigger optimization) — that machinery is built for
skills meant to generalize across many future callers; this one is a bespoke operational
tool for one repo and one developer, so the juice isn't worth the squeeze there.

## Phase 0 — Get on screen

1. **Confirm the journey is concrete enough to test.** "Test onboarding" is fine. "Make
   sure everything works" is not — ask what specifically, or pick the single most
   important journey for the area they named and say which one you're running.
2. **Make sure Canopy is actually running:**
   ```bash
   ps aux | grep "tauri dev" | grep -v grep
   ```
   If nothing's running, start it in the background and give it time to open a window:
   ```bash
   cd "$HOME/Developer/Agent Management/canopy" && npm run tauri dev > /tmp/canopy-dev.log 2>&1 &
   ```
   Also confirm the gateway containers are up (`docker ps | grep canopy-gateway`) — if the
   journey involves an agent actually responding, a dead gateway will masquerade as a UI
   bug. Note which containers were running when you check, so you can tell the difference
   between "the app is broken" and "the backend isn't up."
3. **Request computer-use access to Canopy** (and any other app the journey genuinely
   needs — e.g. Chrome for an OAuth step):
   ```
   request_access(apps: ["Canopy"], reason: "<one line on the journey being tested>")
   ```
   If this fails with **"can't be approved during a scheduled run"**: this is a known
   environment restriction, not something retrying fixes (the tool says so explicitly —
   believe it, don't loop). Tell the user directly and stop here rather than silently
   falling back to describing the app from code, which is not what this skill is for.
   This has actually happened — see the session that first tried to build this skill.

## Phase 1 — Test it (you, live, on screen)

Walk the journey the way a real first-time user would, not the way you'd navigate if you
already knew the codebase. For each meaningful step:

- Screenshot before acting on anything non-obvious, and after anything that should have
  changed state (submitted a form, sent a chat message, connected an integration).
- Note what you expected to happen and what actually happened. A match is still worth a
  one-line log entry — the log is what Phase 2 reads, and "this step worked cleanly" is
  real signal too, not just failures.
- When the journey involves asking an in-app agent to do something, **wait for and read
  its actual response** — don't count "the message sent" as success. If the agent claims
  to have done something, that's a finding worth flagging on its own if you have no way to
  verify it actually happened (that gap is itself a product problem: silent unverifiable
  claims erode trust).
- Classify anything that isn't clean as **blocker** (can't continue the journey at all),
  **major** (worked around it, but a real user would likely give up or file a bug), or
  **minor** (cosmetic, confusing copy, small friction).
- If you hit a genuine blocker, don't force your way past it with backend workarounds
  (direct DB edits, skipping the UI) just to keep testing — that defeats the point. Log
  the blocker, note what you tried, and either stop or ask the user whether to route
  around it for the rest of the journey.

Keep the running log in a simple structured form (a markdown table or numbered list is
fine) — you'll hand this whole thing to the Phase 2 subagent verbatim, plus the
screenshot files. Save screenshots to the scratchpad directory so they have stable paths
to reference (use `save_to_disk: true` on the screenshot/computer_batch calls).

**Verify the screenshots actually landed on disk after your FIRST batch** (`ls` the
scratchpad / search for recent `*.png`) — in the 2026-08-24 run, `save_to_disk: true`
silently wrote nothing anywhere findable, and the gap was only discovered at Phase 2
handoff time. If files aren't materializing, don't burn time hunting: write the log
richly enough to stand alone (quote on-screen copy verbatim, describe layout and state
changes) and tell the Phase 2 observer explicitly that it's working from the log only.

## Phase 2 — Review it for UX opportunity (spawned subagent)

Spawn a subagent (`Agent` tool, foreground — you need its output before reporting) with a
prompt along these lines:

> You are a senior product designer / PM reviewing a recorded user-journey test of the
> Canopy app. You were NOT present for the test — you're reviewing the tester's log and
> screenshots after the fact. Here is the journey that was tested: `<CUJ description>`.
> Here is the step-by-step log: `<full Phase 1 log>`. Screenshots are at: `<file paths>`.
>
> Your job is NOT to find bugs — assume the tester already caught anything actually
> broken. Your job is to spot opportunities a good product/design review would catch even
> in a flow that technically works: unnecessary steps, unclear labels or copy, places a
> user has to make a decision before they have enough context to make it, missing
> feedback after an action, anything that delays the user's first real "this is working"
> moment. Read every screenshot, not just the log text.
>
> Return a structured list. For each suggestion: a short title, what the current
> experience is, what you'd change, and why it matters (impact on completion rate,
> confusion, time-to-value — whichever applies). Skip anything you don't have a genuine,
> specific opinion on — don't manufacture suggestions to fill a quota. If the flow is
> genuinely good, say so plainly instead of inventing nitpicks.

Pass the subagent `Read` access to the screenshot files (they're images — `Read` renders
them) and the full log inline in the prompt.

## Reporting

Present two clearly separate lists to the user — don't merge them, the distinction (found
broken vs. could be better) is the point:

1. **Bugs and gaps found** (from Phase 1) — what broke, what's missing, what the agent
   couldn't actually do. Include severity and enough repro detail (the step log) that
   someone could reproduce it without re-running the test.
2. **UX/product suggestions** (from Phase 2) — the observer's list, verbatim or lightly
   edited for clarity, never silently dropped or "improved" by you.

If the user wants them tracked rather than just read once, file them as GitHub issues —
reuse the same convention the PR pipeline already uses so everything triages in one
place:
```bash
gh issue create --repo ScottieR/canopy --title "<title>" --body "<repro/rationale>" --label "cuj-bug"          # Phase 1 findings
gh issue create --repo ScottieR/canopy --title "<title>" --body "<rationale>"        --label "claude-suggestion" # Phase 2 findings
```

**Never start implementing fixes from this report on your own.** Wait for the user to
pick specific findings ("fix the blocker in #2", "let's do suggestion 3"). When they do,
use the normal workflow: `scripts/worktree/new-task.sh <branch>`, make the change there,
open a PR — the same path everything else in this repo goes through.
