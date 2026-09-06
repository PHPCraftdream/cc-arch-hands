# cc-arch-hands review — round 35

- Date: 2026-09-06
- Reviewer: HS (Faraday), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `763628c`
- Result: 5 P2, 2 P3

## Findings

### P2 — conditional publication creates a visible/crash-persistent vacancy

Moving the old destination into a fence before publishing the new file breaks the old-or-new visibility guarantee. Readers can see `ENOENT`, and a crash can leave the canonical path absent.

### P2 — exclusive-copy fallback is not atomically visible

When hard links are unavailable, `COPYFILE_EXCL` exposes a destination during copying and can leave a truncated file after a crash.

Required design disposition for both: preserve atomic old-or-new publication with same-directory rename. Final-nanosecond races from uncooperative same-UID filesystem writers are outside the portable Node-core security boundary and must be documented rather than “fixed” by introducing vacancy or torn writes.

### P2 — companion runtime publication order is dependency-unsafe

Runtime files are not installed dependency-first, so a concurrently invoked hook can observe a new importer with an old/missing dependency.

Required fix: publish low-level libraries first, then dependent libraries, then executable bins; add boundary smoke checks or stage an immutable runtime tree.

### P2 — full digest snapshots are not propagated to consumers

Several skill/update/lease/removal paths pass identity-only snapshots, allowing same-inode content changes with restored metadata to be treated as expected.

Required fix: propagate exact identity plus content digest/bytes for destructive CAS operations.

### P2 — mode is absent from file identity

A mode-only successor can be missed and then reset to a stale preserved mode.

Required fix: include mode in snapshot/CAS and preserve mode from the expected snapshot.

### P3 — recovery artifacts can be hidden or accumulate

Crash-left quarantine/fence/temp artifacts may be skipped silently when the canonical file is missing; temporary entries can accumulate.

Required fix: identify and report recovery data separately; safely sweep only artifacts proven not to contain displaced user data.

### P3 — explicit test script omits conditional publication tests

`npm test` does not include `test/conditional-publication.test.js`, while bare discovery does.

Required fix: include every `*.test.js` exactly once and add a discovery contract.

## Disposition

Round 35 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
