---
name: cli-run
description: Run long-running CLI jobs through MCP with queued completion notifications or inline results for native subagents. Use for test suites, builds, compilation, large copies, and CI watches; not for quick git, search, or file-reading commands.
---

# CLI run

Use the `cli-run` MCP server's tools for long-running jobs. If the tools are unavailable when needed, stop and ask.

Use native file/terminal tools directly for commands expected to finish in seconds: `git status`, `git diff`, `git log`, `rg`, file listings, and source reads. Do not route these through `cli-run`. Use `cli-run` when a command may take appreciably longer, such as a test suite, build, compilation, substantial copy, or `gh run watch`.

- `run` requires a short human-readable `taskName` and `jobs`, an array of 1-64 commands. The server assigns a UID; never invent one. Optional fields are `maxParallel` (1-16, default 4), `showOutput` (default `false`, inline only), and `delivery` (`queue` by default, or `inline`). Each job has a unique `id` and exactly one of `argv` (preferred, started without a shell) or `command` (a platform-shell string). `cwd` must be absolute; omit it only with exactly one workspace root.
- Use `delivery: "inline"` for long-running jobs in native spawned subagents. The tool call stays open until the jobs finish and returns their exit codes and log paths directly. Set `showOutput: true` only when you need their output. Output is capped at 64 KiB per job and 256 KiB per call; use a narrower command or the saved log if truncated. Inline jobs do not call `codex queue` and do not need a routable thread ID.
- Default `queue` delivery returns only `taskName` and the assigned `uid` as soon as the worker starts. The tool result already shows both; do not repeat them in a chat message. The jobs continue after the tool call returns.
- `status` and `logs` take `query`: the exact task name or UID. Repeated names select the most recent run; use UID for an older run. `logs` accepts an optional `jobId` and `tailBytes` (default 8192, maximum 65536 per log).

On Windows, use `command` for `.cmd` or `.bat` wrappers such as `npm`; `argv` starts a program directly and is for executable paths such as `node.exe`.

Keep the job array minimal and task-directed. Do not run generic version or workspace-inventory probes unless the task needs them. Check the effects of every requested command before launch, and do not add synthetic workload.

## Permissions

`run` can execute arbitrary programs, modify files, and access the network. MCP
processes and their jobs do not inherit Codex's per-turn filesystem sandbox.
`status` and `logs` are read-only; logs can contain secrets.

`MCP tool call requires approval, but approval policy is never` means Codex
rejected the call before this server launched a job. No run was acknowledged;
there is no job to wait for. Do not bypass the rejection with another runner.

Ask the user to choose interactive approval (`on-request`) or explicit trust.
For explicit trust, the user can add this line inside the managed
`[mcp_servers.cli-run]` table in Codex `config.toml`, before the end marker:

```toml
tools.run.approval_mode = "approve"
```

This trusts arbitrary `run` commands, not only tests. Installation does not add
this permission automatically; reinstall preserves an explicit policy line.
Restart Codex after changing it. This does not change `apply_patch` permissions
or make a read-only `.git` writable.

## Completion

For default `queue` delivery, the `run` result is an acknowledgment, not command completion. After all jobs finish, one short message reports the task name, UID, and success/failure count. It does not include commands or output. On success, do not call `status` or `logs` or repeat the completion message unless the task requires further work. On failure or when asked for details, inspect by name or UID. Let the completion message wake you; do not wait or poll `status` to discover completion.

For `inline` delivery, the tool response itself is the completion. Read `results[].output.text` when `showOutput: true`; `results[].output.truncated` indicates that more is in the log. No queued completion message follows. Use this mode for long-running jobs in native spawned subagents: `codex queue` rejects messages to their unloaded threads. Never relaunch jobs from an acknowledged run.

Use `status` when asked, or when a queued completion message is missing or reported a delivery failure. If delivery failed, the result records it; do not claim the message arrived. Queued delivery needs Node.js and `codex queue --thread ... --message ...`. The thread is taken from Codex's tool-call metadata; never guess it.

Jobs get no interactive stdin and no PTY. If a command needs interactive input, stop and ask.

For Rush, put the complete invocation in one `argv` job, set `cwd` to the active repository/worktree, keep a stable `--session`, omit `--codex-thread-id`, and keep `--json` when its result envelope is needed. `cli-run` owns the external completion notification; inspect the saved log after that notification.

Task names appear in completion messages; command arguments are stored in run state. Keep secrets out of both.
