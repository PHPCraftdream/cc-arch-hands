---
description: Save an OpenCode checkpoint and commit only that file locally, preserving unrelated staged changes.
---
# ccheckpoint

Arguments: $ARGUMENTS

This explicit invocation requests a local checkpoint commit, not a push. Part 1 saves the checkpoint exactly like /checkpoint; Part 2 commits only that file. Stop without committing if Part 1 refuses or fails.

## Part 1 — save the checkpoint

1. Resolve the caller repository with git rev-parse --show-toplevel from the original directory. Refuse outside a Git repository; linked worktrees must use their own root. Use only <repo-root>/docs/checkpoints/. Never use a shared home-directory fallback.
2. Accept one optional slug matching ^[a-z0-9]+(?:-[a-z0-9]+)*$. Without a name use local time YYYY-MM-DD-HHmm. Reject paths, separators and invalid names before writing. A user-chosen name overwrites only that checkpoint. Verify the directory and file are not redirected outside this repository.
3. Call cah_todos. Record the actual tasks, verbatim contents, statuses (pending, in_progress, completed, cancelled), and the dependencies or execution strategy visible in task content and session context. Do not invent IDs or state. Record unavailable data plainly.
4. Write <name>.md with sections Session summary, Active goal, Tasks, Decisions, Open questions and Repo state. Include a useful recap, up to five material decisions, pending user questions, git status --short and git log --oneline -5. OpenCode todos have no blocked status: record blockers and external waits as content annotations, distinct from runnable work. If babysit is available, inspect cah_babysit with action: status and record its interval and session-only nature, not a promise to restore its timer. Omit secrets, tokens and large dumps.
5. Report the absolute path of the file written.

## Part 2 — commit only that file

Require the resulting file to be <caller-repo-root>/docs/checkpoints/<safe-name>.md, with basename matching ^[a-z0-9]+(?:-[a-z0-9]+)*\.md$. Invoke Node on the installed helper {{COMMIT_HELPER}} with arguments --name and that basename, from the original caller directory. Pass arguments as data using an argv-capable API (for example Node execFileSync); never interpolate the user label into shell code. The helper verifies repository and filename, uses an isolated index, skips staged checkpoint paths, locks and active Git operations, and preserves unrelated staged changes.

Report the checkpoint path and the helper's actual commit SHA, skip or failure. Never push. A failed commit does not invalidate the saved checkpoint. The helper uses git commit-tree and does not run Git commit hooks.
