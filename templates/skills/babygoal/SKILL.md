---
name: babygoal
description: "Decompose a goal into tasks via TaskCreate, immediately start executing the first ready task, and invoke /babysit on a configurable interval (default 15m) so progress is resumed automatically if interrupted. Prints a /goal copy-paste line at the end for an optional Stop-hook guard."
---

# babygoal

Decompose a goal into tasks, start executing them, and immediately babysit progress.

## Usage

```
/babygoal Implement authentication module with JWT tokens
/babygoal 5m Refactor the database layer
```

The first argument is an optional interval (e.g. `5m`, `1h`). Everything else is the goal description.

## Behavior

1. **Parse the argument.** If the first word matches a time-interval pattern (digits + `s`/`m`/`h`), use it as the babysit interval. Otherwise default to `15m`.
2. **Choose an execution strategy.** Before decomposing, think about *how* the work should be run. Pick one and be honest about why:
   - **single context** — the work is small/contiguous and a single conversation can hold it;
   - **sequential sub-agents** — independent chunks of medium size that benefit from fresh context per chunk (`Agent` calls one at a time);
   - **parallel sub-agents** — truly independent work where wall-clock matters (multiple `Agent` calls in one tool batch);
   - **`/workflows`** — large fan-out with deterministic structure: dimension passes, adversarial verify, synthesis;
   - **batches with worktree isolation** — parallel agents that mutate files and would otherwise conflict (`isolation: 'worktree'`).
3. **Decompose.** Break the goal into concrete sub-tasks with TaskCreate, ordering them and recording `blockedBy` dependencies where they exist. Shape the decomposition to fit the strategy chosen in step 2.
4. **Start executing.** Immediately begin work on the first ready task using the chosen strategy — do not wait.
5. **Babysit.** Once execution is underway, invoke `/babysit` with the resolved interval so progress is monitored and resumed automatically if interrupted.
6. **Print a synthesized `/goal` line for the user.** At the very end of the response, output exactly one fenced code block containing a `/goal <synthesized goal>` line. Prefix it with a short note like "If you want a hard Stop-hook guard, copy and run:". The synthesized goal must be the agent's own restatement of the work, NOT an echo of the user's raw argument. It must contain:
   - **a verifiable success criterion** ("done = X exists / Y passes / Z is documented") so the Stop hook can actually decide when to clear;
   - **the chosen execution strategy from step 2**, named in one short phrase ("via parallel sub-agents", "via a /workflows orchestration with adversarial verify", "in a single context", etc.);
   - **scope guardrails** for anything explicitly out of scope, so the hook doesn't keep the session alive chasing tangents.

   Keep the synthesized goal to one or two sentences — it is the contract, not the plan.

## Important

- The user's argument is *intent*, not the final goal text. The agent enriches it into a verifiable, strategy-aware goal in step 6.
- If no goal text is provided, ask the user what the goal is — do not start an empty babysit and do not invent a goal.
- This skill does NOT call `/goal` — `/goal` is a user-side slash command and the agent cannot invoke it. The printed copy-paste line is the workaround.
- The persistent driver of progress here is the TaskList itself: `/babysit` rechecks unfinished tasks and resumes them.
