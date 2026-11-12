---
name: checkpoint-idle
description: "Turn on the automatic checkpoint cycle for silence: after N minutes (default 30) with no turn and 200k+ tokens of context, the checkpoint-watch mod runs /checkpoint, compacts the session and runs /resume. This project by default, `--global` for every project (inside a Git repository), `--off` to turn it off, `--status` to inspect. /ccheckpoint-idle also commits the checkpoint."
---

# checkpoint-idle

Hands-free save, compact and resume for a session you walked away from. The work
is done by the checkpoint-watch mod, which ships inside the `checkpoint-watch`
skill's folder and loads in every session; this skill only switches the idle
cycle on or off. When a turn ends, the mod starts a timer of N minutes. A new
turn or prompt resets it. If it runs out with no turn running, the context holds
at least 200k tokens and the folder is inside a Git repository, the mod runs the
checkpoint-watch cycle: `/checkpoint watch-<date>-<time>`, compaction, held
events and (for `/ccheckpoint-idle`) the commit of that one file, then
`/resume`. See `/checkpoint-watch` for the details of the cycle.

It starts before Claude Code's own idle compaction (about 54 minutes into the
silence, only with the one-hour prompt cache), so the checkpoint comes first and
that compaction finds nothing left to do. There is no Claude Code setting for
that delay, which is why the timer lives in the mod.

## Usage

```
/checkpoint-idle                # this project: after 30 minutes of silence
/checkpoint-idle 20             # after 20 minutes (5 to 50)
/checkpoint-idle --global       # every project of this user, and every ccgp profile
/checkpoint-idle --off          # off in this project (also mutes a global setting here)
/checkpoint-idle --global --off # remove the global setting
/checkpoint-idle --status       # global, ccgp profiles, project and what applies here
```

`/ccheckpoint-idle` takes the same arguments and adds the commit step.

## Behavior

The work is done by the `cah checkpoint-idle` command; run exactly one Bash
call and report its output verbatim. Build it from the arguments:

| Argument            | Command                                                        |
|---------------------|----------------------------------------------------------------|
| (none)              | `cah checkpoint-idle on --cwd "<cwd>"`                         |
| `N` (a number)      | `cah checkpoint-idle on --minutes N --cwd "<cwd>"`             |
| `--global`          | `cah checkpoint-idle on --global` (add `--minutes N` for `N`)  |
| `--off`             | `cah checkpoint-idle off --cwd "<cwd>"`                        |
| `--global --off`    | `cah checkpoint-idle off --global`                             |
| `--status`          | `cah checkpoint-idle status --cwd "<cwd>"`                     |

`<cwd>` is the caller's working directory; `--global` never takes `--cwd`. If
`cah` is not on `PATH`, run the same arguments through
`npx -y cc-arch-hands checkpoint-idle …`.

The command writes `{ "cahCheckpointIdle": { "mode": "checkpoint", "minutes": 30 } }`
into `<cwd>/.claude/settings.local.json` (personal, not committed) or, with
`--global`, into `~/.claude/settings.json` and every ccgp profile's
`settings.json`, under the shared settings lock. The project setting wins over
the global one. The mod reads it after every turn, so no restart is needed.

If the output says the mod is missing, run `cah install --only checkpoint-watch`
(or `npx -y cc-arch-hands install --only checkpoint-watch`), then
`/reload-plugins`.

## Important

- Never edit the settings files by hand for this skill.
- The mod needs Claude Code with mods (2.1.287 or later) in a terminal session.
- Exit 1 or 2 from the command: report its message; do not retry with other
  flags.
