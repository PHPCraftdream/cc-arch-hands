# cc-arch-hands review — round 48

- Baseline: `v0.6.2` (`149b7d3`)
- Reviewed HEAD: `cda1a540e2a8c277384d86a36c34bfbc8112e90a`
- Mode: strictly read-only; tests and installs were not run
- P0 findings: none
- Result: 2 P1, 3 P2
- P3 findings: none

## Findings

### P1 — prior crash-left transaction proofs remain permanently unrecoverable

The new cleanup ordering prevents fresh artifacts but cannot recover an absent `transaction.json` with a current publication proof left from older code. Add bounded identity-safe recovery/quarantine for this shape.

### P1 — failed dependency republishing can publish incompatible dependents

Connected-generation repair skips unproved or unavailable dependencies but continues publishing later importers. Preflight the complete target generation and never publish a component whose dependency cannot be proven at that generation.

### P2 — attempted runtime generation is not frozen before publication

Capture stable identities and exact bytes for every `BinFiles` source before the first mutation; derive the graph from and reuse that payload map for forward publication and rollback repair.

### P2 — marker capacity transactions are not crash-durable

Fsync staged state and synchronize affected directories after promotion, victim movement and cleanup using the portable directory-sync helper.

### P2 — victim-slot mutation remains check-then-use and mismatches are hidden

Fence the entry, revalidate exact identity and generation immediately before final mutation, validate the moved inode, and surface preserved mismatch recovery paths in results.

## Disposition

Round 48 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
