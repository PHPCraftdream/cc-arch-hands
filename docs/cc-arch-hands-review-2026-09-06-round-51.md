# cc-arch-hands review — round 51

- Reviewed HEAD: `412e4eff34533cc9e63a6d7c36459ad00e394ca5`
- Mode: strictly read-only; tests and installs were not run
- P0 findings: none
- Result: 2 P1, 1 P2
- P3 findings: none

## Findings

### P1 — transaction cleanup can unlink a successor transaction

Retire transaction state or the full transaction directory into a generation-specific no-overwrite quarantine before deletion. Recovery must understand retirement state and mutate only quarantined identities.

### P1 — partial proof-replacement temp permanently wedges publication

Make canonical-valid plus malformed expected temp converge through versioned proof slots or identity/ownership-safe quarantine. Every proof-write crash boundary must recover automatically.

### P2 — rollback repair can expose a mixed runnable generation

Drive repair from frozen `generation.publicationFiles`, iterate dependency convergence, accept reached-target postconditions, and quarantine/disable importers that cannot reach the selected generation.

## Disposition

Round 51 is not clean. Close all findings and repeat the read-only review.
