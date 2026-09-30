---
description: Arm, inspect or stop the OMP session-only todo heartbeat.
---
# babysit

Arguments: $@

Accept one optional interval (positive integer plus s, m or h; default 15m), --status or --off. Reject other arguments. Use the installed cah_babysit tool, not CronCreate, external processes or a narrated imaginary timer. If the tool is unavailable, report that omp-commands must be installed and OMP restarted; do not claim to have armed it.

For --status call action: status and report the returned state. For --off call action: off and verify armed: false. Otherwise call todo with op: view first; if no unfinished work exists, report that no heartbeat is needed. Call cah_babysit with action: arm and the requested interval, then action: status. Only armed: true with the requested interval is success. Do not replace an existing differently configured timer silently: report the conflict and explain --off.

The extension monitors this main session's live todo state. It wakes only an idle session with pending/in_progress work, skips active turns and queued messages, leaves all-blocked plans waiting, and stops when all tasks are completed/abandoned. Tick execution follows the saved plan and never creates new work or overrides user-selected agents. Continue ordinary work immediately after each completed task; ticks only recover idle work.

The timer is session-only, expires after seven days, and stops on session switching, branch navigation or shutdown. It does not revive a closed process, survive restart or guarantee recovery from a broken provider connection. Never launch agents merely by arming babysit. Report actual tool errors instead of asserting success.
