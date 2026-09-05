# cc-arch-hands review — round 33

- Date: 2026-09-06
- Reviewer: HS (Parfit), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `161635f`
- Result: 3 P2, 1 P3

## Findings

### P2 — ESM package boundary can become incompatible during bin installation

A compatible foreign boundary is checked only before installation. If it is replaced by malformed/CommonJS JSON while bin/lib leaves are being published, installation can still report success with an unusable runtime.

Required fix: keep an exact boundary snapshot and revalidate it around publication, or reject foreign boundaries entirely before mutation; add a deterministic replacement test and prevent partial success.

### P2 — probe exact snapshots do not detect in-place byte mutation

Snapshot checks use inode metadata but no content digest. A same-inode rewrite that restores size/mtime can pass and later be rolled back or removed as if it belonged to the probe transition.

Required fix: capture and verify bytes/digest between identity checks while retaining inode ownership; add same-inode, same-size/mtime mutation tests.

### P2 — filesystem identities use lossy numeric inode values

`lstatSync` returns numeric `dev`/`ino`; 64-bit values can lose precision and collide after JavaScript number rounding.

Required fix: use bigint stat identities and compare exact `dev`, `ino`, `size`, and `mtimeNs` consistently across files/directories/quarantines.

### P3 — orphan survivor reporting omits non-regular canonical entries

Symlink/special orphan candidates are skipped, and an occupied quarantine can report only recovery storage while the canonical orphan also survives.

Required fix: report every stable canonical survivor separately from recovery paths, normalize/deduplicate categories, and add symlink/special/occupied-quarantine coverage.

## Disposition

Round 33 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
