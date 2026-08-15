---
name: pr-pipeline
description: Manage this repo's (ScottieR/canopy) PR auto-review-and-merge pipeline, its per-task git worktrees, and the local master-sync job. Use this whenever the user wants to start a new coding task or thread in this repo (they should get an isolated worktree, not edit the shared main checkout directly — that's what causes concurrent sessions to collide), check on open PRs or whether one got auto-merged, understand why a PR didn't auto-merge, verify or finish the one-time setup (ANTHROPIC_API_KEY secret, the local-sync launchd job), or explain what the background sync recently did (fast-forward pulls, worktree cleanups). Trigger even if the user just says "start a new task/branch for X", "spin up a worktree for Y", "what's the PR status", or "why didn't my PR merge" without naming the pipeline explicitly.
---

# PR Pipeline

This repo has three pieces working together so the sole developer never has to manually
review routine PRs, merge them, pull master locally, or clean up branches:

1. **`.github/workflows/pr-auto-review-merge.yml`** — runs on every PR against `master`.
   Reuses `.github/workflows/security.yml` as the CI gate (via `workflow_call`), checks a
   fixed sensitive-path guard, and runs a Claude review (`anthropics/claude-code-action@v1`)
   that returns a structured verdict covering two separate things:
   - **Correctness/safety** (`verdict` + `blocking_issues` + `risk_level`) — this gates
     the merge. Squash-merges + deletes the branch only when **all four** of CI-passed /
     path-guard-clear / `verdict: approve` / `risk_level` not `high` are true. A PR can be
     bug-free and still get held for `risk_level: high` alone (blast radius, not just "did
     it find something") — see `alert-high-risk` below for what happens then.
   - **Approach** (`improvement_suggestions`) — never gates the merge. Filed as GitHub
     issues labelled `claude-suggestion` for you to triage whenever, completely decoupled
     from whether the PR merged.

   Anything short of the four merge conditions only ever gets a posted comment/review —
   it never merges outside those conditions.
2. **`scripts/worktree/new-task.sh <branch-name>`** — creates an isolated git worktree
   off `origin/master` under `~/Developer/Agent Management/canopy-worktrees/<branch>`.
3. **`scripts/local-sync/`** — a launchd job (10-minute interval, installed via
   `scripts/local-sync/install.sh`, never auto-installed) that fast-forward-pulls
   `origin/master` into the main checkout (only when it's on `master` with a clean
   tree), and removes worktrees whose branch was pushed and then merged+deleted on
   origin. Logs to `~/Library/Logs/canopy-local-sync.log`.

When this skill triggers, actually run the commands below on the user's behalf rather
than just describing them — the whole point of this system is that they shouldn't have
to copy-paste into a terminal themselves.

## Starting a new task

Whenever the user wants to start new work in this repo, don't edit the shared main
checkout directly (`~/Developer/Agent Management/canopy`) — if another session is
already working there, you'll see its in-flight edits and it'll see yours. Create a
worktree instead:

```bash
bash "$HOME/Developer/Agent Management/canopy/scripts/worktree/new-task.sh" <branch-name>
```

Pick `<branch-name>` from what the user describes (e.g. `feature/dark-mode`,
`fix/agent-timeout`) — match the existing `feature/`, `fix/`, `chore/` prefixes already
used in this repo's branch history. The script prints the worktree path; `cd` there and
do the work in that directory, not the main checkout. Push the branch and open a PR
(`gh pr create --base master`) when done — everything past that point is automatic.

## Checking pipeline status

To see what's open and what state each PR is in:

```bash
gh pr list --repo ScottieR/canopy --state open
gh pr view <number> --repo ScottieR/canopy --json state,mergeable,statusCheckRollup,reviews,comments
gh run list --repo ScottieR/canopy --workflow "PR Auto Review & Merge" --limit 10
```

To understand why a specific PR *didn't* auto-merge, check in this order (this mirrors
the workflow's own job order):

1. **Did `verify` (the reused `security.yml` gate) fail?** — `gh run view <run-id>
   --log-failed` on the `PR Auto Review & Merge` run for that PR.
2. **Did the sensitive-path guard fire?** — look for a PR comment titled "Auto-merge
   skipped" naming the matched path(s). This is a fixed guard, not a per-PR setting —
   see "Adjusting what's always-needs-a-human" below if the user wants to change it.
3. **Did Claude request changes, or flag it high-risk?** — look for a PR review titled
   "Automated review (Claude)"; it shows both `verdict` and `risk_level`. A PR with
   `verdict: approve` but `risk_level: high` still won't auto-merge — that's intentional,
   not a bug. If it's high-risk, the PR will also be assigned to the repo owner and
   commented on by `alert-high-risk` — mention that to the user rather than making them
   go find it themselves.

If none of those explain it, the PR is probably just still running — check `gh run
list` for an `in_progress` run.

## One-time setup — check and finish if incomplete

Two things need to exist before the pipeline actually works; check both when the user
asks about setup or when something seems to not be firing:

**1. `ANTHROPIC_API_KEY` repo secret** (required for the Claude review step):
```bash
gh secret list --repo ScottieR/canopy | grep ANTHROPIC_API_KEY
```
If missing, tell the user to add it — this needs a real API key value, so don't try to
set it yourself: `gh secret set ANTHROPIC_API_KEY --repo ScottieR/canopy` (it will
prompt for the value, or read it from stdin). Same rule for the optional
`SLACK_WEBHOOK_URL` secret (adds a Slack alert alongside the always-on GitHub
notification for `risk_level: high` PRs) — mention it exists, don't set it yourself.

**2. The local-sync launchd job**:
```bash
launchctl list | grep com.canopy.local-sync-master
```
If that prints nothing, it isn't installed. Tell the user to run (don't run this one
yourself — installing a persistent background job is their call, not something to do
silently on their behalf):
```bash
bash "$HOME/Developer/Agent Management/canopy/scripts/local-sync/install.sh"
```

## Reading the local-sync log

```bash
tail -50 "$HOME/Library/Logs/canopy-local-sync.log"
```
Each line is one run of `sync-master.sh` + `cleanup-merged-worktrees.sh`, timestamped,
one outcome per line (`OK: ...`, `SKIP: ...`, `CLEANUP: ...`, `ERROR: ...`). Summarize
recent activity for the user rather than dumping the raw log — e.g. "fast-forwarded
master twice today, cleaned up one worktree for the branch that just merged."

## Triaging suggested improvements

Every non-sensitive-path review that runs also asks Claude "is this the best approach,"
separately from "is this correct" — those ideas never block a merge, they land as GitHub
issues labelled `claude-suggestion` so they don't get lost but also don't slow anything
down. When the user asks what's been suggested, or wants to work through the backlog:

```bash
gh issue list --repo ScottieR/canopy --label claude-suggestion --state open
gh issue view <number> --repo ScottieR/canopy
```

Walk the user through each one and ask accept or discard — there's no special status
field, just use GitHub's own issue lifecycle:
- **Accept** (turn it into real work): leave it open, optionally `gh issue edit <number>
  --add-label planned` and/or `--milestone`/`--assignee` if the user wants to act on it
  now or track it for later.
- **Discard**: `gh issue close <number> --repo ScottieR/canopy --comment "<why>"` — a
  one-line reason is worth keeping even for a discard, so a future you (or the user)
  doesn't wonder why a seemingly-reasonable suggestion was dropped.

Don't silently close things the user hasn't actually looked at — this triage step exists
because "list every suggestion Claude has ever made and just do them" isn't the point;
the point is a human decides which architectural opinions are actually worth the churn.

## Adjusting what's always-needs-a-human

The sensitive-path guard (release workflows, `keychain.rs`, `payment.rs`,
`jit_server.rs`, `chrome_cookies.rs`, `tauri.conf.json`) is a fixed regex baked into
`.github/workflows/pr-auto-review-merge.yml`'s `sensitive-path-guard` job (the
`PATTERN` variable) — it is not a runtime setting this skill can toggle. If the user
wants to change which paths always require manual review, that's a normal edit to that
workflow file, which itself needs to go through a PR (and per the guard's own rule,
touching `.github/workflows/**` always requires a human to merge it — it can't
auto-approve a change to its own authority).
