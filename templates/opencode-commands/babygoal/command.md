---
description: Investigate work, create a todo plan, arm babysit, and start the first ready task.
---
# babygoal

Arguments: $ARGUMENTS

Parse an optional leading interval (integer plus s, m, h or d; default 15m); the rest is the work request. With no work description, ask and stop without a timer.

1. Investigate only what is needed to understand the target and risks: for an unfamiliar repository read its manifests, README and entry points and run read-only git log/status, and stop once the moving parts and the riskiest seam are clear. Clarify only genuine unresolved user decisions.
2. Choose a strategy that fits the request and available tools. Do the work in this session unless the user explicitly requests delegation. Honor exact agent names and constraints; do not automatically launch subagents.
3. Call cah_todos; ask before replacing an existing unfinished plan. Register every user item as separate executable leaf tasks, in dependency order, via todowrite. Use stable, unique verbatim task contents and keep dependencies, prerequisites and strategy inside the task content and session context (OpenCode todos have no blockedBy field). Block external waits with reasons in the task content; never fabricate IDs.
4. Before beginning the implementation, call cah_babysit with action: arm and the interval, then action: status. Require the status result to show armed: true and the requested interval — prose or a narrated timer is never proof. If the tool is missing or arming fails, surface the actual error and do not pretend the heartbeat exists. The timer is session-only and cannot restart a closed OpenCode process.
5. Call cah_todos and start the earliest actionable task by its verbatim content if needed, then execute it in this same turn. Mark done via todowrite and immediately continue the next ready task; never use a tick as the pacing mechanism. Block genuinely external waits instead of spinning. At completion call cah_babysit with action: off and verify armed: false.

The evidence is a real leaf-level todo plan, a confirmed cah_babysit status (armed: true + interval) while work remains, and observable work results. A prose plan is not a timer. Do not change the main model.
