---
name: checkpoint
description: "Persist current session state — active goal, todo plan with statuses, key decisions, open questions — into a timestamped markdown file under docs/checkpoints/. Use before context compaction or a long pause."
---
# checkpoint

Arguments: take them from the user's request that triggered this skill.

1. Resolve the caller repository with git rev-parse --show-toplevel from the original directory. Refuse outside a Git repository; linked worktrees must use their own root. Use only <repo-root>/docs/checkpoints/. Never use a shared home-directory fallback.
2. Accept one optional slug matching ^[a-z0-9]+(?:-[a-z0-9]+)*$. Without a name use local time YYYY-MM-DD-HHmm. Reject paths, separators and invalid names before writing. A user-chosen name overwrites only that checkpoint. Verify the directory and file are not redirected outside this repository.
3. Call cah_todos. Record the actual tasks, verbatim contents, statuses (pending, in_progress, completed, cancelled), and the dependencies or execution strategy visible in task content and session context. Do not invent IDs or state. Record unavailable data plainly.
4. Write <name>.md with sections Session summary, Active goal, Tasks, Decisions, Open questions and Repo state. Include a useful recap, up to five material decisions, pending user questions, git status --short and git log --oneline -5. OpenCode todos have no blocked status: record blockers and external waits as content annotations, distinct from runnable work. If babysit is available, inspect cah_babysit with action: status and record its interval and session-only nature, not a promise to restore its timer. Omit secrets, tokens and large dumps.
5. Report the absolute path. Do not stage, commit, change the todo plan or launch subagents.
