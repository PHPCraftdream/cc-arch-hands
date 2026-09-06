# cc-arch-hands review — round 49

- Baseline: `v0.6.2` (`149b7d3`)
- Reviewed HEAD: `64f5a068a9c5b57d9f48ee3242811dbcffb492d6`
- Mode: strictly read-only; tests and installs were not run
- P0 findings: none
- Result: 1 P1, 4 P2
- P3 findings: none

## Findings

### P1 — victim removal can still delete a replacement successor

Move the pathname into an identity-validated no-overwrite recovery quarantine before deletion. Preserve and report a moved unexpected inode rather than unlinking it.

### P2 — frozen companion generation can combine different source generations

Fence the source tree as one generation or revalidate every captured source identity and digest after collection, before lifecycle acquisition and mutation.

### P2 — legacy absent-state recovery ignores failed capacity ownership

Require a truthy capacity assertion and reassert immediately before proof link and unlink mutations.

### P2 — capacity-stage promotion does not durably remove the source entry

After promotion synchronize both source and destination parent directories.

### P2 — Astra `ua` emits unsupported `ultra` effort

Remove `ua`; Astra supports only `low`, `medium`, `high`, `xhigh`, and `max`. Align generated counts, README, changelog and registry tests.

## Disposition

Round 49 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
