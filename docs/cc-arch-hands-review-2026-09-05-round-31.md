# cc-arch-hands review — round 31

- Date: 2026-09-05
- Reviewer: HS (Epicurus), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `d54f4fc`
- Result: 4 P2, 2 P3

## Findings

### P2 — probe backup validation does not span settings publication

The backup is validated before settings CAS, but can be replaced before or during settings publication. Enable may arm against unrelated data; stop may restore stale data.

Required fix: revalidate after publication and roll back only the exact settings/backup leaves produced by the transition.

### P2 — deterministic file quarantine still has destructive TOCTOU windows

A replacement can be unlinked during quarantine recovery, and POSIX rename can overwrite a quarantine destination that appears after an existence check.

Required fix: reserve quarantine with a no-replace primitive/directory and identity-fence every deletion; never overwrite or unlink an unverified quarantine entry.

### P2 — ownership sweeps can delete recovery entries

`pruneOrphans` does not reserve/exclude `.cah-owned-remove` entries. A preserved displaced file carrying a valid sentinel can be removed as an orphan.

Required fix: use an excluded quarantine namespace and never classify it as an installable/orphan leaf.

### P2 — occupied lease quarantine can block acquisition forever

If the deterministic quarantine destination exists, the active fence cannot move out of the matched namespace and every future acquisition remains blocked.

Required fix: use bounded collision-safe quarantine storage outside active matching and prove repeated acquisition remains possible while preserving unexpected entries.

### P3 — removal reporting is inconsistent

Foreign successors may be omitted, preserved entries can be duplicated, and bin survivors are reported as bare leaf names rather than relative paths.

Required fix: reclassify/report survivors, normalize paths, and deduplicate result arrays across all consumers.

### P3 — legacy marker sweep deletes unowned prefixed files

Migration deletes every stale regular file with a legacy prefix, even when its suffix/content cannot prove ownership.

Required fix: migrate exact current-session raw names and validated legacy hashes only; preserve unknown prefixed files.

## Disposition

Round 31 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
