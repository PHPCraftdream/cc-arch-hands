---
name: checkpoint-watch
description: "Turn on, for this project only, the automatic checkpoint cycle: at 90% context the checkpoint-watch mod stops the agent, runs /checkpoint, compacts the session and runs /resume; prompts that arrive meanwhile are held and written into the checkpoint. `--off` to turn it off, `--status` to inspect. /ccheckpoint-watch also commits the checkpoint."
---

# checkpoint-watch

Hands-free save, compact and resume for long sessions, in one project. The
work is done by the checkpoint-watch mod (a Claude Code plugin hooks module)
that ships inside this skill's folder (`.claude-plugin/`, `hooks/`) and loads
in every session, but acts only in a project that turned it on. Once the main
loop's context reaches 90% (checked after each of its tool calls and at the end
of each answer), the mod:

1. stops the running turn: it refuses the agent's further tool calls and asks
   it to end the turn with a one-line status (it aborts the turn only if the
   agent keeps calling tools);
2. holds every prompt that would wake the session: messages you type, finished
   background tasks, scheduled and `/loop` ticks, hook wake-ups, peer and
   channel messages. Each one is dropped and recorded with its time, origin and
   full text, and a prompt that was already queued and starts a turn is
   recorded too and its tool calls are refused, so that turn ends at once;
3. runs `/checkpoint watch-<date>-<time>`;
4. compacts the session;
5. writes the held events into the checkpoint as `## Held events`, and, for
   `/ccheckpoint-watch`, commits the checkpoint file (only that file, `git commit
   --only`; Claude Code runs this Git call with repository hooks off);
6. runs `/resume watch-<date>-<time>`, which acts on the held events and goes
   on with the work.

Claude Code's idle compaction (a long session left idle about 54 minutes, just
before the one-hour prompt cache expires; setting `idleCompaction`) gets the
same cycle: when an `auto` compaction comes with no turn running and at least
30 minutes after the last answer, the mod vetoes it and runs steps 3–6, the
checkpoint first and its own compaction right after.

The mod also registers two slash commands that run steps 3–6 at once, whatever
the context size and without turning the watch on: `/checkpoint-now` (no commit)
and `/ccheckpoint-now` (with the commit step). They need a Git repository, take
no argument and name the checkpoint `now-<date>-<time>`; a failed run does not
hold back the 90% cycle. They are commands of the mod, not skills: nothing to
install beyond this skill.

A cycle that fails (no checkpoint written, the checkpoint turn interrupted, the
compaction skipped, no result after 20 minutes) or is cancelled with
`/checkpoint-watch-cancel` stops the hold and sends what it held back to the
session as one prompt. After a failure the mod tries again 60 s later (three
failures in a row at most); after a cancel, or the third failure, the next cycle
waits until the context is below 90% again. When Claude Code refuses the mod's
command (after you press Esc, for example), your next message lifts the wait.
Held events that could not be delivered go with your next message. A cycle
interrupted by a reload of the mod (`/reload-plugins`, a reinstall) is picked up
where it was.

## Usage

```
/checkpoint-watch            # turn the cycle on in this project (checkpoint, no commit)
/checkpoint-watch --off      # turn it off in this project
/checkpoint-watch --status   # show whether it is on, its mode, and whether the mod is installed
```

`/ccheckpoint-watch` turns on the same cycle with the commit step.

## Behavior

The work is done by the `cah checkpoint-watch` command; run exactly one Bash
call and report its output verbatim:

| Argument     | Command                                              |
|--------------|------------------------------------------------------|
| (none)       | `cah checkpoint-watch on --cwd "<cwd>"`              |
| `--off`      | `cah checkpoint-watch off --cwd "<cwd>"`             |
| `--status`   | `cah checkpoint-watch status --cwd "<cwd>"`          |

`<cwd>` is the caller's working directory. If `cah` is not on `PATH`, run the
same arguments through `npx -y cc-arch-hands checkpoint-watch …`.

The command writes `{ "cahCheckpointWatch": { "mode": "checkpoint" } }` into
`<cwd>/.claude/settings.local.json` (personal and not committed, so the cycle
never turns on for teammates) under the shared settings lock, and refuses a
folder outside a Git repository. It also removes the Stop hint hook that
earlier releases wrote into `<cwd>/.claude/settings.json`.

If the output says the mod is missing, run `cah install --only checkpoint-watch`
(or `npx -y cc-arch-hands install --only checkpoint-watch`), then
`/reload-plugins`.

## Important

- Never edit the settings files by hand for this skill, and never turn the cycle
  on globally: it belongs to one project.
- The mod needs Claude Code with mods (2.1.287 or later) in a terminal session.
- Exit 1 or 2 from the command: report its message; do not retry with other
  flags.
