---
name: nobg
description: "Forbid detached shell jobs so no process escapes the tool call: a PreToolUse hook on Bash denies a command with a bare `&`, `nohup`, `setsid`, `disown`, `coproc`, `screen -dm`, Windows `start` or `Start-Process` (also inside `$(…)`, `bash -c '…'`, `eval`, a heredoc fed to a shell) and tells the agent to run in the foreground or use `run_in_background: true`. Default global (~/.claude/settings.json plus every ccgp profile); `--here` for this project, `--off` to remove, `--status` to inspect."
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

- a bare `&`: `a &`, `a & b`, `( a; b ) &`, `a &> log &`, unless a later
  `wait` of the same (sub)shell reaps it (a `wait` in a comment, in quotes or
  after the subshell ended does not count);
- `nohup`, `setsid`, `disown`, `coproc`, `daemonize`, `systemd-run`, `at`,
  `batch`, Windows `start`, `screen -dm`, `tmux new … -d` in command position,
  also quoted, as `name.exe`, and behind `sudo -u user`, `env -u VAR`,
  `timeout -s SIG 5`, `nice -n 5`, `command`, `xargs -n 1`, `VAR=x`,
  `if`/`do`/`{`;
- `cmd /c start …`, PowerShell `Start-Process`/`Start-Job` without `-Wait`;
- the same inside `$(…)`, backticks, double-quoted substitutions,
  `bash -c '…'`, `sh -c "…"`, `env -S '…'`, `eval …` and a heredoc fed to a
  shell (`bash <<EOF`).

Left alone: `&&`, `||`, `|&`, `&>`, `2>&1`, `;&` in `case`, an `&` in quotes, a
comment, a plain heredoc body, `$(( ))`, `(( ))`, `tmux attach -d`, `screen -dr`.
Words that only look like a detacher are not commands: a case pattern
(`start)`), a function definition (`start() {`), a relative script
(`./bin/start`), an assignment value (`MODE="batch" x`, `modes=(batch)`), a
variable (`$batch`) and an argument (`echo start`). A command the bin cannot
read is allowed.

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
