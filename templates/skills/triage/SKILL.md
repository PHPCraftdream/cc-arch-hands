---
name: triage
description: "Inspect the current TaskList and propose hygiene actions: drop or finalize stale in_progress tasks, surface blockers, suggest squashing trivial tasks, and prune kept-around completed tasks. Asks before doing anything destructive."
---

# triage

A foreman walking the TaskList floor. Catches the patterns that quietly degrade an active plan: zombie `in_progress`, fan-out without a stitch back, completed tasks left lying around, blockers nobody is unblocking.

## Usage

```
/triage          # interactive walk, propose actions, ask before each destructive step
/triage --dry    # report only, never mutate
```

## Behavior

1. **Snapshot.** Call TaskList. Bucket every task by status (`pending`, `in_progress`, `completed`, `deleted`). Note `blockedBy` relations.
2. **Classify hygiene issues.** For each bucket, look for the patterns below. Be explicit about what triggered each flag — do NOT invent issues.

   | Pattern | Trigger | Default proposed action |
   |---|---|---|
   | **Stale in_progress** | `in_progress` with no observable progress in conversation context | Ask: complete? back to pending? delete? |
   | **Orphan blocker** | A task's `blockedBy` references an ID that is `completed` or `deleted` | Clear the stale blocker reference |
   | **Dead-end chain** | `pending` whose `blockedBy` includes a deleted/missing task | Either delete the dead-end or remove the broken dep |
   | **Trivial sibling cluster** | 3+ small `pending` tasks under the same theme | Ask whether to squash into one |
   | **Completed clutter** | More than 10 `completed` tasks accumulated | Ask whether to mark a cutoff for deletion |
   | **Duplicate subject** | Two tasks with near-identical `subject` | Ask which to keep |

3. **Print a triage table.** One row per finding: bucket, taskId, pattern, proposed action.
4. **Ask before mutating.** For each proposed action, confirm with the user (one batched confirmation per pattern category is fine — don't ask 20 times in a row). On `--dry`, skip step 5.
5. **Execute confirmed actions.** Use TaskUpdate (status changes, removing blockers) and TaskCreate (for squashed replacements). Report what was done.

## Important

- This skill is *advisory by default*. It never deletes or modifies a task without an explicit yes from the user.
- It is OK for the report to be "no findings — TaskList is clean." Say so plainly.
- Do NOT touch tasks owned by another agent (look at `owner` field) — flag them, but don't act.
- Never invent a "stale" judgement just because activity isn't visible in the trimmed context window. Err on the side of asking the user.
