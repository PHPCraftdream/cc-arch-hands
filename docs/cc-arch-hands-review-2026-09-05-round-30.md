# cc-arch-hands review — round 30

- Date: 2026-09-05
- Reviewer: HS (Chandrasekhar), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `69c8faf`
- Result: 2 P2, 3 P3

## Findings

### P2 — probe settings and backup are not pairwise CAS-safe

After `enableProbe` writes a backup, another writer can replace that backup before settings publication. The probe is then armed against unrelated recovery data. Stop likewise must prove its captured backup is still current before restoring settings.

Required fix: revalidate the newly written/captured backup immediately before settings CAS and roll back only the unchanged backup if settings publication fails.

### P2 — quarantined lease fences remain active forever

Unexpected abandoned fences are renamed with an `.orphan-*` suffix that still matches `fencePaths`; later attempts repeatedly quarantine the quarantine and eventually hit path-length limits while acquisition remains blocked.

Required fix: move unexpected entries into a namespace excluded from active-fence matching and ensure quarantine is bounded/idempotent.

### P3 — file-removal quarantine is unbounded and unreported

A displaced foreign B is preserved under a random sibling when C occupies the canonical path, but repeated races can create unlimited quarantine names and callers receive only `false`.

Required fix: use a deterministic bounded preservation slot (or return structured quarantine information) and never move another file if that slot is occupied.

### P3 — stamp tests can touch the real global home

Default stamp test invocations do not always set `CAH_STAMP_HINT_HOME`, so marker migration/cleanup may inspect or mutate the real `~/.claude` tree.

Required fix: make every sync/async stamp harness invocation use an isolated temporary hint home by default and add a guard assertion.

### P3 — malformed probe backup gets incorrect CLI guidance

A backup JSON parse error is reported as a settings parse error, instructing the user to restore from the malformed backup.

Required fix: use path-specific parse errors and backup-specific recovery guidance/tests.

## Disposition

Round 30 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
