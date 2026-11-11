---
name: checkpoint
description: "Persist session state — summary, active goal, TaskList with blockedBy, recent decisions, open questions, repo state — to docs/checkpoints/ in the repository's main folder (also when run from a linked worktree). Use before auto-compact, a long pause, or a machine switch. Pairs with /resume."
---

# checkpoint

Write the live session state to one markdown file so a later session (or this one after compact) can continue.

## Usage

```
/checkpoint               # timestamped: 2026-06-19-1432.md
/checkpoint pre-refactor  # pre-refactor.md; re-running overwrites it
```

Names are slugs (lowercase, hyphens, no spaces); `/resume pre-refactor` finds it.

{{include:checkpoint-main-worktree}}

## Behavior

1. **Guard** as above. Target: `<name>.md`, else `YYYY-MM-DD-HHMM.md`, in the checkpoint directory: `<repo-root>/docs/checkpoints/`, or the worktree fallback above.
2. **Collect** (omit an absent item silently):
   - **Session summary** — 5–15 sentences in your own words: what the user is working on, what is done, what is in flight, live hypotheses, inspected files/URLs, active /loop or /babysit timers. This is what survives compact: write it for a stranger. Uncertain → say "unclear", don't smooth it over.
   - **Active goal** — a `/goal` Stop hook's condition, verbatim.
   - **TaskList** — call TaskList; record `id`, `status`, `subject`, `blockedBy`. Order: in_progress, pending, completed (latest 10), deleted as a count only.
   - **Decisions** — up to 5 recent material ones: what was chosen, what was rejected. None clearly visible → skip, never invent.
   - **Open questions** — unresolved items flagged as needing user input.
   - **Repo state** — as described above: the main folder first, then every linked worktree and what is done there.
3. **Write** the file:

   ```markdown
   # Checkpoint — <YYYY-MM-DD HH:MM> [<label>]

   ## Session summary
   <5–15 sentences>

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
   ### main folder <repo-root> [<branch>]
   ```
   <git status>
   ```
   ```
   <git log -5>
   ```
   ### worktrees
   - <path> [<branch>] — <what is done there>; <status: clean / N changed>; last <sha subject>  (this session)
   ```

4. **Report** one line with the absolute path. Do not add the file to git.

## Important

- Empty sections keep a one-line reason; never invent content to look complete.
- No secrets, tokens or large file dumps — metadata and decisions only.
- Read-mostly: writes one file, never alters the TaskList or goal.
