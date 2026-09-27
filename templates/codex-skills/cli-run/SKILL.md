---
name: cli-run
description: Run coding-task CLI commands as background jobs through the cli-run MCP tools and receive each completion as a message in the current Codex thread. Use for inspection, tests, builds, and lint.
---

# CLI run

Use the `cli-run` MCP server's tools. `cah install --codex-skills` registers that server in Codex's `config.toml`. If the `cli-run` tools are not available in this session, stop and ask; the user may need to restart Codex to load the server.

- `run` takes `jobs`, an array of 1-64 objects, an optional `maxParallel` (1-16, default 4), and an optional `showOutput` (default `false`). Each job has a unique `id` and exactly one of `argv` (preferred, started without a shell) or `command` (a platform-shell string). `cwd` must be an absolute path. It may be omitted only when the session has exactly one workspace root, which then becomes the default. Example: `{"jobs":[{"id":"tests","argv":["node","--test"],"cwd":"D:\\repo"}]}`.
- `run` returns `runId`, `statusDir`, and the job count as soon as its detached worker has started. The jobs keep running after the call returns.
- `status` takes a `runId` and returns per-job exit codes, log paths, and notification delivery results.

On Windows, use `command` for `.cmd` or `.bat` wrappers such as `npm`; `argv` starts a program directly and is for executable paths such as `node.exe`.

## Required command routing

During a coding task, run every shell/CLI command through `run`. This includes read-only investigation (`git`, `rg`, file listing), edits performed by command-line tools, and checks such as tests, builds, and lint. Do not start task commands directly in a terminal or `exec` tool: routing them through `cli-run` gives each command a completion notification and a saved log. Prefer `argv`, assign unique job IDs, and group related independent commands into one `run` call when useful. Native file-reading and editing tools are not command-line executions.

Keep the job array minimal and task-directed. Do not run generic version or workspace-inventory probes unless the task needs them. Check the effects of every requested command before launch, and do not add synthetic workload.

## Completion

A `run` result is an acknowledgment, not command completion. Each finished job is reported to this thread as a `cli-run <runId>: <id> ...` message. The message includes the exit code, the command, and the full-log path. Only when `run` was called with `showOutput: true` does it also include up to the last 10 lines of combined stdout/stderr (long lines are capped). Output can contain secrets, so set `showOutput` only when you need the output itself in the chat; otherwise rely on the exit code and read the log only if the task requires it. After `run` returns, free the chat and let those messages wake you. Do not wait, sleep, or poll `status` to discover completion, and never relaunch jobs from an acknowledged run.

Use `status` when asked, or when a completion message is missing or reported a delivery failure. If delivery failed, the result records it; do not claim the message arrived. Delivery needs Node.js and `codex queue --thread ... --message ...`. The thread is taken from Codex's tool-call metadata; never guess it.

Jobs get no interactive stdin and no PTY. If a command needs interactive input, stop and ask.

For Rush, put the complete invocation in one `argv` job, set `cwd` to the active repository/worktree, keep a stable `--session`, omit `--codex-thread-id`, and keep `--json` when its result envelope is needed. `cli-run` owns the external completion notification; inspect the saved log after that notification.

Run state and logs live under `$CODEX_HOME/cli-run/runs/` (or `~/.codex/cli-run/runs/`). Command arguments are stored there temporarily and are echoed in completion messages, so avoid putting secrets in commands.
