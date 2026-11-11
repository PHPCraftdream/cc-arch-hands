## Main folder only

The repository's main folder (its main worktree) is the reference point for everything: checkpoints are written, read and committed only there, even when the session runs in a linked worktree. Never create or enter a worktree for a checkpoint. From the caller's working directory run:

```bash
git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir
```

- Fails or prints nothing → not a Git repository: refuse and stop.
- Line 2 (`--git-dir`) equals line 3 (`--git-common-dir`) → the caller is in the main folder: `<repo-root>` is line 1.
- Otherwise → the caller is in a linked worktree (line 1): `<repo-root>` is the parent directory of line 3 (the main folder). Do not refuse, and do not move, merge or change anything in any worktree. Write, read and commit the checkpoint in `<repo-root>` by absolute path (create `docs/checkpoints/` there if missing) and run Git commands that touch it as `git -C <repo-root> …`.
- Checkpoints live only in `<repo-root>/docs/checkpoints/`. Never fall back to a home-directory path or any other path shared across projects/agents.
- The repo state is described from the main folder: `git -C <repo-root> status --short`, `git -C <repo-root> log --oneline -5` and `git -C <repo-root> worktree list`; then, for every linked worktree, its path, branch, `git -C <worktree> status --short` and last commit, saying what is being done there and which worktree this session runs in. Restoring later continues each piece of work in the folder the checkpoint names for it.
