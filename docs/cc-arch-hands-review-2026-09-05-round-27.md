# cc-arch-hands review — round 27

- Date: 2026-09-05
- Reviewer: HS (Hubble), read-only review; tests were not run by the reviewer
- Baseline: `v0.6.2`, with primary focus on `6b21cdc..0b8e070`
- Reviewed HEAD: `0b8e070`
- Result: 1 P2, 3 P3

## Findings

### P2 — concurrent leaf replacement can overwrite user skill content

After a managed `SKILL.md` is classified as owned, another process can atomically replace the destination leaf with foreign content. Parent identities remain unchanged, so the later atomic publication overwrites the successor.

Affected code: `lib/skills.js` managed write path and `lib/fsutil.js` atomic publication contract.

Required fix: capture destination-leaf identity/existence and fail closed if it changes before publication; add an interlock test that replaces the leaf, not only an ancestor.

Validation: confirmed.

### P3 — generic orphan pruning can unlink a fresh successor

`pruneOrphans()` classifies an owned orphan and later calls unconditional `unlinkSync(path)`. A foreign replacement installed between those operations is deleted.

Affected code: `lib/fsutil.js`; consumers include bins, commands, Claude agents, and Codex agents.

Required fix: capture identity around the content read and remove only the observed regular file through identity-checked quarantine. Audit the same ownership-then-unlink pattern in direct removal consumers.

Validation: confirmed.

### P3 — update-lock contention can block hooks for ten seconds

A caller that encounters a valid live refresh owner synchronously polls until the 10-second deadline. This can exceed latency expectations for status/Stop hooks even though update checking is best-effort.

Affected code: `lib/update-check.js` refresh-lock acquisition.

Required fix: return the stale cached value immediately when a valid live owner exists; wait only for narrowly bounded ownerless/dead-lock recovery. Add a latency assertion.

Validation: confirmed.

### P3 — `/ccheckpoint` cleanup can remove a successor `index.lock`

After `mv index.lock index` succeeds, a different Git process can create a new `index.lock`. If a trapped signal runs before `sync_lock_owned=0`, cleanup removes that successor lock.

Affected code: `templates/skills/ccheckpoint/SKILL.md` publication and EXIT cleanup.

Required fix: make publication plus ownership-state transition signal-safe, or otherwise conditionally remove only the owned lock. Add an interlock/signal contract test.

Validation: confirmed.

## Verified round-26 dispositions

- Installed companion binaries include their complete static ESM dependency closure and have installed-tree smoke coverage.
- Detached HEAD and linked worktree checkpoint flows are covered.
- Stamp/rate sidecars use identity-aware pruning.
- Hook ownership uses portable directory locks with fencing and legacy-file handling.
- Astra contains exactly `la`, `ma`, `ha`, `xa`, `xxa`, and `ua`; generated docs and the 36-agent count agree.
- No agent-tree implementation remains; references are limited to migration/history and negative tests.

## Residual risks noted by HS

Crash durability without `fsync`, PID reuse, and the unavoidable crash window between stdout delivery and marker persistence were not promoted to findings. External availability of `gpt-5.6-astra` was not independently verified.

## Disposition

Round 27 is not clean. Apply and accept another HL correction cycle, commit it, and run a fresh HS review. Stop only at `P1–P3 findings: none`.
