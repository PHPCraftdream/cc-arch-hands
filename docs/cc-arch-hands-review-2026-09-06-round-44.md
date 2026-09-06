# cc-arch-hands review — round 44

- Baseline: `v0.6.2` (`149b7d3`)
- Reviewed HEAD: `6f77798`
- Mode: strictly read-only; tests and installs were not run
- Result: 1 P2, 4 P3

## Findings

### P2 — lease-safe atomic publication still has a final ownership race

`bin/cah-stamp.js:146-152` supplies `renewLease(lease)` as the ownership assertion for stamp publication. However, `lib/fs-atomic.js:272-283` checks the destination and lease before calling `renameSync`, with no fence covering the gap between the final check at `:276` and the destructive rename at `:283`.

A process suspended after the check can exceed its lease, allow a successor to acquire the lock and publish, then resume and overwrite that successor. The post-publication ownership check detects the loss only after the overwrite. Hold a generation fence that blocks reclamation across the final destination rename, or use an equivalent publication transaction that cannot replace a successor after ownership loss.

### P3 — empty removal quarantines can still permanently wedge a leaf

After deleting a quarantined payload, `lib/fs-atomic.js:394-413` relies on immediate `rmdirSync` cleanup. A crash or transient cleanup failure leaves an empty `.cah-owned-remove` directory. Later removals treat it as occupied, while recovery excludes empty quarantine namespaces. Treat identity-proven empty quarantine reservations as safely reclaimable during maintenance and reservation.

### P3 — staged marker transactions remain unbounded when the shared-parent scan truncates

`lib/marker-state.js:253-294` scans only `cfg.scanCap` entries in the shared cache parent and can return success after an incomplete scan. A stage beyond that prefix remains while new UUID stages continue to be created. Use a dedicated bounded staging namespace, deterministic slot, or resumable complete enumeration.

### P3 — checkpoint-hint publication drops the injected concurrency interlock

`bin/cah-checkpoint-hint.js:31-50` accepts injected test hooks but `markDelivered()` does not pass them through `markerOptions()` to final marker publication. Thread `testHooks` through and add deterministic coverage.

### P3 — user-facing Codex documentation still advertises the obsolete `extra` value

The registry emits `xhigh`, but `README.md:182` and the current `CHANGELOG.md` release entry still say `extra`. Update prose and add a non-generated documentation contract.

## Disposition

Round 44 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
