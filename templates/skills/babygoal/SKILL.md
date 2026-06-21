---
name: babygoal
description: "Decompose work into tasks via TaskCreate, choose an execution strategy, invoke /babysit, and start the first ready task — all in one turn. The TaskList — not /goal — is what drives progress. /babysit invocation is MANDATORY: skipping it is the #1 contract violation of this skill."
---

# babygoal

End-to-end starter for multi-step work. Decomposes → arms /babysit → starts work. No `/goal` machinery: progress is governed by what's on the TaskList, not by a Stop-hook condition the agent can't actually set.

## Usage

```
/babygoal Implement authentication module with JWT tokens
/babygoal 5m Refactor the database layer
```

The first argument is an optional interval (e.g. `5m`, `1h`). Everything else is the work description.

## The verifiable contract

By the time this turn ends, the following must be **observable in tool output**, not just narrated:

- `CronList` shows a recurring job whose prompt starts with `# babysit tick` and whose cron expression matches the interval from step 1.
- `TaskList` shows the **leaf tasks of the decomposition**, not an umbrella wrapper:
  - **Single-context strategy** → at least one leaf task with status `in_progress`.
  - **Sequential sub-agents** → all decomposed tasks present; the first one `in_progress`, the rest `pending` with correct `blockedBy`.
  - **Parallel sub-agents** OR **`/workflows`** OR **batches with worktree isolation** → all decomposed tasks present; **every task currently in flight** marked `in_progress` simultaneously (not just one); any tasks that depend on these flagged `pending` with proper `blockedBy`.

Umbrella tasks ("run workflow X" hiding 5 phases inside, or "execute parallel batch" hiding 8 agents) are **anti-patterns** — they break resumability, hide progress from `/babysit` ticks and `/resume`, and make `/triage` blind. Count the leaves, not the wrapper.

None of this can be faked by narration. If `TaskList` shows only a wrapper, the decomposition step (§4) was not actually performed and the contract is broken. Surface that to the user instead of sending a "I'm working" response.

This contract exists because two failure modes are extremely common:
1. The agent invokes `Skill('babysit', ...)`, reads the loaded text, and moves on — without actually executing the `CronCreate` that the babysit skill describes. The skill-tool call returns text; it does not install crons for you. Only `CronCreate` does that, and only `CronList` can confirm it.
2. The agent picks `/workflows` or parallel sub-agents as the strategy, writes the phase structure inside the workflow script or batch call, satisfies "≥1 in_progress" with a single umbrella task, and considers the decomposition "materialized in the workflow". It is not — workflow phases are ephemeral; the TaskList is what survives compacts, `/resume`, and babysit ticks.

## Behavior

1. **Parse the argument.** If the first word matches a time-interval pattern (digits + `s`/`m`/`h`), use it as the babysit interval. Otherwise default to `15m`. Remember this number — it goes into the Skill `babysit` call in step 5.

2. **Investigate the problem domain first.** Decomposition without understanding produces bad task lists. Before writing a single TaskCreate call, decide whether the area is already understood:
   - **Already understood** — the user has been working on it in this session, or the conversation already covers the architecture/code paths the work touches. State this explicitly ("domain is already covered by this session — skipping investigation") and move on.
   - **Not understood** — surface that honestly ("the domain looks unfamiliar — investigating before decomposing") and run a focused investigation. Pick the smallest set of probes that will produce a real mental model:
     - For an unfamiliar repository → invoke `/repo-sight` (returns a ranked reading list with caveats).
     - For an unfamiliar subsystem inside a known repo → read the relevant module(s), the tests that exercise them, and the manifest/wiring file that ties them in.
     - For an unfamiliar library or API → read the docs / examples / type definitions, not blog posts.
     - For an unfamiliar bug → reproduce it (or at least find the failing test / log line) before planning the fix.
   - Stop investigating the moment you can name the moving parts and the riskiest one. More investigation past that point burns context that the work itself will need.
   - If the user's argument is too vague to investigate (no target, no file, no symptom) — ask one clarifying question and stop. Do not guess and do not proceed to step 3.

3. **Choose an execution strategy.** Now that the shape of the work is clear, pick *how* it should be run. Be honest about why:
   - **single context** — the work is small/contiguous and a single conversation can hold it;
   - **sequential sub-agents** — independent chunks of medium size that benefit from fresh context per chunk (`Agent` calls one at a time);
   - **parallel sub-agents** — truly independent work where wall-clock matters (multiple `Agent` calls in one tool batch);
   - **`/workflows`** — large fan-out with deterministic structure: dimension passes, adversarial verify, synthesis;
   - **batches with worktree isolation** — parallel agents that mutate files and would otherwise conflict (`isolation: 'worktree'`).

4. **Decompose into tasks.** Break the work into concrete sub-tasks with `TaskCreate`, ordering them and recording `blockedBy` dependencies where they exist. Shape the decomposition to fit the strategy. **In each task's `description`, name the strategy explicitly** (e.g. "strategy: parallel sub-agents") and include any non-obvious finding from the investigation that the task depends on (e.g. "depends on the fact that X is implemented in lib/foo.js, not lib/bar.js — discovered during investigation"). This lets a later `/babysit` tick — or a fresh session after `/resume` — resume without re-investigating.

   **One task per executable unit — including when the strategy is `/workflows` or parallel sub-agents.**

   Each agent call, each workflow phase, each loop iteration, each parallel batch element is its own `TaskList` item. The workflow script's internal `phase()` blocks and the batched arguments to `parallel()` are **NOT a substitute** — they are invisible to `/resume`, `/babysit` ticks, `/triage`, `/checkpoint`, and session restarts. Only the TaskList survives those events.

   A single umbrella task ("run workflow X" hiding 5 phases inside, or "execute parallel batch" hiding 8 agents) is an **anti-pattern**: it satisfies the "≥1 task in_progress" check while hiding the real shape of the work. It looks compliant and it isn't.

   If you find yourself thinking *"the workflow handles its own decomposition"* or *"the parallel batch is one logical unit"* — stop and create the sub-tasks anyway. The workflow / batch / loop drives *execution order and concurrency*; the TaskList tracks *what work exists*. Both are needed.

5. **Invoke `/babysit` FIRST, then start work.**

   This step is one indivisible action, not two. Do **both** sub-steps before you call any *work* tool (Edit, Write, Bash, Agent, etc.).

   - **5a. Invoke `Skill('babysit', '<interval>')`** with the value from step 1. The babysit skill's instructions tell you to call `CronCreate` with an off-minute cron expression and a `# babysit tick` prompt — **execute those instructions to completion**. The Skill-tool call alone returns text; it does not install a cron. You must perform the `CronCreate` and then `CronList` to confirm the job id before moving on. (The verifiable contract below will catch you if you skip this.)
   - **5b. `TaskUpdate` the right tasks to `in_progress` for your strategy**, then begin work.
     - **Single-context** → mark the lowest-id ready pending task `in_progress`, work it.
     - **Sequential sub-agents** → mark the first ready task `in_progress`, launch the first agent.
     - **Parallel sub-agents** / **`/workflows`** / **batches with worktree isolation** → mark **every task that the first concurrent batch will execute** `in_progress` at once, then launch them. "Ready = lowest-id" is for serial strategies only; parallel strategies start multiple tasks simultaneously and their TaskList state must reflect that.

   The ordering protects the user: even if your work turn errors out, dies, or runs out of context mid-edit, `/babysit` is already running and the next tick will pick up where you left off. And every in-flight piece is visible in the TaskList so the tick can find it.

## Important

- **The user's argument is *intent*, not the final plan.** The agent enriches it into a TaskList in step 4 (decomposition) and acts on it in step 5 (install heartbeat + start work).
- **If no description is provided**, ask the user what to do — do not install a heartbeat for empty work and do not invent tasks.
- **This skill does NOT use `/goal`.** `/goal` is a user-side Stop hook and is decoupled from the TaskList monitoring the babysit cron performs. If the user wants a hard "session must not stop until X" guarantee on top of the TaskList, they can type `/goal <text>` themselves in a separate message — `/babygoal` will not synthesize or print such a line.
- **Each task's `description` should be self-contained enough that resuming it does not require the conversation context that produced it.** Write it for a stranger — the babysit tick and `/resume`-restored sessions will both read these descriptions blind.

## Before sending — observable checks

Before ending any response from this skill, **run exactly these two tool calls** and inspect their output:

1. **`CronList`.** Does the returned list contain a recurring job whose prompt starts with `# babysit tick` and whose cron expression matches the interval from step 1?
   - **No** → the babysit invocation in 5a did not actually install the cron (most likely you read the skill text and skipped the actual `CronCreate`). Re-invoke `Skill('babysit', '<interval>')` and this time follow its "On invocation" steps to the letter — including the `CronCreate` and the second `CronList` confirmation. If that still doesn't produce a job, fall back to calling `CronCreate` directly from this file: build the off-minute cron expression for the interval and pass the tick prompt text from the babysit SKILL.md verbatim.
   - **Yes** → check passed.

2. **`TaskList`.** Look at the returned tasks against the strategy you chose in step 3:
   - **Single-context** → at least one leaf task is `in_progress`.
   - **Sequential sub-agents** → all decomposed tasks present; exactly one (the first) is `in_progress`, others `pending` with `blockedBy` chains correct.
   - **Parallel sub-agents** / **`/workflows`** / **batches with worktree isolation** → all decomposed tasks present; **every task currently in flight** is `in_progress` (count them — should match the size of your first parallel batch); the rest are `pending` with proper `blockedBy`.

   **Umbrella-task detector.** If `TaskList` shows only one task whose subject mentions "run workflow X", "execute parallel batch", "do all phases", or similar wrapper language while the strategy is anything other than single-context — the decomposition step (§4) was skipped. Delete the umbrella, perform the real decomposition, then re-check. Do NOT ship a `/babygoal` response that pretends a wrapper task is the decomposition.

If either check still fails after best-effort fix, surface the failure to the user with "contract broken: <reason>" — do not send a confident "I'm working" response while the heartbeat or the leaf-level decomposition is missing.

Narration ("I invoked babysit", "the workflow handles its own phases", "I marked the umbrella in_progress") is not evidence; only the tool output is.
