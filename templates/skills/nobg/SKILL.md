---
name: nobg
description: "Forbid detached shell jobs so no process escapes the tool call: a PreToolUse hook on Bash denies a command with a bare `&`, `nohup`, `setsid`, `disown`, `coproc` or `screen -d` (also inside `$(…)`, `bash -c '…'`, `eval`) and tells the agent to run in the foreground or use `run_in_background: true`. Default global (~/.claude/settings.json plus every ccgp profile); `--here` for this project, `--off` to remove, `--status` to inspect."
---

# nobg

A command that ends in `&` starts a job that outlives the Bash tool call: it
ignores SIGINT, nothing tracks it, it is left behind as an orphan when the call
times out or the session ends, and the next call often starts a second copy.
Claude Code has no setting against it. `/nobg` installs one `PreToolUse` hook
on `Bash` that runs the `cah-nobg` bin shipped by this package and denies such a
call, telling the agent to run the command in the foreground or to call the Bash
tool with `run_in_background: true` (tracked, stoppable, reported when done).

What it catches, with one quote-aware scan and no shell grammar:

- a bare `&`: `a &`, `a & b`, `( a; b ) &`, `a &> log &`;
- `nohup`, `setsid`, `disown`, `coproc`, `daemonize`, `systemd-run`,
  `screen -d…`, `tmux … -d` in command position (also behind `sudo`, `env`,
  `time`, `timeout 5`, `VAR=x`, `if`/`do`/`{`);
- the same inside `$(…)`, backticks, double-quoted substitutions,
  `bash -c '…'`, `sh -c "…"` and `eval …`.

Left alone: `&&`, `||`, `|&`, `&>`, `2>&1`, an `&` in single quotes, a comment,
a heredoc body, `$(( ))`, and a command that reaps its jobs with a `wait` after
the last `&`. A command the bin cannot read is allowed.

## Usage

```
/nobg            # enable in ~/.claude/settings.json and every ccgp profile
/nobg --here     # enable only in <cwd>/.claude/settings.json
/nobg --off      # remove (add --here for the project file)
/nobg --status   # show where it is enabled
```

## Behavior

The work is done by the `cah nobg` command; run exactly one Bash call and
report its output verbatim:

| Argument            | Command                               |
|---------------------|---------------------------------------|
| (none)              | `cah nobg on`                         |
| `--here`            | `cah nobg on --cwd "<cwd>"`           |
| `--off`             | `cah nobg off`                        |
| `--off --here`      | `cah nobg off --cwd "<cwd>"`          |
| `--status`          | `cah nobg status`                     |
| `--status --here`   | `cah nobg status --cwd "<cwd>"`       |

`<cwd>` is the caller's working directory. If `cah` is not on `PATH`, run the
same arguments through `npx -y cc-arch-hands nobg …`. If the command says the
bin is missing, run `cah install --only bins` (or `npx -y cc-arch-hands install
--only bins`) once and repeat the command.

## Important

- Never edit `settings.json` by hand for this skill: `cah nobg` takes the shared
  settings lock, keeps every hook that is not its own (sentinel `cah-hook:v1`,
  `cah-name: nobg`), refuses invalid JSON, and refuses to overwrite a file that
  changed while it worked.
- A running session may keep the hooks it loaded at start: if `/hooks` does not
  list it, restart that session.
- Exit 1 or 2 from the command: report its message; do not retry with other
  flags.
