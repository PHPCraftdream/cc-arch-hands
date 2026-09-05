# cc-arch-hands review — round 34

- Date: 2026-09-06
- Reviewer: HS (Darwin), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `da1e27c`
- Result: 2 P2, 1 P3

## Findings

### P2 — final publication/rollback still has an in-place mutation window

Digest checks occur before the final mutating filesystem operation. A same-inode successor that restores size/mtime can still be overwritten or removed between the check and rename/rollback.

Required fix: use a no-clobber/fenced publication protocol that preserves any displaced successor and proves identity after moving it, rather than relying on check-then-mutate.

### P2 — exact BigInt identity is not propagated everywhere

Some skill, update, lease, and marker identity paths still use numeric stats or mix numeric and BigInt values, retaining rounded inode collision risk and broken comparisons.

Required fix: use exact BigInt identities and conversions consistently across all identity helpers and time arithmetic.

### P3 — split test case modules remain auto-discoverable

Case modules live below `test/`; a bare `node --test` can execute them directly and again through thin entry imports.

Required fix: move support/case modules outside Node's default test discovery tree (or use a non-discovered layout) while keeping explicit package entry tests and exact totals.

## Disposition

Round 34 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
