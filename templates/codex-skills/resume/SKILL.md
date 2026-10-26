---
name: resume
description: Restore context from a project-scoped checkpoint written by checkpoint. Use after a pause or context compaction, or to list available checkpoints.
---

# Resume

From the caller's original working directory, find the repository with `git rev-parse --show-toplevel`. Refuse outside a Git repository. Read only `<repo-root>/docs/checkpoints/`; never use a shared home-directory fallback.

- `--list`: show each `.md` checkpoint's name, size, modification time, and first-line title, newest first. Stop without restoring.
- No argument: choose the `.md` file with the newest filesystem modification time, including named checkpoints.
- Name or prefix: prefer an exact filename (with or without `.md`), then a unique prefix. If ambiguous, list matches and ask the user. If absent, say so; do not invent state.

Read the selected file, tolerating hand edits. Lead with its `Session summary`, then surface open questions and decisions. Recreate unfinished tasks and dependencies only if task tools exist. Decide yourself, never ask how to merge: keep every live task unchanged and add only the unfinished saved tasks that are not already in the live list. Then continue the first ready unfinished task right away instead of waiting for confirmation; ask only when an open question blocks every ready task. Restate any saved goal and use a goal tool only when one is available and the user's intent permits it; otherwise give the user the text to resume manually. Warn when the checkpoint is older than seven days. Restoring itself does not modify the checkpoint, repository, or Git state.
