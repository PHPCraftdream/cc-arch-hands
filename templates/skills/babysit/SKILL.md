---
name: babysit
description: "Run a /loop on a configurable interval (default 15m) that monitors the TaskList and wakes work back up — picks the next ready pending task to start, or resumes a stalled in_progress one. Stops itself when the TaskList has no open tasks. Use whenever you have multi-step work that must not silently halt."
---

# babysit

A heartbeat for the TaskList. Wakes work up after network errors, API timeouts, missed continuations, or any silent stall — and shuts itself off the moment everything is done.

The mental model is deliberate: **the TaskList is the source of truth.** No `/goal` indirection — the agent cannot set `/goal` programmatically anyway. If there are open tasks, there is work to do. If there are none, the loop is done.

## Usage

```
/babysit          # check every 15 minutes (default)
/babysit 5m       # check every 5 minutes
/babysit 1h       # check every hour
```

## Behavior

When invoked, start a `/loop <interval>` that on each tick performs the following steps in order:

1. **Snapshot the TaskList.** Call TaskList. Count `pending`, `in_progress`, `blocked` (a pending whose `blockedBy` is non-empty and not all resolved).
2. **Stop condition: nothing open.** If `pending + in_progress == 0`, stop the loop and report "TaskList empty — babysit done." Do NOT spin.
3. **Wake an in_progress task if it stalled.** If there is at least one `in_progress` task:
   - Look for fresh progress signals in conversation context: a new agent message in the last tick, a new commit in `git log`, a TaskUpdate within the interval.
   - If signals are present → report "still running" with the task subject, and end this tick.
   - If signals are absent → treat the task as stalled. Resume it from where it left off using whatever strategy the original work was started with (`/babygoal` records the strategy in the task description; respect that). Do NOT change the goal, do NOT start new work, do NOT touch tasks owned by another agent.
4. **Otherwise, start the next ready pending task.** If no `in_progress` exists:
   - Pick the lowest-id `pending` task whose `blockedBy` list is empty or fully resolved.
   - Mark it `in_progress` via TaskUpdate, and begin working on it.
   - If every pending task is blocked → report the blocker chain and end this tick (do not loop tighter — let the next tick re-check).
5. **Report concisely.** One short line per tick: `still running #N`, `resumed #N (was stalled)`, `started #N`, `blocked: #N waits on #M`, or `done`.

## Important

- This skill changes neither the goal nor the plan — it only nudges the existing work forward. If the user wants new tasks added, they invoke `/task` or `/babygoal`. If they want hygiene on the list itself, `/triage`.
- Never invent a "stall" because the current conversation window doesn't show recent activity — distinguish *no signal* from *signal absent in trimmed context*. When in doubt, treat it as still-running and recheck next tick.
- If TaskList shows only tasks owned by other agents, stop the loop — it's not yours to babysit.
- Tick reports stay one-line. The point is reassurance ("still moving") or action ("resumed"), not a status essay.
