---
name: cli-run
description: Run an array of approved CLI commands asynchronously and send each completion to the current Codex thread. Use when commands should continue while the chat stays free.
---

# CLI run

Invoke this skill's `scripts/cli-run.mjs` by its absolute path, keeping the shell in the user's intended working directory. Run `node <skill-directory>/scripts/cli-run.mjs launch --spec -` and pass a JSON array on stdin. Each item has a unique `id` and either `argv` (preferred) or a platform-shell `command` string; `cwd` defaults to the launch directory. For example: `[{"id":"tests","argv":["npm","test"]}]`. Set `--max-parallel N` when the default of 4 concurrent commands would be inappropriate.

Check the effects of every requested command before launch. Do not add synthetic workload. Node.js and `codex queue --thread ... --message ...` must be available. The launcher uses `CODEX_THREAD_ID` unless given `--thread <id>`; never guess the target. It returns a run ID after its independent worker confirms startup. Report that launch, then free the chat; do not wait for the commands. Each completion is queued as a separate message with its exit code and log path, never raw command output.

Use `node scripts/cli-run.mjs status --run <id>` for a read-only status check when asked. The run's private state and logs live under `$CODEX_HOME/cli-run/runs/` (or `~/.codex/cli-run/runs/`). If notification delivery fails, the result records the failure; do not claim the message arrived. The launcher temporarily stores command arguments in that private run directory, so avoid embedding secrets in commands when possible.
