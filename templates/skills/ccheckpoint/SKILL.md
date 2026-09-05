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

1. Invoke `Skill('checkpoint', <the same argument, or none>)` from the same
   caller working directory and take note of the absolute path it reports.
   `/checkpoint` resolves that caller repository with
   `git rev-parse --show-toplevel`, so a linked worktree's `.git` file resolves
   to the worktree root, not the parent repository. Before running another
   shell command, extract its basename as data and require it to match
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

   # Claim the real index lock before preflight and keep it through publication.
   # Checkout/switch and index-mutating Git commands honor this lock. Commands
   # that use git_index_file below use a private index and therefore do not
   # deadlock against our real-index lock.
   real_index=$(git rev-parse --git-path index)
   status=$?
   if [ "$status" -ne 0 ] || [ -z "$real_index" ]; then
     echo "commit skipped: could not locate the real index"
     [ "$status" -eq 0 ] && status=1
     exit "$status"
   fi
   real_index_lock=$real_index.lock
   if [ -e "$real_index_lock" ]; then
     echo "commit skipped: real index is locked"
     exit 0
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

   if ! (set -C; : > "$real_index_lock") 2>/dev/null; then
     echo "commit skipped: real index is locked"
     exit 0
   fi
   sync_lock_owned=1

   # This snapshot is used only to decide whether it is safe to synchronize the
   # real index later. All commit trees are built from an explicitly captured
   # old_head, never from a moving HEAD.
   captured_head_ref=$(git symbolic-ref -q HEAD 2>/dev/null)
   head_ref_status=$?
   if [ "$head_ref_status" -gt 1 ]; then
     echo "commit skipped: could not identify HEAD"
     exit "$head_ref_status"
   fi
   old_head=$(git rev-parse --verify HEAD)
   status=$?
   if [ "$status" -ne 0 ] || [ -z "$old_head" ]; then
     echo "commit skipped: could not read HEAD"
     [ "$status" -eq 0 ] && status=1
     exit "$status"
   fi
   if [ "$head_ref_status" -eq 0 ] && [ -n "$captured_head_ref" ]; then
     head_identity_kind=symbolic
     captured_head_identity=$captured_head_ref
   else
     head_identity_kind=detached
     captured_head_identity=$old_head
   fi
   # Updating HEAD lets Git dereference the symbolic ref at the same atomic CAS
   # that checks old_head. A symbolic HEAD that moved to another commit therefore
   # cannot cause the previously captured branch to be advanced accidentally.
   captured_head_target=HEAD
   verify_head_identity() {
     current_head_ref=$(git symbolic-ref -q HEAD 2>/dev/null)
     current_ref_status=$?
     if [ "$head_identity_kind" = symbolic ]; then
       [ "$current_ref_status" -eq 0 ] || return 1
       [ "$current_head_ref" = "$captured_head_identity" ] || return 1
     else
       [ "$current_ref_status" -eq 1 ] || return 1
     fi
   }
   verify_head_state() {
     verify_head_identity || return 1
     current_head_oid=$(git rev-parse --verify HEAD 2>/dev/null) || return 1
     [ "$current_head_oid" = "$expected_head_oid" ]
   }

   # The lock is held while checking staged state, creating the commit, and
   # publishing the replacement index. Recheck operation state after claiming
   # it so a state transition cannot enter the commit path.
   state_name=
   state_path=
   for state_name in MERGE_HEAD MERGE_MSG MERGE_MODE MERGE_RR CHERRY_PICK_HEAD REVERT_HEAD sequencer rebase-merge rebase-apply BISECT_LOG BISECT_START BISECT_NAMES BISECT_TERMS; do
     state_path=$(git rev-parse --git-path "$state_name" 2>/dev/null)
     status=$?
     if [ "$status" -ne 0 ] || [ -z "$state_path" ]; then
       echo "commit skipped: could not inspect Git operation state"
       [ "$status" -eq 0 ] && status=2
       exit "$status"
     fi
     if [ -e "$state_path" ]; then
       echo "commit skipped: Git operation is in progress"
       exit 0
     fi
   done
   expected_head_oid=$old_head
   if ! verify_head_state; then
     echo "commit skipped: HEAD changed concurrently"
     exit 0
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

     expected_head_oid=$old_head
     if ! verify_head_state; then
       echo "commit skipped: HEAD changed concurrently; real index preserved"
       exit 0
     fi
     git update-ref "$captured_head_target" "$new_commit" "$old_head"
     cas_status=$?
     if [ "$cas_status" -eq 0 ]; then
       committed_head=$new_commit
       break
     fi
     if ! verify_head_identity; then
       echo "commit skipped: HEAD switched concurrently; real index preserved"
       exit 0
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

   # Confirm both the captured ref identity and the successful CAS before
   # publishing the real index. The lock prevents checkout/switch from changing
   # HEAD between this check and the lockfile rename. For detached HEAD the
   # post-CAS OID must be the newly committed head (the pre-CAS OID was only the
   # compare-and-swap expected value).
   expected_head_oid=$committed_head
   if ! verify_head_state; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped: HEAD changed concurrently"
     exit 0
   fi
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
   # atomically rename that lockfile over index. Ignore ordinary termination
   # signals across the rename and ownership transition so cleanup cannot
   # remove a successor lock created after publication.
   cp "$sync_index_file" "$real_index_lock"
   status=$?
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
   trap '' HUP INT TERM
   mv -f "$real_index_lock" "$real_index"
   status=$?
   if [ "$status" -eq 0 ]; then
     sync_lock_owned=0
   fi
   trap 'exit 129' HUP
   trap 'exit 130' INT
   trap 'exit 143' TERM
   if [ "$status" -ne 0 ]; then
     echo "commit succeeded: ${committed_head:0:7}; real index synchronization skipped"
     exit 0
   fi
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

   It captures the symbolic HEAD ref (or detached HEAD identity) and `old_head`,
   builds a complete tree in an isolated index, creates the commit with
   `git commit-tree`, and advances `HEAD` with
   `git update-ref HEAD new old` as an atomic compare-and-swap. Git dereferences
   a symbolic `HEAD` while performing that CAS, so a pre-CAS switch to a
   different-OID branch cannot advance the previously captured branch by
   accident. The pre-CAS check requires the captured identity and `old_head` OID;
   after a successful CAS the post-CAS check requires the same symbolic ref (or
   detached `HEAD`) and `committed_head` OID before synchronizing the real index.
   On a CAS conflict on the currently checked-out ref it rebuilds from the newly
   observed `HEAD`, up to three attempts; a changed HEAD identity skips without
   synchronizing the real index. Merge, rebase, cherry-pick, revert, sequencer, and bisect states are
   skipped. The real index lock is claimed before preflight and held through
   publication, so checkout/switch and concurrent index mutations are
   serialized; private-index commands do not contend for that lock. The
   replacement index is written completely to `index.lock` and published by
   the lockfile's atomic rename; ordinary failures and trapped signals remove
   an owned lock. No real-index reset is used on failure, and `git commit-tree`
   does not run pre-commit hooks.
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
