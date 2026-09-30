---
description: Save the current OMP session and todo plan to a project checkpoint.
---
# checkpoint

Arguments: $@

1. Resolve the caller repository with git rev-parse --show-toplevel from the original cwd. Refuse outside a Git repository; linked worktrees must use their own root. Use only <repo-root>/docs/checkpoints/. Never use a shared home-directory fallback.
2. Accept one optional slug matching ^[a-z0-9]+(?:-[a-z0-9]+)*$. Without a name use local time YYYY-MM-DD-HHmm. Reject paths, separators and invalid names before writing. A user-chosen name overwrites only that checkpoint. Verify the directory and file are not redirected outside this repository.
3. Call todo with op: view. Record the actual phases, verbatim task contents, statuses (pending, in_progress, blocked, completed, abandoned), blockers and execution strategy visible in session context. Do not invent IDs, TaskList fields or state. Record unavailable data plainly.
4. Write <name>.md with sections Session summary, Active goal, Tasks, Decisions, Open questions and Repo state. Include a useful recap, up to five material decisions, pending user questions, git status --short and git log --oneline -5. Keep blocked tasks and external waits distinct from runnable work. If babysit is available, inspect cah_babysit with action: status and record its interval and session-only nature, not a promise to restore its timer. Omit secrets, tokens and large dumps.
5. Report the absolute path. Do not stage, commit, change the todo plan or launch agents.
