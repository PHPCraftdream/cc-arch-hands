# cc-arch-hands review — round 56

- Reviewed HEAD: `f909cc45cfde0f29ee77033751430013573e6275`
- Mode: strictly read-only
- P0 findings: none
- Result: 3 P1, 1 P2, 1 P3

## Findings

### P1 — committed publication can escape bin rollback tracking

Mark publication committed immediately after canonical rename, before fallible sync/inspection, and preserve metadata without masking the original error.

### P1 — uninstall guesses dependencies of an opaque surviving importer

Preserve the complete runtime closure and ESM boundary when an importer cannot be removed or safely inspected, or disable it first.

### P1 — recovered transactions may target non-marker children

Require marker/victim names to satisfy configured marker policy and require exact configured capacity-lease path before recovery or stage promotion.

### P2 — stamp-sidecar cleanup can displace successors without recovery

Use governing generation ownership at each mutation and bounded recovery for crash-left sidecar fences.

### P3 — retirement batching still performs unbounded inspection

Bound enumeration and record inspection with lookahead and deterministic continuation, avoiding full rescans.

## Disposition

Round 56 is not clean. Close all findings and repeat the read-only review.
