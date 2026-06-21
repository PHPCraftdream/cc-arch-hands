---
name: resume
description: "Read the latest (or named) checkpoint written by /checkpoint, rebuild the TaskList via TaskCreate, restate the active goal, and surface open questions. Use after auto-compact, after a pause, or when starting a fresh session on the same work."
---

# resume

The other half of `/checkpoint`. Reads a saved snapshot of session state and restores as much of it as the runtime allows.

## Usage

```
/resume                # load the most recently modified checkpoint
/resume pre-refactor   # load checkpoint named pre-refactor.md
/resume --list         # just print the available checkpoints, do not restore
/resume 2026-06-19     # prefix match against filenames; ambiguous → ask
```

## Behavior

1. **Locate the checkpoint directory.** Use `<repo-root>/docs/checkpoints/` if a `.git` directory exists in the current working directory or any parent; otherwise fall back to `~/.claude/checkpoints/`.
2. **`--list` mode.** Read the directory, sort by mtime descending, and print a table: name, size, mtime, first-line title from the file. Then stop — do NOT restore.
3. **Resolve the target file.** With no argument: the most recently modified `.md` in the directory. With an argument:
   - Exact filename match (with or without `.md`): take it.
   - Otherwise prefix match against filenames. **If multiple files match**, list them and ask the user to disambiguate — do not silently pick.
   - If nothing matches: say so and stop. Do not invent state.
4. **Read and parse.** Read the markdown sections produced by `/checkpoint`. Be lenient — sections may have moved or been hand-edited.
5. **Print the Session summary first.** Output the contents of the `Session summary` section verbatim as the leading block of the response. This is what re-establishes context after auto-compact or a new session — surface it before doing anything else.
6. **Restore TaskList.** For each task in the snapshot:
   - Call TaskCreate with the original `subject` and `description` (description may be inferred from `subject` if missing).
   - After all tasks are created, walk the new IDs and call TaskUpdate to set `blockedBy` per the snapshot. Note: IDs WILL differ from the snapshot; re-derive them by `subject` match.
   - Skip tasks whose status was `completed` or `deleted` in the snapshot — they don't need to come back.
7. **Restate the goal.** If the snapshot had an active goal, print it back and instruct the user how to re-arm the Stop hook: a fenced `/goal <text>` block they can copy-paste.
8. **Surface open questions.** Print them as a bullet list. These are likely the first things the user needs to answer before work continues.
9. **Print decisions.** As a short "context recap" so the agent (and the user) re-anchor on what was chosen and why.

## Important

- `/resume` does NOT auto-set `/goal` — `/goal` is a user-side command. Print the line, ask the user to copy it.
- If the checkpoint is older than 7 days, warn the user — repo state and decisions may have drifted.
- If the live TaskList already has open tasks, ask the user whether to merge or replace before doing anything destructive.
- If no checkpoint exists at the resolved path, say so and stop — do not invent state.
