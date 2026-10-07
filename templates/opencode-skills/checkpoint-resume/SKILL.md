---
name: checkpoint-resume
description: "Restore a todo plan and context from a project checkpoint in place, without switching sessions."
---
# checkpoint-resume

Arguments: take them from the user's request that triggered this skill.

OpenCode's built-in session resume switches sessions; this command instead restores checkpoint context in place.

1. Resolve the caller repository with git rev-parse --show-toplevel and read only its docs/checkpoints/. Refuse outside a Git repository. Reject path traversal and checkpoints redirected outside that directory.
2. --list lists Markdown checkpoints by filesystem mtime descending, with name, size and title; stop without restoring. Otherwise choose the most recently modified checkpoint without arguments, or prefer an exact name (with or without .md), then a unique prefix. Ask on ambiguous matches; report absence without inventing state.
3. Read the chosen file and lead with its Session summary. Show unresolved questions, decisions, goal and any age warning (>7 days). Accept both Tasks and older TaskList section names.
4. Call cah_todos. Ask before merging or replacing unfinished live tasks. Restore unfinished items in their saved order via todowrite, using unique stable verbatim contents. Preserve the saved order, strategy and dependencies in the task content and session context (OpenCode todos have no blockedBy field: put prerequisite and blocker information into the task content itself). Never write blocked, abandoned or other non-canonical statuses (only pending/in_progress/completed/cancelled exist): map items a checkpoint recorded as blocked or abandoned onto pending tasks whose content carries the blocker annotation, and do not resurrect completed or cancelled tasks.
5. Restate the saved goal. Report any state that could not be represented. Never automatically arm babysit or launch subagents during restoration; give the saved interval if the user wants to re-arm /babysit. Do not edit the checkpoint or Git state.
