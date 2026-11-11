## Main folder only

The repository's main folder (its main worktree) is the reference point for everything: checkpoints are written, read and committed there, even when the session runs in a linked worktree. The one exception is a session its harness confines to its worktree (below). Never create or enter a worktree for a checkpoint. From the caller's working directory run:

```bash
git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir
```

- Fails or prints nothing → not a Git repository: refuse and stop.
- Line 2 (`--git-dir`) equals line 3 (`--git-common-dir`) → the caller is in the main folder: `<repo-root>` is line 1.
- Otherwise → the caller is in a linked worktree (line 1): `<repo-root>` is the parent directory of line 3 (the main folder). Do not refuse, and do not move, merge or change anything in any worktree. Write the checkpoint into `<repo-root>/docs/checkpoints/` by absolute path with the file tools (create the directory if missing); Git commands aimed at the main folder use `git -C <repo-root> …`.
- The checkpoint directory is `<repo-root>/docs/checkpoints/`. Never fall back to a home-directory path or any other path shared across projects/agents.
- The repo state is described from the main folder's point of view. From the caller's directory run `git worktree list --porcelain` (the main folder first, then every linked worktree, each with its branch and HEAD) and `git status --short` plus `git log --oneline -5` for the caller's own folder; for each other folder add `git -C <folder> status --short` and its last commit. Say what is being done in each worktree and which one this session runs in.

### A session confined to its worktree

A harness may confine a session to its own worktree and refuse any write or Git command aimed at another folder. Never work around such a refusal (no `cd`, `GIT_DIR`, `GIT_WORK_TREE`, wrapper scripts or another tool).

- A refused status read of another folder → record it as "not readable from this session" and go on.
- A refused write into `<repo-root>/docs/checkpoints/` → the checkpoint directory becomes `<worktree>/docs/checkpoints/` (line 1 of the check). Write the same file there, with this line right under the title: `> Written in worktree <worktree> [<branch>]: this session could not write to <repo-root>; carry this file into <repo-root>/docs/checkpoints/.` Report both paths.
- Commits go to the folder that holds the checkpoint, so a fallback checkpoint is committed on the worktree's branch.

### Reading checkpoints

Read `<repo-root>/docs/checkpoints/` and, for every linked worktree that `git worktree list --porcelain` lists, its `docs/checkpoints/`. Show the folder of each checkpoint. Treat them as one list ordered by file mtime; a name present in several folders is shown once per folder. A refused read of another folder → skip it and say so.
