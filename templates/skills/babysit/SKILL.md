---
name: babysit
description: "Install a recurring cron job that monitors the TaskList and resumes stalled work on each tick. Self-stops by calling CronDelete the moment the TaskList is empty. The contract is verifiable: after invoking, CronList must show a recurring job whose prompt starts with `# babysit tick`."
---

# babysit

A heartbeat for the TaskList. Wakes work up after network errors, API timeouts, missed continuations, or any silent stall — and shuts itself off the moment everything is done.

`/babysit` itself installs **one cron job** via `CronCreate`. The cron's prompt — the "tick prompt" — is what runs on each fire. They are different programs running at different times; don't confuse them.

## Usage

```
/babysit          # every 15 minutes (default)
/babysit 5m
/babysit 1h
```

## On invocation (this is what /babysit DOES, once)

Run these steps in order. **Each one has an observable result** — don't trust your own narration, trust the tool output.

1. **Call `CronList`.** Look for a recurring entry whose prompt starts with `# babysit tick`. If found, compare its full saved prompt with the current **Tick prompt** below. If identical, report `babysit already armed: <job-id>, every <interval>`; if different, report the job id and that the current logic is not applied. If only a truncated prompt is available, report `babysit prompt match unverified: <job-id>`; a matching prefix proves neither equality nor difference. Stop in all three cases: do not duplicate or replace the job without the user's request.

2. **Call `CronCreate`.** Arguments:
   - `cron`: an "every N minutes" expression at **off-minutes** (the CronCreate doc warns about :00 and :30 fleet pileups). Examples:
     - `15m` → `"7,22,37,52 * * * *"`
     - `5m`  → `"2,7,12,17,22,27,32,37,42,47,52,57 * * * *"`
     - `1h`  → `"7 * * * *"`
     - Any other interval → pick offsets that aren't :00 or :30.
   - `prompt`: the **Tick prompt** verbatim, from the next section of this file.
   - `recurring`: `true`.
   - `durable`: `false` (session-only). Pass `true` only if the user explicitly asked the heartbeat to survive a restart.

3. **Call `CronList` again** to confirm the job appears. Report exactly one line: `babysit armed: <job-id>, every <interval>`.

If step 2 returns an error → surface it to the user verbatim. Do NOT continue without a confirmed job id.

## Tick prompt (this is the text passed to CronCreate as `prompt`)

Copy the block below into the `prompt` argument of CronCreate **as-is**, including the leading `# babysit tick` line. The leading line is the marker that step 1 above uses for ownership detection — if you change it, future `/babysit` invocations will install duplicates.

```
# babysit tick — monitor the TaskList and wake stalled work

The TaskList defines remaining work, not execution state; /goal is not consulted. User stops and changes of direction take priority. Respect scope and permissions; leave other agents' tasks alone.

1. Read the TaskList. If no owned pending or in_progress tasks remain, find your cron via CronList by this prompt's first line, delete it via CronDelete, and end the tick.

2. Establish execution state from tool results and notifications, distinguishing last-known from currently confirmed state. in_progress, TaskUpdate, a commit, a cron, or repeating an old result does not prove a live executor. Reconfirm inherited executors after a session restart; stopped/failed/completed supersedes earlier running for that executor, not for the operation it observes. Distinguish running, queued, waiting, blocked, and unknown; if current state cannot be established, use unknown. Use the supported verification mechanism; do not launch duplicates or replace completion notifications with manual polling. If queued/waiting state persists unusually long, inspect available evidence of the delay and report its confirmed cause or that it is unknown; do not label waiting as execution or restart work merely because it is delayed.

3. Continue actionable started tasks and pick pending tasks with satisfied dependencies; prefer lower IDs when otherwise equal. Follow the recorded strategy. Run independent work in parallel when authorized and free of file or resource conflicts. One waiting task does not block the rest; permission to parallelize grants no additional permissions for agents or commands.

4. Execute work, not just status updates. Mark started tasks in_progress and completed tasks completed only after verifying their acceptance criteria. After each result, continue actionable work in this turn without waiting for a tick. When no owned open tasks remain, delete the cron as in step 1.

5. Wait only when no other authorized work is actionable and a launched finite operation or agent will produce a result needed to advance the goal. Name the task, executor ID, confirmed state, needed result, and resumption mechanism. Servers and watchers are infrastructure: wait for a specific necessary event (server readiness, a finite CI run's result), not merely a live process. A running CI watch does not prove CI execution. Do not launch unnecessary work to justify waiting. If blocked, name the missing permission, decision, resource, or dependency instead of promising background work.

Keep reports brief: actual results or the precise reason for waiting or blockage. The next tick is a recovery fallback, not a substitute for an available action.
```

## Cleanup

- The tick prompt **self-deletes** the cron when no owned open tasks remain (steps 1 and 4 of the tick).
- If you finish a babygoal-led session early and want to kill the babysit explicitly: `CronList` to find the job, then `CronDelete <id>`.
- All cron jobs auto-expire after 7 days regardless. If a babygoal run lives that long, re-invoke `/babysit` to re-arm.

## Important

- **The timer is a recovery fallback, not a pacing gate.** An active session continues actionable work without waiting for the next tick.
- A cron stores a copy of the tick prompt: editing this file does not update existing jobs. Recreate an existing babysit job to apply the new logic.
- The skill loader does not execute the cron for you. **Reading this file is not the same as installing the cron.** Don't move on until step 3 above has logged a confirmed `<job-id>`.
- This skill changes neither the goal nor the plan — it only nudges existing work forward. New tasks come from `/task` or `/babygoal`. List hygiene comes from `/triage`.
- If `CronList` shows the TaskList is empty of your work but other agents' tasks are still alive — leave their tasks alone, but do call CronDelete on your own job. It's not yours to babysit.
