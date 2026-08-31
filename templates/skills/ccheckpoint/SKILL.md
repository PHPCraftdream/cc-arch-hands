---
name: ccheckpoint
description: "Same as /checkpoint, plus an automatic local commit of the checkpoint file it writes. Use when you want the snapshot to survive as a real commit instead of an uncommitted file. Pairs with /resume the same way /checkpoint does."
---

# ccheckpoint

`/checkpoint` that also commits itself. Same snapshot, same target directory, same format — the only difference is what happens once the file lands on disk.

## Usage

```
/ccheckpoint               # auto-named with timestamp: 2026-06-19-1432.md
/ccheckpoint pre-refactor  # named: pre-refactor.md (overwrites if exists)
```

Same naming rules as `/checkpoint`: a name is a first-class identifier (`/resume pre-refactor` finds it either way), slug-style (lowercase, hyphens, no spaces), re-running with the same name overwrites the file — and, here, adds a new commit on top of the old one.

## Behavior

1. **Run `/checkpoint` with the same argument.** Invoke the `checkpoint` skill directly (`Skill('checkpoint', <same argument you were given, or none>)`) rather than re-deriving its steps by hand — that keeps this skill exactly in sync with whatever `/checkpoint` actually collects and writes, forever, with no duplicated logic to drift out of date. Let it resolve the path, collect state, and write the file exactly as it normally would; take note of the absolute path it reports.
2. **Commit that one file.**
   - If the resolved path is NOT inside a git repository (`/checkpoint`'s own fallback to `~/.claude/checkpoints/` when no `.git` is found in the cwd or any parent) — skip the commit, say so in one line, stop. There is nothing to commit into.
   - Otherwise: `git add <that exact absolute path>` — nothing else, never `-A` or `.`. Then `git commit -m "checkpoint: <name-or-timestamp>"`, where `<name-or-timestamp>` is the file's own base name without the `.md` extension (so `pre-refactor.md` → `checkpoint: pre-refactor`, `2026-06-19-1432.md` → `checkpoint: 2026-06-19-1432`).
   - If `git commit` reports nothing to commit (this exact content already matches the last commit — happens when re-running against an unchanged named checkpoint), say so plainly; that is not an error.
   - If `git add`/`git commit` fails for any other reason (a hook rejects it, the file is gitignored, etc.), report the failure plainly. The checkpoint file itself is still written and valid regardless of whether the commit succeeded.
3. **Report** the absolute path AND the commit outcome: the short SHA on success, or the specific reason it was skipped/failed.

## Important

- This is the one difference from `/checkpoint`, which explicitly leaves the file uncommitted ("Do NOT add the file to git automatically — leave that to the user"). Use `/checkpoint` instead of this skill when you want that default kept.
- Stage and commit ONLY the checkpoint file — never anything else that happens to be dirty in the working tree at the time, even if the user has other uncommitted changes sitting there.
- Never push. This skill commits locally only; pushing is a separate, explicit action the user asks for by name.
- Everything `/checkpoint`'s own Important section says still applies here unchanged (honesty about unknowns, no secrets/tokens/large dumps, read-mostly — it does not alter the TaskList or goal) — this skill only adds the commit step on top.
