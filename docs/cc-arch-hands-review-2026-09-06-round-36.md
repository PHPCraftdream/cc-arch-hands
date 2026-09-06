# cc-arch-hands review — round 36

- Date: 2026-09-06
- Reviewer: HS (Ramanujan), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `95de9ab`
- Result: 3 P2, 5 P3

## Findings

### P2 — orphan deletion loses the classification digest

Orphan candidates are classified from content but only a stat identity is passed to removal. A same-inode content mutation with restored metadata can be deleted as owned.

Required fix: classify and remove through one digest-bearing snapshot.

### P2 — bin install does not preflight the full dependency closure

A foreign shared library may be skipped while new dependents/executables are still published, yielding a successful incompatible runtime.

Required fix: preflight every managed runtime leaf before any mutation and reject any foreign dependency.

### P2 — bin uninstall removes the ESM boundary first

Removing root `package.json` before executable/library leaves creates a window where existing `.js` runtime is parsed as CommonJS.

Required fix: remove in reverse dependency order and delete the boundary last.

### P3 — minimum Node engine predates the test-runner flag

The test script uses `--test-concurrency`, unavailable in Node 18.17/18.18 while engines declares `>=18.17.0`.

Required fix: raise minimum Node to 18.19 or avoid the flag.

### P3 — crash recovery artifacts are not integrated into production maintenance

Temporary/recovery entries can accumulate or starve bounded recovery enumeration, and unproved temps remain unreported.

Required fix: invoke bounded maintenance from production paths, separate recovery from disposable owned temps, and prevent ignored entries from consuming report capacity.

### P3 — missing canonical skill hides its recovery payload

`removeSkills` can skip a skill before enumerating `SKILL.md.cah-owned-remove/payload`; other recovery paths are mixed into `preserved`.

Required fix: enumerate recovery before ownership filtering and return a distinct `recovery` array.

### P3 — stamp capacity pruning refreshes the expected snapshot

The capacity branch re-snapshots immediately before deletion and can remove a fresh successor instead of the originally observed entry.

Required fix: retain and use the initial digest-bearing snapshot.

### P3 — probe log failure occurs after successful settings commit

If log truncation fails after settings/backup publication, start reports failure although the probe is active.

Required fix: prepare log before transition or make post-commit log truncation best-effort.

## Disposition

Round 36 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
