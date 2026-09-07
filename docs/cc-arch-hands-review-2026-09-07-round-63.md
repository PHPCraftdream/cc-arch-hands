# cc-arch-hands review — round 63

- Baseline: `3f890d9` (`fix: close round 62 fence-disposal and probe-parity gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 62's `disposeOwnFence()` /
  `quarantineFenceDir()` rewrite, its two-separate-budgets design, and the
  `probeStatus()`/`readSettingsSnapshot()` parity fix — each probed with isolated
  reproductions rather than by reading the commit message. Second, a fresh sweep of
  `lib/*.js`, `lib/binstall/`, `bin/*.js`, `templates/`, `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), a
  third serialized TAP run enumerated the skips exactly, the doc-generation gate and a full
  `node --check` were run, eight isolated temp-directory reproductions plus one throwaway `lib/`
  copy were built outside the repository, and the CLI was smoke-tested end to end in a sandbox
  home. Nothing outside this document was modified.
- P0 findings: none
- Result: 1 P1, 2 P2, 1 P3 batch (10 items). Round 62's `disposeOwnFence()` is confirmed genuinely
  fixed on the `releaseLease()` side — the two cases it claims to cover were reproduced and both
  now converge. The P1 is the branch round 62 did not look at: `acquireLease()`'s reclaim path has
  the identical `removeClaimPath()` rejection and *no* disposal fallback at all.

## Findings

### P1 — `acquireLease()`'s reclaim path strands its own fence on the exact rejection `releaseLease()` now handles, dropping the invocation's work; a single stray file in a stale claim directory is enough

`lib/lease-lock.js:632`, against `lib/lease-lock.js:913-920` and `lib/lease-lock.js:867-880`.

Round 62 added the terminal disposal to `releaseLease()` only:

```js
  for (let attempt = 0; attempt < RELEASE_CLAIM_REMOVAL_ATTEMPTS; attempt += 1) {
    testInterlock(releaseOptions.interlockPhase, 'claim-removal', releaseOptions);
    if (removeClaimPath(fence.path, options.ownerFile, removalDeadline)) return true;
  }
  return disposeOwnFence(fence.path, options.ownerFile, removalDeadline);   // :913-920
```

The reclaim half of `acquireLease()` performs the *same* fence-then-remove sequence and has no
fallback whatsoever:

```js
      const fence = takeFence(path, expected, config);                       // :626
      if (!fence.path) return null;
      if (hasInFlightFence(path, config, fence.path)) {
        restoreWithoutOverwrite(fence.path, path, ownerFile, config.recoveryDeadline);
        return null;
      }
      if (!removeClaimPath(fence.path, ownerFile, config.recoveryDeadline)) return null;   // :632
```

`removeClaimPath()`'s first rejection is the stray-entry guard:

```js
      if (entries.some((entry) => entry !== ownerFile)) return false;        // :302
```

A reclaimed claim directory is, by construction, *foreign* state — it was written by another
process (or another release of this package), which is exactly why the guard exists. When it
fires, `acquireLease()` returns `null` **after** `takeFence()` has already renamed the claim
directory away, so:

1. the canonical claim path no longer exists,
2. a `<claim>.taken-<our-pid>-<uuid>` fence holding the foreign body is left beside it, and
3. because `recoverFence()` refuses to touch a fence whose operator pid is alive and whose mtime
   is younger than `maxLeaseMs` (`lib/lease-lock.js:491`), **every further `acquireLease()` on that
   path in this process returns `null` for the rest of the process lifetime**.

Nothing quarantines the foreign body the way `disposeOwnFence()` → `quarantineFenceDir()` would
(`:875-879`); it simply sits in an unnamed, unreported `.taken-` entry.

Reproduction 1, lease level, isolated temp directory importing the unmodified repository library.
A claim directory owned by a dead pid, plus one extra file inside it:

```
A: reclaimed claim holds a stray entry
   firstAcquire=null  strandedFencesAfterFirst=1  secondAcquire=BLOCKED (null)
   thirdAcquire=BLOCKED (null)  claimPathPresent=false  quarantine=null
   homeAfter=["claim.taken-41564-b5f74dcc-6c8c-46a6-a2d4-9f512ea1ae90"]
B: reclaimed claim is clean (control)
   firstAcquire=acquired  strandedFencesAfterFirst=0  claimPathPresent=true
```

Reproduction 2, end to end through the real `bin/cah-stamp.js` (spawned as a child with a sandbox
`HOME`/`USERPROFILE`), sabotaging only the per-session stamp lock
`stamp-state/last-stamp.json.session-<hash>.json.lock` with a dead-pid `owner.json` plus one
`stray` file:

```
control: stale lock, no stray entry   stdout={"continue":true,"systemMessage":"21:01:34 · Opus 5 · 0.1% (1k/1M)"}
                                      strandedFences=[]  lockDirPresent=false
stale lock + stray entry              stdout=(empty — stamp dropped)   exit=0
                                      strandedFences=["…json.lock.taken-10344-f5a222c0-…"]
                                      lockDirPresent=false  quarantine=null
```

`acquireStampLock()` (`bin/cah-stamp.js:256`) returns `null`, `main()` returns at
`bin/cah-stamp.js:341`, and the chat stamp for that turn is lost — round 58's P1 symptom verbatim,
on the one branch of this defect class rounds 58-62 never examined.

Blast radius is bounded and it converges, because the *next* process sees a dead operator pid and
`recoverFence()` → `quarantineUnexpectedFence()` disposes of the fence. Three consecutive real
`cah-stamp` invocations against the same sabotaged state:

```
invocation 1  stdout=(empty — stamp dropped)  strandedFences=1  quarantine=null
invocation 2  stdout={"continue":true,"systemMessage":"21:02:25 · Opus 5 · 0.1% (1k/1M)"}
              strandedFences=0  quarantine=["…json.lock.taken-26956-9d6435a7-…"]
invocation 3  stdout=(empty)  — the 10 s STAMP_MIN_INTERVAL_MS throttle, not this defect
```

This is rated P1 rather than P2 (the severity rounds 59-62 gave their variants) because the
trigger requires **no timing race at all**: one ordinary file inside a stale claim directory is
sufficient, deterministically, on every platform. Round 60's and round 61's own regression tests
(`test/lease-lock.test.js:112`, `:147`) inject exactly such a `stray` file to prove the release
path handles it; the acquire path is untested for it and does not.

Fix direction: `:632` should end the same way `:920` does. The fence at that point is provably
this process's own creation (`takeFence()` named it with `process.pid` and `sameOwnerSnapshot()`
validated the displaced claim at `:560`), and the reclaim has already decided the displaced claim
is expired, so `quarantineFenceDir(fence.path, config.recoveryDeadline)` is the correct terminal
step — it preserves the foreign body in the reportable `.cah-lease-quarantine` namespace instead
of stranding it under a `.taken-` name that also blocks the current process. `restoreWithoutOverwrite`
is *not* the right fallback here: it would put the expired claim back and re-block the path.

### P2 — round 62 tripled `takeFence()`'s release-time budget as well, so worst-case `releaseLease()` is now ~1.5 s (measured), and its own P3 "`RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3` is observationally 1" is not closed

`lib/lease-lock.js:26-28`, `:898`, `:912-915`.

The commit message describes the change as restoring what round 61 shrank. What round 61 shrank
was the *removal loop*. `takeFence()`'s budget was `Date.now() + LEASE_RECOVERY_WAIT_MS` (250 ms)
in rounds 59, 60 **and** 61 (`git show a5d7afd 588baad ade9a60 -- lib/lease-lock.js`). Round 62
changed it to

```js
    recoveryDeadline: Date.now() + RELEASE_CLAIM_REMOVAL_ATTEMPTS * LEASE_RECOVERY_WAIT_MS,  // :898
```

i.e. 750 ms, using a constant whose own comment two hundred lines earlier describes something else
entirely:

```js
// Bounded attempts for removing the fence after takeFence succeeded. The
// removal loop races one total budget of attempts × LEASE_RECOVERY_WAIT_MS.   // :26-27
const RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3;
```

An attempt *count* is now also a wall-clock *multiplier* for a phase that runs before the first
removal attempt. Measured worst-case per release, isolated temp directories:

| phase | scenario | measured |
|---|---|---|
| `takeFence` alone | claim pinned by a live child's CWD for the whole budget | `released=false`, 878 ms |
| removal loop alone | `owner.json` replaced by a directory at the first `claim-removal` interlock | `released=true`, 764 ms, `claim-removal calls=3` |
| both | child holds a descendant handle for 700 ms, then the same `owner.json` sabotage | `released=true`, **1502 ms** |

Against a throwaway `lib/` copy outside the repository whose only difference is `:898` restored to
`Date.now() + LEASE_RECOVERY_WAIT_MS`, the same combined scenario gives `released=false`,
`totalMs=252`, `claim-removal calls=0` — so the extra 500 ms is genuinely load-bearing for
recovering a 700 ms obstruction. This is a defensible robustness/latency trade, exactly like the
one round 61 made in the opposite direction; the problem is that it was made silently, under a
constant that documents the opposite, and it stacks:

- worst-case `releaseLease()`: 250 ms (round 61) → 1000 ms (round 60, theoretical) → **1502 ms**
  (round 62, measured);
- `releaseMarkerClaim()` (`lib/marker-state.js:120-132`) releases up to three leases per claim;
- `bin/cah-stamp.js` runs on **every** `Stop` *and* `PostToolUse` and performs one release per
  stale sidecar (`pruneStampSidecarsScan`, up to `MAX_STAMP_SESSIONS * 2 + 8` = 136 entries), plus
  the migration, marker-prune and claim paths. Round 62 also deleted `releaseClaimLease()`'s
  wall-clock cap (`lib/marker-state.js`, old `:456-465`) when it removed the wrapper, so there is
  no longer any outer bound on a migration's release stall.

Second half of the finding: round 62's own P3 — "`RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3` is
observationally equal to `1`" — is **not** closed by giving the loop its own budget. Attempt 1
still consumes the entire `removalDeadline` on a transient rejection, and every non-transient
rejection returns without reading the deadline and without changing state, so attempts 2 and 3 are
no-ops unless a third party clears the obstruction in the microseconds between two calls.
Measured directly in the removal-loop row above: `claim-removal calls=3` with a total of 764 ms,
i.e. 750 ms inside attempt 1 and ~0 ms in attempts 2 and 3. Round 62's new regression test
(`test/lease-lock.test.js:220-262`) does not contradict this — it clears the obstruction from
inside the `claim-removal` interlock before attempt 2, which is precisely the third-party case —
and it hard-codes the window with `assert.ok(elapsed >= 700, …)` at `:262`, adding ~750 ms of
deliberate sleep to every suite run.

Fix direction: pick one explicit total budget for `releaseLease()` and name it (e.g. a
`RELEASE_TOTAL_WAIT_MS`), split it between the fence rename and the removal, and either drop the
loop to a single attempt or give each attempt a real share of the remaining time. Whatever is
chosen, `RELEASE_CLAIM_REMOVAL_ATTEMPTS` should stop being a time multiplier for a phase its
comment does not describe.

### P2 — `test-support/interlocks.js` now silently drops the first alias of every alias-bearing interlock call, so thirteen production rendezvous aliases are unreachable from `CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE`

`test-support/interlocks.js:25-27`.

Round 62 rewrote the argument parser to close round 61's P3 (non-`before`/`vacancy` stages
collapsing onto the `.before` rendezvous suffix):

```js
    const stage = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'before';   // :25
    const aliases = args.slice(2);                                                       // :26
    const candidates = [phase, ...aliases];                                              // :27
```

That fixes the staged-suffix collapse, but the interlock protocol has **two** shapes:
`(phase, stage, ...aliases)` and `(phase, ...aliases)` with no stage at all. The new parser cannot
tell them apart, so for the second shape `args[1]` is consumed as a bogus stage and disappears from
`candidates`. Thirteen production call sites use that shape:

| call site | alias lost |
|---|---|
| `lib/fs-atomic.js:110` | `write-after-transaction-temp-create` |
| `lib/fs-atomic.js:144` | `write-post-rename` |
| `lib/fs-atomic.js:294` | `write-after-temp-partial-write` (middle of three) |
| `lib/fs-atomic-publication.js:782` | `write-post-rename-before-sync` |
| `lib/fs-atomic-publication.js:813` | `write-after-final-operation` |
| `lib/probe.js:400`, `:403`, `:412` | `enable-after-backup-check`, `enable-before-settings-rename`, `enable-after-settings-rename` |
| `lib/probe.js:465`, `:468`, `:478` | `disable-after-backup-check`, `disable-before-settings-rename`, `disable-after-settings-rename` |
| `lib/binstall/runtime.js:245`, `:251` | the per-file `file.dest` alias |

Reproduction, isolated temp directory, driving `makeInterlock()` directly with
`CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE` set to each candidate (`rendezvous` = the `.ready` file the
interlock creates when it matches):

```
fs-atomic.js:110 phase (control)      alias=write-after-temp-create               rendezvous=true  timedOut=true
fs-atomic.js:110 alias                alias=write-after-transaction-temp-create   rendezvous=false timedOut=false
fs-atomic.js:144 alias                alias=write-post-rename                     rendezvous=false timedOut=false
fs-atomic-publication.js:813 alias    alias=write-after-final-operation           rendezvous=false timedOut=false
probe.js:400 middle alias             alias=enable-after-backup-check             rendezvous=false timedOut=false
probe.js:400 last alias               alias=post-backup-check                     rendezvous=true  timedOut=true
binstall/runtime.js:245 file.dest     alias=lib/lease-lock.js                     rendezvous=false timedOut=false
```

The same three rows against `git show be00bf2:test-support/interlocks.js` (the pre-round-62 parser)
all report `rendezvous=true`, so this is a regression, not a pre-existing limitation.

The suite is green because every value currently passed through
`CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE` is an `args[0]` phase name, and the only alias a test uses
(`post-settings-rename`, 7 occurrences) happens to sit at `args[2]`. The failure mode is silent:
`wait()` returns immediately when the configured phase is not in `candidates`
(`test-support/interlocks.js:9-10`), so a future test targeting one of these aliases would not
error — it would simply fail to synchronize, producing exactly the class of nondeterministic flake
this review cycle exists to catch.

Fix direction: keep `args[1]` as the stage only when it is a declared stage name, and put it into
`candidates` otherwise — e.g. `const isStage = args[1] === 'before' || args[1] === 'vacancy' ||
args[1] === 'claim-removal' || args[1] === 'after';` with `aliases = isStage ? args.slice(2) :
args.slice(1)`. That closes round 61's P3 (`claim-removal` gets its own suffix) without dropping
the alias shape.

### P3 — quarantine reporting reaches only one producer, dead disposal branches, and a doc/UX gap

None of these change behaviour today.

- `lib/fs-atomic.js:789-801` — round 62's new `lease-quarantine` artifact kind is only ever reached
  for the directory `mergeCacheMaintenance()` actually scans, `~/.claude/cah-bin/cache/`
  (`lib/binstall.js:842`), and `maintainRecoveryArtifacts()` inspects direct entries only. Exactly
  one lease path quarantines into that directory: `cache/update-check.json.lock`. Every other
  producer quarantines one level deeper or somewhere else entirely, where nothing enumerates it —
  `cache/stamp-state/…json.lock` and `…sidecar.lock` (the highest-volume producers by far: one per
  `Stop` *and* per `PostToolUse`), `cache/update-markers/` and `cache/hint-markers/`
  (`.cah-marker-claim-…`, `.cah-marker-capacity-…`), `~/.claude/cah-bin.lock`, and
  `~/.claude/settings.json.probe-lock`. Nothing sweeps the tree in any case:
  `sweepRecoveryArtifacts()` (`lib/fs-atomic.js:684-738`) has branches for `temp`, `publication`
  and `quarantine` only, so a `lease-quarantine` entry always falls through to `preserved`.
  Verified in an isolated directory: empty → `preserved`, non-empty → `recovery`, never `swept`.
- `lib/fs-atomic.js:789-801` — the new branch has no test (`grep -rn "lease-quarantine" test/
  test-support/` matches only `lib/`), and it is the one artifact kind that calls
  `directoryIsEmpty()` directly instead of the swallowing `recoveryLstat()`. `directoryIsEmpty()`
  rethrows every non-`ENOENT` error (`:858-866`), so an `EACCES` on the quarantine root drops the
  artifact entirely via `scanRecoveryCategory`'s catch rather than reporting
  `inspectionIncomplete: true` the way the branch's own field intends. A `.cah-lease-quarantine`
  that is a regular file is also still classified `kind: 'lease-quarantine'` with
  `displacedData: false` (verified).
- `lib/lease-lock.js:470-475` — the bounded slot loop can only ever help when the *primary*
  destination name is already occupied, because `moveFenceContents()` reserves
  `join(slotDir, fenceName)` inside a directory it just created; any other failure (a child rename
  that cannot proceed, a source `rmdir` that cannot proceed) reproduces identically in all 32
  slots. Round 62's change from `mkdirSync(slotDir, { recursive: true })` to `mkdirSync(slotDir)`
  (`:472`) additionally makes a slot permanently unusable if a crash lands between the `mkdir` and
  the compensating `rmdirSync(slotDir)` at `:474`: the `EEXIST` now `continue`s past it forever,
  where the old recursive form reused it.
- `lib/lease-lock.js:920` — `disposeOwnFence()` is handed `removalDeadline`, which in the exact
  case round 62's commit message says it now covers ("a transient failure whose retry budget simply
  expired") is *already expired*: attempt 1 of the loop spent it. Both retries inside the disposal
  (`removeClaimPath` at `:876`, `moveFenceContents` at `:469`/`:473`) therefore run with zero
  transient budget. Measured: the `owner.json`-replaced-by-a-directory case reaches the disposal at
  t=750 ms and only succeeds because renaming a directory needs no retry at all.
- `lib/lease-lock.js:870` — `if (!lstatSync(fencePath, { bigint: true }).isDirectory()) return false;`
  is unreachable: `acquireLease()` only ever creates directory claims (`:602`), so `takeFence()`
  can only produce a directory fence. The file-claim compatibility in `ownerPath()` (`:268-274`)
  has no live producer either.
- `lib/lease-lock.js:467` — `mkdirSync(quarantineRoot, { recursive: true })` is never undone. When
  the primary destination and all 32 slots fail, `quarantineFenceDir()` returns `false` having
  created an empty `.cah-lease-quarantine` directory beside the lease path, which nothing removes
  and (per the first bullet) nothing reports outside `cah-bin/cache/` itself.
- `lib/cli.js:734-743` — `probeStart()` is now the only probe entry point without a
  `MalformedSettingsError` branch. Round 62 gave `probe statusline status` the same path-plus-
  recovery-hint contract `stop` has (`lib/cli.js:807-820` vs `:772-779`); `start` still falls
  through to the generic `cah probe start: ${e.message}` line, which names the file but offers no
  recovery step.
- `lib/lease-lock.js` is now 993 lines against `test/source-size.test.js`'s 1000-line cap — seven
  lines of headroom, down from the 32 round 62's own review recorded (968 lines). The P1 fix above
  fits, but only just, and the next structural change to this file will have to extract something
  first.
- `test/lease-lock.test.js:262` — `assert.ok(elapsed >= 700, …)` encodes the exact latency the
  second P2 describes, so the suite now asserts that a release *must* take at least 700 ms in that
  scenario. Any future reduction of the release budget fails this test rather than the test
  tracking an intentional policy constant.
- `lib/lease-lock.js:26-27` — the `RELEASE_CLAIM_REMOVAL_ATTEMPTS` comment describes only the
  removal loop; since `:898` the same constant also scales `takeFence()`'s pre-removal rename
  budget. Documentation and use no longer agree.

## Disposition

Round 62 is not clean. Close the P1 first (it is the only finding with a deterministic,
race-free trigger and a user-visible outcome), then the two P2s and the P3 batch, then repeat the
read-only review.

Round 62's changes were checked individually and, apart from the items above, hold:

- `disposeOwnFence()` genuinely closes both branches it claims on the release side. Reproduced in
  isolated temp directories against the unmodified library: `owner.json` replaced by a directory →
  `released=true` in 764 ms with the body preserved under `.cah-lease-quarantine/claim.taken-…/`
  and a successor `acquireLease()` succeeding; stray entry → `released=true` in 4 ms, same shape;
  empty fence → `released=true` in 1 ms with no quarantine created at all; clean release → 2 ms.
  All four leave zero `.taken-` entries beside the claim path. The one shape that still fails is
  the quarantine root being occupied by a regular file (`released=false`, 882 ms, fence stranded,
  successor blocked) — an artificial condition with no producer in this codebase.
- The `mkdirSync(slotDir)` / `rmdirSync(slotDir)` pair does close round 62's slot-litter P3: the
  32 empty `.slot-N` directories the prior code left behind no longer appear, and a
  partially-populated slot is preserved by the `ENOTEMPTY` catch at `:474`.
- The `probeStatus()` parity fix is correct and complete for the defect it names. Verified against
  three settings files: the Latin-1 mojibake BOM now parses (`active:true`), malformed JSON raises
  `MalformedSettingsError` which `probeStatusReport()` turns into a path-specific message plus a
  recovery line and exit 1, and a real `U+FEFF` still parses. Behaviour for a non-regular or
  unreadable `settings.json` is unchanged (`captureRegularFileSnapshot` → `readFileMaybe` rethrows
  non-`ENOENT`), so the switch away from `readJsonMaybe` introduced no new escape. The only
  remaining asymmetry is `probeStart()` (P3 above); `enableProbe`/`disableProbe` additionally hold
  the probe lease while `probeStatus` does not, which is correct for a read-only inspection of a
  rename-published file.
- `lib/fs-atomic-publication.js`'s removed `isOwnershipLoss()` was genuinely dead there (both
  branches rethrew the same value); the identically-named helper in `lib/fs-atomic.js:58` is a
  separate, live function with two real call sites (`:342`, `:748`).
- The `absent` constant is now threaded consistently: `makeCapacityRecoveryHelpers`'s `ops()`
  (`lib/marker-capacity-recovery.js:21-28`) supplies it, both new pass-through sites (`:181`,
  `:459`) supply it, and the only external caller (`test/marker-state.test.js:348`) was updated.
  No `'absent'`/`'indeterminate'` string literal remains in `lib/marker-capacity-ops.js`.
- `scripts/gen-docs.js`'s split is correct: `validateMarkers()` (`:180-185`) performs the
  exactly-once literal-count assertion that `substituteLiteralCounts()` no longer duplicates, and
  it runs first in `main()` (`:193`); the out-of-sync message is now `check`-gated (`:196-198`) so
  `npm run gen:docs` no longer tells the user to run `npm run gen:docs`.
- `lib/transcript-stats.js`'s two simplifications are behaviour-preserving: `modelLimit()`'s
  removed condition was an unconditional duplicate of the default return (`:275`), and
  `readRateLimitsCache()` now reuses `globalFresh` for the identical expression it recomputed
  (`:601-604`).
- `lib/skills.js:750`'s `recoveredRel` rename removes the shadow of the enclosing loop's `rel`
  without touching behaviour, and `lib/cli.js:284-289`'s `prepareInstall` cleanup is cosmetic only.
- `releaseClaimLease()`'s removal from `lib/marker-state.js` is behaviour-preserving for the
  success path (`:481` now calls `releaseLease()` directly and its result is used identically);
  the latency consequence is covered in the second P2.

Beyond these items, the concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`,
`lib/marker-capacity-*.js`, `lib/marker-state.js`), the installers, the repair path, the runtime
description, the CLI, the probe, the four companion bins, the shared transcript library, the
manifest, the doc generator and the skill templates were read again and no additional confirmed
P0-P3 defect was identified. That is not a claim that every filesystem race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 596 total, 590 passed, 6 skipped, 0 failed (224.4 s).
- `FORCE_COLOR=1 npm test`: 596 total, 590 passed, 6 skipped, 0 failed (254.6 s). Round 58's
  `FORCE_COLOR` fix remains closed.
- The counts are +5 tests / +5 passes over round 62's 591/585, matching exactly the five tests
  `3f890d9` added (two in `test/lease-lock.test.js`, one in `test/cli.test.js`, two in
  `test/probe.test.js`); the skip count is unchanged at 6, so none of them skipped on this host.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are all legitimate platform guards:
  `test/binstall.test.js:434` ("hardlink metadata is not portable on this Windows runner"), three
  "POSIX mode bits are not portable on Windows" guards in `test-support/installer-atomic.cases.js`,
  and two "nanosecond mtime restoration is not deterministic on Windows" guards in
  `test/probe.test.js`. The two
  `this.skip('platform does not block rename of a directory held as a child process CWD')` guards
  (`test/lease-lock.test.js:69`, `test/marker-state.test.js:1091`) do **not** fire on this host, so the
  round-58/59/60/61/62 regression tests all really run.
- `node --check` over all 68 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names and no overlap between the
  two registries; every skill in `AllSkills` has a matching `templates/skills/<name>/SKILL.md`
  whose `name:` equals its directory name, and an `npx cah install --only <name>` line in
  README.md; no template directory is missing from `AllSkills`; every `SkillDeps` key is a real
  skill; README.md carries `--only commands`, `--only codex-agents` and `--only bins` examples;
  `package.json` version `0.8.0` equals `lib/update-check.js`'s `CURRENT_VERSION`.
- `BinFiles` publication order re-checked against CLAUDE.md's documented list: 17 destinations,
  `package.json` first, the twelve `lib/` leaves in dependency-first order, the four `bin/`
  executables last — matching the architecture note exactly.
- Unused-binding sweep over all 68 tracked JavaScript files (import clauses, including multi-line
  ones, and non-exported top-level `const`/`let`/`function`/`class` declarations): zero unused
  bindings.
- Encoding sweep over every tracked `.js/.mjs/.cjs/.md/.json/.sh/.bat/.toml/.yml/.yaml` file
  (132 files): all decode as strict UTF-8. The only `U+FEFF` and double-encoded sequences are the
  deliberate compatibility literals (`lib/probe.js:36`, `test/probe.test.js`) and this review
  series' own quotations of them (rounds 59, 60, 62).
- P1 reproduction 1 (lease level): temp directory, a claim directory whose `owner.json` names a
  dead pid, with and without one extra file inside. Results in the table above; the stray-entry
  case leaves `claim.taken-<pid>-<uuid>`, an absent claim path and three consecutive `null`
  acquires in the same process, while `acquireLease(..., { pidIsAlive: () => false })` (modelling a
  later invocation) converges to `acquired` with the body under `.cah-lease-quarantine/`.
- P1 reproduction 2 (end to end): `bin/cah-stamp.js` spawned as a child with a sandbox
  `HOME`/`USERPROFILE`, `CAH_STAMP_THROTTLE_PATH`, `CAH_UPDATE_CHECK_CACHE` and a one-line
  transcript. Control emits `{"continue":true,"systemMessage":"…"}`; the sabotaged run emits
  nothing and leaves one `.json.lock.taken-…` fence. A three-invocation run shows the loss is
  confined to invocation 1.
- P2 #1 measurements: three scenarios (takeFence pinned by a live child CWD; `owner.json` replaced
  by a directory at the first `claim-removal` interlock; both, with the pin released after 700 ms),
  each run against HEAD and — for the combined case — against a throwaway `lib/` copy outside the
  repository whose only difference is `lib/lease-lock.js:898` restored to
  `Date.now() + LEASE_RECOVERY_WAIT_MS`. Numbers in the table above (878 ms / 764 ms / 1502 ms vs
  252 ms and `released=false` on the patched copy).
- P2 #2 reproduction: `makeInterlock()` driven directly with a temp rendezvous base and
  `CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE` set to each phase/alias, against both HEAD's
  `test-support/interlocks.js` and `git show be00bf2:test-support/interlocks.js`. Table above.
- P3 quarantine-reporting reproduction: `enumerateRecoveryArtifacts()` /
  `maintainRecoveryArtifacts()` over three temp directories (empty `.cah-lease-quarantine`,
  non-empty, and one that is a regular file) → `kind: 'lease-quarantine'` in all three,
  `displaced=true` only for the non-empty one, `swept: []` in all three.
- CLI smoke test in a sandbox `HOME`/`USERPROFILE` outside the repository: `install` (agents 44,
  skills 11, bins 17, zero skipped/recovery), `doctor` → `mine: 72 … missing: 0`, exit 0,
  `probe statusline start` → `status` (ACTIVE) → `stop` (disarmed, statusLine key removed),
  `uninstall --only bins` → removed 17. A `--cwd` install into a temp project was also exercised.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; every temp directory and the throwaway `lib/` copy were created and deleted outside the
  repository. No version change, no push.
