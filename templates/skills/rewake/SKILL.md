---
name: rewake
description: "Wake a session whose turn an API error cut off (\"API Error: Connection lost mid-response\", overloaded, server errors): a StopFailure hook waits 60 s, then 120/240/480/900 s, up to 6 tries, and asks Claude to continue. Default global (~/.claude/settings.json plus every ccgp profile); `--here` for this project, `--off` to remove, `--status` to inspect."
---

# rewake

Claude Code does not retry a response that was already streaming when the
connection dropped: the turn ends with `API Error: Connection lost
mid-response…` and the session sits idle. `/rewake` installs two hooks that run
the `cah-rewake` bin shipped by this package:

- **`StopFailure`** (`async`, `asyncRewake`): after a turn ends on an API error
  it waits, then exits 2, which wakes the idle session with a message asking
  Claude to continue the interrupted work (and to check a half-applied action
  before repeating it).
- **`Stop`** (`async`): a turn that completes normally resets the counter.

Waits: 60 s, 120 s, 240 s, 480 s, then 900 s; at most 6 tries in a row per
session. No wake when the session moved on meanwhile (you typed, a turn ran),
and none for errors a wake cannot fix: authentication, billing, invalid
request, unknown model, output-token cap, and `rate_limit` (Claude Code resumes
usage limits itself). Every event is logged to
`~/.claude/cah-bin/cache/rewake.log`.

## Usage

```
/rewake            # enable in ~/.claude/settings.json and every ccgp profile
/rewake --here     # enable only in <cwd>/.claude/settings.json
/rewake --off      # remove (add --here for the project file)
/rewake --status   # show where it is enabled and the last logged events
```

## Behavior

The work is done by the `cah rewake` command; run exactly one Bash call and
report its output verbatim:

| Argument            | Command                                  |
|---------------------|------------------------------------------|
| (none)              | `cah rewake on`                          |
| `--here`            | `cah rewake on --cwd "<cwd>"`            |
| `--off`             | `cah rewake off`                         |
| `--off --here`      | `cah rewake off --cwd "<cwd>"`           |
| `--status`          | `cah rewake status`                      |
| `--status --here`   | `cah rewake status --cwd "<cwd>"`        |

`<cwd>` is the caller's working directory. If `cah` is not on `PATH`, run the
same arguments through `npx -y cc-arch-hands rewake …`. If the command says the
bin is missing, run `cah install --only bins` (or `npx -y cc-arch-hands install
--only bins`) once and repeat the command.

## Important

- Never edit `settings.json` by hand for this skill: `cah rewake` takes the
  shared settings lock, keeps every hook that is not its own (sentinel
  `cah-hook:v1`, `cah-name: rewake`), refuses invalid JSON, and refuses to
  overwrite a file that changed while it worked.
- A running session may keep the hooks it loaded at start: if `/hooks` does not
  list them, restart that session.
- Exit 1 or 2 from the command: report its message; do not retry with other
  flags.
