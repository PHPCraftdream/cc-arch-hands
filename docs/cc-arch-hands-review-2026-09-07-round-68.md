# cc-arch-hands review — round 68

- Baseline: `301b124` (`fix: close round 67 proof-race and pid-recycling gaps`); working tree clean.
- Scope: two halves. First, the mandate's own experiment — extend round 67's *multi-process
  contention* technique to the two subsystems it had never been applied to: `lib/lease-lock.js`'s
  `acquireLease()`/`renewLease()`/`releaseLease()` fence machinery and
  `lib/marker-state.js`/`lib/marker-capacity-*.js`'s claim + capacity-eviction machinery, driven by
  real concurrent Node processes racing one lease path / one marker namespace (with and without
  `SIGKILL` chaos), not by single-process interlock injection. Second, adversarial re-verification of
  round 67's own three fixes, then a fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`,
  `templates/`, `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), the 6
  skips were enumerated exactly, `npm run gen:docs:check` and a full `node --check` were run, twelve
  isolated reproductions were built outside the repository (several spawning 4–8 real child
  processes), and the CLI was smoke-tested end to end in a sandbox `HOME`/`USERPROFILE`. Nothing
  outside this document was modified. The real `~/.claude` was never touched.
- P0 findings: none
- Result: **1 P1, 2 P2, 3 P3.** The technique transfer paid off, but not where it was aimed. The
  lease and marker layers turn out to have airtight *error* discipline — several thousand real
  concurrent acquire/renew/release and claim/publish/evict operations produced **zero** raw
  errno escapes, and the capacity machinery converged cleanly even when half the workers were
  `SIGKILL`ed mid-transaction. What the same harness did find is a defect of a different class:
  `recoverFence()` creates a `<lease>.abandoned-<pid>-<uuid>` displacement quarantine and, on one
  error path, returns without disposing it — into a namespace that `RECOVERY_MARKERS` does not
  list, so **nothing in the product ever reclaims or even reports it**. It accumulates without
  bound in `~/.claude/cah-bin/cache/`, and at roughly 200 entries it silently and permanently
  disables `claimMarker()` (the `/clock` update notice and the `/checkpoint-watch` hint).
  Separately, round 67's `pruneOrphanDirs()` fix does not close the bug it was written for: the
  same concurrently removed orphan skill directory still aborts `cah install` with exit 1, 12 times
  out of 14, through two other unguarded calls in the same few lines.

## Findings

### P1 — `recoverFence()` leaks its `.abandoned-` displacement quarantine into a namespace nothing reclaims or reports, so the shared cache grows without bound until `claimMarker()` stops working forever

`lib/lease-lock.js:516` (creation) against `:529` (the leaking return), and `lib/fs-atomic.js:43-44`
(`RECOVERY_MARKERS`).

```js
    const currentSnapshot = ownerSnapshot(path, readOwner);
    const quarantine = `${path}.abandoned-${process.pid}-${randomUUID()}`;   // :516
    const movedCurrent = withTransientRetry(
      () => renameSync(path, quarantine),
      recoveryDeadline,
    );
    if (!movedCurrent.ok) return false;
    if (!sameOwnerSnapshot(quarantine, currentSnapshot, readOwner)) {
      restoreWithoutOverwrite(quarantine, path, ownerFile, recoveryDeadline);   // disposed
      return false;
    }
    // Restore the old fence before deleting the displaced claim. If a new
    // successor appeared while the path was vacant, the displaced content
    // stays quarantined and can never be mistaken for disposable state.
    if (!restoreWithoutOverwrite(fencePath, path, ownerFile, recoveryDeadline)) return false;   // :529 — NOT disposed
    return removeClaimPath(quarantine, ownerFile, recoveryDeadline);
```

Three of the four exits from this block dispose the quarantine (`restoreWithoutOverwrite` at `:523`,
`removeClaimPath` at `:530`). The fourth — `:529`, taken when the *old fence* can no longer be put
back — returns `false` and leaves `${path}.abandoned-<pid>-<uuid>` on disk. The retention itself is
deliberate (the comment at `:526-528` says so). What is missing is any consumer of that namespace:

| namespace the code creates | reclaimed by | listed in `RECOVERY_MARKERS` |
|---|---|---|
| `.cah-owned-remove` | `sweepRecoveryArtifacts()` quarantine branch | yes |
| `.cah-owned-publish` | `recoverPublicationFence()` / sweep | yes |
| `.cah-tmp-…` | reported (`unprovedTemps`), swept with inode proof | yes |
| `.cah-lease-quarantine` | reported only (round 65 disposition) | yes |
| `<lease>.taken-…` / `.stale-…` | `recoverFence()` | n/a (recovered) |
| `<file>.cah-owned-file-…fence` | `recoverOwnedFileFences()` | n/a (recovered) |
| **`<lease>.abandoned-<pid>-<uuid>`** | **nothing** | **no** |
| **`.cah-capacity-quarantine/victim`** | **nothing** | **no** |

`fencePaths()` (`lib/lease-lock.js:397-415`) only matches `${basename}${fenceSuffix}`, so
`.abandoned-` is outside the active fence set; `isQuarantineName()` (`lib/fs-atomic.js:942-945`)
returns `false` for it, so `describeRecoveryArtifact()` classifies it as `null` and
`enumerateRecoveryArtifacts()` produces **zero** artifacts for it; `pruneOrphans()`/
`pruneOrphanDirs()` never scan the cache sub-namespaces at all. Measured directly:

```
isQuarantineName: false          isQuarantinePath: false
maintenance swept: []   preserved: []   recovery: []   artifacts: 0
after 200 ordinary acquire/release cycles: [ 'the.lock.abandoned-99999-…' ]
```

This directly contradicts the design rule stated 490 lines above it
(`lib/lease-lock.js:22-25`): *"The finite namespace is important: repeated recovery must not grow a
suffix chain, and every move must preserve an existing entry."* `quarantineFenceDir()` obeys that
rule with a fixed root plus 32 slots; `recoverFence()`'s sibling quarantine is exactly the unbounded
`randomUUID()` suffix chain the rule forbids.

**Reproduction (isolated temp dir, real product code, production lease defaults).** A crashed lease
reclaim leaves a `.taken-<deadpid>-<uuid>` fence — precisely what a `SIGKILL`ed hook leaves between
`takeFence()`'s rename and its disposal. Four ordinary `acquireLease()` processes then race to
recover it: one wins `restoreWithoutOverwrite(fence → path)`, and a loser that read `path` *after*
that restore displaces the restored claim into `.abandoned-…` and can no longer put the fence back:

```
rounds: 12  acquirers/round: 4
rounds that leaked: 8-11 of 12    total .abandoned- entries left: 1-4
contents of first leak: [ 'owner.json' ]
```

An instrumented copy of `lease-lock.js` (in a temp tree; product code untouched) attributes every
leak to the same line:

```
LEAK@529 restore-fence-failed …\ns\the.lock.abandoned-44496-263bea13-…
```

It is not confined to a planted fence. A crash-free run of 6 real workers on one lease path with a
40 ms lease (the production shape of an expired 5-minute lease plus concurrent reclaimers) also
leaked, and the reclaim-heavy 6×200 harness produced **7–11 leaks per run**.

**Reproduction through the real bin.** 14 rounds × 4 concurrent real `cah-stamp` Stop hooks against
one sandbox `HOME`, with one planted crashed lock fence, left three permanently orphaned
directories in the production namespace:

```
stamp-state entries: 5
abandoned leaks:
  last-stamp.json.session-876ce…3c.json.lock.abandoned-25164-21ecf80d-…
  last-stamp.json.session-876ce…3c.json.lock.abandoned-38680-b3dde1cf-…
  last-stamp.json.session-876ce…3c.json.lock.abandoned-43896-c4d05dc7-…
taken fences left: []
other: [ '.migration-v1', 'last-stamp.json.session-876ce…3c.json' ]
```

`cache/stamp-state` is one of the four `CACHE_SCAN_SUBDIRS` (`lib/binstall.js:847`) that
`cah install --only bins` sweeps, so the report is where a user would learn about it. It does not:

```
  bins: wrote 17, skipped 0 (foreign or canonical survivor), recovery 1 (quarantine)
    recovery: cache/stamp-state/.cah-tmp-1-control          ← the control artifact IS reported
    maintenance: visits 69, recovery 0, temps 1, swept 0, preserved 1
leak still present: true      report mentions the leak: false
```

**Why this is P1 rather than a hygiene P3.** The accumulation is monotone, invisible, and terminal.
Every producer sits in a directory whose consumers use a *bounded* scan that must complete:
`scanCapacity()` (`lib/marker-state.js:267-281`) returns `complete: false` once
`streamDirectoryEntries` hits `cfg.scanCap`, and `prepareCapacityEviction()` turns that into
`return null` (`lib/marker-state.js:301`) — as does `reconcileLegacyCapacityFences()`
(`lib/marker-capacity-stage.js:110`). `claimMarker()` then returns `null` forever. Demonstrated
end to end with `scanCap = 20`:

```
claim with a clean namespace: true
claimMarker() started returning null after 18 leaked entries; directory entry count = 18
claim again: false
```

In production `UPDATE_MARKER_SCAN_CAP` and `MARKER_SCAN_CAP` are both `64 * 3 + 8 = 200`, and normal
occupancy is ≤ 65 markers plus claims, so roughly 130–190 leaked entries silently and permanently
disable the `/clock` update notice and the `/checkpoint-watch` 90 % hint — with no error, no report
and no recovery path. `cache/stamp-state/`'s bounded scans (`MAX_STAMP_SESSIONS * 2 + 8 = 136`)
degrade rather than fail: `pruneStampSidecarsScan()` returns early (`bin/cah-stamp.js:223`) so
sidecar pruning quietly stops. The leaked directory itself holds only an expired `owner.json` (the
displacement is reached only when `currentOwner` is `null` or expired, `lib/lease-lock.js:504-514`),
so this is a leak and a denial of service, not data loss — which is why it is P1 and not P0.

Secondary, same root cause, **not reproduced, static observation only**:
`pruneQuarantinePath()`'s `.cah-capacity-quarantine/victim`
(`lib/lease-lock.js:35`, `:929-931`, created at `:978-988`) is likewise absent from
`RECOVERY_MARKERS`, and its only caller — `pruneMarkers()` at `lib/marker-state.js:649-650` —
discards the returned `quarantinePath`, so a preserved marker there is orphaned silently too. That
one is bounded (one deterministic path per directory), which is why it is a note rather than the
finding.

The fix is local: dispose (or fixed-namespace quarantine) the displacement at `:529` the way the
other three exits already do, and/or add the marker to `RECOVERY_MARKERS` so the existing sweep can
see and report it.

### P2 — round 67's `pruneOrphanDirs()` fix does not close the bug it was written for: a concurrently removed orphan skill directory still aborts `cah install` with exit 1, through two other unguarded calls in the same block

`lib/fsutil.js:307` and `lib/fsutil.js:161`, reaching `lib/fs-atomic.js:328` and
`lib/fs-atomic.js:480`/`:485`.

Round 67 guarded the third `readdirSync` at `lib/fsutil.js:286-292`. Two calls later the same
function hands the manifest to `removeOwnedRegularFile()` with no guard at all:

```js
    options.testInterlock?.('prune-before-manifest-remove');
    options.beforeRemove?.(manifestPath, manifestSnapshot);
    const removal = removeOwnedRegularFile(manifestPath, manifestExpected,        // :307
      { assertOwnership, testInterlock: options.testInterlock });
```

`removeOwnedRegularFile()` throws for the same race in two independent places:

1. `lib/fs-atomic.js:328` — `const currentSnapshot = captureRegularFileSnapshot(path);`.
   `captureRegularFileSnapshot()` lstats, reads, lstats again and throws
   `managed destination leaf changed concurrently; refusing operation`
   (`lib/fs-atomic-identity.js:22-25`) whenever the leaf *disappears* between the two lstats — which
   is exactly what a concurrent remover does.
2. `lib/fs-atomic.js:480`/`:485` — `unlinkForRemoval()`'s final `unlinkSync(path)` treats `ENOENT` as
   fatal: `RETRY_CODES` (`lib/fs-atomic.js:30`) is `EPERM, EACCES, EBUSY, EEXIST, ENOTEMPTY`, so
   `if (!isTransientFsError(e)) throw e;` rethrows a raw `ENOENT`. This is the outlier in the tree:
   `removeClaimPath()` (`lib/lease-lock.js:311`, `:314`, `:317`, `:321`), `removeEmptyDirectory()`
   (`lib/fs-atomic.js:582`), `releaseQuarantineReservation()` (`:561`), `recoverOwnedFileFence()`
   (`lib/lease-lock.js:754`, `:759`) and `removeOwnedFileForGeneration()` (`:861`, `:869`) all treat
   "already gone" as success.

`writeSkills()` calls `pruneOrphanDirs()` with no `try` (`lib/skills.js:154-157`), so both surface as
`cah install: skills: …` and exit 1 after part of the install has been written.

**CLI reproduction**, sandbox `HOME`/`USERPROFILE`, one orphan managed skill directory with a 96 MB
`SKILL.md`, one separate real process removing it, remover delay swept across the window:

```
delay=1050ms exit=1  cah install: skills: managed destination leaf changed concurrently; refusing operation
delay=1080ms exit=1  cah install: skills: ENOENT: no such file or directory, unlink
                     '…\.claude\skills\zzz-retired-skill\SKILL.md.cah-owned-remove\payload'
delay=1100ms exit=1  … (same)      delay=1120ms exit=1  … (same)
delay=1150ms exit=1  … (same)      delay=1180ms exit=1  … (same)
delay=1200ms exit=0
```

Repeated: **12 of 14 runs in the 1050–1180 ms window exit 1** (11 raw `ENOENT`, 1 conflict message).
Direct-API reproductions of the same two escapes, with real remover processes:

```
pruneOrphanDirs, 80 rounds × 8 orphans:  21 throws, all
  lib/fs-atomic-identity.js:24 <- lib/fs-atomic.js:328 <- lib/fsutil.js:307
pruneOrphans,    60 rounds × 8 orphans:   4 throws, all
  lib/fs-atomic-identity.js:24 <- lib/fs-atomic.js:328 <- lib/fsutil.js:161
```

The `pruneOrphans()` site matters independently: it is the bin-root sweep run by `writeBins()`
(`lib/binstall.js:245`) and `removeBins()` (`:779`, `:823`), and by
`writeModelCommands`/`writeCodexAgents`.

Severity is P2 rather than P1 to stay consistent with round 67's own rating of the identical
trigger and impact (an *orphan* directory or file plus a concurrent remover). What is new is that
the fix shipped for it closes only one of at least three escapes.

### P2 — round 67's staleness bound on `deferForeignCommitted` is wall-clock-only, so a proof timestamped in the future (a backward clock step) restores the exact permanent deferral it was written to remove

`lib/fs-atomic-publication.js:676-677` against `fenceIsStale()` at `:165-172`.

```js
      const deferForeignLive = options.deferForeignCommitted && foreignLiveOwner
        && !fenceIsStale(fencePath, proof);
```

```js
function fenceIsStale(path, proof = null) {
  const proofTime = Number(proof?.createdAtMs);
  if (Number.isSafeInteger(proofTime)) return Date.now() - proofTime >= FENCE_STALE_MS;
  …
```

`Date.now() - proofTime` is negative for a proof whose recorded creation time is in the future, so
`fenceIsStale()` answers `false` for the whole duration of the skew and never becomes true. A
committed fence left by a crashed publisher, whose recorded pid has since been recycled by an
unrelated live process, is then deferred to exactly as it was before `301b124` — the entire round-67
P2 symptom returns. A backward `Date.now()` step is ordinary on a machine with a bad RTC corrected
by NTP at boot, or after a VM snapshot restore.

**Reproduction**, identical fixture to round 67's own new regression test
(`test/fs-atomic.test.js:301-347`) with one change — the proof's `createdAtMs` is set an hour ahead
instead of an hour behind:

```
destination after crash: "victim-payload\n"
fence entries: [ 'publication.json' ]
crashed ownerPid: 22536   ownerState: active
patched ownerPid -> 25740   createdAtMs skew: + 3600000 ms
acquirer outcome after 30966 ms: exit=3 FAILED:EEXIST:EEXIST: file already exists,
  mkdir '…\leaf.json.cah-owned-publish'
fence still present: true      destination now: "victim-payload\n"
```

That is 30.9 s of `sleepSync()` busy-wait (`lib/fs-atomic-publication.js:67-70`, a `while
(Date.now() < end) {}` spin) burning one core, then a hard `EEXIST` — repeated on *every* later
publication to that leaf, including `cah-status`'s per-render `cache/rate-limits.json`.

A one-line sanity check (`proofTime > Date.now()` ⇒ treat as stale/invalid) closes it without
touching the deferral's intent. Two smaller observations in the same expression, no behaviour
change: (a) for `beginFence()` the trailing `(proofOwnerIsAlive(proof) || !fenceIsStale(fencePath,
proof))` clause at `:680` is now redundant — `deferForeignLive` already implies both disjuncts — so
`fenceIsStale()` is evaluated twice for the same proof; (b) the boundary itself is fine: `>=
FENCE_STALE_MS` makes an exactly-1000 ms-old fence stale, with no off-by-one.

### P3 — the whole `phase.includes('capacity')` half of `removePathIfUnchangedRecoverable()` is unreachable: its only caller passes `'marker-remove'`

`lib/lease-lock.js:945-947` and `:961-969`, against the sole call site at
`lib/marker-state.js:649-650`.

```js
  const quarantine = pruneQuarantinePath(path);
  if (phase.includes('capacity') && pathIdentity(quarantine)) {          // :945
    return { ok: false, restored: false, quarantinePath: quarantine };
  }
…
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_FINAL_UNLINK_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE === '1')
        && phase.includes('capacity')) {                                 // :965
```

```js
            && markerClaimOwned(claim)) removePathIfUnchangedRecoverable(
              path, current.identity, 'marker-remove', { testInterlock: cfg.testInterlock });
```

`removePathIfUnchangedRecoverable` is exported from `lib/lease-lock.js` and imported in exactly one
place (`lib/marker-state.js:9`), which calls it once, with the literal phase `'marker-remove'`. No
test imports it directly. So the guard at `:945` never fires and the failure injection at `:961-969`
never fires. The two tests that set `CAH_TEST_ONLY_FINAL_UNLINK_FAILURE`
(`test/checkpoint-hint.test.js:897`, `test-support/stamp-update.cases.js:560`) are served by the
*other* gate at `lib/marker-capacity-recovery.js:613-615`; `CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE`
and `CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE` are read in both files and set by nothing at all.

The cost is not only dead lines: the `:945` guard is the one thing that would stop a stranded
`.cah-capacity-quarantine/victim` from being re-created, and it is inert, which is part of why the
secondary note under finding 1 has no reclaimer.

### P3 — round 67 fixed the recycled-pid deferral only on the acquire side; the maintenance sweep still defers such a fence forever

`lib/fs-atomic-publication.js:678-680` reached with `deferCommitted: true` from
`lib/fs-atomic.js:738-739`.

`301b124` bounded `deferForeignLive` by staleness but left `options.deferCommitted` untouched, and
the trailing clause is `(proofOwnerIsAlive(proof) || !fenceIsStale(...))` — so for maintenance a
recycled pid still wins the tie regardless of age. Verified on round 67's own fixture (crashed
publisher in window B, `ownerPid` repointed at a live unrelated process, `createdAtMs` aged one
hour):

```
maintenance swept    : []
maintenance preserved: [ '…\leaf.json.cah-owned-publish' ]
fence still present  : true      fence entries: [ 'publication.json' ]
second pass swept    : []
```

The practical blast radius is small — `beginFence()` now reclaims the fence on the next publication
to that leaf, which for `cache/rate-limits.json` is every statusLine render — so this only matters
for a leaf that is never published again (an abandoned session's `cache/stamp-state/…json`). The
artifact is at least *reported* under `preserved`, thanks to round 66. Recording it because the two
deferral paths now disagree about what "a live owner" means, and the asymmetry is undocumented.

### P3 — `readProofBytes()`'s EPERM tolerance is aimed at the right platform behaviour but the wrong syscall family: on Windows it is the *directory* reads in the same recovery path that return EPERM, and every one of those tolerates only ENOENT

`lib/fs-atomic-publication.js:263-272` (round 67's helper and its comment) against
`lib/fsutil.js:288`, `:252`, `:227`, `lib/fs-atomic.js:482`, `:602`, `:630`, `:645`, `:749`.

Round 67's comment claims *"On Windows the same race surfaces as a transient EPERM on open (already
in RETRY_CODES), not ENOENT."* Measured on this host (Windows 10 19045, Node 24.12.0) with four
reader processes hammering a path a writer repeatedly creates, opens, and unlinks (3 282 unlinks
performed while a read handle was open, i.e. genuine delete-pending state):

```
lstat codes:  { OK: 16315, ENOENT: 15195 }
read  codes:  { OK: 20869, EPERM: 1195, ENOENT: 9446 }
```

So the claim is right for `readFileSync` — round 67's `EPERM` arm is real and needed — and the
`lstatMaybe()`/`regularFileIdentity()` calls that precede it on the same two paths
(`lib/fs-atomic-publication.js:36-41`, `lib/fs-atomic-identity.js:43-53`, both ENOENT-only) are
safe, because file `lstat` never returned `EPERM` in 31 510 attempts. The gap is one level up. The
same probe over a *directory* another process is concurrently `rmdir`ing:

```
lstatdir: { OK: 16116, ENOENT: 6668 }
readdir : { OK: 17483, ENOENT: 5063, EPERM: 238 }
opendir : { OK: 18832, ENOENT: 3769, EPERM: 183 }
```

`readdirSync`/`opendirSync` do return `EPERM` (≈ 4.5 % of the ENOENT rate), and every directory read
on the recovery path admits only `ENOENT` — including round 67's own new guard:

```js
    let current;
    try {
      current = readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') { addUnique(preserved, entry.name); continue; }   // lib/fsutil.js:290
      throw e;
    }
```

Filed as P3 rather than P2 because I could **not** reproduce an escape through that specific line in
situ (80 rounds of the harness produced 21 throws, all from finding 2's much wider windows and none
from `:288`); the errno is demonstrated, the path from it to a user-visible failure is not. It is
recorded because the asymmetry is now baked into a comment that reads as a platform conclusion, and
because the correct generalisation — "a concurrently vanishing entry is not an error, whatever errno
the platform picks" — is the one finding 2 also wants.

## Disposition

Useful order if these are worked:

1. **The P1** (`lib/lease-lock.js:529`). It is the only finding here that is permanent, silent and
   self-amplifying, and the only one that ends in a feature that simply stops working with no
   diagnostic. Two changes, either of which alone helps: dispose the displacement on that exit like
   the other three exits do, and add `.abandoned-` (and `.cah-capacity-quarantine`) to
   `RECOVERY_MARKERS` so the existing sweep at least reports what it cannot reclaim.
2. **The `pruneOrphanDirs`/`pruneOrphans` P2.** `unlinkForRemoval()` treating `ENOENT` as fatal
   (`lib/fs-atomic.js:485`) is a one-line correction in a primitive every removal path uses, and it
   accounts for 11 of the 12 CLI failures. The `captureRegularFileSnapshot` escape needs a
   `try`/`catch` around the two `removeOwnedRegularFile()` calls (`lib/fsutil.js:161`, `:307`) that
   maps a throw onto the `preserved` reporting the surrounding code already has.
3. **The clock-skew P2** (`lib/fs-atomic-publication.js:676`). One conjunct, and it restores the
   property `301b124` intended.
4. The three P3s; the dead-`capacity`-phase one (finding 4) is worth doing together with (1),
   because its inert guard is what would otherwise bound the second leaked namespace.

**On the technique transfer.** The mandate's hypothesis — that the lease and marker-capacity layers
would yield the same class of defect round 67 found in the publication layer (a raw errno escaping
through an unguarded read) — did **not** hold, and the negative result is worth recording as
precisely as the positive ones:

- **`lib/lease-lock.js` has no unguarded filesystem call reachable from `acquireLease()`,
  `renewLease()` or `releaseLease()`.** Six real processes × 200 acquire/renew/release cycles on one
  lease path with production defaults: 0 raw errors, 412 ms, no leftovers. The same with a 1 ms
  lease, which forces every iteration through `takeFence()` → `recoverFence()` →
  `restoreWithoutOverwrite()` → `removeClaimPath()`/`disposeOwnFence()`: 0 raw errors across
  repeated runs. A dedicated harness aimed at `renewLease()`'s fenced heartbeat path (6 workers,
  40 ms lease, 30 ms hold, 3 renews per hold, 3 rounds): 0 raw errors, despite that function's
  `try`/`finally` having no `catch` around `writeFileSync(join(fence.path, ownerFile), …)`
  (`lib/lease-lock.js:700`). That write is protected in practice by `recoverFence()`'s
  `pidIsAlive(operatorPid) && !fenceExpired` gate (`:495`), which keeps peers off a live process's
  fresh fence; it is the one place in the module where a future change to the expiry rule would
  expose a raw error, and it is worth a `catch` on general principle.
- **The marker-capacity machinery converges under contention and under real kills.** 6 workers ×
  40–80 iterations with unique session ids (so every claim forces an eviction): 0 raw errors, marker
  count always ≤ `maxSessions + 1` (the documented bound — `scanCapacity()` excludes the marker
  being claimed), no stranded `.cah-tmp-victim-` fence, no `.cah-capacity-fence`, no
  `capacity-transaction-stage`, and no `…-capacity-transaction` directory or `victim` slot left
  behind. Repeating that with a killer `SIGKILL`ing half the workers at staggered points, then a
  single quiescent recovery worker, gave the same clean end state in 4 of 4 rounds; the only
  leftovers were `writeFileAtomic` temps from the killed processes, which are a *recognised,
  reported* artifact class.
- The technique's actual yield was therefore a **leak**, not an error escape — which is the reason
  it survived nine rounds of crash injection *and* round 67's contention harness: both of those look
  for a wrong outcome, and this one produces the right outcome every time while leaving a directory
  behind.

Round 67's three fixes were checked individually:

- **The `readProofBytes()` fix holds and is stronger than its own test.** 6 rounds × 8 concurrent
  publishers × 200 publications on one leaf — 9 600 publications, more than eight times the load of
  the regression test `301b124` added — produced 0 raw failures and no `.cah-tmp-` leftovers. The
  residual is the errno-family gap in finding 6.
- **The `deferForeignLive` fix holds for a backward-looking clock and fails for a
  forward-dated proof** (finding 3), and its maintenance-side twin was left open (finding 5).
- **The `pruneOrphanDirs()` fix is correct for the errno it guards and insufficient for the race it
  targets** (finding 2).
- The three non-product P3s from round 67 are closed and verified: the `EXPECTED_CALL_SITES` comment
  now reads `57 + 3` and names `lib/fs-atomic.js`; `test/interlocks.test.js:223` builds a fresh
  `RegExp` per `exec` consumer, so the shared-`lastIndex` coupling is gone; and the trailing-newline
  sweep over all 139 tracked text files now reports zero offenders.
- The `reportClass()` deduplication also holds: with a planted `.cah-tmp-` in
  `cache/rate-context/`, the artifact appears once under `recovery:` and is not repeated under
  `maintenance preserved:`.

Verification that the rest of the tree has not drifted:

- Every generated and hand-written invariant still holds: 44 model definitions → 88 bodies, 23 Codex
  agents, 11 skills, no duplicate or overlapping names, every skill's template directory + root
  `SKILL.md` + front-matter `name:` + `npx cah install --only <name>` README line present, no orphan
  template directory, no stale `SkillDeps` key, `--only commands` / `--only codex-agents` /
  `--only bins` examples present, `package.json` `0.8.0` = `lib/update-check.js`'s
  `CURRENT_VERSION`, `BinFiles` 17 entries in dependency-first order with `validateBinFileOrder()`
  passing at module load.
- Mechanical hygiene is clean: zero unused import bindings across all 70 tracked JavaScript files;
  all 139 tracked text files decode as strict UTF-8 with no CRLF and no missing trailing newline;
  the only two `U+FEFF` occurrences remain the deliberate compatibility literal in
  `test/probe.test.js` and round 62's quotation of it.
- The long-standing P3 that rounds 63–67 all deferred is unchanged: `quarantineFenceDir()`'s 32-slot
  loop (`lib/lease-lock.js:473-478`) is still not deadline-gated, and `lib/lease-lock.js` is still
  **999** lines against `test/source-size.test.js`'s `maximumLines = 1000`, so that fix — and the
  P1's fix, if it adds lines there — still needs an extraction first. This is now a live constraint,
  not a theoretical one.
- `lib/probe.js`, `lib/binstall/runtime.js`, `lib/binstall-repair.js`, `lib/skills.js`,
  `lib/commands.js`, `lib/codex-agents.js`, `lib/scope.js`, `lib/sentinel.js`, `lib/templates.js`,
  `lib/transcript-stats.js`, `lib/cli.js`, the four companion bins, the manifest, the doc generator
  and the eleven skill templates were read again; beyond the items above no additional confirmed
  P0–P3 defect was identified.

**On convergence.** Round 67 concluded that the cycle "has exhausted one technique". Round 68 says
something slightly different: the *second* technique is now also close to exhausted on the layers it
was aimed at. Thousands of genuinely concurrent lease and marker operations produced no wrong
answers at all — the fence protocol, the CAS chains and the bounded scans do what they claim. The
two real defects this round are both **residue**: state a correct operation leaves behind
(`.abandoned-`), and an errno vocabulary that a correct operation cannot classify
(`ENOENT`-on-unlink). Neither is visible to an oracle that only asks "did the operation return the
right answer". If a round 69 is run, the productive next oracle is probably *conservation*: after
any sequence of concurrent operations, every path the code created must be either canonical,
reclaimed, or in a namespace some consumer enumerates — a property this round had to discover by
eyeballing a directory listing, and which nothing in the test suite currently asserts.

## Verification

- `env -u FORCE_COLOR npm test`: 625 total, 619 passed, 6 skipped, 0 failed, 81 suites (191.7 s).
- `FORCE_COLOR=1 npm test`: 625 total, 619 passed, 6 skipped, 0 failed, 81 suites (190.6 s).
  Round 58's `FORCE_COLOR` fix remains closed.
- The counts are +3 tests / +3 suites over round 67's 622/616/6/78, matching exactly what `301b124`
  added (`a recycled-pid committed fence`, `concurrent publishers racing one leaf`, and the new
  `test/fsutil-prune-orphans.test.js` suite). The skip count is unchanged at 6.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are the same six round 67 listed: one "hardlink metadata is not portable
  on this Windows runner", three "POSIX mode bits are not portable on Windows", two "nanosecond
  mtime restoration is not deterministic on Windows". Every round-58 … round-67 regression test
  really runs on this host.
- `node --check` over all 70 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- **Lease contention harness (new this round).** N separate `node` processes each looping
  `acquireLease()` → guarded write → `renewLease()` → `releaseLease()` on one lease path, with a
  mutual-exclusion probe. Production defaults, 6 × 200: 0 raw errors, 412 ms, 65/1200 acquisitions
  (the try-lock design), leftovers `['guarded.txt']`. `CAH_HARNESS_MAX_LEASE_MS=1` (every claim
  instantly expired, so every iteration exercises `takeFence`/`recoverFence`/
  `restoreWithoutOverwrite`/`disposeOwnFence`), 6 × 200 × 3 runs: 0 raw errors, 7–11
  `.abandoned-` leftovers per run. `renewLease()`-focused harness (6 workers, 40 ms lease, 30 ms
  hold, 3 renews per hold, 3 rounds): 0 raw errors.
- **Finding 1 (P1) reproductions.** (a) Planted crashed `.taken-<deadpid>-<uuid>` fence + 4 ordinary
  `acquireLease()` processes × 12 rounds, production defaults: leaks in 8–11 of 12 rounds; an
  instrumented copy of the module (temp tree only) attributes 100 % of them to
  `lib/lease-lock.js:529`. (b) The crash-free variant (expired dead-owner claim, no planted fence, 5
  acquirers × 25 rounds) leaked 0 times, which is why the finding names a crashed/expired fence as
  the trigger. (c) Real `cah-stamp`: 14 rounds × 4 concurrent Stop hooks in a sandbox
  `HOME`/`USERPROFILE` → 3 permanent `.abandoned-` directories in `cache/stamp-state/`. (d)
  Invisibility: `isQuarantineName`/`isQuarantinePath` both `false`;
  `maintainRecoveryArtifacts` → `swept: []`, `preserved: []`, `recovery: []`, `artifacts: 0`; 200
  further acquire/release cycles leave it untouched; `cah install --only bins` reports a control
  `.cah-tmp-1-control` under `recovery:` in the same directory and never mentions the leak. (e)
  Terminal state: with `scanCap = 20`, `claimMarker()` returned a claim on a clean namespace and
  `null` from the 18th planted entry onward, permanently.
- **Finding 2 (P2) reproductions.** CLI: 96 MB orphan `SKILL.md`, one real remover process,
  remover-delay sweep — 12 of 14 runs in the 1050–1180 ms window exited 1 (11 `ENOENT … unlink
  '…SKILL.md.cah-owned-remove\payload'`, 1 `managed destination leaf changed concurrently`); the
  same sweep at 400–1000 ms and 1200–1800 ms exited 0. Direct API: `pruneOrphanDirs` 21/80 rounds
  and `pruneOrphans` 4/60 rounds, every throw at
  `lib/fs-atomic-identity.js:24 ← lib/fs-atomic.js:328 ← lib/fsutil.js:307` / `:161`.
- **Finding 3 (P2) reproduction.** Round 67's own fixture with `createdAtMs` set to
  `Date.now() + 3 600 000` and `ownerPid` repointed at a live unrelated process: the acquirer
  returned `FAILED:EEXIST` after 30 966 ms, the fence was still present and the destination
  unchanged.
- **Finding 5 (P3) reproduction.** Same fixture with `createdAtMs` an hour in the past:
  `maintainRecoveryArtifacts` swept `[]` and preserved the fence on two consecutive passes.
- **Finding 6 (P3) measurement.** Four reader processes against one writer churning
  create/open/unlink and create/rmdir: `readFileSync` `{OK 20869, EPERM 1195, ENOENT 9446}`,
  `lstatSync` `{OK 16315, ENOENT 15195}`, `readdirSync` `{OK 17483, ENOENT 5063, EPERM 238}`,
  `opendirSync` `{OK 18832, ENOENT 3769, EPERM 183}`.
- **Round 67 P1 regression check.** 6 rounds × 8 concurrent publisher processes × 200
  `writeFileAtomic()` publications on one leaf (9 600 publications): 0 raw failures, no `.cah-tmp-`
  leftovers, destination intact in every round.
- **Marker/capacity contention.** 6 workers × 40–80 iterations, unique session ids,
  `maxSessions = 4`: 0 raw errors, markers ≤ 5 (= `maxSessions + 1`), only `.migration-v1` and lease
  /claim namespaces left. With `CAH_UPDATE_OWNER_MAX_LEASE_MS=1`: still 0 raw errors, but 7–10
  `.abandoned-` entries per run in `cache/update-markers/`. Chaos variant (half the workers
  `SIGKILL`ed at staggered points, then one quiescent recovery worker), 4 rounds: recovery worker
  exited 0 every time; `victimFences=0 capacityFences=0 stage=0 txDirPresent=false txSlot=false` in
  all four.
- **CLI smoke test** in a sandbox `HOME`/`USERPROFILE` outside the repository: `install` (agents 44,
  skills 11, bins 17, zero skipped/recovery), `doctor` → `mine: 72, legacy: 0, foreign: 0,
  missing: 0 (out of 72)`, exit 0; `list --json` → 139 rows (72 `mine`, 67 `missing` = the 44 opt-in
  commands + 23 opt-in Codex agents); `uninstall` exit 0.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this document;
  every temp directory and sandbox home was created and deleted outside the repository, and the real
  `~/.claude` was never written to. No version change, no push.
