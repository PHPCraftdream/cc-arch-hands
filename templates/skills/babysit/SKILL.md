---
name: babysit
description: "Run a /loop on a configurable interval (default 15m) to detect when a goal has stalled — network errors, API timeouts, missed continuations — and resume work automatically. Use when you have an active task list or multi-step plan that must not silently stop."
---

# babysit

Watch over long-running task execution and restart it if interrupted.

## When to use

Invoke `/babysit` when you have an active goal (a task list, a multi-step plan, or an ongoing implementation) and want Claude Code to periodically check that progress has not stalled due to network errors, context loss, or other transient failures.

## Usage

```
/babysit          # check every 15 minutes (default)
/babysit 5m       # check every 5 minutes
/babysit 1h       # check every hour
```

## Behavior

When invoked, start a `/loop` with the interval from the argument (default `15m`). On each tick:

1. **Check for an active goal.** Look at the current task list (TaskList) or conversation context. If there is no active goal or all tasks are completed, stop the loop and report that there is nothing to babysit.
2. **Detect interruption.** If the goal exists but progress has stalled — e.g. the last action resulted in a network error, an API timeout, a tool failure, or the task is still marked in-progress with no recent activity — resume execution from where it left off.
3. **Continue the work.** Pick up the interrupted task and keep going toward the goal.
4. **Goal reached.** Once all tasks are completed or the goal is achieved, stop the loop and report completion.

## Important

- Do NOT start new work or change the goal — only resume interrupted progress.
- If the situation is ambiguous (unclear whether the goal is met, or unclear what to do next), stop the loop and ask the user.
- Keep tick reports concise: one line for "still running" or "resumed after error", a short summary when stopping.
