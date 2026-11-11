---
name: resume
description: "Read the latest (or named) checkpoint written by /checkpoint from the repository's main folder (never a linked worktree), rebuild the TaskList via TaskCreate, restate the active goal, and surface open questions. Use after auto-compact, after a pause, or when starting a fresh session on the same work."
---

# resume

The other half of `/checkpoint`: load a snapshot, restore what is missing, keep working.

## Usage

```
/resume                # most recently modified checkpoint
/resume pre-refactor   # pre-refactor.md
/resume --list         # list only, restore nothing
/resume 2026-06-19     # prefix match; ambiguous → ask
```

{{include:checkpoint-main-worktree}}

## Behavior

1. **Guard** as above; read only `<repo-root>/docs/checkpoints/`.
2. **`--list`:** print name, size, mtime and first-line title, newest first. Stop.
3. **Pick the file.** No argument: sort every `.md` in the directory by filesystem mtime descending, take the first. With an argument:
   - Exact filename match (with or without `.md`): take it.
   - Otherwise prefix match; several → list them and ask.
   - None → say so and stop. Never invent state.
4. **Print the `Session summary` section verbatim** as the reply's first block. Warn if the checkpoint is older than 7 days.
5. **Restore tasks — decide yourself, never ask.** Call TaskList. TaskCreate only the snapshot's unfinished tasks whose `subject` is not already live, then set their `blockedBy` by `subject` match (IDs differ). Leave live tasks untouched. Nothing missing → one line "TaskList already up to date".
6. **Goal:** if saved, print it as a fenced `/goal <text>` line for the user to paste; never set it yourself.
7. **Print open questions and decisions** as short bullet lists.
8. **Continue the work in this same turn**, here in the main folder: keep the `in_progress` task or start the lowest-id ready one. Ask only if an open question blocks every ready task.
