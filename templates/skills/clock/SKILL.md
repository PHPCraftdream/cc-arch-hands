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

**Refuse unsafe home paths before writing anything.** The generated command is
run by a shell, and inside double quotes POSIX shells and Git Bash still expand
`$var`, `$(command)`, and backticks, cmd.exe still expands `%VAR%`, and a
literal double quote ends the argument outright. Before building either
command, check the expanded home path for any of these characters:

```
"  `  $  &  <  >  |  ;  ^  !  %
```

plus control characters (code points U+0000 through U+001F). If the path
contains any of them, do **not** write, rewrite, or migrate any settings
entry: report the problem to the user instead ("your home directory path
contains characters a shell would interpret inside the clock command — move
the `cah-bin` tree to a plain filesystem path") and stop. Home paths built
from plain filesystem characters (letters, digits, spaces, dashes,
underscores, parentheses) are fine.

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
6. Save atomically with the safe write protocol from the "Atomic write only"
   rule below (settings lock held for the whole cycle, fresh unique temp file,
   re-read-and-verify immediately before the rename, refuse to publish on a
   mismatch). Report all three pieces'
   final states (statusLine, chat-stamp.Stop, chat-stamp.PostToolUse).

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
   - Save atomically (same safe write protocol as above — settings lock held
     for the whole cycle). Never delete
     `settings.json` itself — even if it becomes `{}`.
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
- **Lock `settings.json` for the whole read-modify-write cycle.** Cooperating
  cah skills (`/clock` and `/checkpoint-watch`) — and
  `cah probe statusline start` / `cah probe statusline stop`, which take the same lock — can run at
  the same time, and verification alone cannot stop two in-flight writers from
  passing the same check just before both rename — the second rename would
  silently erase the first writer's own change. Before your FIRST read of
  `settings.json` in any mode that will save, take the shared settings lock
  and hold it until the save attempt is fully finished. The executable
  implementation of this protocol is `lib/settings-lock.js` (built on the
  directory leases of `lib/lease-lock.js`); follow its rules exactly:
  1. Try to create a lock directory named `settings.json.lock` beside
     `settings.json`. Directory creation is atomic across processes: it either
     does not exist and you win, or it exists and someone else holds it.
  2. On winning, immediately write an `owner.json` file inside it containing
     your process id, the current epoch ms, and a fresh random token, e.g.
     `{"pid":12345,"timestamp":1789000000000,"token":"8f14e45f"}`. Until that
     write lands the reservation is not established: an ownerless lock is
     possibly-initializing, NEVER proof of abandonment.
  3. If the lock already exists, read its `owner.json`. A missing or
     unreadable owner file means "possibly initializing": wait a short grace
     period and read again. Reclaim an ownerless lock only when the lock
     directory itself is older than the grace window (about 30 seconds). An
     owner you CAN read is abandoned only when its `pid` is no longer a live
     process, or when its `timestamp` is more than 5 minutes old (the same
     lease window `lib/lease-lock.js` uses for the companion bins).
  4. To reclaim: rename the lock aside to a unique
     `settings.json.lock.stale-<pid>-<random-suffix>` name, re-read what you moved
     and confirm it is still the abandoned claim you observed, and only then
     delete the renamed copy — only ever its owner.json-style lock state. If
     the renamed copy holds anything else, do NOT delete it: keep it in a
     clearly named quarantine location and mention it to the user. A live
     holder: wait about 200 ms and retry, up to a bounded total wait of about
     30 seconds.
  5. If the lock still cannot be acquired, write nothing, delete nothing you
     do not own, and tell the user the settings are busy and to re-run
     `/clock` once the other operation finishes.
  6. Release the lock on EVERY exit path — but "release" means delete it only
     if a fresh re-read of `owner.json` still carries YOUR process id and
     token. If a successor now owns the lock (your lease was reclaimed while
     you worked), delete nothing, do not publish your pending save, and tell
     the user the settings changed while /clock was working.
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
  modified by something else while /clock was working; nothing was written —
  re-run /clock to apply the change on top of the new content". Only when the
  re-read matches, rename your unique temp file over `settings.json`.
  **Also re-verify the lock owner immediately before the final rename**: if
  `owner.json` no longer carries your token, your lease was reclaimed while
  you were working — refuse to publish exactly as for a concurrent edit.
  Never do a partial or in-place truncating write.
- **Serialize with `JSON.stringify(value, null, 2) + "\n"`** — 2-space indent and
  a trailing newline.
- **Never delete `settings.json` itself.** The `--off` path only removes our
  keys; it leaves the file in place even when it becomes `{}`.
- The `cah-status` binary reads a JSON envelope from stdin (statusLine protocol),
  formats a one-line string, and exits 0. It never crashes or emits a blank line.
- The `cah-stamp` binary reads a Stop hook JSON envelope from stdin, walks the
  transcript JSONL for the latest usage/model, formats the same one-line string,
  and emits `{"continue":true,"systemMessage":"<line>"}`. It is fail-silent.
