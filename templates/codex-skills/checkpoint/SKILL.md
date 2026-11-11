---
name: checkpoint
description: Save the current Codex session state to a project-scoped Markdown checkpoint. Use before a pause, context compaction, or handoff; pairs with resume.
---

# Checkpoint

Accept an optional slug-style name. Without a name, use a local-time `YYYY-MM-DD-HHmm` filename. A named checkpoint overwrites only the matching file when the user explicitly chose that name.

1. Run the main-folder check below from the caller's original working directory; stop if it refuses. Write `<name>.md` into the checkpoint directory it picks (the main folder, or the worktree fallback).
2. Record what is visible in this conversation: a useful session summary, active goal and tasks if available, recent decisions, unresolved questions, and the repo state described in the main-folder section below (main folder first, then every linked worktree). Include statuses and dependencies for tasks when the current tools expose them. State unavailable information plainly; do not invent it. Omit secrets, tokens, and large output dumps.
3. Write a Markdown file with sections `Session summary`, `Active goal`, `Tasks`, `Decisions`, `Open questions`, and `Repo state`. Check the target path stays under this repository's `docs/checkpoints/`; create that directory if necessary. Do not stage or commit the file.
4. Report the absolute path written. Preserve the caller's other working-tree changes.

{{include:checkpoint-main-worktree}}
