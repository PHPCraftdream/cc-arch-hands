## Main folder only

Checkpoints are written, read and committed only in the repository's main folder (its main worktree), never in a linked worktree. Never create or enter a worktree for a checkpoint. From the caller's working directory run:

```bash
git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir
```

- Fails or prints nothing → not a Git repository: refuse and stop.
- Line 2 (`--git-dir`) differs from line 3 (`--git-common-dir`) → linked worktree: refuse and stop. Say that checkpoints live in the main folder (the parent of line 3), so the work done in this worktree has to be carried into the main folder first, together with all its changes, and the checkpoint is then made there.
- Otherwise `<repo-root>` is line 1 and checkpoints live only in `<repo-root>/docs/checkpoints/`. Never fall back to a home-directory path or any other path shared across projects/agents.
