---
name: ccheckpoint
description: "Same as /checkpoint, plus an automatic local commit of the checkpoint file it writes."
---

# ccheckpoint

Run `/checkpoint` with the same argument, then commit only the checkpoint file
it writes, with ordinary Git commands. Never push.

## Usage

```
/ccheckpoint
/ccheckpoint pre-refactor
```

## Behavior

1. Invoke `Skill('checkpoint', <the same argument, or none>)` from the same
   caller working directory. If it refused (caller outside any Git
   repository), relay that and stop: there is no file to commit.
   `/checkpoint` resolves the caller repository with
   `git rev-parse --show-toplevel`, so a linked worktree's `.git` file resolves
   to the worktree root, not the parent repository.
2. Take the basename of the path it reported, as data. It must match
   `^[a-z0-9]+(?:-[a-z0-9]+)*\.md$` and the file must be
   `<caller-repo-root>/docs/checkpoints/<basename>`. Call the basename without
   `.md` `NAME`.
3. Commit only that file. Run these as short, separate Bash calls from the
   caller working directory, with `NAME` replaced by that stem. The `:(top)`
   pathspec addresses the file from the repository root, so the commands work
   from any subdirectory and never need the absolute path:

   ```bash
   git status --porcelain -- ':(top)docs/checkpoints/NAME.md'
   git add -- ':(top)docs/checkpoints/NAME.md'
   git commit --only -m 'checkpoint: NAME' -- ':(top)docs/checkpoints/NAME.md'
   git rev-parse --short HEAD
   ```

   - Empty output from `git status` means the file already matches `HEAD`:
     report "unchanged" and stop. That is a success, not a failure.
   - If `git add` reports the path is ignored by `.gitignore`, report "not
     committed: docs/checkpoints/ is ignored". Never use `git add -f`.
   - Follow the active commit-attribution instructions (add trailers with an
     extra `-m`).
   - `git commit --only` commits just this path and leaves everything else
     staged exactly as it was.

## Errors

- A failure caused by how you typed the command (quoting, a wrong path, a
  missing argument) is yours to fix: correct the command and run it again. Do
  not end the turn with a failure report while an ordinary Git command can
  still do the job.
- Stop and report only a real blocker the user must resolve: a merge, rebase,
  cherry-pick or revert in progress, another process holding `index.lock`,
  a failing commit hook, or a denied permission. Quote Git's message.
- Never remove a lock you did not create, never bypass hooks (`--no-verify`),
  never reset, restore or discard anything.
- Do not use `git commit-tree`, `git update-ref`, a custom `GIT_INDEX_FILE`,
  hand-made lock files or a generated multi-line script. Git takes its own
  locks.

## Important

- Never stage or commit any other file. Never push. Never launch sub-agents.
- Finish with the checkpoint's absolute path and the commit SHA (or
  "unchanged", or the blocker).
- A saved checkpoint stays valid even if the commit does not happen.
- Everything in `/checkpoint`'s Important section still applies: be honest,
  omit secrets and large dumps, and do not alter the TaskList or goal.
