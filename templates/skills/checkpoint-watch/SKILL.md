---
name: checkpoint-watch
description: "Install a per-project Stop hook that shows a one-time hint when context fills past 90%, suggesting /checkpoint to save session state before auto-compact. Use `--off` to remove, `--status` to inspect. Lives in <cwd>/.claude/settings.json; foreign hooks are never touched."
---

# checkpoint-watch

Arm (or disarm, or inspect) a per-project Stop hook that nudges you to
`/checkpoint` once the session's context window crosses 90% full. The hint is a
single soft `[hint]` line per session — the agent keeps working, and you decide
when to actually checkpoint. The hook runs the `cah-checkpoint-hint` bin shipped
by this package.

## When to use

- At the start of working in a project where you want an automatic reminder to
  save state before Claude Code auto-compacts the context.
- Run `--status` any time to see whether the hook is armed in the current
  project.
- Run `--off` to remove it.

## Usage

```
/checkpoint-watch            # default: enable the Stop hook in this project
/checkpoint-watch --off      # remove our Stop hook from this project
/checkpoint-watch --status   # report whether our hook is present (no write)
```

This skill is **per-project**. It only ever touches
`<cwd>/.claude/settings.json`. It never touches the global
`~/.claude/settings.json`.

## Behavior

Resolve the local settings path: `<cwd>/.claude/settings.json`. For every mode
below, that single file is the target — never the global `~/.claude/settings.json`.

### Resolving the bin path

The hook command points at a JavaScript file that `cah install` copies into the
**global** bin directory `<HOME>/.claude/cah-bin/`, where `<HOME>` is the
current user's home directory. This absolute path is used even though this skill
is otherwise project-local — the bin always lives in the one global location, so
the hook keeps working no matter where the `cc-arch-hands` package is moved,
relinked, or whether it is even still on `PATH`.

Build the command like this (forward slashes on every OS; wrap in double quotes
so a home directory with spaces still works):

```
node "<HOME>/.claude/cah-bin/bin/cah-checkpoint-hint.js"
```

Expand `<HOME>` to the real absolute path at write time (e.g. `C:/Users/Alice`
or `/home/alice`) — do **not** leave a literal `<HOME>` or a `$HOME` token in
the file. Use forward slashes even on Windows.

**Refuse unsafe home paths before writing anything.** The generated command is
run by a shell, and inside double quotes POSIX shells and Git Bash still expand
`$var`, `$(command)`, and backticks, cmd.exe still expands `%VAR%`, and a
literal double quote ends the argument outright. Before building the command,
check the expanded home path for any of these characters:

```
"  `  $  &  <  >  |  ;  ^  !  %
```

plus control characters (code points U+0000 through U+001F). If the path
contains any of them, do **not** write, rewrite, or migrate any settings
entry: report the problem to the user instead ("your home directory path
contains characters a shell would interpret inside the checkpoint-watch hook
command — move the `cah-bin` tree to a plain filesystem path") and stop. Home
paths built from plain filesystem characters (letters, digits, spaces,
dashes, underscores, parentheses) are fine.

**Prerequisite:** this file exists only after `cah install` (or
`cah install --only bins`) has run. If `<HOME>/.claude/cah-bin/bin/` is missing,
tell the user to run `cah install` first, then continue.

The hook entry this skill manages looks exactly like this (the two `cah-*`
fields are our ownership sentinel):

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "node \"<HOME>/.claude/cah-bin/bin/cah-checkpoint-hint.js\"",
      "cah-sentinel": "cah-hook:v1",
      "cah-name": "checkpoint-watch"
    }
  ]
}
```

### Default (enable)

1. If `<cwd>/.claude/settings.json` is missing: create the `.claude` parent
   directory if needed, and start from `{}` as the content.
2. Read and `JSON.parse` the file. If it exists but is **invalid JSON**: report
   the problem and STOP. Never overwrite a file you could not parse.
3. Scan `hooks.Stop[*].hooks[*]` for an inner hook where
   `cah-sentinel === "cah-hook:v1"` AND `cah-name === "checkpoint-watch"`. If one
   already exists:
   - If its `command` already equals the freshly computed
     `node "<HOME>/.claude/cah-bin/bin/cah-checkpoint-hint.js"` → report
     "already enabled" and stop.
   - Otherwise it is an **older** entry (e.g. the bare `cah-checkpoint-hint`
     from a pre-0.4.0 install): rewrite its `command` to the computed absolute
     path, keep the sentinel fields, save with the safe write protocol from
     the "Atomic write only" rule below, and report "migrated".
4. Otherwise add our entry: create the `hooks` key if missing, create the
   `hooks.Stop` array if missing, then push the matcher entry shown above onto
   `hooks.Stop`.
5. Save atomically with the safe write protocol from the "Atomic write only"
   rule below (settings lock held for the whole cycle, fresh unique temp file,
   re-read-and-verify immediately before the rename, refuse to publish on a
   mismatch). Report "enabled".

### `--off` (disable)

1. If the file is missing: report "not enabled" and stop (nothing to remove,
   never create a file here).
2. Read and `JSON.parse`. If invalid JSON: report and STOP — do not overwrite.
3. Walk `hooks.Stop[*]`. In each matcher entry, filter its inner `hooks` array
   to drop items where `cah-sentinel === "cah-hook:v1"` AND
   `cah-name === "checkpoint-watch"`.
4. Drop the outer matcher entry if its `hooks` array is now empty.
5. Drop `hooks.Stop` if it is now empty. Drop `hooks` if it is now empty.
6. Save atomically (same safe write protocol as above — settings lock held
   for the whole cycle). Never delete
   `settings.json` itself — even if it ends up `{}`. Report what was removed
   (or "not enabled" if nothing matched).

### `--status` (inspect)

1. If the file is missing or has no matching entry: report "not enabled".
2. If `JSON.parse` fails: report "invalid JSON" and stop.
3. If a hook with `cah-sentinel === "cah-hook:v1"` AND
   `cah-name === "checkpoint-watch"` exists under `hooks.Stop`: report "enabled".
4. Never write in this mode.

## Important

- **Never touch entries WITHOUT our sentinel.** Any hook lacking both
  `cah-sentinel === "cah-hook:v1"` and `cah-name === "checkpoint-watch"` belongs
  to the user or another tool — leave it exactly as is.
- **Lock `settings.json` for the whole read-modify-write cycle.** Cooperating
  cah skills (`/clock` and `/checkpoint-watch`) can run at the same time, and
  verification alone cannot stop two in-flight writers from passing the same
  check just before both rename — the second rename would silently erase the
  first writer's own change. Before your FIRST read of `settings.json` in any
  mode that will save, take the shared settings lock and hold it until the
  save attempt is fully finished:
  1. Try to create a lock directory named `settings.json.lock` beside
     `settings.json`. Directory creation is atomic across processes: it either
     does not exist and you win, or it exists and someone else holds it.
  2. On winning, immediately write an `owner.json` file inside it containing
     your process id and the current epoch ms, e.g.
     `{"pid":12345,"timestamp":1789000000000}`.
  3. If the lock already exists, read its `owner.json`. If the owner file is
     missing or unreadable, the holder has abandoned the lock. Otherwise the
     holder has abandoned the lock when its `pid` is no longer a live process,
     or when the recorded `timestamp` is more than 5 minutes old (the same
     lease window `lib/lease-lock.js` uses for the companion bins). An
     abandoned lock: rename it aside to a unique
     `settings.json.lock.stale.<random-suffix>` name, delete that renamed
     copy, and start again at step 1. A live holder: wait about 200 ms and
     retry, up to a bounded total wait of about 30 seconds.
  4. If the lock still cannot be acquired, write nothing, delete nothing you
     do not own, and tell the user the settings are busy and to re-run
     `/checkpoint-watch` once the other operation finishes.
  5. Release the lock by deleting `settings.json.lock` in EVERY outcome:
     after a successful rename, and on every early exit — unreadable JSON,
     the concurrent-edit refusal below, or the user cancelling.
  This lock serializes only writers that follow this protocol. A writer that
  ignores it is still caught by the byte-for-byte re-read in the next rule.
- **Atomic write only — with a concurrent-edit check.** Do this whole
  sequence while holding the settings lock from the previous rule. Serialize
  with
  `JSON.stringify(value, null, 2) + "\n"` and write the bytes to a **fresh,
  unique** temp file beside `settings.json`, e.g.
  `settings.json.tmp.<random-suffix>`, with a new random suffix for this
  invocation. Never write into a pre-existing `settings.json.tmp*` file: it
  may be another invocation's in-flight write or leftover recovery data — if
  your chosen temp name already exists, pick a different suffix instead of
  overwriting it. **Immediately before the final rename**, re-read
  `settings.json` and compare it byte for byte with the raw text you read at
  the start of this invocation. If it changed, something else edited settings
  while you were working: refuse to publish — delete your unique temp file,
  leave `settings.json` untouched, and tell the user "settings.json was
  modified by something else while /checkpoint-watch was working; nothing was
  written — re-run /checkpoint-watch to apply the change on top of the new
  content". Only when the re-read matches, rename your unique temp file over
  `settings.json`. Never do a partial or in-place truncating write.
- **Serialize with `JSON.stringify(value, null, 2) + "\n"`** — 2-space indent and
  a trailing newline.
- **Never delete `settings.json` itself.** The `--off` path only edits content;
  it leaves the file in place even when it becomes `{}`.
- This skill only edits `<cwd>/.claude/settings.json`. It never reads or writes
  the global `~/.claude/settings.json`.
