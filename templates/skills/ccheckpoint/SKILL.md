---
name: ccheckpoint
description: "Same as /checkpoint (checkpoint kept in the repository's main folder, also when run from a linked worktree), plus a local commit of just the checkpoint file it writes."
---

# ccheckpoint

Run `/checkpoint` with the same argument, then commit only the file it wrote,
with ordinary Git commands. Never push.

## Usage

```
/ccheckpoint
/ccheckpoint pre-refactor
```

## Behavior

1. Invoke `Skill('checkpoint', <the same argument, or none>)` from the same
   caller working directory. If it refused (not a Git repository), relay that
   and stop: nothing to commit. If its write was refused, relay that blocker
   and stop. In a linked worktree it still writes into the main folder, so
   continue; never enter a worktree for this.
2. Take the basename of the reported path, as data. It must match
   `^[a-z0-9]+(?:-[a-z0-9]+)*\.md$` and the file must be
   `<repo-root>/docs/checkpoints/<basename>`, with `<repo-root>` the main
   folder `/checkpoint` resolved. Its stem is `NAME`.
3. Commit only that file in the main folder: separate short Bash calls,
   `NAME` replaced by the stem, `<repo-root>` by the main folder's absolute
   path (quoted). `-C` runs Git there even when the session is in a worktree;
   `:(top)` addresses the path from the repository root:

   ```bash
   git -C "<repo-root>" status --porcelain -- ':(top)docs/checkpoints/NAME.md'
   git -C "<repo-root>" add -- ':(top)docs/checkpoints/NAME.md'
   git -C "<repo-root>" commit --only -m 'checkpoint: NAME' -- ':(top)docs/checkpoints/NAME.md'
   git -C "<repo-root>" rev-parse --short HEAD
   ```

   - Empty `git status` output → the file already matches `HEAD`: report
     "unchanged" and stop (success).
   - `git add` says the path is ignored → report "not committed:
     docs/checkpoints/ is ignored". Never use `git add -f`.
   - Add the active commit-attribution trailers with an extra `-m`.
   - From a worktree the commit lands on the branch checked out in the main
     folder; say so in the report.
   - The harness refuses `git -C` because this session is confined to its
     worktree → report "not committed: this session is confined to its
     worktree; commit it from `<repo-root>`" and stop. The checkpoint is
     already written. Never work around the refusal (`cd`, `GIT_DIR`,
     `GIT_WORK_TREE`, wrapper scripts).
   - `git commit --only` commits just this path; everything else stays staged
     as it was.

## Errors

- A failure caused by how you typed the command (quoting, a wrong path, a
  missing argument) is yours to fix: correct the command and run it again.
  Don't end the turn on a failure an ordinary Git command can still fix.
- Stop and report (quoting Git) only a real blocker for the user: a merge,
  rebase, cherry-pick or revert in progress, another process holding
  `index.lock`, a failing commit hook, or a denied permission (including a
  session confined to its worktree).
- Never remove a lock you did not create, never bypass hooks (`--no-verify`),
  never reset, restore or discard anything.
- Do not use `git commit-tree`, `git update-ref`, a custom `GIT_INDEX_FILE`,
  hand-made lock files or a generated multi-line script.

## Important

- Never stage or commit any other file. Never push. Never launch sub-agents.
- Finish with the checkpoint's absolute path and the commit SHA (or
  "unchanged", or the blocker). The checkpoint stays valid without a commit.
- `/checkpoint`'s Important rules still apply.
