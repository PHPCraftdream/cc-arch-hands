---
description: Arm, inspect or stop the session-only todo heartbeat.
---
# babysit

Arguments: $ARGUMENTS

Accept one optional interval (positive integer plus s, m, h or d; default 15m), --status or --off. Reject other arguments. Use the installed cah_babysit tool, not cron, external processes or a narrated imaginary timer. If the tool is unavailable, report that opencode-commands must be installed and OpenCode restarted; do not claim to have armed it.

For --status call action: status and report the returned state, including the stop reason (stopped) when it is not armed. For --off call action: off and verify armed: false. Otherwise call cah_todos first; if no unfinished work exists, report that no heartbeat is needed. Call cah_babysit with action: arm and the requested interval, then action: status. Only a status result showing armed: true with the requested interval is success; prose narration or a claimed arming is not proof. Do not replace an existing differently configured timer silently: report the conflict and explain --off.

The plugin monitors this main session's live todo state. It wakes only an idle session with pending/in_progress work, skips active turns and in-flight wakes, leaves content-annotated blockers waiting, and stops when all tasks are completed. Tick execution follows the saved plan and never creates new work or overrides user-selected agents. Continue ordinary work immediately after each completed task; ticks only recover idle work.

The timer is session-only, expires after seven days, and stops on session deletion, completion/cancellation, assistant errors or plugin dispose. Unresolved accepted wakes stop and report after thirty minutes rather than enqueueing duplicates. Off cancels local pending requests but cannot retract a prompt already accepted by OpenCode. It does not revive a closed process, survive restart or guarantee recovery from a broken provider connection. Never launch subagents merely by arming babysit. Report actual tool errors instead of asserting success.
