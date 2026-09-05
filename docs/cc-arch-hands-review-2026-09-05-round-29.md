# cc-arch-hands review — round 29

- Date: 2026-09-05
- Reviewer: HS (Dewey), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `4778cba`
- Result: 4 P2, 3 P3

## Findings

### P2 — stale lease recovery can busy-spin for ten seconds

Transient Windows directory-rename failures are converted to an immediate retry until the test-oriented 10-second deadline, without backoff. A status or Stop hook can consume CPU and stall for the whole interval.

Required fix: use a short production recovery budget, retry only transient codes with backoff, and reserve long interlock waits for explicit test mode.

### P2 — `removeSkills` can capture and delete a foreign successor

The manifest can be replaced after ownership classification but before `captureOwnedFiles`; the successor identity is then treated as managed and removed.

Required fix: retain the exact manifest identity used for classification and require it to remain unchanged through removal.

### P2 — failed restoration can delete displaced foreign content

If removal moves successor B to quarantine and successor C appears at the canonical path, the `EEXIST` restoration branch can unlink quarantined B.

Required fix: never discard a quarantined inode that differs from the expected managed file. Preserve/report it when no-overwrite restoration is impossible, and revalidate before retries.

### P2 — probe start/stop transitions are not concurrency-safe

Concurrent settings edits can be overwritten, and an old `probe stop` can unlink a new `probe start` backup, leaving an active probe without recoverable original settings.

Required fix: serialize the whole settings/backup transition with an owned lease and use expected-leaf CAS/removal for both files.

### P3 — raw legacy markers are not migrated

Migration only accepts 64-hex suffixes, while pre-hash releases used raw session IDs. Old markers remain in `~/.claude` and upgraded sessions may receive duplicate notices.

Required fix: inspect direct regular entries with the legacy prefixes regardless of suffix, without following links; migrate/remove them safely.

### P3 — expired owner can release a successor lease

`releaseLease` checks the old token, then takes a fresh snapshot. A successor can reclaim between those operations; release then fences/removes the successor.

Required fix: build the fence expectation from the releasing lease token itself and abort on any moved-owner mismatch.

### P3 — test lease overrides affect production

Lease-duration environment overrides are honored without `CAH_TEST_ONLY=1`, allowing an accidental value such as `1` to cause immediate live-lease reclamation.

Required fix: honor test lease overrides only in explicit test mode and add a production-ignore regression.

## Residual risk

Multi-file installs remain intentionally non-transactional, and portable path checks are path-based rather than descriptor-anchored.

## Disposition

Round 29 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
