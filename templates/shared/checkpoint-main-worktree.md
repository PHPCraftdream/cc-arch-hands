## Main folder only

The repository's main folder (its main worktree) is the reference point for everything: checkpoints are written, read and committed only there, even when the session runs in a linked worktree. Never create or enter a worktree for a checkpoint. From the caller's working directory run:

```bash
git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir
```

- Fails or prints nothing → not a Git repository: refuse and stop.
- Line 2 (`--git-dir`) equals line 3 (`--git-common-dir`) → the caller is in the main folder: `<repo-root>` is line 1.
- Otherwise → the caller is in a linked worktree (line 1): `<repo-root>` is the parent directory of line 3 (the main folder). Do not refuse, and do not move, merge or change anything in any worktree. Write and read the checkpoint in `<repo-root>/docs/checkpoints/` by absolute path with the file tools (create the directory if missing); Git commands aimed at the main folder use `git -C <repo-root> …`.
- Checkpoints live only in `<repo-root>/docs/checkpoints/`. Never fall back to a home-directory path, the worktree, or any other path shared across projects/agents.
- The repo state is described from the main folder's point of view. From the caller's directory run `git worktree list --porcelain` (the main folder first, then every linked worktree, each with its branch and HEAD) and `git status --short` plus `git log --oneline -5` for the caller's own folder; for each other folder add `git -C <folder> status --short` and its last commit. Say what is being done in each worktree and which one this session runs in.
- A harness may confine a session to its own worktree and refuse a command or write aimed at another folder. Never work around such a refusal (no `cd`, `GIT_DIR`, `GIT_WORK_TREE` or wrapper scripts). A refused status read → record that folder as "not readable from this session" and go on. A refused checkpoint write or commit → report it as the blocker, naming the main folder where it has to be run.
