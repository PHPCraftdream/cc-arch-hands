---
name: cli-run
description: Run coding-task CLI commands as jobs in a persistent Background Terminal and send each completion to the current Codex thread. Use for inspection, tests, builds, and lint.
---

# CLI run

Invoke this skill's `scripts/cli-run.mjs` by its absolute path, keeping the shell in the user's intended working directory. Run `node <skill-directory>/scripts/cli-run.mjs launch --spec -` and pass a JSON array on stdin. Each item has a unique `id` and either `argv` (preferred) or a platform-shell `command` string; `cwd` defaults to the launch directory. For example: `[{"id":"tests","argv":["node","--test"]}]`. Set `--max-parallel N` when the default of 4 concurrent commands would be inappropriate.

On Windows, use `command` for `.cmd` or `.bat` wrappers such as `npm`; `argv` starts a program directly and is for executable paths such as `node.exe`.

## Required command routing

During a coding task, run every shell/CLI command through this skill, including read-only investigation (`git`, `rg`, file listing), edits performed by command-line tools, and checks such as tests, builds, and lint. Do not start task commands directly in a terminal or `exec` tool: routing them through `cli-run` gives each command a completion notification and a saved log. Prefer `argv`, assign unique job IDs, and group related independent commands into one launch when useful.

Direct command-line calls are limited to bootstrapping `cli-run launch`, reading `cli-run status --run <id>`, and the terminal wrapper described below. That wrapper may start `cli-run` and wait on its worker PID, but all actual task commands must still be jobs inside `cli-run`. Native file-reading and editing tools are not command-line executions. If `cli-run` or its completion notification mechanism is unavailable, stop and ask rather than silently running task commands outside it.

Check the effects of every requested command before launch. Do not add synthetic workload. Node.js and `codex queue --thread ... --message ...` must be available. The launcher uses `CODEX_THREAD_ID` unless given `--thread <id>`; never guess the target. It returns a run ID after its independent worker confirms startup. Keep the launcher inside the Background Terminal wrapper below; once its terminal/session handle is returned, free the chat and let the completion message wake you. Each completion message includes its exit code, up to the last 10 lines of combined stdout/stderr, and the full-log path. Long individual lines are capped to keep notifications bounded. These lines are sent to the Codex thread, so avoid commands whose output may reveal secrets.

## Mandatory Background Terminal

Run the `$cli-run` launcher from a persistent Codex Background Terminal with PTY enabled. The PTY keeps the launcher terminal visible while its worker runs; individual job processes are spawned without interactive stdin, and their combined stdout/stderr go to per-job log files. Do not assume jobs have a PTY. This is mandatory for every command and duration, even if the user only says "run". Never launch `cli-run launch` from an ordinary terminal/exec call and never use a detached-only fallback; a detached worker alone is not visible in `/ps`.

1. Start the terminal wrapper in the active repository/worktree. Pass each complete task command as an `argv` job to `node <absolute-skill-path>/scripts/cli-run.mjs launch --spec -` on stdin.
2. Parse and print the launch JSON (`runId`, `pid`, status directory), then keep the same terminal alive by waiting on that exact worker PID. In PowerShell, use `Wait-Process -Id ([int]$started.pid)`; on other shells, use the equivalent blocking OS wait. This is not polling.
3. Preserve the terminal/session handle returned by the host; it must remain inspectable in `/ps` while the worker is alive. After securing the handle, free the chat and use the `cli-run` completion message and saved log for the result. Do not wait on the terminal merely to discover completion or launch a duplicate.

If a native Background Terminal option is not exposed but `exec_command` can create a PTY and return a live session handle (for example, `tty: true`), use that PTY and retain its handle. If neither a native Background Terminal nor a persistent PTY/session handle is available, stop and ask rather than launching detached.

Short commands may finish before the terminal handle can be inspected; the completion message and saved log remain authoritative. Do not add artificial delays to keep a terminal visible.

For Rush, put the complete invocation in one `argv` job, set `cwd` to the active repository/worktree, keep a stable `--session`, omit `--codex-thread-id`, and keep `--json` when its result envelope is needed. `cli-run` owns the external completion notification; inspect the saved log after that notification.

Use `node scripts/cli-run.mjs status --run <id>` for a read-only status check when asked. The run's private state and logs live under `$CODEX_HOME/cli-run/runs/` (or `~/.codex/cli-run/runs/`). If notification delivery fails, the result records the failure; do not claim the message arrived. The launcher temporarily stores command arguments in that private run directory, so avoid embedding secrets in commands when possible.
