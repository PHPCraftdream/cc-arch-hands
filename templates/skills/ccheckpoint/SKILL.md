---
name: ccheckpoint
description: "Same as /checkpoint, plus an automatic local commit of the checkpoint file it writes."
---

# ccheckpoint

Run `/checkpoint` with the same argument, then commit only the checkpoint file
through a temporary isolated git index. The checkpoint itself is still valid if
the commit is skipped or fails.

## Usage

```
/ccheckpoint
/ccheckpoint pre-refactor
```

## Behavior

1. Invoke `Skill('checkpoint', <the same argument, or none>)` and take note of
   the absolute path it reports.
2. If the path is outside a git repository, skip the commit and report that
   reason. Otherwise run this exact sequence as one shell invocation. It first
   checks whether the target path has any staged delta versus `HEAD`; if so, it
   stops before creating a temporary index and preserves the real index exactly:

   ```bash
   checkpoint_path="<absolute path to checkpoint>"
   git diff --cached --quiet -- "$checkpoint_path"
   preflight_status=$?
   if [ "$preflight_status" -eq 1 ]; then
     echo "commit skipped: checkpoint path already has staged changes"
     exit 0
   elif [ "$preflight_status" -ne 0 ]; then
     echo "commit skipped: staged-state preflight failed"
     exit "$preflight_status"
   fi

   git_index_file="$(mktemp)"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed: could not allocate temporary index"
     exit "$status"
   fi

   # mktemp creates a zero-byte file, but git read-tree requires the index
   # path not to exist yet (or to contain a valid index).
   rm -f "$git_index_file"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed: could not prepare temporary index"
     exit "$status"
   fi

   cleanup() { rm -f "$git_index_file"; }
   trap cleanup EXIT HUP INT TERM

   GIT_INDEX_FILE="$git_index_file" git read-tree HEAD
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed: could not seed temporary index; real index preserved"
     exit "$status"
   fi

   GIT_INDEX_FILE="$git_index_file" git add -- "$checkpoint_path"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed: could not stage checkpoint in temporary index; real index preserved"
     exit "$status"
   fi

   GIT_INDEX_FILE="$git_index_file" git diff --cached --quiet -- "$checkpoint_path"
   temp_diff_status=$?
   if [ "$temp_diff_status" -eq 0 ]; then
     echo "commit unchanged: checkpoint already matches HEAD"
     exit 0
   elif [ "$temp_diff_status" -ne 1 ]; then
     echo "commit failed: could not compare temporary index; real index preserved"
     exit "$temp_diff_status"
   fi

   GIT_INDEX_FILE="$git_index_file" git commit -m "checkpoint: <name-or-timestamp>"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed; real index preserved"
     exit "$status"
   fi

   # HEAD advanced. Synchronize only this previously-unstaged path in the
   # real index so it does not appear as a staged deletion/revert.
   git reset -- "$checkpoint_path"
   status=$?
   exit "$status"
   ```

   `git read-tree HEAD` keeps the temporary commit's tree complete. The
   temporary `git add` stages only the checkpoint. The temp-index diff detects
   a legitimate unchanged/no-op before attempting `git commit`, so a nonzero
   commit result means a hook or another real failure. The single real-index
   `git reset --` is reached only after a successful temporary commit; it
   synchronizes only this path to the new `HEAD`. Every failure exits with its
   original nonzero status, cleanup still runs, and the real index is never
   reset. If the checkpoint was unstaged, it remains unstaged after success.
3. Report the absolute path and the commit outcome (short SHA, unchanged/no-op,
   or the specific failure reason).

## Important

- Never stage or commit any other dirty file.
- Never push. This skill commits locally only.
- If the commit hook fails, report the failure but do not undo or alter the
  user's real index.
- Everything in `/checkpoint`'s Important section still applies: be honest,
  omit secrets and large dumps, and do not alter the TaskList or goal.
