---
name: clock
description: "Install a Claude Code statusLine that shows current time, model, and context-window usage at the bottom of the terminal (HH:MM · model · X% (Nk/Mk)). Refreshes every second. Does not consume LLM context — runs as a separate process. Default global (~/.claude/settings.json); pass `--here` for project-local."
---

# clock

Install (or remove, or inspect) a Claude Code `statusLine` entry that shows
the current time, active model, and context-window usage at the bottom of the
terminal. The display refreshes every second via a separate process — it never
adds a single token to the LLM context.

## When to use

- Run `/clock` once (globally) to always see the status bar in Claude Code.
- Use `/clock --here` to install it only for the current project.
- Use `/clock --off` to remove our `statusLine` entry from whichever scope has it.
- Use `/clock --status` to check which scopes have it installed.

## Usage

```
/clock              # install in ~/.claude/settings.json (global, recommended)
/clock --here       # install in <cwd>/.claude/settings.json (project-local)
/clock --off        # remove our statusLine entry from the chosen scope
/clock --status     # report which scope has ours installed
```

## Behavior

### Scope resolution

- Default (no flags): operate on `~/.claude/settings.json` (global).
- `--here`: operate on `<cwd>/.claude/settings.json` (project-local).
- `--off` and `--status`: check **both** scopes (global and local) and report each.

The `statusLine` entry this skill manages looks exactly like this (the two
`cah-*` fields are our ownership sentinel):

```json
{
  "type": "command",
  "command": "cah-status",
  "padding": 0,
  "refreshInterval": 1,
  "cah-sentinel": "cah-status:v1",
  "cah-name": "clock"
}
```

### Default / `--here` (install)

1. Resolve the target `settings.json` path (global for default, local for `--here`).
2. If the file is missing: create the parent `.claude` directory if needed, then
   start from `{}` as the content.
3. Read and `JSON.parse` the file. If the file exists but is **invalid JSON**:
   report the problem and STOP. Never overwrite a file you could not parse.
4. Inspect `data.statusLine`:
   - If it exists AND has `cah-sentinel === "cah-status:v1"` AND
     `cah-name === "clock"` → report "already enabled" and stop.
   - If it exists WITHOUT our sentinel → treat as foreign, refuse to overwrite,
     ask the user whether to replace it.
   - If there is no `statusLine` key yet: add our entry (shown above).
5. Save atomically: write to `settings.json.tmp`, then rename it over
   `settings.json`. Report "enabled".

### `--off` (disable)

1. Check both scopes (global and local).
2. For each scope where the file exists:
   - Read and `JSON.parse`. If invalid JSON: report and STOP.
   - If `data.statusLine` has our sentinel (`cah-sentinel === "cah-status:v1"`
     AND `cah-name === "clock"`): delete the `statusLine` key entirely.
   - If `data.statusLine` is foreign: refuse and report — do not touch it.
   - Save atomically. Never delete `settings.json` itself — even if it ends up `{}`.
3. Report what was removed, or "not enabled" if nothing matched in either scope.

### `--status` (inspect)

For both scopes (global `~/.claude/settings.json` and local
`<cwd>/.claude/settings.json`), report:

- "enabled" — if `data.statusLine` has `cah-sentinel === "cah-status:v1"` AND
  `cah-name === "clock"`.
- "foreign statusLine" — if `data.statusLine` exists but lacks our sentinel.
- "not enabled" — if the file is missing or has no `statusLine`.
- "invalid JSON" — if the file exists but cannot be parsed.

Never write in this mode.

## Important

- **Never touch `statusLine` entries WITHOUT our sentinel.** Any existing
  `statusLine` lacking both `cah-sentinel === "cah-status:v1"` and
  `cah-name === "clock"` belongs to the user or another tool — ask before
  replacing.
- **Atomic write only.** Stringify, write to `settings.json.tmp`, then rename it
  over `settings.json`. Never do a partial or in-place truncating write.
- **Serialize with `JSON.stringify(value, null, 2) + "\n"`** — 2-space indent and
  a trailing newline.
- **Never delete `settings.json` itself.** The `--off` path only removes the
  `statusLine` key; it leaves the file in place even when it becomes `{}`.
- The `cah-status` binary reads a JSON envelope from stdin, formats a one-line
  string, and exits 0. It never crashes or emits a blank line.
