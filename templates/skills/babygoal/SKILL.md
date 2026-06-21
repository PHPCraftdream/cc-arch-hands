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
- `TaskList` shows at least one task with status `in_progress`.

Neither can be faked. If either check returns the wrong thing at the end, the contract is broken — surface that to the user instead of sending a "I'm working" response while the heartbeat is missing.

This contract exists because the most common failure mode is the agent invoking `Skill('babysit', ...)`, reading the loaded text, and moving on — without actually executing the `CronCreate` that the babysit skill describes. The skill-tool call returns text; it does not install crons for you. Only `CronCreate` does that, and only `CronList` can confirm it.

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

5. **Invoke `/babysit` FIRST, then start work.**

   This step is one indivisible action, not two. Do **both** sub-steps before you call any *work* tool (Edit, Write, Bash, Agent, etc.).

   - **5a. Invoke `Skill('babysit', '<interval>')`** with the value from step 1. You are NOT setting up a cron or scheduler yourself — that's `/babysit`'s job. You just **call** the skill once. `/babysit` internally invokes `/loop` to register the recurring monitor and returns immediately, so there's no reason to "do it later". Doing it later is how the contract gets broken: by the time you'd otherwise come back to it, you're absorbed in the first task and the turn is closing.
   - **5b. `TaskUpdate` the lowest-id ready pending task to `in_progress`** and begin work using the strategy from step 3. "Ready" = `blockedBy` is empty or fully resolved.

   The ordering protects the user: even if your work turn errors out, dies, or runs out of context mid-edit, `/babysit` is already running and the next tick will pick up where you left off.

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

2. **`TaskList`.** Is at least one task with status `in_progress`?
   - **No** → mark the first ready pending task `in_progress` via `TaskUpdate`. If there are no pending tasks at all, something went wrong in step 4 — surface that to the user.
   - **Yes** → check passed.

Both checks must pass before the response ships. Narration ("I invoked babysit", "I marked the task in_progress") is not evidence; only the tool output is. If either check still fails after best-effort fix, surface the failure to the user with "heartbeat not installed: <reason>" — do not send a confident "I'm working" response while the babysit is missing.
