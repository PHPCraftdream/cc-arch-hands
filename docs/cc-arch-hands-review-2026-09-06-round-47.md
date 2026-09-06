# cc-arch-hands review — round 47

- Baseline: `v0.6.2` (`149b7d3`)
- Reviewed HEAD: `fb6be0b60dbcbbe4482552cd3f447793dd4fe6c7`
- Mode: strictly read-only; tests and installs were not run
- P0 findings: none
- Result: 2 P1, 2 P2
- P3 findings: none

## Findings

### P1 — crash-left transaction-state publication proof permanently wedges marker capacity

Marker cleanup removes `transaction.json` before finishing its current publication proof. The absent-state inspection understands only an obsolete `old` child, not current `publication.json` proof state, so the namespace becomes permanently indeterminate. Recover or finish the current proof before removing state and make absent-state recovery understand the current generation-fenced protocol.

### P1 — failed dependency rollback leaves restored dependents on the wrong generation

Reverse rollback can restore importers before a dependency restoration fails. Current protection walks importer-to-dependency edges and cannot revisit already-restored dependents. Preserve one coherent connected runtime generation, or republish every dependent when its dependency cannot return to the prior state.

### P2 — rollback does not treat the ESM package boundary as a runtime dependency

Represent installed `package.json` as a synthetic dependency of every JavaScript leaf, or protect it whenever any runtime leaf survives rollback. Add a fresh-install rollback smoke regression.

### P2 — capacity recovery can promote or delete a replacement victim-slot file

Require the final victim slot's exact identity to match `victimKey` immediately before every rename or unlink, after the final interlock and generation check. Preserve and report mismatches.

## Disposition

Round 47 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
