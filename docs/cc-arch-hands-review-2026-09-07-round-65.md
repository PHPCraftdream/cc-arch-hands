# cc-arch-hands review — round 65

- Baseline: `728bf68` (`fix: close round 64 maintenance-sweep and cleanup gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 64's five changes — the
  `deferFresh: true` maintenance guard in `lib/fs-atomic.js`, the `cache/rate-context/` addition to
  `CACHE_SCAN_SUBDIRS`, the `maintenance.swept` reporting in `lib/cli.js`, the `STAGE_NAMES`
  regression test in `test/interlocks.test.js`, and the `probeStatusReport()` /
  `RECOVERY_MARKERS` / `lib/lease-lock.js` batch — each probed with isolated reproductions rather
  than by reading the commit message. Second, a fresh sweep of `lib/*.js`, `lib/binstall/`,
  `bin/*.js`, `templates/`, `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), a
  third serialized TAP run enumerated the skips exactly, the doc-generation gate and a full
  `node --check` were run, six isolated temp-directory reproductions were built outside the
  repository (three of which drive the real `bin/cah-stamp.js` as a child process against a
  sandbox `HOME`/`USERPROFILE` while the parent runs the real `writeBins()`), and the CLI was
  smoke-tested end to end in a sandbox home. Nothing outside this document was modified. The real
  `~/.claude` was never touched.
- P0 findings: none
- Result: 1 P2, 1 P3 batch (5 items). No P1. Round 64's headline fix is real but **half a fix**:
  it closes the pre-rename half of the live-publisher race and leaves the post-rename half open,
  and the post-rename half produces the *same* dropped-chat-stamp symptom — with a strictly worse
  outcome, because the raced turn's retry is then suppressed as well. Round 64's four other
  changes are confirmed genuinely closed.

## Findings

### P2 — round 64's `deferFresh: true` closes only the pre-rename half of the live-publisher race; the post-rename half still lets `cah install`/`cah uninstall` abort a running `cah-stamp`'s atomic write, and the raced turn now produces no chat stamp at all

`lib/fs-atomic.js:712-717` against `lib/fs-atomic-publication.js:641-652`.

Round 64 changed the recovery sweep to defer to a live publisher:

```js
          const recovered = artifact.publicationProof
            // Maintenance is not a fence acquirer: defer to any live, in-flight
            // publisher exactly as beginFence() does. A genuinely crashed
            // publisher (dead pid, stale proof) is still recovered.
            ? recoverPublicationFence(artifact.canonicalPath, { ...options, deferFresh: true })
```

That is the right flag on the right call site, and it is applied at the right layer — every
maintenance caller (`lib/binstall.js:884`, `lib/fsutil.js:94`, `lib/fsutil.js:237`,
`lib/skills.js:168`/`:668`/`:772`) reaches `recoverPublicationFence()` only through
`sweepRecoveryArtifacts()`, so all of them inherit it. But the guard it enables sits **after** the
`committed` branch, not before it:

```js
  if (publication) {
    const committed = destinationIsPublished(publication, destPath);          // :642
    assertOwnership(options);
    if (committed) {
      if (lstatMaybe(publication.tempPath) !== null) return false;            // :645
      if (!cleanupDiscardableProofEntries(publication)) return false;
      if (cleanupPublicationFence(publication)) return true;                  // :647
      throw recoveryRequired(fencePath);
    }
    if (options.deferFresh                                                    // :650-652
        && !verifiedLifecycleSuccessor(proof, options)
        && (proofOwnerIsAlive(proof) || !fenceIsStale(fencePath, proof))) return false;
```

A publication therefore has two exposure windows, not one:

| window | span | guarded by round 64? |
|---|---|---|
| A | proof renamed into the fence → canonical `renameSync` (`lib/fs-atomic-publication.js:731` → `:777`) | **yes** (`deferFresh`, `:650-652`) |
| B | canonical `renameSync` → `finishPublication()`'s `cleanupPublicationFence()` (`:777` → `:815` → `:554`) | **no** (`committed` branch, `:644-649`) |

Window B is not narrower than window A. It spans `syncParentDirectory(destPath)` (`:783`), two
interlock calls, `assertOwnership()`, `lstatMaybe(tempPath)`, a full read plus SHA-256 of the
canonical leaf inside `destinationIsPublished()` (`:543`), then `readdirSync` + identity checks +
unlink + `syncDirectory` + `rmdir` + `syncParentDirectory` inside `cleanupPublicationFence()` —
strictly more filesystem work than window A's tail.

When maintenance wins window B it reaps the live publisher's fence; the publisher's
`finishPublication()` then finds `directoryIdentity(fencePath) === null`,
`cleanupPublicationFence()` returns `false`, and `writeFileAtomic()` throws
`ERR_ATOMIC_RECOVERY_REQUIRED` — *even though its data reached the canonical destination*.

Reproduction 1, primitive level, isolated temp directory, real product code, a child paused at each
of the library's own crash boundaries inside `cache/stamp-state/` while the parent runs
`maintainRecoveryArtifacts()`:

| paused at | `maintenance.swept` | child |
|---|---|---|
| `write-after-proof-before-final-operation` (window A) | `[]` | exit 0, `PUBLISHED`, dest = `child-payload\n` |
| `write-after-rename-before-sync` (window B) | `["…json.cah-owned-publish"]` | exit 3, `FAILED:ERR_ATOMIC_RECOVERY_REQUIRED`, dest = `child-payload\n` |

Reproduction 2, end to end through the real bin — `bin/cah-stamp.js` spawned as a child with a
sandbox `HOME`/`USERPROFILE`, paused at each boundary, while the parent runs `writeBins()` (which
is exactly what `cah install --only bins` does):

```
control (no concurrent install)
  stamp stdout : {"continue":true,"systemMessage":"01:39:58 · Opus 5 · 0.1% (1k/1M)"}

window A raced by writeBins   -> wrote 17 | swept []
  stamp stdout : {"continue":true,"systemMessage":"01:39:58 · Opus 5 · 0.1% (1k/1M)"}   (round 64's fix holds)

window B raced by writeBins   -> wrote 17 | swept ["cache/stamp-state/last-stamp.json.session-….json.cah-owned-publish"]
  stamp stdout : (EMPTY — stamp dropped)
```

The chain is identical to round 64's P2: `writeFileAtomic()` throws → `writeLastStamp()`'s
`catch { return false; }` (`bin/cah-stamp.js:252`) → `main()` returns at `bin/cah-stamp.js:380`
without writing the `systemMessage`.

**The outcome is worse than round 64's window A, not equal to it.** In window A the sidecar write
never landed, so the next `Stop` for the same turn re-stamps. In window B the sidecar write *did*
land, carrying `deliveryState: "pending"` and this turn's `lastStampedRequestId`, so the retry is
suppressed by `requestSuppressed` (`bin/cah-stamp.js:356-357`, via `pendingFresh` at `:351`) for
the whole `STAMP_PENDING_TTL_MS` window (30 s). Reproduction 3, same harness plus an immediate
second invocation of the same turn:

```
installSwept : ["cache/stamp-state/last-stamp.json.session-….json.cah-owned-publish"]
first  exit 0, stdout ""      <- raced
retry  exit 0, stdout ""      <- suppressed by the pending record the raced write left behind
sidecar      : {"version":3,…,"deliveryState":"pending"}
```

The turn produces **zero** chat stamps. There is still no data loss (the canonical sidecar holds
the publisher's own bytes) and the next turn recovers, so this stays P2 rather than P1 — but it is
the finding round 64 believed it had closed.

Blast radius across the four scanned namespaces:

- `cache/stamp-state/` — the case above: a dropped chat stamp, plus a suppressed retry.
- `cache/update-markers/`, `cache/hint-markers/` — `publishMarker()` returns `false`
  (`lib/marker-state.js:766`) → `abortMarkerTransaction()`. The notice was already written to
  stdout, so the visible effect is a possible duplicate update/checkpoint notice later, not a loss.
- `cache/rate-context/` (added by round 64) — `writeJsonAtomic()` swallows the throw
  (`lib/transcript-stats.js:391-399`), so the statusLine still renders and the sidecar is refreshed
  on the next render. Benign.

Fix direction: make the maintenance sweep defer in the committed branch as well when it is not a
fence acquirer — i.e. a caller that only maintains should leave a fence whose proof names a live
pid and whose `createdAtMs` is fresh, exactly as it now does for the uncommitted case. Note the
trap: `beginFence()` also passes `deferFresh: true` (`lib/fs-atomic-publication.js:689`), and it
*must* keep finishing a committed predecessor's fence — including one whose `ownerPid` is this
process — or a same-process second publication to the same leaf could spin its 100 acquire
attempts against a fence nobody will clean. The deferral therefore needs its own option (a
`maintenanceOnly` / `deferCommitted` flag set only by `sweepRecoveryArtifacts()`), not a widening
of `deferFresh`. A regression test at the `write-after-rename-before-sync` boundary belongs beside
round 64's two `write-after-proof-before-final-operation` tests in `test/binstall.test.js:256`
and `:275`.

### P3 — one weaker-than-advertised regression test, one unguarded sweep branch, one unused import, and two carried-over items

None of these change behaviour today.

- `test/interlocks.test.js:85-89` (whole test `:81-112`) — round 64's `STAGE_NAMES` regression test
  is real and it does catch the common drift, but its stated guarantee is false in both directions.
  The comment claims:

  ```js
    // Every current call site is single-line, so a bounded same-line argument
    // scan is exact today; if a call site ever spans lines this test fails on
    // the resulting set mismatch and the scan must be extended with it.
  ```

  Three `testInterlock` call sites at HEAD already span lines and are already invisible to the
  scan (`callSiteRe = /testInterlock(?:\s*\?.\s*)?\(([^)\n]*)\)/g` cannot match across `\n`):
  `lib/marker-capacity-ops.js:293-294`, `lib/marker-capacity-stage.js:65-66`,
  `lib/marker-capacity-stage.js:119-120`. Re-running the test's own scan over `lib/` + `bin/`
  yields 17 matched call sites and 4 stage names:

  ```
  before        => lease-lock.js:557,607,825,843,912,943 · marker-capacity-ops.js:274,382,440,457,634 · marker-state.js:353,674
  vacancy       => lease-lock.js:563
  claim-removal => lease-lock.js:636, lease-lock.js:922
  after         => marker-capacity-ops.js:468
  ```

  — the three multi-line sites are absent. The test passes only because all three happen to pass
  `'before'`, which single-line sites also use. A future multi-line call site introducing a *new*
  stage is therefore exactly the drift the test was written to prevent, and it would pass silently.
  A first-argument containing `)` (e.g. `testInterlock(phase(), 'stage')`) has the same blind spot.
  Matching multi-line call sites (or asserting the scan's own hit count) would close it.
- `lib/fs-atomic.js:726-741` — the `deferFresh` question applies to the `quarantine` sweep branch
  too, and there it has no answer at all: that branch has no liveness guard of any kind, only
  `directoryIsEmpty()` + `sameStatIdentity()`. `removeOwnedRegularFile()` reserves its namespace
  with a bare `mkdirSync()` (`lib/fs-atomic.js:501`) and leaves it *empty* twice — between the
  reservation and the payload rename (`:318` → `:336`), and between the payload unlink and the
  reservation release (`:384` → `:399`). Reproduced against a child paused inside
  `removeOwnedRegularFile()` in `cache/rate-context/` while the parent ran
  `maintainRecoveryArtifacts()`:

  | paused at | sweep | remover result | canonical leaf |
  |---|---|---|---|
  | `remove-before-rename` | `swept ["deadbeef.json.cah-owned-remove"]` | `{removed:false, reason:"reservation-changed"}` | survives |
  | `remove-before-unlink` | `swept []` (payload present → `displacedData`) | `true` | removed |
  | `remove-after-unlink` | `swept ["deadbeef.json.cah-owned-remove"]` | `{removed:false, reason:"reservation-changed"}` | removed |

  Non-destructive in every shape — no data loss, and the only live producer inside a swept
  namespace (`pruneRateContextSidecars()` → `removeOwnedRegularFile()`,
  `lib/transcript-stats.js:517`/`:534`) discards the result — but the sweep still destroys a live
  operation's private reservation, makes a *successful* removal report `removed: false`, and prints
  `maintenance swept: cache/rate-context/…` (`lib/cli.js:275-277`) for a namespace that was
  in-flight rather than crash state. That report line was added by round 64 precisely so a
  destructive maintenance action would be visible; here it is visible and wrong.
- `test-support/stamp-state.cases.js:3` — `spawn` is imported and never used (the only occurrence
  of the word elsewhere in the file is inside the comment at `:158`, "process spawn make the
  predecessor's lease look not-yet-stale"). Introduced by `588baad` (round 60). This is the only
  unused binding in the repository: a comment-stripping sweep of import clauses (including
  multi-line and `as` forms) and non-exported top-level `const`/`let`/`function`/`class`
  declarations across all 69 tracked JavaScript files reports exactly this one. Round 64's
  equivalent sweep reported `test/lease-lock.test.js:5`'s `chmodSync` (now genuinely used again by
  the POSIX branch of the rewritten budget test) and missed this one, most likely because its scan
  counted the `:158` comment as a usage.
- `lib/lease-lock.js` is **999** lines against `test/source-size.test.js:9`'s `maximumLines = 1000`.
  Round 64's fix bought exactly one line of headroom back. The P2 above does not touch this file,
  but the acquire/release symmetry items round 64 deliberately deferred still cannot be fixed here
  without extracting something first.
- `lib/lease-lock.js:467-484` — round 63's and round 64's P3 about `quarantineFenceDir()`'s bounded
  slot loop is still open, and one half of round 64's characterisation of it needs correcting.
  The loop is still not deadline-gated (only the `withTransientRetry()` calls *inside* each
  `moveFenceContents()` are, `:431-435`), so it always runs to completion regardless of remaining
  budget. But it is **not** unreachable: `moveFenceContents()` only rmdirs an *empty* reservation
  on failure (`:443-447`), so a partially-completed move leaves
  `join(quarantineRoot, basename(fencePath))` populated and control falls straight into the slot
  loop in the same call — where the remaining source entries can land in a *different* quarantine
  directory from the entries already moved. Both halves stay preserved and reportable, so this is
  cosmetic rather than a data hazard, but "the primary destination is never occupied" is only true
  on the happy path.

## Disposition

Close the P2 first: it is the only finding with a user-visible outcome, it is the direct
continuation of the defect round 64 set out to fix, and the fix is one option plus one regression
test at the `write-after-rename-before-sync` boundary. Take the `deferCommitted`-style separate
flag rather than widening `deferFresh`, for the `beginFence()` reason given above. The P3 batch can
follow in any order; the `test/interlocks.test.js` item is the one with real future leverage, since
it is the guard against re-introducing round 62's regression class.

Round 64's changes were checked individually and, apart from the item above, hold:

- **The `deferFresh` fix is correct as far as it goes, and it is at the right layer.** Window A is
  genuinely closed end to end through the real `cah-stamp` bin (table above), and a genuinely
  crashed publisher is still recovered — round 64's own crash test
  (`test/binstall.test.js:275`) passes and the sweep still reports the fence. Every maintenance
  call site in the repository reaches `recoverPublicationFence()` only through
  `sweepRecoveryArtifacts()`, so no other maintenance/sweep site is missing the guard. The two
  direct `recoverPublicationFence()` calls outside that path
  (`lib/marker-capacity-recovery.js:193` and `:585`) deliberately omit `deferFresh`: both run
  under the capacity lease that is the sole publisher of `capacityStatePath()`, i.e. they *are*
  the acquirer, which is the case the flag is not for.
- **`verifiedLifecycleSuccessor()` does not accidentally defeat the new guard.** With the sweep
  passing the bin-lifecycle lease (`~/.claude/cah-bin.lock`) and a stamp proof carrying the
  per-sidecar `…json.lock`, the lease-path lookup at `lib/fs-atomic-publication.js:224` fails and
  the function returns `false`, so the deferral applies. A proof with no lease at all
  (`lib/transcript-stats.js`, `lib/update-check.js`) returns `false` at `:219`. A maintenance
  caller with no lease (`writeSkills`/`removeSkills`, which pass `options.recovery ?? {}`) also
  returns `false`. Verified by reading all four shapes, and consistent with reproduction 1.
- **`cache/rate-context/` is a genuine producer and is now reported.** Verified in a sandbox home:
  with a `.cah-tmp-` leftover planted in `cache/stamp-state/` and `cache/rate-context/` and an
  empty `cache/crashed.cah-owned-remove/`, `cah install --only bins` reports

  ```
    bins: wrote 17, skipped 0 (foreign or canonical survivor), recovery 2 (quarantine)
      recovery: cache/stamp-state/.cah-tmp-1-bbbb
      recovery: cache/rate-context/.cah-tmp-1-aaaa
      maintenance: visits 75, recovery 0, temps 2, swept 1
      maintenance swept: cache/crashed.cah-owned-remove
  ```

  Round 64's P3 about the invisible `rate-context` namespace is closed, and `maintenance.swept` is
  no longer silent. The `swept` list is bounded (`RECOVERY_SWEEP_LIMIT = 32` per scanned root) so
  the new report lines cannot flood the install output.
- **`probeStatusReport()`'s parity fix is complete.** `start`, `stop` and `status` now all end
  their `catch` with a scoped `cah probe <action>: <message>` and exit 1; nothing else in
  `probeStatus()` can throw a class the three-way contract does not cover
  (`ProbeAlreadyActiveError`/`ProbeNotActiveError`/`MissingBackupError`/`MalformedBackupError` are
  raised only by `enableProbe`/`disableProbe`). The `settings.json`-is-a-directory case was
  re-checked in a sandbox home; the round-64 test at `test/cli.test.js:1120` covers it.
- **The `RECOVERY_MARKERS` addition is correct and has no regression tail.** `isQuarantineName()`
  and `describeRecoveryArtifact()` now agree on `.cah-lease-quarantine`. The predicate is
  substring-based, so the change can only make *more* names classified as recovery state, i.e.
  strictly fewer entries pruned or reported foreign; the `pruneOrphanDirs()` path where that
  matters (`lib/fsutil.js:259`, `:287`) still refuses to remove a non-empty directory
  (`removeEmptyDirectory()` returns `false` on `ENOTEMPTY`), so no user data becomes reachable by
  deletion. A `kind: 'lease-quarantine'` artifact matches none of the three sweep branches and
  falls through to `preserved`/`recovery`, which is the intended read-only handling.
- **The `lib/lease-lock.js` batch is behaviour-preserving.** The new
  `testInterlock(config.interlockPhase, 'claim-removal', config)` at `:636` mirrors
  `releaseLease()`'s at `:922`; acquire and release use distinct phase names in every production
  caller (`binstall-lease-reclaim`/`binstall-lease-release`, `lock-reclaim`/`lock-release`,
  `probe-lease-reclaim`/`probe-lease-release`, `claim-reclaim`/`claim-release`), so the new
  rendezvous point cannot fire inside a release test. The `testInterlock()` helper's
  early-return collapse at `:393-395` is a pure simplification. The corrected
  `disposeOwnFence()` comment at `:873-876` now describes both callers accurately.
- The rewritten release-budget test really does run on this host (it is not among the 6 skips), and
  round 64 restored POSIX coverage for it via the worker-thread `chmodSync` restore, closing its
  own "Windows only" P3.

Beyond these items, the concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`,
`lib/marker-capacity-*.js`, `lib/marker-state.js`), the installers, the repair path, the runtime
description, the CLI, the probe, the four companion bins, the shared transcript library, the
manifest, the doc generator and the skill templates were read again and no additional confirmed
P0-P3 defect was identified. One candidate was investigated and dropped: `npm test` is bare
`node --test` with no path scoping, so a git worktree created under the repository's (empty,
untracked) `worktrees/` directory would have its whole suite discovered and run as well — verified
against Node v24 in an isolated fixture — but `test/discovery-contract.test.js:83-87` already turns
exactly that situation into a loud failure by comparing an independent recursive scan against
`test/*.test.js`. That is not a claim that every filesystem race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 613 total, 607 passed, 6 skipped, 0 failed (193.6 s).
- `FORCE_COLOR=1 npm test`: 613 total, 607 passed, 6 skipped, 0 failed (188.4 s). Round 58's
  `FORCE_COLOR` fix remains closed.
- The counts are +8 tests / +8 passes over round 64's 605/599, matching exactly the eight tests
  `728bf68` added (three in `test/binstall.test.js`, three in `test/cli.test.js`, one in
  `test/fs-atomic.test.js`, one in `test/interlocks.test.js`); the skip count is unchanged at 6.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are all legitimate platform guards: `test/binstall.test.js`
  ("hardlink metadata is not portable on this Windows runner"), three "POSIX mode bits are not
  portable on Windows" guards in `test-support/installer-atomic.cases.js`, and two "nanosecond
  mtime restoration is not deterministic on Windows" guards in `test/probe.test.js`. Round 63's
  `platform does not make unlinkSync of a directory fail transiently` guard is gone (round 64
  replaced it with a cross-platform test) and the `platform does not block rename of a directory
  held as a child process CWD` guards do not fire on this host, so every round-58 … round-64
  regression test really runs.
- `node --check` over all 69 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names and no overlap between the
  two registries; every skill in `AllSkills` has a matching `templates/skills/<name>/SKILL.md`
  whose `name:` equals its directory name, and an `npx cah install --only <name>` line in
  README.md; no template directory is missing from `AllSkills`; every `SkillDeps` key is a real
  skill; README.md carries `--only commands`, `--only codex-agents` and `--only bins` examples;
  `package.json` version `0.8.0` equals `lib/update-check.js`'s `CURRENT_VERSION`.
- `BinFiles` re-checked against CLAUDE.md's documented list: 17 destinations, `package.json` first,
  the twelve `lib/` leaves in dependency-first order, the four `bin/` executables last;
  `validateBinFileOrder()` runs at module load and passes.
- P2 reproduction #1 (primitive level): a child pauses the real `writeFileAtomic()` at
  `write-after-proof-before-final-operation` and at `write-after-rename-before-sync` while writing
  into `cache/stamp-state/`; the parent then runs `maintainRecoveryArtifacts()` on that namespace.
  Window A: `swept=[]`, child exits 0 with `PUBLISHED`. Window B:
  `swept=["…json.cah-owned-publish"]`, child exits 3 with
  `FAILED:ERR_ATOMIC_RECOVERY_REQUIRED:atomic publication cleanup requires recovery: …`, and the
  destination nevertheless holds the publisher's bytes.
- P2 reproduction #2 (end to end): `bin/cah-stamp.js` run through `test-support/run-companion.js`
  in a child with a sandbox `HOME`/`USERPROFILE`, `CAH_STAMP_THROTTLE_PATH`,
  `CAH_UPDATE_CHECK_CACHE`, `CAH_RATE_LIMITS_CACHE` and a one-line transcript, paused at each
  boundary while the parent runs `writeBins(binDir, repoRoot)`. Control and window A emit the
  `systemMessage`; window B emits nothing and the install reports the swept fence.
- P2 reproduction #3 (retry suppression): the window-B run followed immediately by a second,
  unraced `cah-stamp` invocation for the same session and transcript. Both emit nothing; the
  sidecar is left at `deliveryState: "pending"` with the turn's hashed `lastStampedRequestId`.
- P3 quarantine-branch reproduction: a child paused inside the real `removeOwnedRegularFile()` at
  `remove-before-rename`, `remove-before-unlink` and `remove-after-unlink` in
  `cache/rate-context/`, raced by `maintainRecoveryArtifacts()`. Results in the P3 table; the
  canonical leaf is intact in every shape.
- Interlock stage-set check: the test's own scan re-implemented and run over `lib/` + `bin/` with
  file:line attribution — 17 matched call sites, 4 stage names, and the three multi-line sites
  (`lib/marker-capacity-ops.js:293`, `lib/marker-capacity-stage.js:65`, `:119`) absent from the
  results, confirming the blind spot.
- Unused-binding sweep over all 69 tracked JavaScript files (comment-stripped; import clauses
  including multi-line and `as` forms, plus non-exported top-level `const`/`let`/`function`/`class`
  declarations): exactly one, `test-support/stamp-state.cases.js:3`'s `spawn`.
- Encoding sweep over every tracked `.js/.mjs/.cjs/.md/.json/.sh/.bat/.toml/.yml/.yaml` file
  (135 files): all decode as strict UTF-8. The only `U+FEFF` occurrences are the deliberate
  compatibility literal in `test/probe.test.js` and this review series' own quotation of it
  (round 62).
- Node test-discovery behaviour verified in an isolated fixture outside the repository: bare
  `node --test` does run `worktrees/<name>/test/*.test.js`. `test/discovery-contract.test.js`
  already fails loudly on that shape, so no finding was raised.
- CLI smoke test in a sandbox `HOME`/`USERPROFILE` outside the repository: `install` (agents 44,
  skills 11, bins 17, zero skipped/recovery), `doctor` → `mine: 72, legacy: 0, foreign: 0,
  missing: 0`, exit 0; then, with crash leftovers planted in `cache/`, `cache/stamp-state/` and
  `cache/rate-context/`, `install --only bins` reporting both `.cah-tmp-` temps and the
  `maintenance swept:` line; then `probe statusline start` → `status` (ACTIVE) → `stop` (disarmed,
  statusLine key removed) and a final `doctor` at exit 0.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; every temp directory and sandbox home was created and deleted outside the repository,
  and the real `~/.claude` was never written to. No version change, no push.
