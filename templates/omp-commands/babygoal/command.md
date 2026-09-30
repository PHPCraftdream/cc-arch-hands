---
description: Investigate work, create an OMP todo plan, arm babysit, and start the first ready task.
---
# babygoal

Arguments: $@

Parse an optional leading interval (integer plus s, m or h; default 15m); the rest is the work request. With no work description, ask and stop without a timer.

1. Investigate only what is needed to understand the target and risks. For an unfamiliar repository read the sibling repo-sight.md and execute its investigation instructions; do not assume reading a command runs it. Clarify only genuine unresolved user decisions.
2. Choose a strategy that fits the request and available tools. Do the work in this session unless the user explicitly requests delegation. Honor exact agent names and constraints; do not automatically launch agents or invent /workflows or worktree isolation flags.
3. Call todo view; ask before replacing an existing unfinished plan. Register every user item as separate executable leaf tasks, in dependency-ordered named phases, via todo init/append. Use stable, unique verbatim task contents and retain strategy and prerequisite findings in context. OMP maintains only one active todo item; concurrent agents, if explicitly requested, do not imply simultaneous in_progress todo entries. Block external waits with reasons; never fabricate blockedBy IDs.
4. Before beginning the implementation, call cah_babysit with action: arm and the interval, then action: status. Require armed: true and the requested interval. If the tool is missing or arming fails, surface the actual error and do not pretend the heartbeat exists. The timer is session-only and cannot restart a closed OMP process.
5. Call todo view and start the earliest actionable task by its verbatim content if needed, then execute it in this same turn. Mark done and immediately continue the next ready task; never use a tick as the pacing mechanism. Block genuinely external waits instead of spinning. At completion call cah_babysit off and verify it is disarmed.

The evidence is a real leaf-level todo plan, a confirmed timer while work remains, and observable work results. A prose plan or a read of babysit.md is not a timer. Do not manipulate /goal or change the main model.
