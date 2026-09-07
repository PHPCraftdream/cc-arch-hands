# cc-arch-hands review — round 59

- Baseline: `d135f7b` (`fix: close round 58 lease-release and publication gaps`); working tree clean.
- Scope: two halves. First, adversarial verification that round 58's six fixes are correct and
  complete — including two sandboxed revert-and-compare reproductions that prove the fixes are
  load-bearing. Second, a fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`, `templates/`,
  `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`),
  the doc-generation gate and a full `node --check` were run, and three isolated
  temp-directory reproductions were built outside the repository. Nothing outside this
  document was modified.
- P0 findings: none
- Result: 3 P2, 1 P3. Round 58's P1, its `FORCE_COLOR` P2, its capacity-retry P2 and its
  capacity-lease P2 are confirmed genuinely fixed; its publication-unwind P2 is fixed only
  partially (see the third P2 below).

## Findings

### P2 — `releaseLease()` inherits the acquire-time recovery deadline, so its transient-error retry budget is always already spent

`lib/lease-lock.js:863-883`. `acquireLease()` stamps a one-shot budget into the lease's option
object — `recoveryDeadline: Date.now() + LEASE_RECOVERY_WAIT_MS` (`:589`, 250 ms) — and that object
is stored on the returned lease (`:612`). `releaseLease()` reuses it verbatim: `options = lease.options`
(`:865`), `releaseOptions = { ...options, interlockPhase: ... }` (`:874`), and both `takeFence()`
(`:880` → `withTransientRetry(renameSync, options.recoveryDeadline)`, `:549-552`) and
`removeClaimPath()` (`:882`) are handed that same, long-expired timestamp. `withTransientRetry()`
(`:134-149`) computes `remaining = deadline - Date.now()`; once it is ≤ 0 it returns the first
error without a single retry. Any lease held longer than 250 ms — i.e. every bin-lifecycle lease,
every stamp lock, every marker capacity lease in practice — therefore releases with a zero-length
retry window, even though `EPERM/EACCES/EBUSY/ENOTEMPTY` are exactly the codes this module
classifies as transient (`:19`).

That this is an oversight rather than a policy is visible one function above: `renewLease()` builds
`renewOptions` by spreading `lease.options` and then explicitly overwriting
`recoveryDeadline: Date.now() + LEASE_RECOVERY_WAIT_MS` (`:671-678`), precisely because the stored
value is stale by then. `releaseLease()` does not.

Reproduced deterministically in a temp directory (child process holds the lease directory as its
CWD for 150 ms, which makes Windows fail the fence rename with `EBUSY`):

- current code — `releaseLease()` returned `false` after **1 ms**, and the lease directory survived
  with our `owner.json` still in it;
- same run with only `options.recoveryDeadline` refreshed to `Date.now() + 250` — returned `true`
  after **188 ms**, lease removed.

A leaked lease is not cosmetic: the path stays claimed by a *live* pid, so `claimExpired()`
(`:535-544`) refuses to reclaim it for `LEASE_MAX_MS` (5 min). Within the same process this is
immediately fatal to the operation that follows — `migrateClaim()` releases and then the caller
re-acquires the identical path (`bin/cah-stamp.js:341`), `claimMarker()` releases the recovered
session claim at `lib/marker-state.js:706` and re-acquires that same claim path at `:715` whenever
the recovered transaction belongs to this session, and the stamp sidecar maintenance pass
acquires/releases one lock per sidecar. Across processes,
`withBinLifecycleLease()`'s silent `finally { releaseLease(lease); }` (`lib/binstall.js:67-69`)
turns the same failure into a spurious `BinLifecycleBusyError` on the next `cah install`.
Give release (and its `removeClaimPath`) a freshly computed deadline, exactly as renew does.

### P2 — `migrateClaim()` still strands a live-owner lease when its *target* release fails

`lib/marker-state.js:475-489`. Round 58 fixed the success path (verified below), but the branch
that acquires a lease on the target claim in order to prove it is not live still discards the
result of releasing it:

```js
const targetLease = acquireLease(targetPath, leaseOptions(cfg, 'legacy-claim-reclaim'));
if (!targetLease) { releaseLease(sourceLease); return INDETERMINATE; }
let moved = false;
try {
  if (!releaseLease(targetLease)) return INDETERMINATE;   // <- targetLease is still held
```

On that exit the lease directory at `targetPath` is still owned by this live pid (or, if
`removeClaimPath` was the step that failed, a `.taken-<pid>-<uuid>` fence sits beside it and
`hasInFlightFence()` blocks every acquire). `targetPath` is the exact path
`acquireStampLock()`/`acquireClaim()` is about to take: the caller returns `blocked`/`null` and the
turn produces no chat stamp and no update notice — the same observable symptom as the round-58 P1,
on the branch its fix did not cover. The trigger is a failed release, which the finding above makes
materially more likely than it looks (zero retry budget against a transient Windows `EBUSY`).
Release the target lease on every exit of this branch, or reuse it instead of dropping it.

### P2 — the publication unwind still has one unguarded call, and it is the destructive one

`lib/fs-atomic-publication.js:823-842`. Round 58 wrapped `markPublicationAbandoned()` and the
re-inspection in `try { … } catch { /* keep original */ }` under the rule that "a failed
inspection must never replace the original publication error". The call the fix *added* is not
wrapped:

```js
if (!inspected || provenAbsent) {
  if (!abortPublication(publication) && inspected) {
    throw recoveryRequired(publication.path);
  }
}
```

`abortPublication()` (`:563-574`) is the one step in that block that mutates the filesystem, and
every I/O primitive it reaches can throw a non-`ENOENT` error straight through: `lstatMaybe()`
(`:36-41`) rethrows anything that is not `ENOENT`; `exactTemp()` (`:459-466`) calls
`captureRegularFileSnapshot()`, which `lib/fs-atomic-identity.js:18-25` documents as throwing by
design; and the `unlinkSync(publication.tempPath)` / `syncParentDirectory(...)` pair at `:570-571`
is the only unlink in this codebase with neither a `try` nor a `withTransientRetry` wrapper —
`EPERM/EACCES/EBUSY` on the temp is precisely what `RETRY_CODES` (`:12`) exists for everywhere
else. When it throws, the caller's real error (commonly `AtomicOwnershipLostError`, which
`lib/binstall.js:265` and `lib/binstall-repair.js:207/297` dispatch on) is replaced by a generic
transient error, and `attachCommittedPublication()` at `:843` is skipped as well.

The round-58 test (`test/conditional-publication.test.js:242-286`) only exercises the
`!inspected` path where `abortPublication()` succeeds, so this gap is untested. Guard the abort the
same way the other two calls are guarded, or make the commit message's claim true by treating a
throwing abort as "abort attempted, original error preserved".

### P3 — dead code, dead imports, corrupted comment bytes, and one capacity-semantics note

None of these change behaviour, but they contradict the codebase's own conventions, and several are
in files that are mirrored verbatim into `~/.claude/cah-bin/`, so they ship to users:

- `bin/cah-stamp.js:187-188` — round 58's own extraction left `stateDir` and `prefix` bound in
  `pruneStampSidecars()` and never read; the body that uses them was moved into
  `pruneStampSidecarsScan()`, which re-declares both at `:206-207`.
- `lib/lease-lock.js:151-153` — `interlockDeadline()` is now write-only. Round 58 removed the
  `deadline` parameter from `testInterlock()` (`:388`), and nothing reads the
  `interlockDeadline:` keys it still populates at `:590`, `:655`, `:677` and `:872`.
- `lib/lease-lock.js:699`, `:946-948`, `:961-963` — `heartbeatLease`, `removePathIfUnchanged` and
  `leaseFileIdentity` have no caller anywhere in `lib/`, `bin/`, `scripts/`, `test/` or
  `test-support/`.
- `lib/sentinel.js:45-55` — `isOurs()` has no caller, and `allForClass()`'s only caller is
  `isOurs()`, so both are dead. `CLAUDE.md`'s Key-files table still advertises
  "`lib/sentinel.js` | Sentinel constants, `classifyContent`, `isOurs`".
- `lib/marker-state.js:30` (`INSPECTION`) and `lib/probe.js:33`
  (`TEST_INTERLOCK_TIMEOUT_MS`) are unused.
- Unused named imports: `lib/fs-atomic.js:4` (`writeFileSync`), `lib/marker-state.js:3`
  (`readdirSync`), `lib/probe.js:14` (`writeFileSync`), `lib/update-check.js:12` (`dirname`).
- Mojibake — a double-encoded em dash — in three source files:
  `lib/fs-atomic.js:299` (`/* busy wait â€” keeps this sync and zero-dep */`),
  `test-support/installer-model.cases.js:430`, and
  `test-support/installer-data-loss-scope.cases.js:519`, where it sits inside the `it(...)` title
  and is quadruple-encoded (`Ã¢â‚¬â€`), so the suite prints a garbled test name on every run.
- `test-support/stamp-helpers.js:14` — `BIN` is assigned and never read.
- `lib/fs-atomic.js:297-300` and `lib/fs-atomic-publication.js:73-76` implement `sleepSync` as a
  `while (Date.now() < end)` spin, while `lib/lease-lock.js:121-124` uses `Atomics.wait` for the
  same purpose. The publication fence's contention loop (`lib/fs-atomic-publication.js:676-690`)
  can spin for `FENCE_ACQUIRE_RETRIES` × up to 320 ms ≈ 31 s of busy CPU inside a statusLine or
  Stop hook.
- Capacity semantics note, not a defect: `scanCapacity()` (`lib/marker-state.js:264-283`) counts
  only non-excluded markers, so the widened exclusion set from round 58 lets
  `scan.count < cfg.maxSessions` pass with up to `MAX_CAPACITY_EVICTION_RETRIES` (4) live markers
  hidden from the count — a namespace can now settle at `maxSessions + 4` rather than
  `maxSessions + 1`. Bounded and TTL-pruned, but worth stating explicitly since the bound is a
  documented invariant of this subsystem.

## Disposition

Round 59 is not clean. Close the three P2s and the P3 batch, then repeat the read-only review.

Round 58's disposition is otherwise confirmed by direct experiment, not by inspection alone: its P1
and its capacity-retry P2 were each reverted in a throwaway copy of `lib/` and both defects
reproduced exactly as described, while HEAD is clean on the same scenarios (numbers in
Verification). The `FORCE_COLOR` P2 is confirmed by a green suite under `FORCE_COLOR=1`. Its
capacity-lease P2 and stamp-maintenance P2 are covered by the tests it added, which pass.

The concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`, `lib/marker-capacity-*.js`,
`lib/marker-state.js`) was read in full again, along with the installers, the repair path, the CLI,
the probe, all four companion bins and the shared transcript library. Beyond the items above, no
additional confirmed P0–P3 defect was identified in that scope. That is not a claim that every
filesystem race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 585 total, 579 passed, 6 skipped, 0 failed (169.0 s).
- `FORCE_COLOR=1 npm test`: 585 total, 579 passed, 6 skipped, 0 failed (171.2 s) — round 58's
  `FORCE_COLOR` P2 is genuinely closed; the two `test/binstall.test.js` smoke assertions now pass
  under the maintainer's ambient environment.
- The 6 skips are all legitimate platform guards (hardlink metadata, POSIX mode bits, nanosecond
  mtime restoration on Windows). No test is silently disabled.
- `node --check` over all 67 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: README.md is in sync with `lib/manifest.js`.
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills; every skill in `AllSkills` has a matching `templates/skills/<name>/`
  directory and an `npx cah install --only <name>` line in README.md; `bins`, `commands` and
  `codex-agents` examples present; `package.json` version `0.8.0` equals
  `lib/update-check.js`'s `CURRENT_VERSION`.
- Round-58 P1 (migrated claim lease), revert-and-compare in a copied `lib/` tree, driving
  `migrateLegacyStateFiles()` then the `acquireStampLock()` that follows it in `bin/cah-stamp.js`:
  with the one-line fix reverted → `migratedLockStillOwned: true, ownerPidIsThisProcess: true,
  acquireStampLockAfterMigration: null (stamp dropped)`; at HEAD → `false / false / ok`.
- Round-58 capacity-retry P2, same technique with 8 live markers, `maxSessions: 2` and an
  interlock that invalidates every selected victim: HEAD performs **5** victim selections and then
  returns `null`; with the exclusion set reverted to the previous single-path exclusion the same
  scenario performed **2551** victim selections (each a full stage/durable-write/rename/cleanup
  cycle) before giving up. The bound is real and load-bearing.
- The first P2 was reproduced in a throwaway temp directory as described above (1 ms/`false` with
  the shipped deadline vs 188 ms/`true` with a refreshed one).
- `git diff --check` and `git status --porcelain`: clean before and after, apart from this
  document. No real `~/.claude` state was touched; no install, no version change, no push.
