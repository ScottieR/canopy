# Agent Notes

- When you make a major architectural change or add a meaningful new runtime, service, or data-flow path, update [README.md](/Users/scottieryan/Documents/Claude/Projects/Agent%20Management/canopy/README.md) in the same change.
- Keep the Architecture section and Mermaid diagram aligned with real behavior, especially around control-plane calls, local runtime boundaries, provider traffic, credential storage, memory services, and new integrations or execution planes.
- Finish isolated work by pushing it: `git push -u origin <branch>`. A branch with no
  upstream is invisible to every cleanup and reporting tool here, and its worktree is
  indistinguishable on disk from an already-merged one.
- Local worktree hygiene is automated by `scripts/local-sync/` (launchd, every 10 min):
  it fast-forwards master, removes worktrees whose branch was merged and deleted on
  origin, and reports work that exists only on this machine to
  `~/Library/Logs/canopy-stranded-work.md`. It is installed by running
  `scripts/local-sync/install.sh` once -- if that has never been run on a machine,
  none of it is happening.
