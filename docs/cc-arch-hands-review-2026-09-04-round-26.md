# cc-arch-hands review — round 26

- Date: 2026-09-04
- Reviewer: HS (Harvey), read-only review; tests were not run by the reviewer
- Baseline: `v0.6.2`
- Reviewed HEAD: `6b21cdc9cfec9154e3a9cd9c64b3e0259dd581a7`
- Scope: release 0.8.0/Fable 5.1, agent-tree extraction, installer and skill safety, transcript scanning, hook state/delivery, and `/ccheckpoint`
- Result: 1 P1, 3 P2, 3 P3

## Findings

### P1 — installed companion binaries miss runtime dependencies

`lib/binstall.js:10-17` installs `transcript-stats.js` and `update-check.js`, but the new code imports `fsutil.js`, which imports `sentinel.js`. Neither transitive module is in `BinFiles`. Installed `cah-status`, `cah-stamp`, and `cah-checkpoint-hint` therefore fail with `ERR_MODULE_NOT_FOUND` outside the source tree.

Required fix: ship the complete dependency closure and smoke-run the installed binaries from a temporary installation tree.

Validation: confirmed.

### P2 — managed skill operations retain an ancestor-swap TOCTOU

`lib/skills.js` validates path components before path-based write/remove operations. A concurrent same-user process can replace a checked parent directory with a symlink or junction between the final check and the operation, redirecting it outside the skills root.

Required disposition: use a portable anchored operation/quarantine protocol where possible, or explicitly define and test the local same-user concurrency boundary. A plain pre-operation `lstat` is not a complete guarantee.

Validation: technically confirmed, conditional on a concurrent process already holding the same filesystem authority. This is not an independent privilege boundary, but it remains a correctness risk.

### P2 — `/ccheckpoint` leaves the index stale on detached HEAD

After a successful detached-HEAD CAS, `verify_head_identity` still compares HEAD with the pre-CAS OID. The check therefore always fails, index synchronization is skipped, and the committed checkpoint appears as an index/worktree difference relative to the new HEAD.

Required fix: distinguish pre-CAS and post-CAS detached identity checks; after publication require detached HEAD to equal `committed_head`. Add a detached-HEAD contract test.

Validation: confirmed.

### P2 — `/checkpoint` and `/ccheckpoint` do not support linked worktrees

`templates/skills/checkpoint/SKILL.md` searches only for a `.git` directory. In a linked worktree `.git` is a file, so the checkpoint is written to the fallback location or associated with the wrong ancestor repository; `/ccheckpoint` then cannot commit it in the caller repository.

Required fix: resolve the repository with `git rev-parse --show-toplevel` and add a linked-worktree contract test.

Validation: confirmed.

### P3 — cache-sidecar pruning can delete a fresh successor

`bin/cah-stamp.js` and `lib/transcript-stats.js` perform `stat`, then later unconditionally unlink the same path. A concurrent atomic writer can replace it between those operations, causing cleanup to delete fresh dedup/context state.

Required fix: identity-checked rename-to-quarantine deletion or equivalent writer/cleaner synchronization, with an interlock regression.

Validation: confirmed.

### P3 — update-cache refresh can stampede and overwrite a newer result

Concurrent stale-cache readers can both fetch. A slower failed fetch may publish its old/null value with a fresh `checkedAt` after another process has published a successful newer result, hiding the update for the TTL.

Required fix: serialize refresh or re-read before publication; a failed fetch must not overwrite a fresher successful cache record. Add concurrent refresh tests.

Validation: confirmed.

### P3 — hook locks require hard-link support

The stamp/hint/update claim protocol relies on `linkSync`. On filesystems without hard links (for example exFAT and some network filesystems), acquisition fails silently and the hooks never emit.

Required fix: use a portable atomic primitive such as directory creation, or provide a safe fallback with equivalent ownership, fencing, and crash-recovery semantics.

Validation: confirmed as a portability defect.

## Residual risk noted by HS

Crash durability without `fsync`, PID reuse during abandoned-lock recovery, and external availability of workflow/model identifiers were not promoted to findings in this round.

## Disposition

Round 26 is not clean. Start another HL correction cycle, accept and commit it, then run a fresh HS review against the new stable HEAD. The stop condition remains the exact result `P1–P3 findings: none`.
