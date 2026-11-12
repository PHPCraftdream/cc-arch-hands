---
name: ccheckpoint-watch
description: "Same as /checkpoint-watch, plus a local commit of each checkpoint: at 90% context the checkpoint-watch mod stops the agent, runs /checkpoint, compacts, commits only the checkpoint file, then runs /resume. This project only; `--off` to turn it off, `--status` to inspect."
---

# ccheckpoint-watch

The commit variant of `/checkpoint-watch`, as `/ccheckpoint` is of
`/checkpoint`. It turns on the same cycle in this project, and after the
compaction the mod commits the checkpoint file it wrote: only that file,
`git commit --only -m 'checkpoint: <name>'`, on the branch checked out in the
folder that holds it. Claude Code runs this Git call with repository hooks off.
It never pushes. When `docs/checkpoints/` is ignored, nothing is committed and
the mod says so.

See `/checkpoint-watch` for the whole cycle and how held events are handled.

## Usage

```
/ccheckpoint-watch            # turn the cycle on in this project, with the commit step
/ccheckpoint-watch --off      # turn the cycle off in this project
/ccheckpoint-watch --status   # show whether it is on, its mode, and whether the mod is installed
```

## Behavior

Run exactly one Bash call and report its output verbatim:

| Argument     | Command                                              |
|--------------|------------------------------------------------------|
| (none)       | `cah checkpoint-watch on --commit --cwd "<cwd>"`     |
| `--off`      | `cah checkpoint-watch off --cwd "<cwd>"`             |
| `--status`   | `cah checkpoint-watch status --cwd "<cwd>"`          |

`<cwd>` is the caller's working directory. If `cah` is not on `PATH`, run the
same arguments through `npx -y cc-arch-hands checkpoint-watch …`. If the
output says the mod is missing, run `cah install --only checkpoint-watch`, then
`/reload-plugins`.

## Important

- `/checkpoint-watch` afterwards switches the same project back to the cycle
  without the commit step; there is one setting per project.
- Never edit the settings files by hand for this skill.
- Exit 1 or 2 from the command: report its message; do not retry with other
  flags.
