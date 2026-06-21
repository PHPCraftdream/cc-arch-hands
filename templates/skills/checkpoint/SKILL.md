---
name: checkpoint
description: "Persist current session state — active goal, TaskList with statuses and blockedBy, recent key decisions, open questions — into a timestamped markdown file under docs/checkpoints/. Use before context auto-compacts, before a long pause, or when switching to a different machine. Pairs with /resume."
---

# checkpoint

Dump the live session state to disk so the next session (or the next compact-and-reload cycle) can pick up where this one left off.

## Usage

```
/checkpoint               # auto-named with timestamp: 2026-06-19-1432.md
/checkpoint pre-refactor  # named: pre-refactor.md (overwrites if exists)
```

A name is a first-class identifier — `/resume pre-refactor` will find it. Re-running `/checkpoint pre-refactor` overwrites the prior file (useful for iterating on a single named state). Names should be slug-style (lowercase, hyphens, no spaces).

## Behavior

1. **Resolve the target path.** Use `<repo-root>/docs/checkpoints/` if a `.git` directory is found in the current working directory or any parent; otherwise fall back to `~/.claude/checkpoints/`. Filename: `<name>.md` if a name was provided, else `YYYY-MM-DD-HHMM.md`.
2. **Collect state.** Gather these, each only if present (omit silently otherwise):
   - **Session summary.** A 5–15 sentence narrative recap of the session in the agent's own words: what the user is working on, what's been done so far, what's currently in flight, what working hypotheses are alive, which files/URLs were inspected, what /loop or /babysit timers are active. This is the section that survives auto-compact — write it so a stranger (or a future you with no memory of this chat) can pick up the thread. Honesty over polish: if something is uncertain, say "unclear" rather than smoothing it over.
   - **Active goal.** If a `/goal` Stop hook is in force in the session, copy its condition text verbatim.
   - **TaskList snapshot.** Call TaskList and record every task: `id`, `status`, `subject`, `blockedBy`. Group by status: in_progress first, then pending, then completed (most recent 10), then any deleted shown only as a count.
   - **Decision log.** Up to 5 recent material decisions visible in conversation context — *what was chosen* and *what was rejected*. Skip if none are clearly identifiable rather than inventing them.
   - **Open questions.** Anything the agent flagged as "needs user input" that has not been resolved.
   - **Repo state.** `git status --short` output and `git log --oneline -5`.
3. **Write the file.** Format (markdown):

   ```markdown
   # Checkpoint — <YYYY-MM-DD HH:MM> [<label>]

   ## Session summary
   <5–15 sentence narrative — see step 2 for what to cover>

   ## Active goal
   <goal text or "none">

   ## TaskList
   ### in_progress
   - #<id> <subject>  (blockedBy: #<id>, …)
   ### pending
   - #<id> <subject>  (blockedBy: …)
   ### recently completed
   - #<id> <subject>

   ## Decisions
   - chose X over Y because Z

   ## Open questions
   - …

   ## Repo state
   ```
   <git status>
   ```
   ```
   <git log -5>
   ```
   ```

4. **Report path written.** One-line confirmation with the absolute path. Do NOT add the file to git automatically — leave that to the user.

## Important

- Be honest about what you don't know. Empty sections stay empty with a one-line reason, never invented to look complete.
- Never include secrets, tokens, or large file dumps in the checkpoint — only metadata and decisions.
- This skill is read-mostly: it inspects state and writes one file. It does not alter the TaskList or goal.
