# cc-arch-hands review — round 37

- Date: 2026-09-06
- Reviewer: HS (James), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `1a756c6`
- Result: 2 P2, 4 P3

## Findings

### P2 — probe log preflight can truncate linked user data

A symlink or multi-link regular file at `envelope-probe.log` is truncated before the settings transition.

Required fix: reject symlinks/non-regular entries and files with multiple hard links; atomically replace only an exact owned/safe log leaf.

### P2 — bin removal preflight treats non-regular declared leaves as missing/owned

Dangling symlinks and symlinks to sentinel-bearing content can bypass regular snapshot logic, allowing partial runtime removal.

Required fix: lstat every declared leaf and reject every present non-regular entry before mutation.

### P3 — recovery payloads can be starved by maintenance artifacts

Lexically earlier empty quarantine/publication entries can consume the bounded enumeration budget and hide displaced data.

Required fix: prioritize displaced data with an independent capacity from disposable/non-displaced maintenance entries.

### P3 — reserved cache lacks production recovery maintenance

Crash-left cache temp files are neither cleaned nor reported because bin maintenance does not descend into `cache`.

Required fix: run bounded cache maintenance, preserving/reporting unproved entries.

### P3 — marker capacity pruning re-snapshots selected entries

Hint/update marker capacity branches can delete a fresh successor because they replace the scan-time snapshot before removal.

Required fix: retain and remove only against the original digest-bearing snapshot.

### P3 — stamp sidecar pruning accepts non-files

Matching directories/symlinks/special entries can be fenced/deleted or left as unreported random artifacts.

Required fix: require a regular non-linked file before age/capacity handling and preserve/report other entry types.

## Disposition

Round 37 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
