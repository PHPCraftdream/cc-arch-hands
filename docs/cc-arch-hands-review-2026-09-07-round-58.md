# cc-arch-hands review — round 58

- Baseline: `92312c7` (`fix: close round 56 recovery and lifecycle gaps`); working tree clean.
- Scope: comprehensive fresh review of the current codebase — `lib/*.js`, `lib/binstall/`,
  `bin/*.js`, `templates/`, `scripts/`, `test/`, `test-support/`. Deliberately not a diff
  against round 57, which reviewed only the round-56 disposition.
- Mode: read-only for product code. The suite, the doc-generation gate, and two isolated
  temp-directory reproductions were run; nothing outside this document was modified.
- P0 findings: none
- Result: 1 P1, 5 P2, 1 P3

## Findings

### P1 — `migrateClaim` never releases the lease it acquires, and the migrated lock stays owned by the live migrator

`lib/marker-state.js:471-485`. In the `winner > 0` branch, `migrateClaim()` acquires a lease on
the legacy claim path, renames that directory onto `targetPath`, and then runs
`finally { if (moved) releaseLease(sourceLease); }`. The guard is inverted with respect to where
the lease directory actually is:

- on success (`moved === true`) the lease directory now lives at `targetPath`, so
  `releaseLease(sourceLease)` — bound to `sourcePath` — fails its `leaseOwned()` fast-fail and
  returns `false` without doing anything. The migrated claim keeps an `owner.json` naming the
  live migrating pid with a fresh timestamp;
- on every failure exit of the same branch (`releaseLease(targetLease)` returning false, a
  non-absent target, a `renameSync` throw) `moved` is `false`, so the lease at `sourcePath` is
  not released either.

Reproduced in an isolated temp directory: after `migrateLegacyStateFiles()` migrates a legacy
stamp lock, `<namespace>/<lock>/owner.json` contains `{"pid": <migrating process pid>, ...}`, and
the `acquireStampLock()` that `bin/cah-stamp.js:321` performs immediately afterwards on that exact
path returns `null`. `main()` then returns at `if (!lock) return;` and the turn produces no chat
stamp. The marker namespace has the same shape: `migrateMarkerState()` migrates
`.cah-marker-claim-<marker>` and `claimMarker()` → `acquireClaim()` targets the identical path, so
the update notice is dropped the same way. The condition is deterministic, not a race; it is
bounded to the one migrating invocation because the stale owner becomes reclaimable once that
process exits.

Release the acquired lease on every exit of the branch, and release it at the path where the lease
directory actually lives after a successful rename (or return the moved lease so the caller can
reuse or release it).

### P2 — two `binstall` smoke assertions fail whenever `FORCE_COLOR` is set

`test/binstall.test.js:1031` and `:1184` assert `/new 2/` and `/surviving 1/` against the raw
stdout of a spawned child. The fixtures those children run are `console.log('new', x)` and
`console.log('surviving', x)` with a numeric `x`, and the child inherits the parent environment
verbatim (`env: { ...process.env, HOME, USERPROFILE }`). When `FORCE_COLOR` is present Node
colourises the number, so stdout is `new \x1b[33m2\x1b[39m` and both assertions fail. This is not
hypothetical: `FORCE_COLOR=1` is exported by the maintainer's own terminal, so `npm test` fails as
checked out there, while `env -u FORCE_COLOR npm test` is green. Note that `FORCE_COLOR=` (empty)
and `NO_COLOR=1` do not help — Node treats a present-but-empty `FORCE_COLOR` as "force 16 colours".
Delete the colour-forcing variables from the spawned child's environment, or normalise ANSI
sequences out of `result.stdout` before matching.

### P2 — bounded-sidecar-progress uses a wall-clock oracle over a namespace-quadratic maintenance pass

`test-support/stamp-state.cases.js:391` asserts `Date.now() - started < 5_000` for a single
`runStamp()` — a full Node process spawn plus maintenance over 300 sidecars. It failed once during
this review under concurrent load (`✖ ... (6434.3792ms)`) and passed on an unloaded rerun, so it is
a timing flake rather than a deterministic failure. The margin is thin because the maintenance path
re-enumerates the whole state directory once per removal: `pruneStampSidecars()`
(`bin/cah-stamp.js:182-214`) streams up to `MAX_STAMP_SESSIONS * 2 + 8 = 136` entries and calls
`removeStampSidecar()` for each stale one; every `removeStampSidecar()` (`:159-180`) runs
`recoverOwnedFileFences()`, which itself enumerates up to 136 entries of the same directory
(`lib/lease-lock.js:776-791`), on top of the `recoverStampSidecarFences()` pass that already
precedes the loop. Replace the wall-clock oracle with a structural one — the module already exposes
`resetDirectoryScanStats()` / `readDirectoryScanStats()` for exactly this — and hoist the
per-removal namespace scan out of the loop.

### P2 — `claimMarker` leaks the capacity lease when transaction preparation fails

`lib/marker-state.js:717-721`. Every other failure exit of `claimMarker()` calls
`releaseLease(capacityLease)`. The `if (!prepared)` exit calls only
`releaseMarkerClaim(sessionClaim)`, and `sessionClaim.capacityLease` is assigned on the *next*
line, so `releaseMarkerClaim()` observes `undefined` and the exclusive
`.cah-marker-capacity-<namespace>` lease is retained for the remaining life of the process.
`acquireCapacityLeaseForPrune()` masks this for `pruneMarkers()` through its same-pid "borrowed"
path, but `claimMarker()` and `migrateMarkerState()` have no such fallback and simply fail. Release
the capacity lease on that exit, or attach it to `sessionClaim` before `prepareCapacityEviction()`
runs.

### P2 — capacity-eviction retry excludes only the previous victim and can recurse without bound

`lib/marker-state.js:353-361` retries `prepareCapacityEviction()` recursively after a failed
`casMoveVictim()`, passing `scan.oldest.path` as `excludedPath`; `scanCapacity()` (`:263-282`)
honours a single exclusion, not an accumulated set. With more than `maxSessions` live markers and a
victim mutation that fails deterministically for every candidate — the sole mutation is
`linkSync()` in `lib/marker-capacity-ops.js:691-699`, which fails uniformly where hard links are
denied or unsupported — the recursion alternates between the two oldest markers indefinitely,
performing real filesystem work (stage directory, durable state write, rename, cleanup) on every
frame until the stack overflows. Accumulate the exclusion set across retries and cap the retry
count per invocation, matching the bounded-work discipline used everywhere else in this subsystem.

### P2 — the unwound publication path can lose its original error and skip fence release

`lib/fs-atomic-publication.js:812-832`. The first commit re-check is deliberately wrapped —
`try { committed = destinationIsPublished(...); } catch { /* keep original */ }` — under the
comment "A failed inspection must never replace the original publication error". The `!committed`
branch immediately below is not: `markPublicationAbandoned()` (a durable proof rewrite) and the
second `destinationIsPublished()` both run unguarded, and `captureRegularFileSnapshot()` throws by
design when the leaf changes between its two identity reads. Such a throw replaces the caller's
real error *and* skips `abortPublication()`, leaving the temp plus a fence whose proof still names
a live `ownerPid`. `recoverOccupiedFence()`'s `deferFresh` path refuses to reclaim a live-owner
fence, so a later publication to the same destination from that process burns the full
`FENCE_ACQUIRE_RETRIES` backoff (~31 s) and then throws `EEXIST`. Guard the abandon and inspection
calls the way the first inspection is guarded, and always attempt the abort before rethrowing.

### P3 — dead code, stale comments, and key-file documentation gaps

None of these change behaviour, but they contradict the codebase's own conventions:

- `lib/fs-atomic-identity.js:43` — the comment "Move a validated inode to a deterministic sibling
  before unlinking it" documents removal, and sits above `regularFileIdentity()`, which only stats.
- `lib/lease-lock.js:378-384` — `testInterlock(phase, stage, deadline, options)` never uses
  `deadline`; the comment at `:386-387` describes the capacity/owner interlock but sits above
  `fencePaths()`.
- `lib/binstall.js:779-783` — `sub` is always truthy inside `for (const sub of ... ['bin','lib'])`,
  so both `sub ? ... : ...` false branches are unreachable. `:847-852` re-declares a local
  `emptyMaintenanceReport()` byte-identical to the one already exported from `lib/fsutil.js:62`
  and imported alongside `mergeMaintenanceReport` in the same file.
- `lib/marker-capacity-recovery.js:166-169` — the `retirement.state` fallback is unreachable:
  `inspectTransactionRetirement()` only spreads `state` when `records.length === 1`, which the
  preceding branch already consumes. `reconcileExpiredRetirements()` (`:288-366`) returns bare
  `false` on hard failure and `{ ok, complete }` otherwise, so the caller at `:138` reads `.ok` off
  a boolean primitive; it happens to yield `undefined` rather than throwing, but the mixed return
  type is a trap.
- `lib/marker-state.js:627` — the `maintenance` binding in `pruneMarkers()` is never read.
- `bin/cah-stamp.js:4,15` — `writeFileSync`, `mkdirSync`, and `leaseOwned` are imported and unused.
- `lib/fsutil.js:99` — `listFilesRel()` has no remaining caller anywhere in `lib/`, `bin/`,
  `scripts/`, `test/`, or `test-support/`.
- `CLAUDE.md`'s "Key files" table omits `lib/lease-lock.js` (mentioned only in prose) and both
  `lib/binstall-repair.js` and `lib/binstall/runtime.js`, which appear nowhere in the file — three
  of the project's production modules, one of which owns rollback repair.

## Disposition

Round 58 is not clean. Close the findings and repeat the read-only review.

The concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`, `lib/marker-capacity-*.js`,
`lib/marker-state.js`) was read in full, along with the installers, the CLI, the four companion
bins, and the probe. Beyond the items above, no additional confirmed P0–P3 defect was identified
in that scope. That is not a claim that every filesystem race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 580 total, 574 passed, 6 skipped, 0 failed (182.4 s).
- `npm test` with the ambient `FORCE_COLOR=1`: 2 failed (`test/binstall.test.js:973` and `:1147`).
- One additional intermittent failure was observed under concurrent load at
  `test-support/stamp-state.cases.js:359`; it did not reproduce on the unloaded rerun.
- `node --check` over all 67 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: README.md is in sync with `lib/manifest.js`.
- `git diff --check`: clean. Manifest counts match the documentation (44 model definitions →
  88 bodies, 23 Codex agents, 11 skills), and every skill in `AllSkills` still has its
  `npx cah install --only <name>` line in README.md.
- The P1 was reproduced twice in throwaway temp directories driving `lib/marker-state.js` and
  `lib/lease-lock.js` directly. No real `~/.claude` state was touched; no install, no version
  change, no push.
