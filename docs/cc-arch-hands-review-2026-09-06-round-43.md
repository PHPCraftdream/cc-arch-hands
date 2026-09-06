# cc-arch-hands review — round 43

- Baseline: `73aeaea`
- Mode: read-only; tests were not run by the reviewer
- Result: 2 P2, 5 P3

## Findings

### P2 — Codex “extra” agents emit an undocumented reasoning-effort value

`lib/manifest.js:72`, `:78`, `:84`, and `:90` define the `x*` agents with `effort: 'extra'`; `lib/codex-agents.js:17` writes that value verbatim as `model_reasoning_effort = "extra"`. Official Codex custom-agent documentation names the configuration value `xhigh`, while “Extra High” is the UI label. Consequently `xt`, `xl`, `xs`, and `xa` can be rejected or fail to select the intended effort. Use `xhigh` in the registry while retaining “Extra High” as display text.

### P2 — stamp publication can overwrite a successor after lease loss

`bin/cah-stamp.js:224-225` acquires the session lease, but neither publication at `:259` nor `:262` verifies or renews it. `writeLastStamp()` instead captures whatever destination currently exists at `:131` and publishes against that fresh snapshot at `:132-135`. A paused hook whose lease has expired can therefore resume after a successor hook, snapshot the successor’s sidecar, and overwrite it with the older request/timestamp. Thread a generation-aware ownership callback through both atomic writes and stop immediately on lease loss.

### P3 — ownership loss after successful unlink permanently wedges removal

`lib/fs-atomic.js:518-523` can successfully unlink the quarantined payload, after which `:529` performs another ownership check before `:530` removes the now-empty reservation directory. If that check reports lease loss, the empty `.cah-owned-remove` directory remains. Maintenance only sweeps empty publication namespaces at `lib/fs-atomic.js:818-833`, so every later removal sees the occupied quarantine and preserves the managed leaf indefinitely. Empty private reservations should be released in a lease-independent `finally` once their payload is gone.

### P3 — atomic transaction staging leaks unbounded crash artifacts

`lib/marker-state.js:484-488` creates a randomly named staging directory and writes `transaction.json` before renaming it into the canonical transaction slot. A crash before the rename bypasses the catch cleanup at `:489-490`. Neither marker recovery nor the recovery-name registry at `lib/fs-atomic.js:19` recognizes these `.*-capacity-transaction-stage-*` directories, so repeated full-capacity crashes accumulate permanent directories. Use a bounded deterministic stage or explicitly reconcile staged transactions.

### P3 — incomplete migration scans are still marked complete

In marker migration, `lib/marker-state.js:691-707` records each bounded scan result but ignores `scan.complete`, then unconditionally writes `.migration-v1` at `:712`, contradicting `:708-710`. Stamp-state migration has the same defect: `:747-753` continues after an incomplete root, but `:755` still writes the sentinel. Subsequent runs skip bulk migration, permanently leaving entries beyond the scan cap. Publish the sentinel only when every legacy root reached EOF without indeterminate entries.

### P3 — migration freshness loses nanosecond ordering

`lib/marker-state.js:121-126` converts `mtimeNs` from `BigInt` to `Number`, and `:131-136` uses that rounded value to choose collision winners. Epoch nanoseconds exceed JavaScript’s exact-integer range, so distinct mtimes can compare equal; the target then wins and the newer legacy state may be removed. Compare `mtimeNs` as `BigInt`, converting only for bounded age calculations.

### P3 — the 1,000-line production-file contract has no regression gate

Current production files comply, but `lib/fs-atomic.js` already reaches line 999. The test entry point at `package.json:21-24` has no source-size check, and no discovered test enforces the limit. A one-line production edit can therefore violate the contract unnoticed. Add a test that enumerates production JavaScript files and rejects any file exceeding 1,000 lines.

## Disposition

Round 43 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
