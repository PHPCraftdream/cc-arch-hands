# cc-arch-hands review — round 55

- Reviewed HEAD: `412e28eb98771d5c4f86899360957d562f39940c`
- Mode: strictly read-only
- P0 findings: none
- Result: 3 P1, 3 P2, 1 P3

## Findings

### P1 — committed bin publication can escape rollback tracking

Enroll a leaf that reached frozen target state in rollback convergence even when `writeFileAtomic()` throws after the canonical commit.

### P1 — uninstall strips dependencies from a preserved executable

A preserved or failed importer removal must protect its complete dependency closure and ESM boundary, or safely disable the importer first.

### P1 — recovered transactions are not confined to marker namespace

Validate every canonical and recovered path relationship before acquiring leases or mutating victim state.

### P2 — marker and stamp publications omit lifecycle-generation proof

Pass governing leases through publication and recovery for every lease-protected leaf.

### P2 — worker lifecycle remains unbounded and message-settled

Route all workers through deadline escalation and await confirmed termination before settlement and fixture cleanup.

### P2 — rollback convergence ignores runtime mode

Include required file mode in target and prior-generation postconditions.

### P3 — populated-retirement reconciliation is unbounded

Reconcile bounded deterministic batches per invocation while retaining canonical recovery evidence.

## Disposition

Round 55 is not clean. Close all findings and repeat the read-only review.
