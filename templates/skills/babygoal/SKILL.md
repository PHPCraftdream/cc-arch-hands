---
name: babygoal
description: "Decompose a piece of work into tasks via TaskCreate, choose an execution strategy, immediately start the first ready task, and invoke /babysit so the TaskList is monitored and stalls are resumed. The TaskList — not /goal — is what drives progress."
---

# babygoal

End-to-end starter for multi-step work. Decomposes → starts → hands off to a TaskList-driven `/babysit`. No `/goal` machinery: progress is governed by what's on the TaskList, not by a Stop-hook condition the agent can't actually set.

## Usage

```
/babygoal Implement authentication module with JWT tokens
/babygoal 5m Refactor the database layer
```

The first argument is an optional interval (e.g. `5m`, `1h`). Everything else is the work description.

## Behavior

1. **Parse the argument.** If the first word matches a time-interval pattern (digits + `s`/`m`/`h`), use it as the babysit interval. Otherwise default to `15m`.
2. **Investigate the problem domain first.** Decomposition without understanding produces bad task lists. Before writing a single TaskCreate call, decide whether the area is already understood:
   - **Already understood** — the user has been working on it in this session, or the conversation already covers the architecture/code paths the work touches. State this explicitly ("domain is already covered by this session — skipping investigation") and move on.
   - **Not understood** — surface that honestly ("the domain looks unfamiliar — investigating before decomposing") and run a focused investigation. Pick the smallest set of probes that will produce a real mental model:
     - For an unfamiliar repository → invoke `/repo-sight` (returns a ranked reading list with caveats).
     - For an unfamiliar subsystem inside a known repo → read the relevant module(s), the tests that exercise them, and the manifest/wiring file that ties them in.
     - For an unfamiliar library or API → read the docs / examples / type definitions, not blog posts.
     - For an unfamiliar bug → reproduce it (or at least find the failing test / log line) before planning the fix.
   - Stop investigating the moment you can name the moving parts and the riskiest one. More investigation past that point burns context that the work itself will need.
   - If the user's argument is too vague to investigate (no target, no file, no symptom) — ask one clarifying question and stop. Do not guess.
3. **Choose an execution strategy.** Now that the shape of the work is clear, pick *how* it should be run. Be honest about why:
   - **single context** — the work is small/contiguous and a single conversation can hold it;
   - **sequential sub-agents** — independent chunks of medium size that benefit from fresh context per chunk (`Agent` calls one at a time);
   - **parallel sub-agents** — truly independent work where wall-clock matters (multiple `Agent` calls in one tool batch);
   - **`/workflows`** — large fan-out with deterministic structure: dimension passes, adversarial verify, synthesis;
   - **batches with worktree isolation** — parallel agents that mutate files and would otherwise conflict (`isolation: 'worktree'`).
4. **Decompose.** Break the work into concrete sub-tasks with TaskCreate, ordering them and recording `blockedBy` dependencies where they exist. Shape the decomposition to fit the strategy and the understanding from step 2. **In each task's `description`, name the strategy explicitly** (e.g. "strategy: parallel sub-agents") and include any non-obvious finding from the investigation that the task depends on (e.g. "depends on the fact that X is implemented in lib/foo.js, not lib/bar.js — discovered during investigation"). This lets a later `/babysit` tick — or a fresh session after `/resume` — resume without re-investigating.
5. **Start executing.** Immediately mark the first ready task `in_progress` and begin work using the chosen strategy. Do not wait.
6. **Babysit.** Once execution is underway, invoke `/babysit <interval>` so the TaskList is monitored and any stall is resumed automatically. `/babysit` shuts off by itself once the TaskList has no open tasks.

## Important

- The user's argument is *intent*, not the final plan. The agent enriches it into a TaskList in step 3.
- If no description is provided, ask the user what to do — do not start an empty babysit and do not invent work.
- This skill does NOT use `/goal`. `/goal` is a user-side Stop hook and is decoupled from the TaskList monitoring `/babysit` performs. If the user wants a hard "session must not stop until X" guarantee on top of the TaskList, they can type `/goal <text>` themselves in a separate message — `/babygoal` will not synthesize or print such a line.
- Each task's `description` should be self-contained enough that resuming it does not require the conversation context that produced it. Write it for a stranger.
