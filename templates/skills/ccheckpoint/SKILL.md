---
name: ccheckpoint
description: "Same as /checkpoint, plus an automatic local commit of the checkpoint file it writes."
---

# ccheckpoint

Run `/checkpoint` with the same argument, then commit only the checkpoint file
it writes. The checkpoint itself is still valid if the commit is skipped or
fails.

## Usage

```
/ccheckpoint
/ccheckpoint pre-refactor
```

## Behavior

1. Invoke `Skill('checkpoint', <the same argument, or none>)` and take note of
   the absolute path it reports. Before running another shell command, extract
   its basename as data and require it to match
   `^[a-z0-9]+(?:-[a-z0-9]+)*\.md$` (the timestamp form matches this rule too).
   Also verify conceptually that the reported path is
   `<caller-repo-root>/docs/checkpoints/<basename>`. If either check cannot be
   completed safely, skip the commit and report why.
2. In the block below, replace the single literal `SAFE_BASENAME` with that
   validated basename. This is the only permitted substitution: never insert
   the reported absolute path or the original user label. Run the resulting
   block as one Bash tool command from the same caller cwd used by
   `/checkpoint`:

   ```bash
   checkpoint_basename='SAFE_BASENAME'
   if [[ ! "$checkpoint_basename" =~ ^([a-z0-9]+(-[a-z0-9]+)*)\.md$ ]]; then
     echo "commit skipped: checkpoint basename is not a safe slug/timestamp"
     exit 0
   fi
   checkpoint_stem=${checkpoint_basename%.md}

   repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
   status=$?
   if [ "$status" -ne 0 ] || [ -z "$repo_root" ]; then
     echo "commit skipped: caller cwd is outside a git repository"
     exit 0
   fi
   repo_root=$(cd -- "$repo_root" && pwd -P)
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit skipped: could not resolve git repository root"
     exit 0
   fi
   checkpoint_rel=docs/checkpoints/$checkpoint_basename
   checkpoint_dir=$repo_root/docs/checkpoints
   checkpoint_path=$checkpoint_dir/$checkpoint_basename
   if [ ! -f "$checkpoint_path" ]; then
     echo "commit skipped: reported checkpoint file does not exist"
     exit 0
   fi
   cd -- "$repo_root" || {
     echo "commit skipped: could not enter git repository root"
     exit 0
   }

   # This snapshot is used only to decide whether it is safe to synchronize the
   # real index later. All commit trees are built from an explicitly captured
   # old_head, never from a moving HEAD.
   old_head=$(git rev-parse HEAD)
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit skipped: could not read HEAD"
     exit "$status"
   fi
   git diff --cached --quiet "$old_head" -- "$checkpoint_rel"
   preflight_status=$?
   if [ "$preflight_status" -eq 1 ]; then
     echo "commit skipped: checkpoint path already has staged changes"
     exit 0
   elif [ "$preflight_status" -ne 0 ]; then
     echo "commit skipped: staged-state preflight failed"
     exit "$preflight_status"
   fi
   preflight_index_entry=$(git ls-files --stage -- "$checkpoint_rel")
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit skipped: could not snapshot checkpoint index state"
     exit "$status"
   fi

   git_index_file=$(mktemp)
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed: could not allocate temporary index"
     exit "$status"
   fi
   rm -f -- "$git_index_file"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit failed: could not prepare temporary index"
     exit "$status"
   fi
   sync_index_file=
   real_index_lock=
   sync_lock_owned=0
   cleanup() {
     [ -z "$git_index_file" ] || rm -f -- "$git_index_file"
     [ -z "$sync_index_file" ] || rm -f -- "$sync_index_file"
     if [ "$sync_lock_owned" -eq 1 ]; then
       rm -f -- "$real_index_lock"
     fi
   }
   trap cleanup EXIT
   trap 'exit 129' HUP
   trap 'exit 130' INT
   trap 'exit 143' TERM

   commit_message="checkpoint: $checkpoint_stem"
   max_attempts=3
   attempt=1
   committed_head=
   while [ "$attempt" -le "$max_attempts" ]; do
     GIT_INDEX_FILE="$git_index_file" git read-tree "$old_head"
     status=$?
     if [ "$status" -ne 0 ]; then
       echo "commit failed: could not seed temporary index; real index preserved"
       exit "$status"
     fi
     GIT_INDEX_FILE="$git_index_file" git add -- "$checkpoint_rel"
     status=$?
     if [ "$status" -ne 0 ]; then
       echo "commit failed: could not stage checkpoint in temporary index; real index preserved"
       exit "$status"
     fi
     GIT_INDEX_FILE="$git_index_file" git diff --cached --quiet "$old_head" -- "$checkpoint_rel"
     temp_diff_status=$?
     if [ "$temp_diff_status" -eq 0 ]; then
       echo "commit unchanged: checkpoint already matches HEAD"
       exit 0
     elif [ "$temp_diff_status" -ne 1 ]; then
       echo "commit failed: could not compare temporary index; real index preserved"
       exit "$temp_diff_status"
     fi
     new_tree=$(GIT_INDEX_FILE="$git_index_file" git write-tree)
     status=$?
     if [ "$status" -ne 0 ] || [ -z "$new_tree" ]; then
       echo "commit failed: could not write checkpoint tree; real index preserved"
       [ "$status" -eq 0 ] && status=1
       exit "$status"
     fi
     new_commit=$(printf '%s\n' "$commit_message" | git commit-tree "$new_tree" -p "$old_head")
     status=$?
     if [ "$status" -ne 0 ] || [ -z "$new_commit" ]; then
       echo "commit failed: could not create checkpoint commit; real index preserved"
       [ "$status" -eq 0 ] && status=1
       exit "$status"
     fi

     git update-ref HEAD "$new_commit" "$old_head"
     cas_status=$?
     if [ "$cas_status" -eq 0 ]; then
       committed_head=$new_commit
       break
     fi
     current_head=$(git rev-parse HEAD 2>/dev/null)
     if [ -n "$current_head" ] && [ "$current_head" != "$old_head" ]; then
       old_head=$current_head
       attempt=$((attempt + 1))
       continue
     fi
     echo "commit failed: could not atomically advance HEAD; real index preserved"
     exit "$cas_status"
   done
   if [ -z "$committed_head" ]; then
     echo "commit skipped: HEAD changed concurrently; retry limit reached"
     exit 0
   fi

   # Claim the real index lock before checking it. A concurrent git add either
   # completed before this point (and is detected below) or cannot overwrite
   # the index while this private copy is being prepared. The real index is
   # changed only after the successful CAS above, and only for this path.
   real_index=$(git rev-parse --git-path index)
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   real_index_lock=$real_index.lock
   if ! (set -C; : > "$real_index_lock") 2>/dev/null; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped: index changed concurrently"
     exit 0
   fi
   sync_lock_owned=1
   sync_index_file=$(mktemp)
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   rm -f -- "$sync_index_file"
   if [ -e "$real_index" ]; then
     cp "$real_index" "$sync_index_file"
     status=$?
   else
     GIT_INDEX_FILE="$sync_index_file" git read-tree "$committed_head"
     status=$?
   fi
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   current_index_entry=$(GIT_INDEX_FILE="$sync_index_file" git ls-files --stage -- "$checkpoint_rel")
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   if [ "$current_index_entry" != "$preflight_index_entry" ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped: checkpoint was staged concurrently"
     exit 0
   fi
   checkpoint_cacheinfo=$(git ls-tree --format='%(objectmode) %(objectname)' "$committed_head" -- "$checkpoint_rel")
   status=$?
   if [ "$status" -ne 0 ] || [ -z "$checkpoint_cacheinfo" ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   checkpoint_mode=${checkpoint_cacheinfo%% *}
   checkpoint_oid=${checkpoint_cacheinfo##* }
   GIT_INDEX_FILE="$sync_index_file" git update-index --add --cacheinfo "$checkpoint_mode" "$checkpoint_oid" "$checkpoint_rel"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   # Publish through Git's lockfile path: fill index.lock completely, then
   # atomically rename that lockfile over index. Cleanup removes our lock on
   # every ordinary failure or trapped signal before the rename.
   cp "$sync_index_file" "$real_index_lock"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   mv -f "$real_index_lock" "$real_index"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   sync_lock_owned=0
   rm -f -- "$sync_index_file"
   sync_index_file=
   short_commit=${committed_head:0:7}
   echo "commit succeeded: $short_commit"
   exit 0
   ```

   The block revalidates the substituted basename and derives `repo_root`, the
   relative checkpoint path, absolute checkpoint path, and commit message
   itself. The unsafe reported path and user label never enter shell source;
   repository paths containing spaces, quotes, `$()`, or backticks therefore
   remain ordinary cwd/filesystem data.

   It captures `old_head`, builds a complete tree in an isolated index, creates
   the commit with `git commit-tree`, and advances `HEAD` with
   `git update-ref HEAD new old` as an atomic compare-and-swap. On a CAS
   conflict it rebuilds from the newly observed `HEAD`, up to three attempts;
   if contention continues it skips without changing the branch. The real
   index is considered only after a successful CAS. Its lock is claimed while
   checking the preflight index entry, so a checkpoint staged after preflight
   is preserved and synchronization is skipped. The replacement index is
   written completely to `index.lock` and published by the lockfile's atomic
   rename; ordinary failures and trapped signals remove an owned lock. No
   real-index reset is used on failure, and `git commit-tree` does not run
   pre-commit hooks.
3. Report the absolute path and the commit outcome (short SHA, unchanged/no-op,
   skip reason, or the specific failure reason).

## Important

- Never stage or commit any other dirty file.
- Never push. This skill commits locally only.
- The commit uses `git commit-tree`, so pre-commit hooks are not run; do not
  promise hook execution.
- If commit creation fails, report the failure but do not undo or alter the
  user's real index.
- Everything in `/checkpoint`'s Important section still applies: be honest,
  omit secrets and large dumps, and do not alter the TaskList or goal.
