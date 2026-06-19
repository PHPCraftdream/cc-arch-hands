---
name: checkpoint-prune
description: "Delete checkpoints — by name, by age, or interactively. Reports what was removed. Use to clean up docs/checkpoints/ when old snapshots have stopped being useful. /resume --list is the read-only counterpart."
---

# checkpoint-prune

Companion to `/checkpoint`. Removes checkpoint files from the same directory `/checkpoint` writes into.

## Usage

```
/checkpoint-prune                # no arg → delete ALL checkpoints (asks to confirm)
/checkpoint-prune 14d            # delete files older than 14 days
/checkpoint-prune 48h            # delete files older than 48 hours
/checkpoint-prune 10             # keep the 10 most recent, delete the rest
/checkpoint-prune pre-refactor   # delete one named checkpoint
/checkpoint-prune --dry <arg>    # report only, never delete (works with any of the above)
```

## Behavior

1. **Locate the directory.** Use `<repo-root>/docs/checkpoints/` if a `.git` is found in cwd or any parent; otherwise `~/.claude/checkpoints/`. If it doesn't exist, say so and stop.
2. **Resolve the selection** by parsing the argument in this order — the **first rule that matches wins**:
   - **no argument** → target every checkpoint (mode: `all`).
   - **digits followed by `d` or `h`** (e.g. `14d`, `48h`) → target every file whose mtime is older than `now - N` (mode: `older-than`).
   - **digits only** (e.g. `10`) → sort by mtime descending, keep the first N, target the rest (mode: `keep-last`).
   - **anything else** → treat as a filename (with or without `.md`). Exact match only — if the file is not found, report and stop, never silently widen (mode: `name`).
3. **Print the target list.** One line per file: name, mtime, size. End with the total count and the parsed mode (e.g. `mode: older-than 14d → 6 files`). If the list is empty, say "nothing to prune" and stop.
4. **Confirm.** Before any deletion, ask the user to confirm — except in these cases:
   - `--dry` is set (no deletion happens regardless);
   - the selection is mode `name` and exactly one file matched (the user just typed the name themselves).
5. **Delete and report.** Use `fs.unlinkSync`. On success, print "removed N file(s)". On any error, abort the remaining deletions and report what was removed vs what was not.

## Important

- This skill only touches files inside the resolved checkpoints directory. It never recurses outside, and never deletes the directory itself.
- It does NOT inspect file contents — selection is by name and mtime only.
- For one-off deletion, plain `rm docs/checkpoints/<name>.md` is fine and faster. This skill exists for the batch cases (`--older-than`, `--keep-last`) and for the comfort of a confirmation prompt.
- Pairs with `/resume --list` for read-only browsing. Together they cover the full lifecycle: write (`/checkpoint`), read (`/resume`), list (`/resume --list`), delete (`/checkpoint-prune`).
