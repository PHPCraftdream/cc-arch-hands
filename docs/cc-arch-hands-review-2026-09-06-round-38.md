# cc-arch-hands review — round 38

- Date: 2026-09-06
- Reviewer: HS (Kuhn), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `98828a0`
- Result: 3 P3

## Findings

### P3 — cache recovery maintenance can fail install/uninstall

Unreadable cache state can throw from maintenance after install publication or before uninstall, making optional runtime cache a mandatory failure source.

Required fix: make maintenance best-effort, return an explicit incomplete/truncated warning, and never fail runtime installation/removal solely because cache cannot be inspected.

### P3 — recovery enumeration has unbounded work

Although output buckets are capped, recovery code materializes, sorts, and stats every matching directory entry. Large accumulated cache state can consume unbounded time/memory.

Required fix: use streaming/bounded visitation, expose truncation, and separate displaced-data priority from disposable maintenance artifacts.

### P3 — ineligible marker checks consume capacity

At exactly 64 markers, below-threshold hint or no-update Stop can prune the oldest marker before learning that no new marker will be created.

Required fix: stale cleanup may run early, but capacity reservation/pruning must occur only immediately before an eligible new marker claim.

## Disposition

Round 38 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
