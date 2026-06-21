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

1. **Call `CronList`.** Look in the returned jobs for a recurring entry whose prompt starts with `# babysit tick`. If you find one, stop here and report `babysit already running: <job-id>, every <interval>`. Do NOT install a second one — two babysitters fight each other.

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

Run these steps in order on each tick. The TaskList is the source of truth; /goal is not consulted.

1. Snapshot the TaskList. Count pending, in_progress, and blocked (a pending whose blockedBy is non-empty and not all resolved).

2. Stop condition: if pending + in_progress == 0, find your own job id by calling CronList, matching this prompt's first line. Call CronDelete on that id. Report "TaskList empty — babysit done." End the tick.

3. If any task is in_progress:
   - Look for fresh progress signals since the previous tick: a new commit in `git log`, a TaskUpdate within the interval, a recent agent message.
   - Signal present → one-line report "still running #<id>". End the tick.
   - Signal absent → resume that task from its description (it carries the strategy /babygoal recorded). Do NOT change the goal, do NOT start new work, do NOT touch tasks owned by another agent.

4. Otherwise (only pending tasks remain): pick the lowest-id pending whose blockedBy is empty or fully resolved. Mark it in_progress via TaskUpdate. Begin work using the strategy named in its description.

5. Every blocked? Report the blocker chain and end the tick — don't loop tighter, the next tick will re-check.

Each tick must end with at most one short line of output: still running #N / resumed #N / started #N / blocked / done. Status essays burn the cron's small token budget.
```

## Cleanup

- The tick prompt **self-deletes** the cron when the TaskList becomes empty (step 2 of the tick).
- If you finish a babygoal-led session early and want to kill the babysit explicitly: `CronList` to find the job, then `CronDelete <id>`.
- All cron jobs auto-expire after 7 days regardless. If a babygoal run lives that long, re-invoke `/babysit` to re-arm.

## Important

- The skill loader does not execute the cron for you. **Reading this file is not the same as installing the cron.** Don't move on until step 3 above has logged a confirmed `<job-id>`.
- This skill changes neither the goal nor the plan — it only nudges existing work forward. New tasks come from `/task` or `/babygoal`. List hygiene comes from `/triage`.
- If `CronList` shows the TaskList is empty of your work but other agents' tasks are still alive — leave their tasks alone, but do call CronDelete on your own job. It's not yours to babysit.
