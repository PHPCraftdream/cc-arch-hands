# cc-arch-hands review — round 46

- Baseline: `v0.6.2` (`149b7d3`)
- Reviewed HEAD: `8ba9b76f70211ebd8f208f9edc852261731bbaa5`
- Mode: strictly read-only; tests and installs were not run
- P0 findings: none
- Result: 1 P1, 3 P2, 3 P3

## Findings

### P1 — a crash during abandonment-proof publication permanently wedges the destination

Crashing while replacing `publication.json` can leave both the old proof and `publication.json.tmp`. Recovery selects the old proof and rejects the extra temp forever. Validate both proofs as one transaction, select the newest complete state, and conditionally clean both before releasing the fence.

### P2 — publication proofs are not fenced to the lifecycle-lease generation

Proof generation is not tied to the production lifecycle lease. A verified successor generation must be able to recover an older transaction even while its stale owner PID remains alive; retain PID conservatism for callers without a lease.

### P2 — durable publication does not flush payload or directory mutations

The payload, proof-directory rename, canonical replacement and cleanup lack the necessary file/directory synchronization. Add portable fsync handling or explicitly narrow the contract; the current durable recovery claim is not met.

### P2 — failed executable rollback can be followed by dependency rollback

Rollback ignores failed executable removal/restoration and continues reverting dependencies, potentially leaving a new executable with old libraries. Stop dependency rollback when a dependent survives and surface incomplete recovery.

### P3 — stage identity checks occur before the mutation interlock

Revalidate complete directory and child identity after the interlock and ownership check immediately before mutation. Include the staged transaction child's exact identity/content in current and legacy promotion branches.

### P3 — legacy capacity-fence reconciliation remains generation- and identity-unfenced

Pass capacity generation ownership into legacy reconciliation and use exact conditional rename/removal immediately before every mutation.

### P3 — extracted agent-tree state still hides `/worktrees/`

Remove the obsolete `/wrush` `/worktrees/` ignore rule from `.gitignore`.

## Disposition

Round 46 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
