---
name: clock
description: "Install a Claude Code statusLine that shows model + context-window usage AND, for Pro/Max subscribers, the 5-hour and weekly quota use with reset times (`<model> · X% (Nk/Mk) · 5h N% (→HH:MM) · wk N% (→wd HH:MM)`). Also installs a chat-stamp hook (`cah-stamp`) on BOTH Stop AND PostToolUse, so an `HH:MM · model · X% · 5h N% · wk N%` audit line appears after every tool call — not only at end of turn. The statusLine refreshes every 60 seconds (`refreshInterval: 60000`) AND on every turn boundary; the 60s default sits well above Windows Node cold-start (1–3s), so the bar stays live without races. Default global (~/.claude/settings.json); pass `--here` for project-local."
---

# clock

Install (or remove, or inspect) three Claude Code settings entries:

1. A **`statusLine`** entry at the bottom of the terminal showing the active
   model, context-window usage, and (for Pro/Max subscribers) the **5-hour**
   and **weekly** quota use with reset times:
   `<model> · X% (Nk/Mk) · 5h N% (→HH:MM) · wk N% (→wd HH:MM)`. The 5h/wk
   parts only appear after the first API response of the session, and are
   omitted entirely on accounts where Claude Code does not deliver
   `rate_limits` in the statusLine envelope. Refreshes every **60 seconds**
   (`refreshInterval: 60000`) AND on each assistant turn boundary, so the bar
   stays live even during long, quiet stretches. The 60s default sits well
   above Windows Node cold-start (1–3s), so the harness never cancels an
   in-flight script — avoid sub-second tickers, those cause the bar to
   intermittently disappear. The clock face was dropped from this line —
   the chat audit-trail Stop/PostToolUse hook (`cah-stamp`) carries the
   timestamp instead.

2. A **chat-stamp hook** (`cah-stamp`) installed on **BOTH** `Stop` AND
   `PostToolUse`. It emits an `HH:MM · model · X% · 5h N% · wk N%` line as a
   `systemMessage` into the chat scrollback, both after every tool call AND at
   end of turn. This gives a fine-grained, timestamped audit trail: going back
   through the conversation you can see when each tool fired and how the
   context / 5h / weekly counters were rising at that moment. `cah-stamp` reads
   the rate_limits from a small state file that `cah-status` writes (the Stop
   and PostToolUse envelopes don't carry rate_limits themselves).

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

### Resolving the bin path

The two commands point at JavaScript files that `cah install` copies into the
**global** bin directory `<HOME>/.claude/cah-bin/`, where `<HOME>` is the
current user's home directory. These absolute paths are used **even for
`--here` (project-local) installs** — the bins always live in the one global
location, so `/clock` keeps working no matter where the `cc-arch-hands` package
is moved, relinked, or whether it is even still installed on `PATH`.

Build the two command strings like this (forward slashes on every OS; wrap in
double quotes so a home directory containing spaces still works):

```
node "<HOME>/.claude/cah-bin/bin/cah-status.js"
node "<HOME>/.claude/cah-bin/bin/cah-stamp.js"
```

Expand `<HOME>` to the real absolute path at write time (e.g.
`C:/Users/Alice` or `/home/alice`) — do **not** leave a literal `<HOME>` or a
`$HOME`/`%USERPROFILE%` token in the file. Use forward slashes even on Windows;
Node accepts them and they need no JSON escaping.

**Prerequisite:** these files exist only after `cah install` (or
`cah install --only bins`) has run. If `<HOME>/.claude/cah-bin/bin/` is missing,
tell the user to run `cah install` first, then continue.

### What gets installed

**statusLine entry** (ownership sentinel: `cah-sentinel: "cah-status:v1"`, `cah-name: "clock"`):

```json
{
  "type": "command",
  "command": "node \"<HOME>/.claude/cah-bin/bin/cah-status.js\"",
  "padding": 0,
  "refreshInterval": 60000,
  "cah-sentinel": "cah-status:v1",
  "cah-name": "clock"
}
```

Note on `refreshInterval`: 60 000 ms (60 s) by default. Keeps the bar visibly
live during long, quiet stretches without racing Windows Node cold-start
(1–3 s). **Do not drop below 5 s** — sub-second tickers cause the harness to
cancel in-flight scripts and the bar intermittently disappears. If the user
exports `CAH_STATUSLINE_REFRESH_MS=<n>` in their shell, honour it as an integer
millisecond value instead of the 60 000 default (but still write whatever value
ends up chosen into `refreshInterval` so it persists across sessions).

**Stop hook entry** (ownership sentinel: `cah-sentinel: "cah-hook:v1"`, `cah-name: "clock"`),
appended to `hooks.Stop` as a new matcher object:

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "node \"<HOME>/.claude/cah-bin/bin/cah-stamp.js\"",
      "cah-sentinel": "cah-hook:v1",
      "cah-name": "clock"
    }
  ]
}
```

**PostToolUse hook entry** (same shape, same sentinel — appended to `hooks.PostToolUse`).
This makes the audit-trail stamp fire after **every** tool call in a turn, not only
at the end of the assistant message, so context %, 5h, and weekly counters tick visibly
through long turns instead of jumping in one step. The matcher `""` means "all tools".

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "node \"<HOME>/.claude/cah-bin/bin/cah-stamp.js\"",
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
4. **statusLine check**: Inspect `data.statusLine`. Resolve the desired
   `refreshInterval` first: read `process.env.CAH_STATUSLINE_REFRESH_MS`; if it
   parses as a positive integer, use that, otherwise use `60000`.
   - If it exists AND has `cah-sentinel === "cah-status:v1"` AND
     `cah-name === "clock"`:
     - Compare current `command` and `refreshInterval` against the freshly
       computed values. If **both** already match → report
       "statusLine: already enabled" and continue.
     - Otherwise it is an **older** entry (pre-0.4.0 bare `cah-status`, a path
       under a different home, or a pre-0.4.4 entry with no `refreshInterval`):
       rewrite `command` AND `refreshInterval` to the computed values, keep the
       sentinel fields, and report "statusLine: migrated".
   - If it exists WITHOUT our sentinel → treat as foreign, refuse to overwrite,
     ask the user whether to replace it.
   - If there is no `statusLine` key yet: add our entry (shown above) including
     the resolved `refreshInterval`.
5. **Stamp hook check (Stop AND PostToolUse).** Stamp is installed on **both**
   events so the chat shows progress after every tool call, not only at the end
   of the assistant message. Repeat the following for `event in ["Stop", "PostToolUse"]`:
   Scan `hooks[event][*].hooks[*]` for an entry with
   `cah-sentinel === "cah-hook:v1"` AND `cah-name === "clock"`:
   - If found:
     - If its `command` already equals the computed
       `node "<HOME>/.claude/cah-bin/bin/cah-stamp.js"` → report
       "chat-stamp.<event>: already enabled" and continue.
     - Otherwise rewrite that entry's `command` to the computed absolute path
       (migration from the bare `cah-stamp` or an old path), keep the sentinel
       fields, and report "chat-stamp.<event>: migrated".
   - If not found → append a new matcher entry to `hooks[event]` (create
     `hooks` and `hooks[event]` as arrays if they don't exist yet). IMPORTANT:
     if other entries already exist there (e.g. from `/checkpoint-watch` in
     `hooks.Stop`), append ours — never replace.
6. Save atomically: write to `settings.json.tmp`, then rename it over
   `settings.json`. Report all three pieces' final states (statusLine,
   chat-stamp.Stop, chat-stamp.PostToolUse).

### `--off` (disable)

1. Check both scopes (global and local).
2. For each scope where the file exists:
   - Read and `JSON.parse`. If invalid JSON: report and STOP.
   - **statusLine**: if `data.statusLine` has our sentinel (`cah-sentinel ===
     "cah-status:v1"` AND `cah-name === "clock"`): delete the `statusLine` key.
     If foreign: refuse and report — do not touch it.
   - **Stamp hooks (Stop AND PostToolUse)**: for `event in ["Stop", "PostToolUse"]`,
     walk `hooks[event]`, drop inner hook entries with
     `cah-sentinel === "cah-hook:v1"` AND `cah-name === "clock"`. After
     removal, drop any matcher entry whose `hooks` array is empty. Drop
     `hooks[event]` if it becomes empty. Drop `hooks` if it becomes empty.
   - Save atomically. Never delete `settings.json` itself — even if it
     becomes `{}`.
3. Report what was removed, or "not enabled" if nothing matched in either scope.

### `--status` (inspect)

For both scopes (global `~/.claude/settings.json` and local
`<cwd>/.claude/settings.json`), report:

```
~/.claude/settings.json:
  statusLine:              enabled / foreign / not set / invalid JSON
  chat-stamp.Stop:         enabled / foreign / not set / invalid JSON
  chat-stamp.PostToolUse:  enabled / foreign / not set / invalid JSON
<cwd>/.claude/settings.json:
  statusLine: ...
  chat-stamp.Stop: ...
  chat-stamp.PostToolUse: ...
```

- **statusLine "enabled"** — `data.statusLine` has `cah-sentinel ===
  "cah-status:v1"` AND `cah-name === "clock"`.
- **statusLine "foreign"** — `data.statusLine` exists but lacks our sentinel.
- **statusLine "not set"** — file is missing or has no `statusLine` key.
- **statusLine "invalid JSON"** — file exists but cannot be parsed.
- **chat-stamp.<event> "enabled"** — any entry in `hooks[event][*].hooks[*]` has
  `cah-sentinel === "cah-hook:v1"` AND `cah-name === "clock"` (checked
  independently for `Stop` and `PostToolUse`).
- **chat-stamp.<event> "foreign"** — `hooks[event]` exists but contains no
  entry with our sentinel (yet contains something).
- **chat-stamp.<event> "not set"** — `hooks[event]` is absent or empty.
- **chat-stamp.<event> "invalid JSON"** — file exists but cannot be parsed.

Never write in this mode.

## Important

- **Never touch `statusLine` entries WITHOUT our sentinel.** Any existing
  `statusLine` lacking both `cah-sentinel === "cah-status:v1"` and
  `cah-name === "clock"` belongs to the user or another tool — ask before
  replacing.
- **Never touch hook entries WITHOUT our sentinel.** Other hooks in
  `hooks.Stop` (e.g. from `/checkpoint-watch`) or in `hooks.PostToolUse`
  (any third-party tool) must be preserved exactly.
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
