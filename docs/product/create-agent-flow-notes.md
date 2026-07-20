# Create Agent Flow Notes

Date: June 24, 2026

## Fixes landed

- Aligned agent ID derivation across onboarding and the Rust `create_agent` command so pre-create integrations stay attached to the agent that is actually created.
- Stopped folder access setup from failing during deploy by switching onboarding to the correct bridge flow and sending the required bridge permissions payload.
- Persisted Apple Photos as a real integration during onboarding so agents that were granted Photos access actually know they have it after creation.
- Reset more onboarding state after Slack pairing / skip so stale pairing codes, selected channels, and old draft setup do not bleed into the next agent creation attempt.
- Added regression coverage for onboarding integration mapping and the new agent ID normalization behavior.

## UX / product improvements to review

- Collapse the wizard around the aha moment. The fastest path should be: pick a role, name the agent, deploy, and immediately watch that agent complete a starter task. Everything else should be optional or deferred.
- Move most integrations after first value. Slack, GitHub, folders, Photos, and Google setup are powerful, but they should be framed as "make this agent better next" rather than a prerequisite to meeting the agent.
- Add a final review card before deploy. Show name, role, model/provider, isolation mode, and selected integrations in one place so users can sanity-check before the expensive step.
- Auto-enable or strongly recommend isolation when a user grants folder access. Right now the flow allows a risky/shared interpretation that is easy to miss.
- Use progressive connection language. Replace "Set up" on every option with copy that explains the immediate payoff, like "Let them read one folder" or "Let them help in Slack."
- Let users defer naming polish. A temporary working name plus easy rename later would remove friction for users who know the job they want done before the persona details.
- Trim duplicate Google steps. If Gmail or Calendar was already connected earlier in onboarding, the user should not be asked to reconnect or re-verify it later in the flow.
- Preselect role-based connection defaults where confidence is high. Coder -> GitHub, Assistant -> Calendar/Gmail, Researcher -> folders, etc., with clear opt-out.
- Show "what happens next" after deploy. A short checklist like "container starts", "credentials sync", "starter task begins" would reduce anxiety during the wait.
- Add clearer failure recovery in the canopy view for background deploy errors. If the optimistic agent hits an error state, expose the retry path directly from the card.

## Highest-impact simplification idea

- Split the journey into two moments:
  1. Create and meet the agent.
  2. Upgrade the agent with connections and permissions once the user has seen value.

That sequencing gets to the aha faster and removes a lot of setup burden that is valuable long-term, but not necessary before the first success.
