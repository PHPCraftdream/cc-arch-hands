# cc-arch-hands review — round 64

- Baseline: `858f4d3` (`fix: close round 63 acquire-reclaim and timing-budget gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 63's four changes — the
  `acquireLease()` reclaim disposal, the `RELEASE_TOTAL_WAIT_MS` three-share timing design, the
  `test-support/interlocks.js` stage/alias parser, and the `CACHE_SCAN_SUBDIRS` /
  `directoryEmptyMaybe` / `probeStart()` batch — each probed with isolated reproductions rather
  than by reading the commit message. Second, a fresh sweep of `lib/*.js`, `lib/binstall/`,
  `bin/*.js`, `templates/`, `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), a
  third serialized TAP run enumerated the skips exactly, the doc-generation gate and a full
  `node --check` were run, seven isolated temp-directory reproductions were built outside the
  repository (including two that drive the real `bin/cah-stamp.js` as a child process against a
  sandbox `HOME`/`USERPROFILE`), and the CLI was smoke-tested end to end in a sandbox home.
  Nothing outside this document was modified. The real `~/.claude` was never touched.
- P0 findings: none
- Result: 1 P2, 1 P3 batch (10 items). No P1. Round 63's headline fix — the `acquireLease()`
  reclaim disposal — is confirmed genuinely closed, end to end through the real `cah-stamp` bin,
  and the new timing design measurably does what it claims (worst measured release dropped from
  round 62's 1502 ms to 535 ms, ceiling 1250 ms). The P2 is in the *other* half of the same
  commit: the `CACHE_SCAN_SUBDIRS` extension put `cah install`'s recovery sweep onto the hook
  bins' live publication path, where it destroys a concurrently-running `cah-stamp`'s in-flight
  atomic write — the same "dropped chat stamp" symptom rounds 58-63 have been chasing, with a
  brand-new trigger.

## Findings

### P2 — round 63's cache sub-namespace scan makes `cah install`/`cah uninstall` abort a concurrently running `cah-stamp`'s in-flight atomic write; the chat stamp for that turn is dropped and nothing reports it

`lib/binstall.js:846` and `lib/binstall.js:869`, against `lib/fs-atomic.js:702-716` and
`lib/fs-atomic-publication.js:650-652`.

Round 63 widened `mergeCacheMaintenance()` from "the `cache/` directory's direct entries" to four
roots:

```js
const CACHE_SCAN_SUBDIRS = ['stamp-state', 'update-markers', 'hint-markers'];   // :846
...
  for (const root of [cacheDir, ...CACHE_SCAN_SUBDIRS.map((name) => join(cacheDir, name))]) {  // :869
```

Those three namespaces are not crash-leftover graveyards. They are the *live* working directories
of the hook bins: `cache/stamp-state/` receives one `writeFileAtomic()` per `Stop` **and** per
`PostToolUse` (`bin/cah-stamp.js:244`), `cache/update-markers/` and `cache/hint-markers/` receive
the marker publications. `maintainRecoveryArtifacts()` → `sweepRecoveryArtifacts()` reaches this
branch for every `*.cah-owned-publish` fence it finds there:

```js
    } else if (artifact.kind === 'publication' && !artifact.displacedData
      && (artifact.publicationProof || provenOwnedPath(...))) {                    // :702-703
      ...
          const recovered = artifact.publicationProof
            ? recoverPublicationFence(artifact.canonicalPath, options)             // :709-710
```

`recoverPublicationFence()` is called with `options` = `{ assertOwnership, lifecycleLease }` and
**no `deferFresh`**, so the one guard that exists for exactly this case is skipped:

```js
    if (options.deferFresh
        && !verifiedLifecycleSuccessor(proof, options)
        && (proofOwnerIsAlive(proof) || !fenceIsStale(fencePath, proof))) return false;  // :650-652
```

`beginFence()` passes `deferFresh: true` (`lib/fs-atomic-publication.js:689`); the maintenance
sweep does not. With the guard bypassed, `recoverOccupiedFence()` proceeds to
`unlinkSync(publication.tempPath)` and then removes the fence — i.e. it deletes the *private temp
of a live publisher whose pid is alive and whose proof is seconds old*, and the publisher's
`writeFileAtomic()` throws `ERR_ATOMIC_RECOVERY_REQUIRED`.

Reproduction, isolated temp directory, real product code, publisher paused at the library's own
`write-after-proof-before-final-operation` crash boundary (proof + temp on disk, canonical rename
not yet done — a window `cah-stamp` passes through on every turn):

| maintenance root | result |
|---|---|
| `maintainRecoveryArtifacts(dir, { deferFresh: true })` | `swept=[]` — publisher completes, `dest="child-payload\n"` |
| `maintainRecoveryArtifacts(cache/)` (pre-round-63 reach) | `swept=[]` — publisher completes, `dest="child-payload\n"` |
| `writeBins(binDir, repo)` at HEAD | `swept=["cache/stamp-state/…json.cah-owned-publish"]`, publisher throws `ERR_ATOMIC_RECOVERY_REQUIRED`, `dest="ORIGINAL\n"` |

End to end through the real bin — `bin/cah-stamp.js`'s exported `main()` running in a child
process with a sandbox `HOME`/`USERPROFILE`, paused at the same boundary, while the parent runs
`writeBins()` (which is exactly what `cah install --only bins` does):

```
control (no concurrent install)
  stamp stdout : {"continue":true,"systemMessage":"23:24:59 · Opus 5 · 0.1% (1k/1M)"}

race (concurrent writeBins)
  cah install --only bins -> wrote 17 | swept ["cache/stamp-state/last-stamp.json.session-…json.cah-owned-publish"]
  stamp stdout : (EMPTY — stamp dropped)
```

The chain is `writeFileAtomic()` throws → `writeLastStamp()`'s `catch { return false; }`
(`bin/cah-stamp.js:252`) → `main()` returns at `bin/cah-stamp.js:380` without writing the
`systemMessage`. That is round 58's symptom verbatim, produced by the installer rather than by a
lease bug.

Two aggravating details:

1. **It is silent.** The destroyed publication is recorded only in `maintenance.swept`, and
   `reportClass()` (`lib/cli.js:242-281`) prints `recovery`, `preserved`, `unprovedTemps`,
   failures and visit counts — never `swept`. The install output above shows
   `bins: wrote 17, skipped 0` and nothing else. Verified: `maintenance.swept` contains the path,
   `maintenance.recovery` is empty.
2. **The authority is the wrong one.** `assertOwnership(options)` here proves the caller holds the
   *bin lifecycle* lease (`~/.claude/cah-bin.lock`). The state being swept is governed by an
   entirely different lock family — the per-sidecar `…json.lock` leases in
   `bin/cah-stamp.js:107`/`:258` — which the installer does not hold and does not check.

Trigger probability is not exotic: `npx cah install` is normally run from inside a Claude Code
session, and every Bash tool call fires `cah-stamp` on `PostToolUse`. What is narrow is the
overlap window (temp create → proof write → rename), which is sub-millisecond in the common case.
Blast radius is bounded — the canonical destination is never touched, so there is no data loss,
and the next turn re-stamps — hence P2 rather than P1.

Fix direction: pass `deferFresh: true` from the maintenance sweep
(`lib/fs-atomic.js:710`), which is what `beginFence()` already does and what the guard was written
for; a genuinely crashed publisher still gets recovered via `proofOwnerIsAlive()` /
`fenceIsStale()`. Independently, `reportClass()` should surface `maintenance.swept` — a
destructive maintenance action inside a namespace the installer does not own should not be
invisible in the install report.

### P3 — one omitted cache namespace, one unused import, four unguarded/asymmetric spots, and three carried-over items

None of these change behaviour today.

- `lib/binstall.js:846` — `CACHE_SCAN_SUBDIRS` enumerates three of the **four** fixed cah-owned
  namespaces below `cache/`. The fourth, `cache/rate-context/`
  (`lib/transcript-stats.js:38`, `:370`, `:488`), is missing. It is a genuine producer: every
  `cah-status` render writes a session sidecar there through `writeFileAtomic()`, whose private
  temp is created in the destination directory (`lib/fs-atomic.js:260`), and
  `pruneRateContextSidecars()` removes entries via `removeOwnedRegularFile()`, which reserves a
  `<leaf>.cah-owned-remove/` namespace there. Verified in a sandbox home: with one `.cah-tmp-`
  leftover planted in each of `cache/`, `cache/stamp-state/` and `cache/rate-context/`,
  `cah install --only bins` reports

  ```
    bins: wrote 17, skipped 0 (foreign or canonical survivor), recovery 2 (quarantine)
      recovery: cache/.cah-tmp-1-cccc
      recovery: cache/stamp-state/.cah-tmp-1-bbbb
  ```

  — the `rate-context` leftover is invisible. Note the coupling with the P2: adding `rate-context`
  to the list *without* fixing `deferFresh` first would widen the live-publisher race to
  `cah-status`'s per-render sidecar writes as well. Fix `deferFresh` first, then the namespace list.
- `test/lease-lock.test.js:5` — `chmodSync` is imported and never used. `858f4d3` deleted the only
  POSIX `chmodSync` sabotage when it rewrote the budget test but left the import. This is the only
  unused binding in the repository: a sweep of import clauses (including multi-line and `as`
  forms) and non-exported top-level `const`/`let`/`function`/`class` declarations across all 69
  tracked JavaScript files reports exactly this one.
- `test-support/interlocks.js:3-6`, `:34-36` — the new `STAGE_NAMES` set is a hardcoded mirror of a
  production fact with no automated link to `lib/`. It is currently **complete**: a static scan of
  every `testInterlock(phase, '<literal>' …)` second argument across `lib/` and `bin/` yields
  exactly `before`, `vacancy`, `claim-removal`, `after` (the six `enable-*`/`disable-*` literals in
  `lib/probe.js` are aliases and correctly absent). But nothing keeps it complete, and the failure
  mode is silent in *both* directions. Demonstrated with `makeInterlock()` against a hypothetical
  new stage name `post-rename`:

  ```
  configured=post-rename, call=("lease-release","post-rename")   -> rendezvous fires
  configured=post-rename, call=("marker-capacity","post-rename") -> rendezvous fires
  configured=claim-removal, call=("lease-release","claim-removal") -> does not fire (correct)
  ```

  An undeclared stage becomes a *phase-agnostic* rendezvous candidate that fires at every unrelated
  call site using the same stage, and the three-party owner-interlock suffix (`:50`,
  `staged ? \`.${stage}\` : ''`) silently collapses back onto `.before` — round 61's P3, reopened.
  This is the same class of regression round 62 introduced and round 63 fixed; `test/interlocks.test.js`
  asserts the parser's behaviour but never asserts that `STAGE_NAMES` matches `lib/`. A derived set,
  or a test that greps `lib/` and compares, would close it structurally.
- `test/lease-lock.test.js:223-228` — the rewritten budget test now returns `this.skip(...)` on every
  non-Windows host. The test it replaced (`recovers a transient obstruction that outlasts the first
  removal attempt…`) ran on both platforms, using a `chmodSync(fenceDir, 0o555)` obstruction on
  POSIX. So the removal-share/disposal-share convergence — the core of round 63's timing rework — is
  now asserted on Windows only. On this host it runs (it is not among the 6 skips), but a POSIX CI
  would silently lose it.
- `lib/lease-lock.js:874-877` vs `:640-644` — `disposeOwnFence()`'s doc comment now contradicts one
  of its two callers: *"Everything inside is therefore this process's own state: dispose outright"*.
  For the `releaseLease()` caller that is true. For the `acquireLease()` reclaim caller added by
  round 63 it is false by construction — the fence holds another process's **expired** claim, which
  is precisely why `removeClaimPath()`'s stray-entry guard rejected it. The behaviour is unchanged
  (the pre-round-63 code deleted the same foreign `owner.json` at the same place), but the comment
  now justifies the wrong thing.
- `lib/lease-lock.js:640-644` vs `:922-927` — the two paths are close but not symmetric, in three
  ways. (a) `releaseLease()` emits `testInterlock(..., 'claim-removal', …)` before its removal;
  the acquire reclaim emits nothing, so no test can pause between `takeFence()` and the reclaim's
  removal/disposal. (b) `releaseLease()` returns the disposal's boolean; the acquire discards it
  and `continue`s — benign, because the next loop turn re-checks `hasInFlightFence()` and returns
  `null` if the fence survived, but it means a failed disposal is unobservable. (c) The disposal is
  given a *fresh* `Date.now() + LEASE_RECOVERY_WAIT_MS` while the enclosing loop is still gated on
  the acquire's original `config.recoveryDeadline` (`:602`, `:607`), so a disposal that actually
  succeeds can still be followed by `while (Date.now() < config.recoveryDeadline)` failing and the
  acquire returning `null` despite having just freed the path. Bounded (one extra 250 ms share) and
  self-converging on the next invocation, but it is the one shape where the reclaim does the work
  and still reports failure.
- `lib/lease-lock.js:477-482` — round 63's own P3 about the bounded slot loop is not closed, and the
  answer to "is the fresh 250 ms disposal share sufficient for `quarantineFenceDir()`'s worst case of
  32 slots?" is that the share does not bound that loop at all: the slot iteration is not
  deadline-gated, only the `withTransientRetry()` calls *inside* each `moveFenceContents()` are, so
  the loop always runs to completion (33 × ~5 syscalls) regardless of remaining budget. Separately
  the loop remains effectively unreachable: the primary destination is
  `join(quarantineRoot, basename(fencePath))` and every fence basename already carries
  `${process.pid}-${randomUUID()}`, so it is never occupied. Both the "sufficient" and the
  "bounded" halves of the constant's documentation are therefore vacuous for this phase.
- `lib/cli.js:813-826` — `probeStatusReport()` is now the only probe entry point without a generic
  scoped fallback: `start` and `stop` end their `catch` with
  `process.stderr.write(\`cah probe start|stop: ${e.message}\n\`)`, while `status` re-`throw`s at
  `:826` and lands in `bin/cah.js`'s top-level handler. Verified with `settings.json` replaced by a
  directory in a sandbox home:

  ```
  status -> cah: unexpected error: EISDIR: illegal operation on a directory, read   (exit 1)
  start  -> cah probe start: EISDIR: illegal operation on a directory, read         (exit 1)
  stop   -> cah probe stop: EISDIR: illegal operation on a directory, read          (exit 1)
  ```

  Round 62 established the three-way parity contract for `MalformedSettingsError` and round 63
  completed `start`'s branch; the generic branch is still two-of-three. "unexpected error" is a
  misleading label for an ordinary filesystem condition.
- `lib/fs-atomic.js:38` vs `:41` — `LEASE_QUARANTINE_DIR` is mirrored into this module and given its
  own `describeRecoveryArtifact()` branch (`:789-801`), but it is **not** in `RECOVERY_MARKERS`, so
  `isQuarantineName()`/`isQuarantinePath()` (`:906-913`) do not recognise it. Every orphan sweep
  (`lib/fsutil.js:119`, `:234`, `:259`, `:287`; `lib/binstall.js:312`, `:344`; `lib/skills.js:164`,
  `:485`) therefore treats a `.cah-lease-quarantine` entry as ordinary user data rather than as a
  recovery namespace. No live producer places one inside a pruned directory today (leases live at
  `~/.claude/cah-bin.lock`, `~/.claude/settings.json.probe-lock`, and under `cah-bin/cache/…`, none
  of which are orphan-swept), so this is latent, not active — but the two predicates and the
  describer now disagree about what the string means.
- `lib/lease-lock.js` is now exactly **1000 lines** against `test/source-size.test.js:9`'s
  `maximumLines = 1000` cap (`lines > 1000` fails, 1000 passes). Zero headroom. Any fix in this file
  must now extract something first — including the acquire/release symmetry items above.

## Disposition

Round 63 is not clean, but it is much closer than rounds 58-62 were. Close the P2 first — it is the
only finding with a user-visible outcome, it was introduced by the last commit, and the fix is one
option flag plus one report line. Then the P3 batch, in the order given (the `deferFresh` fix must
land before `rate-context` is added to `CACHE_SCAN_SUBDIRS`). Then repeat the read-only review.

Round 63's changes were checked individually and, apart from the items above, hold:

- **The `acquireLease()` reclaim disposal genuinely closes round 63's P1**, at both levels.
  At the lease level: a claim directory owned by a dead pid with one extra file inside now yields
  `acquired`, zero `.taken-` leftovers, and the foreign body preserved under
  `.cah-lease-quarantine/claim.taken-…/`. End to end through the real `bin/cah-stamp.js` spawned as
  a child with a sandbox `HOME`/`USERPROFILE` and the per-session stamp lock sabotaged exactly as
  round 63 described:

  ```
  control (stale lock only)      stdout={"continue":true,"systemMessage":"23:18:53 · Opus 5 · 0.1% (1k/1M)"}
                                 stranded fence=[]  lock present=false  quarantine=null
  stale lock + stray entry       stdout={"continue":true,"systemMessage":"23:18:53 · Opus 5 · 0.1% (1k/1M)"}
                                 stranded fence=[]  lock present=false
                                 quarantine=["last-stamp.json.session-…json.lock.taken-30748-dd385623-…"]
  ```

  The sabotaged run — which dropped its stamp at round 63's baseline — now emits it on the first
  invocation. The quarantined body additionally lands in `cache/stamp-state/.cah-lease-quarantine/`,
  which the same commit's `CACHE_SCAN_SUBDIRS` change makes reportable, so the two halves of the
  commit do compose as intended for this case.
- **The one-explicit-total-budget timing design measurably does what it claims.**
  `RELEASE_TOTAL_WAIT_MS` is 1250 (750 + 250 + 250), and the phases are genuinely sequential and
  non-multiplying. Measured against the unmodified library in isolated temp directories:

  | scenario | round 62 (round 63's measurement) | HEAD |
  |---|---|---|
  | clean release | 2 ms | 1 ms |
  | stray entry in the fence | 4 ms | 2 ms |
  | `owner.json` replaced by a directory at `claim-removal` | 764 ms | 535 ms |
  | both phases contended (round 63's worst case) | 1502 ms | ≤ 1250 ms by construction |

  All four converge with `released=true`, zero `.taken-` leftovers and the body preserved. The
  `RELEASE_CLAIM_REMOVAL_ATTEMPTS` constant that had become an undocumented 3× multiplier on the
  fence-rename phase is gone, and the removal loop's decorative extra attempts (round 63's second P2
  half) are gone with it. The one shape that still fails is the quarantine root being occupied by a
  regular file (`released=false`, 2 ms, one stranded fence) — an artificial condition with no
  producer in this codebase, and it now fails fast instead of after 882 ms.
- **The interlock parser fix is correct and complete for the defect it names.** The 13 production
  alias call sites round 63 listed are reachable again (`test/interlocks.test.js` covers one
  representative per production file), a declared stage is still consumed as the stage and not
  leaked into `candidates`, and the static scan above confirms the declared set matches `lib/`
  today. The only residue is the staleness hazard in the P3 batch.
- The `directoryEmptyMaybe()` change is behaviour-preserving where it matters and strictly better
  where it does not: `inspectionIncomplete` now distinguishes "could not inspect" from "empty", and
  an `EACCES` on the quarantine root reports the artifact instead of dropping it via
  `scanRecoveryCategory`'s catch (round 63's second P3 bullet, closed, with a regression test at
  `test/fs-atomic.test.js`). The `ENOENT → false` return is inherited from `directoryIsEmpty()` and
  over-reports a vanished directory as `displacedData: true`; harmless and unchanged from before.
- The `mkdirSync(slotDir, { recursive: true })` revert does close round 63's crash-orphaned-slot
  P3 without reintroducing round 62's slot litter — the compensating `rmdirSync(slotDir)` at `:481`
  and the new emptied-root cleanup at `:483` remain, and a partially populated slot is still
  preserved by the `ENOTEMPTY` catch.
- The removal of the non-directory guards from `quarantineUnexpectedFence()` (`:456-465`) and
  `disposeOwnFence()` (`:878-884`) is behaviour-preserving: a file at the fence path made
  `lstatSync(...).isDirectory()` return false before and makes `readdirSync()` throw `ENOTDIR` now,
  and both spellings return `false`. The `entries.some(...)` check moved outside the `try`, where it
  cannot throw.
- `probeStart()`'s new `MalformedSettingsError` branch is correct and matches `stop`/`status`'s
  wording and exit code (verified in a sandbox home).
- `mergeCacheMaintenance()`'s multi-root loop preserves the `leaseLost` re-throw, dedupes through
  `addUnique`/`mergeMaintenanceReport`, and maps every scanned root's paths into the same
  bin-relative namespace; `lstatNoFollow` gates each sub-namespace so an absent or non-directory
  entry is skipped silently. The mechanics are sound — the defect is *what* it was pointed at.

Beyond these items, the concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`,
`lib/marker-capacity-*.js`, `lib/marker-state.js`), the installers, the repair path, the runtime
description, the CLI, the probe, the four companion bins, the shared transcript library, the
manifest, the doc generator and the skill templates were read again and no additional confirmed
P0-P3 defect was identified. That is not a claim that every filesystem race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 605 total, 599 passed, 6 skipped, 0 failed (189.7 s).
- `FORCE_COLOR=1 npm test`: 605 total, 599 passed, 6 skipped, 0 failed (196.3 s). Round 58's
  `FORCE_COLOR` fix remains closed.
- The counts are +9 tests / +9 passes over round 63's 596/590, matching exactly the nine tests
  `858f4d3` added (one in `test/binstall.test.js`, one in `test/cli.test.js`, two in
  `test/fs-atomic.test.js`, four in the new `test/interlocks.test.js`, one in
  `test/lease-lock.test.js`); the skip count is unchanged at 6.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are all legitimate platform guards: `test/binstall.test.js`
  ("hardlink metadata is not portable on this Windows runner"), three "POSIX mode bits are not
  portable on Windows" guards in `test-support/installer-atomic.cases.js`, and two "nanosecond
  mtime restoration is not deterministic on Windows" guards in `test/probe.test.js`. The
  `platform does not block rename of a directory held as a child process CWD` guards
  (`test/lease-lock.test.js`, `test/marker-state.test.js`) and round 63's new
  `platform does not make unlinkSync of a directory fail transiently` guard do **not** fire on this
  host, so the round-58 … round-63 regression tests all really run.
- `node --check` over all 69 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names and no overlap between the
  two registries; every skill in `AllSkills` has a matching `templates/skills/<name>/SKILL.md`
  whose `name:` equals its directory name, and an `npx cah install --only <name>` line in
  README.md; no template directory is missing from `AllSkills`; every `SkillDeps` key is a real
  skill; README.md carries `--only commands`, `--only codex-agents` and `--only bins` examples;
  `package.json` version `0.8.0` equals `lib/update-check.js`'s `CURRENT_VERSION`.
- `BinFiles` publication order re-checked against CLAUDE.md's documented list: 17 destinations,
  `package.json` first, the twelve `lib/` leaves in dependency-first order (note that the derived
  order differs from the `BinFileDefinitions` literal, which lists `lease-lock.js` before its
  `fsutil.js` dependency — `deriveCompanionPublicationOrder()` is what `BinFiles` exports and
  `validateBinFileOrder()` then checks, so this is correct), the four `bin/` executables last.
- Unused-binding sweep over all 69 tracked JavaScript files (import clauses, including multi-line
  and `as` forms, plus non-exported top-level `const`/`let`/`function`/`class` declarations):
  exactly one, `test/lease-lock.test.js:5`'s `chmodSync` (P3 above).
- Encoding sweep over every tracked `.js/.mjs/.cjs/.md/.json/.sh/.bat/.toml/.yml/.yaml` file
  (134 files): all decode as strict UTF-8. The only `U+FEFF` occurrences are the deliberate
  compatibility literal in `test/probe.test.js` and this review series' own quotation of it
  (round 62).
- P2 reproduction #1 (primitive level): a child process pauses the real `writeFileAtomic()` at
  `write-after-proof-before-final-operation` while writing into `cache/stamp-state/`; the parent
  then runs, in three separate temp directories,
  `maintainRecoveryArtifacts(dir, { deferFresh: true })`, `maintainRecoveryArtifacts(cache/)` and
  `writeBins(binDir, repo)`. Only the third sweeps the fence and unlinks the temp; the publisher
  then throws `ERR_ATOMIC_RECOVERY_REQUIRED` and the destination retains its original bytes. The
  swept path appears in `maintenance.swept` and in neither `recovery` nor the printed report.
- P2 reproduction #2 (end to end): `bin/cah-stamp.js`'s exported `main({ testInterlock })` run in a
  child with a sandbox `HOME`/`USERPROFILE`, `CAH_STAMP_THROTTLE_PATH`, `CAH_UPDATE_CHECK_CACHE`,
  `CAH_RATE_LIMITS_CACHE` and a one-line transcript. Control emits the `systemMessage`; the run
  raced by `writeBins()` emits nothing.
- Round-63 P1 regression check (end to end): `bin/cah-stamp.js` spawned as a child against a stamp
  lock owned by a genuinely dead pid, with and without one stray file inside. Both variants now
  emit the stamp on the first invocation; the stray variant additionally quarantines the foreign
  body. Table in the Disposition section.
- Release-timing measurements: four scenarios (clean release; stray entry injected at the `vacancy`
  interlock; `owner.json` replaced by a same-named directory at the `claim-removal` interlock;
  stray entry plus a quarantine root occupied by a regular file), each driven through the real
  `acquireLease()`/`releaseLease()` in isolated temp directories. Numbers in the Disposition table;
  `RELEASE_TOTAL_WAIT_MS` read from the module as 1250.
- Interlock stage-set check: a static scan of every `testInterlock(phase, '<literal>' …)` second
  argument across `lib/` and `bin/` (13 occurrences, 4 distinct stage names) plus a behavioural
  drive of `makeInterlock()` with a hypothetical undeclared stage. Results in the P3 batch.
- `rate-context` reporting gap reproduced in a sandbox home: `.cah-tmp-1-*` planted in `cache/`,
  `cache/stamp-state/` and `cache/rate-context/`; `cah install --only bins` reports the first two
  and not the third.
- CLI smoke test in a sandbox `HOME`/`USERPROFILE` outside the repository: `install` (agents 44,
  skills 11, bins 17, zero skipped/recovery), `doctor` → `mine: 72, legacy: 0, foreign: 0,
  missing: 0`, exit 0, the installed `SKILL.md` carrying `<!-- cah-skill:v1 -->`,
  `probe statusline start` → `status` (ACTIVE) → `stop` (disarmed, statusLine key removed), plus
  the `settings.json`-is-a-directory error-path comparison across all three probe actions.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; every temp directory and sandbox home was created and deleted outside the repository,
  and the real `~/.claude` was never written to. No version change, no push.
