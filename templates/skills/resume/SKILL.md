---
name: resume
description: "Read the latest (or named) checkpoint written by /checkpoint, rebuild the TaskList via TaskCreate, restate the active goal, and surface open questions. Use after auto-compact, after a pause, or when starting a fresh session on the same work."
---

# resume

The other half of `/checkpoint`: load a saved snapshot, restore what is missing, keep working.

## Usage

```
/resume                # most recently modified checkpoint
/resume pre-refactor   # pre-refactor.md
/resume --list         # list checkpoints only, do not restore
/resume 2026-06-19     # prefix match; ambiguous → ask
```

## Behavior

1. **Find the directory.** Run `git rev-parse --show-toplevel` from the caller's working directory and read `<repo-root>/docs/checkpoints/`. Git's discovery handles a linked worktree's `.git` file too. If the command fails or returns an empty path (caller is outside any Git repository), refuse and stop. Checkpoints are project-scoped: never read `~/.claude/checkpoints/` or any other path shared across projects/agents.
2. **`--list`:** print name, size, mtime and first-line title, newest first. Stop.
3. **Pick the file.** No argument: sort every `.md` in the directory by filesystem mtime descending and take the first. With an argument:
   - Exact filename match (with or without `.md`): take it.
   - Otherwise prefix match; several matches → list them and ask.
   - No match → say so and stop. Never invent state.
4. **Print the `Session summary` section verbatim** as the first block of the reply. Warn if the checkpoint is older than 7 days.
5. **Restore tasks — decide yourself, never ask.** Call TaskList. TaskCreate only the snapshot's unfinished tasks whose `subject` is not already in the live list, then set their `blockedBy` by `subject` match (IDs differ). Leave live tasks untouched. Nothing missing → one line "TaskList already up to date".
6. **Goal:** if one was saved, print it as a fenced `/goal <text>` line for the user to paste; never set it yourself.
7. **Print open questions and decisions** as short bullet lists.
8. **Continue the work in this same turn:** keep the `in_progress` task or start the lowest-id ready one. Ask only if an open question blocks every ready task.
