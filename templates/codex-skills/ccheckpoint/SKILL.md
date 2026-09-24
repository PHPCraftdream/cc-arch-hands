---
name: ccheckpoint
description: Create a project checkpoint and commit only that checkpoint locally, preserving unrelated staged changes. Use when the user explicitly requests a checkpoint commit.
---

# Ccheckpoint

Follow the sibling `checkpoint` skill with the same optional name, from the same caller working directory. If it refuses or cannot produce a file, stop without a commit. The skill must produce `<repo-root>/docs/checkpoints/<safe-name>.md`; never accept a path outside that directory.

After writing the checkpoint, invoke `node <this-skill-directory>/scripts/commit-checkpoint.mjs --name <safe-name>.md` from the caller's original working directory. Pass only the basename, never the user label or reported absolute path as shell source. The helper validates the repository and filename, skips when the checkpoint path is staged or another Git operation is active, commits through an isolated index, and leaves unrelated staged changes alone. It performs a local commit only; never push.

Report the checkpoint path and the helper's commit SHA, skip reason, or failure. A successful checkpoint remains useful even if the commit is skipped. The helper uses `git commit-tree`, so Git commit hooks do not run; do not promise hook execution.
