# cc-arch-hands review — round 41

- Date: 2026-09-06
- Reviewer: HS (Nietzsche), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `9cf8da0`
- Result: 1 P2, 7 P3

## Findings

### P2 — bin lifecycle can continue after losing an expired lease

A paused operation can resume after another process reclaims the lease and mutates the runtime, then prune or roll back the successor tree.

Required fix: renew/heartbeat the lease and verify its generation before every mutation; a process that loses ownership must stop without rollback/pruning successor data.

### P3 — legacy marker migration bypasses capacity reconciliation

Bulk migration can import far more than 64 entries or race publication, so capacity does not converge.

### P3 — migration collision can discard newer legacy state

When a target exists, source state is removed without semantic freshness/delivery comparison.

### P3 — expired capacity owner can mutate a successor transaction

Finish/abort paths do not verify every lease and persisted transaction nonce before mutating the shared victim/slot.

### P3 — inspection errors are treated as absence

Transient marker/slot read failures can trigger incorrect restore or transaction deletion.

Required fix for the four marker findings: centralize the marker transaction/migration implementation; use capacity-lease migration, semantic collision resolution, nonce checks before every mutation, and tri-state inspection that preserves indeterminate transactions.

### P3 — rate-context maintenance remains unbounded in the shared cache

Every status render materializes the full shared cache directory.

Required fix: move rate-context state to a dedicated namespace with streaming bounded maintenance and direct current-session migration.

### P3 — `/resume` does not support linked worktrees

It searches for a `.git` directory while checkpoint now uses `git rev-parse --show-toplevel`.

Required fix: share the checkpoint repository-resolution rule and add a linked-worktree contract.

### P3 — `cah-stamp.js` exceeds the 1000-line limit

The file reached 1015 lines and duplicates marker transaction/migration logic.

Required fix: extract a shared installed marker-state module and enforce a source-size contract.

## Disposition

Round 41 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
