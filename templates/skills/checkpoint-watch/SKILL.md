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
     path, keep the sentinel fields, save, and report "migrated".
4. Otherwise add our entry: create the `hooks` key if missing, create the
   `hooks.Stop` array if missing, then push the matcher entry shown above onto
   `hooks.Stop`.
5. Save atomically (see "Atomic write" below). Report "enabled".

### `--off` (disable)

1. If the file is missing: report "not enabled" and stop (nothing to remove,
   never create a file here).
2. Read and `JSON.parse`. If invalid JSON: report and STOP — do not overwrite.
3. Walk `hooks.Stop[*]`. In each matcher entry, filter its inner `hooks` array
   to drop items where `cah-sentinel === "cah-hook:v1"` AND
   `cah-name === "checkpoint-watch"`.
4. Drop the outer matcher entry if its `hooks` array is now empty.
5. Drop `hooks.Stop` if it is now empty. Drop `hooks` if it is now empty.
6. Save atomically. Never delete `settings.json` itself — even if it ends up
   `{}`. Report what was removed (or "not enabled" if nothing matched).

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
- **Atomic write only.** Stringify, write to `settings.json.tmp`, then rename it
  over `settings.json`. Never do a partial or in-place truncating write.
- **Serialize with `JSON.stringify(value, null, 2) + "\n"`** — 2-space indent and
  a trailing newline.
- **Never delete `settings.json` itself.** The `--off` path only edits content;
  it leaves the file in place even when it becomes `{}`.
- This skill only edits `<cwd>/.claude/settings.json`. It never reads or writes
  the global `~/.claude/settings.json`.
