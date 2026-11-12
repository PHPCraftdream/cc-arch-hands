---
name: ccheckpoint-idle
description: "Same as /checkpoint-idle, plus a local commit of each checkpoint: after N minutes (default 30) of silence with 200k+ tokens of context the checkpoint-watch mod runs /checkpoint, compacts, commits only the checkpoint file, then runs /resume. This project by default, `--global` for every project, `--off` to turn it off, `--status` to inspect."
---

# ccheckpoint-idle

The commit variant of `/checkpoint-idle`, as `/ccheckpoint` is of `/checkpoint`.
It turns on the same silence cycle, and after the compaction the mod commits the
checkpoint file it wrote: only that file,
`git commit --only -m 'checkpoint: <name>'`, on the branch checked out in the
folder that holds it. Claude Code runs this Git call with repository hooks off.
It never pushes. When `docs/checkpoints/` is ignored, nothing is committed and
the mod says so.

See `/checkpoint-idle` for the whole cycle and `/checkpoint-watch` for how held
events are handled.

## Usage

```
/ccheckpoint-idle                # this project: after 30 minutes of silence, with the commit step
/ccheckpoint-idle 20             # after 20 minutes (5 to 50)
/ccheckpoint-idle --global       # every project of this user, and every ccgp profile
/ccheckpoint-idle --off          # off in this project (also mutes a global setting here)
/ccheckpoint-idle --global --off # remove the global setting
/ccheckpoint-idle --status       # global, ccgp profiles, project and what applies here
```

## Behavior

Run exactly one Bash call and report its output verbatim. Build it from the
arguments:

| Argument            | Command                                                                |
|---------------------|------------------------------------------------------------------------|
| (none)              | `cah checkpoint-idle on --commit --cwd "<cwd>"`                        |
| `N` (a number)      | `cah checkpoint-idle on --commit --minutes N --cwd "<cwd>"`            |
| `--global`          | `cah checkpoint-idle on --commit --global` (add `--minutes N` for `N`) |
| `--off`             | `cah checkpoint-idle off --cwd "<cwd>"`                                |
| `--global --off`    | `cah checkpoint-idle off --global`                                     |
| `--status`          | `cah checkpoint-idle status --cwd "<cwd>"`                             |

`<cwd>` is the caller's working directory; `--global` never takes `--cwd`. If
`cah` is not on `PATH`, run the same arguments through
`npx -y cc-arch-hands checkpoint-idle …`. If the output says the mod is missing,
run `cah install --only checkpoint-watch`, then `/reload-plugins`.

## Important

- `/checkpoint-idle` afterwards switches the same place back to the cycle without
  the commit step; there is one setting per file.
- Never edit the settings files by hand for this skill.
- Exit 1 or 2 from the command: report its message; do not retry with other
  flags.
