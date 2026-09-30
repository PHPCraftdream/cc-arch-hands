---
description: Restore an OMP todo plan and context from a project checkpoint, without switching sessions.
---
# checkpoint-resume

Arguments: $@

OMP's built-in /resume switches sessions; this command instead restores checkpoint context.

1. Resolve the caller repository with git rev-parse --show-toplevel and read only its docs/checkpoints/. Refuse outside a Git repository. Reject path traversal and checkpoints redirected outside that directory.
2. --list lists Markdown checkpoints by filesystem mtime descending, with name, size and title; stop without restoring. Otherwise choose the most recently modified checkpoint without arguments, or prefer an exact name (with or without .md), then a unique prefix. Ask on ambiguous matches; report absence without inventing state.
3. Read the chosen file and lead with its Session summary. Show unresolved questions, decisions, goal and any age warning (>7 days). Accept both Tasks and older TaskList sections.
4. Call todo with op: view. Ask before merging or replacing unfinished live tasks. Restore unfinished items in named phases via todo init or append, using unique stable verbatim contents. Preserve the saved order, strategy and dependencies in the plan/context. Reapply blocked status and its reason with todo block. Do not resurrect completed or abandoned tasks. OMP auto-selects one active item; do not pretend that it supports concurrent in_progress entries or Claude blockedBy IDs.
5. Restate the saved goal; do not synthesize /goal or switch sessions. Report any state that could not be represented. Never automatically arm babysit or launch agents during restoration; give the saved interval if the user wants to re-arm /babysit. Do not edit the checkpoint or Git state.
