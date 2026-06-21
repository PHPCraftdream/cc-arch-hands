---
name: clock
description: "Install a Claude Code statusLine that shows model + context-window usage at the bottom of the terminal (`<model> · X% (Nk/Mk)`), AND a Stop hook that emits an `HH:MM · model · X%` line as a systemMessage after each assistant turn for a timestamped chat audit trail. The statusLine refreshes on turn boundaries — no refreshInterval, to dodge Node cold-start races (the bin needs 1–3s on Windows, faster ticks just cancel each other and the bar blanks). Does not consume LLM context. Default global (~/.claude/settings.json); pass `--here` for project-local."
---

# clock

Install (or remove, or inspect) two Claude Code settings entries:

1. A **`statusLine`** entry at the bottom of the terminal showing the active
   model and context-window usage (`<model> · X% (Nk/Mk)`). Refreshes on each
   assistant turn boundary — no `refreshInterval` is set. On Windows the
   Node cold-start cost (1–3s) is longer than any sub-second tick, so a tighter
   refresh just causes the harness to cancel in-flight scripts and the bar
   intermittently disappears. The clock face was dropped from this line for
   the same reason — the chat audit-trail Stop hook (`cah-stamp`) carries
   the timestamp instead.

2. A **Stop hook** (`cah-stamp`) that runs after each assistant turn and emits
   an `HH:MM · model · X%` line as a `systemMessage` into the chat scrollback.
   This gives you a timestamped audit trail: going back through the conversation
   you can see when each exchange happened and what the context state was at
   that moment.

## When to use

- Run `/clock` once (globally) to always see the status bar in Claude Code
  AND get per-turn timestamps in the chat.
- Use `/clock --here` to install both pieces only for the current project.
- Use `/clock --off` to remove both entries from whichever scope has them.
- Use `/clock --status` to check which scopes have each piece installed.

## Usage

```
/clock              # install both pieces in ~/.claude/settings.json (global, recommended)
/clock --here       # install both pieces in <cwd>/.claude/settings.json (project-local)
/clock --off        # remove both from the chosen scope
/clock --status     # report which scope has each piece installed
```

## Behavior

### Scope resolution

- Default (no flags): operate on `~/.claude/settings.json` (global).
- `--here`: operate on `<cwd>/.claude/settings.json` (project-local).
- `--off` and `--status`: check **both** scopes (global and local) and report each.

### What gets installed

**statusLine entry** (ownership sentinel: `cah-sentinel: "cah-status:v1"`, `cah-name: "clock"`):

```json
{
  "type": "command",
  "command": "cah-status",
  "padding": 0,
  "cah-sentinel": "cah-status:v1",
  "cah-name": "clock"
}
```

Note: **do NOT add `refreshInterval`**. A sub-second tick races with Node cold-start on Windows and causes the bar to disappear. Event-driven refresh (the default) is fine — the bar updates on each turn boundary, which is what you read it on anyway.

**Stop hook entry** (ownership sentinel: `cah-sentinel: "cah-hook:v1"`, `cah-name: "clock"`),
appended to `hooks.Stop` as a new matcher object:

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "cah-stamp",
      "cah-sentinel": "cah-hook:v1",
      "cah-name": "clock"
    }
  ]
}
```

### Default / `--here` (install)

1. Resolve the target `settings.json` path (global for default, local for `--here`).
2. If the file is missing: create the parent `.claude` directory if needed, then
   start from `{}` as the content.
3. Read and `JSON.parse` the file. If the file exists but is **invalid JSON**:
   report the problem and STOP. Never overwrite a file you could not parse.
4. **statusLine check**: Inspect `data.statusLine`:
   - If it exists AND has `cah-sentinel === "cah-status:v1"` AND
     `cah-name === "clock"` → report "statusLine: already enabled" and continue.
   - If it exists WITHOUT our sentinel → treat as foreign, refuse to overwrite,
     ask the user whether to replace it.
   - If there is no `statusLine` key yet: add our entry (shown above).
5. **Stop hook check**: Scan `hooks.Stop[*].hooks[*]` for an entry with
   `cah-sentinel === "cah-hook:v1"` AND `cah-name === "clock"`:
   - If found → report "chat-stamp: already enabled" and continue.
   - If not found → append a new matcher entry to `hooks.Stop` (create
     `hooks` and `hooks.Stop` as arrays if they don't exist yet). IMPORTANT:
     if other entries already exist in `hooks.Stop` (e.g. from
     `/checkpoint-watch`), append ours — never replace.
6. Save atomically: write to `settings.json.tmp`, then rename it over
   `settings.json`. Report both pieces' final states.

### `--off` (disable)

1. Check both scopes (global and local).
2. For each scope where the file exists:
   - Read and `JSON.parse`. If invalid JSON: report and STOP.
   - **statusLine**: if `data.statusLine` has our sentinel (`cah-sentinel ===
     "cah-status:v1"` AND `cah-name === "clock"`): delete the `statusLine` key.
     If foreign: refuse and report — do not touch it.
   - **Stop hook**: walk `hooks.Stop`, drop inner hook entries with
     `cah-sentinel === "cah-hook:v1"` AND `cah-name === "clock"`. After
     removal, drop any matcher entry whose `hooks` array is empty. Drop
     `hooks.Stop` if it becomes empty. Drop `hooks` if it becomes empty.
   - Save atomically. Never delete `settings.json` itself — even if it
     becomes `{}`.
3. Report what was removed, or "not enabled" if nothing matched in either scope.

### `--status` (inspect)

For both scopes (global `~/.claude/settings.json` and local
`<cwd>/.claude/settings.json`), report:

```
~/.claude/settings.json:
  statusLine: enabled / foreign / not set / invalid JSON
  chat-stamp: enabled / foreign / not set / invalid JSON
<cwd>/.claude/settings.json:
  statusLine: ...
  chat-stamp: ...
```

- **statusLine "enabled"** — `data.statusLine` has `cah-sentinel ===
  "cah-status:v1"` AND `cah-name === "clock"`.
- **statusLine "foreign"** — `data.statusLine` exists but lacks our sentinel.
- **statusLine "not set"** — file is missing or has no `statusLine` key.
- **statusLine "invalid JSON"** — file exists but cannot be parsed.
- **chat-stamp "enabled"** — any entry in `hooks.Stop[*].hooks[*]` has
  `cah-sentinel === "cah-hook:v1"` AND `cah-name === "clock"`.
- **chat-stamp "foreign"** — `hooks.Stop` exists but contains no entry with
  our sentinel (yet contains something).
- **chat-stamp "not set"** — `hooks.Stop` is absent or empty.
- **chat-stamp "invalid JSON"** — file exists but cannot be parsed.

Never write in this mode.

## Important

- **Never touch `statusLine` entries WITHOUT our sentinel.** Any existing
  `statusLine` lacking both `cah-sentinel === "cah-status:v1"` and
  `cah-name === "clock"` belongs to the user or another tool — ask before
  replacing.
- **Never touch Stop hook entries WITHOUT our sentinel.** Other hooks in
  `hooks.Stop` (e.g. from `/checkpoint-watch`) must be preserved exactly.
- **Atomic write only.** Stringify, write to `settings.json.tmp`, then rename it
  over `settings.json`. Never do a partial or in-place truncating write.
- **Serialize with `JSON.stringify(value, null, 2) + "\n"`** — 2-space indent and
  a trailing newline.
- **Never delete `settings.json` itself.** The `--off` path only removes our
  keys; it leaves the file in place even when it becomes `{}`.
- The `cah-status` binary reads a JSON envelope from stdin (statusLine protocol),
  formats a one-line string, and exits 0. It never crashes or emits a blank line.
- The `cah-stamp` binary reads a Stop hook JSON envelope from stdin, walks the
  transcript JSONL for the latest usage/model, formats the same one-line string,
  and emits `{"continue":true,"systemMessage":"<line>"}`. It is fail-silent.
