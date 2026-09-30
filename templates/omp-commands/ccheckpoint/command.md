---
description: Save an OMP checkpoint and commit only that file locally, preserving unrelated staged changes.
---
# ccheckpoint

Arguments: $@

This explicit invocation requests a local checkpoint commit, not a push. Read the sibling checkpoint.md command definition and execute its instructions with the same arguments and original caller cwd; merely reading it does not save the checkpoint. Stop without committing if it refuses or fails.

Require the resulting file to be <caller-repo-root>/docs/checkpoints/<safe-name>.md, with basename matching ^[a-z0-9]+(?:-[a-z0-9]+)*\.md$. Invoke Node on the installed helper {{COMMIT_HELPER}} with arguments --name and that basename, from the original caller cwd. Pass arguments as data using an argv-capable API (for example Node execFileSync); never interpolate the user label into shell code. The helper verifies repository and filename, uses an isolated index, skips staged checkpoint paths, locks and active Git operations, and preserves unrelated staged changes.

Report the checkpoint path and the helper's actual commit SHA, skip or failure. Never push. A failed commit does not invalidate the saved checkpoint. The helper uses git commit-tree and does not run Git commit hooks.
