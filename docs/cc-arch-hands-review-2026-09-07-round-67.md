# cc-arch-hands review — round 67

- Baseline: `560bf41` (`fix: close round 66 residual visibility and foreign-fence gaps`); working tree
  clean.
- Scope: two halves. First, adversarial verification of round 66's three changes — the
  `deferForeignCommitted` split in `beginFence()`, the empty-proof-less publication-fence reclaim in
  the maintenance sweep plus the new `maintenance preserved:` report lines, and the
  balanced-parenthesis rewrite of `test/interlocks.test.js`'s `STAGE_NAMES` scan — each probed with
  isolated reproductions and counterfactuals rather than by reading the commit message. Second, a
  fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`, `templates/`, `scripts/`, `test/`,
  `test-support/`, driven this round by a *contention* harness (2, 3, 5 and 6 real publisher
  processes racing one leaf through the real `writeFileAtomic()`) rather than only by single-process
  crash injection.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), the 6
  skips were enumerated exactly, the doc-generation gate and a full `node --check` were run, seven
  isolated reproductions were built outside the repository, and the CLI was smoke-tested end to end
  in a sandbox `HOME`/`USERPROFILE`. Nothing outside this document was modified. The real
  `~/.claude` was never touched.
- P0 findings: none
- Result: **1 P1, 2 P2, 4 P3.** The convergence trend of round 66 does not hold. Running two
  ordinary publisher processes against one leaf — the exact shape round 66's own new test builds —
  turns up a raw `ENOENT` escaping `writeFileAtomic()` from two unguarded `readFileSync()` calls
  that have been in `proofPublication()` since the proof-entry mechanism landed, reproduced at the
  CLI level as `cah install: agents: ENOENT: … 'fl.md.cah-owned-publish\publication.json.tmp'`,
  exit 1. Separately, round 66's own `deferForeignCommitted` fix introduced a new failure mode it
  did not consider: `proofOwnerIsAlive()` answers by pid alone, so a crashed publisher's committed
  fence whose pid has been recycled is now deferred to *forever* — 30.8 s of busy-wait followed by a
  hard `EEXIST`, on every subsequent publication to that leaf, permanently. Pre-`560bf41` code
  recovered it; verified by counterfactual.

## Findings

### P1 — `proofPublication()` reads proof bytes with two unguarded `readFileSync()` calls, so a live fence owner's own cleanup makes `writeFileAtomic()` throw a raw `ENOENT` naming an internal fence path

`lib/fs-atomic-publication.js:391` and `:395`.

```js
    proofPath: ownedProofPath,
    proofIdentity,
    proofContent: readFileSync(ownedProofPath),                 // :391
    proofEntries: state.candidates.map((candidate) => ({
      path: candidate.path,
      identity: candidate.identity,
      content: readFileSync(candidate.path),                    // :395
    })),
```

These are the only two unprotected filesystem reads in the module. Every other proof access goes
through `readJson()` (`:256-261`, try/catch → `null`), `lstatMaybe()` (`:36-41`, ENOENT → `null`) or
`regularFileIdentity()`. `proofPublication()` even performs the correct pre-check one line earlier —
`if (!ownedProofPath || !proofIdentity) return null;` (`:379`) — and then reads outside that
check's protection.

The call chain is entirely inside the *publisher's own* hot path, not maintenance:

`writeFileAtomic()` (`lib/fs-atomic.js:148`) → `publishWithFence()` (`:815`) → `beginFence()`
(`:703`) → `recoverOccupiedFence()` (`:640`) → `validPublicationProof()` (`:440`) →
`proofPublication()`.

`beginFence()` is the one caller of `recoverOccupiedFence()` with no `try/catch` around it. The
other two paths are protected: `sweepRecoveryArtifacts()` wraps its `recoverPublicationFence()` call
(`lib/fs-atomic.js:731-750`) and `maintainRecoveryArtifacts()` wraps the whole sweep (`:781-788`);
both `marker-capacity-recovery.js` callers wrap theirs (`:192-197`, `:584-595`).

The race is the ordinary one the fence exists to arbitrate: publisher A holds the fence and is
inside `cleanupPublicationFence()`'s `unlinkSync` loop (`lib/fs-atomic-publication.js:484-488`)
removing `publication.json` and `publication.json.tmp`; publisher B is between
`publicationProofState()`'s stat/read and these two reads. B does not get a classified conflict and
does not retry the fence loop — it dies with an errno.

Reproduction, isolated temp directory, real product code, N separate `node` processes each looping
`writeFileAtomic()` on one leaf:

```
6 publishers  → 4 of 6 exited 7 with a raw errno; two distinct shapes observed:
  RAW ENOENT ENOENT: no such file or directory, open '…\leaf.json.cah-owned-publish\publication.json'
      at readFileSync (node:fs:444:35)
      at proofPublication (lib/fs-atomic-publication.js:391:19)
      at validPublicationProof (lib/fs-atomic-publication.js:440:23)
      at recoverOccupiedFence (lib/fs-atomic-publication.js:640:32)
      at beginFence (lib/fs-atomic-publication.js:703:12)
      at publishWithFence (lib/fs-atomic-publication.js:815:23)
      at writeFileAtomic (lib/fs-atomic.js:148:28)
  RAW ENOENT … '…\leaf.json.cah-owned-publish\publication.json.tmp'
      at proofPublication (lib/fs-atomic-publication.js:392:36)   ← the proofEntries map, :395
2 publishers  → 2 of 3 runs hit it (120 iterations per process)
```

Reproduced end to end through the CLI as well. `writeModelAgents()` takes no lease, so two
concurrent `cah install --only agents` runs against one sandbox `HOME` publish the same 44 leaves
simultaneously:

```
run 1 exits: 1 0
cah install: agents: ENOENT: no such file or directory, open
  'D:\…\h1\.claude\agents\fl.md.cah-owned-publish\publication.json.tmp'
```

The correct outcome for that race — and the outcome in the other 13 CLI runs — is the classified
`cah install: agents: managed destination leaf changed concurrently; refusing operation`.
`writeFileAtomic()`'s documented failure vocabulary is exactly three shapes: `conflict()`
(`lib/fs-atomic-publication.js:74-76`), `AtomicOwnershipLostError` (`:27-34`) and
`recoveryRequired()` (`:535-540`). A bare `ENOENT` whose message names a private fence directory is
none of them.

Why this is P1 rather than P2: the trigger needs nothing exotic — two ordinary publishers, no crash,
no injected failure, no pid reuse, no clock skew — and it reproduces within a second. The reachable
production pairs are (a) two Claude Code windows rendering concurrently, where `cah-status` writes
`cache/rate-limits.json` and `cache/rate-context/<hash>.json` with no lock at all
(`lib/transcript-stats.js:576`, `:580` via `writeJsonAtomic` at `:391-399`) — swallowed there, so
the cost is a lost cache write; and (b) two concurrent `cah install`/`cah reinstall` runs on
`agents`/`commands`/`skills`, which have no lease, where it is a hard exit 1 mid-install with a
confusing message. Why it is not P0: `beginFence()` throws before any temp is renamed, so
`writeFileAtomic()`'s catch (`lib/fs-atomic.js:206-219`) still unlinks the private temp; every run
of the reproduction ended with `leftovers: []` and the destination intact.

Round 66 measurably *amplified* this. Pre-`560bf41`, an acquirer that found a committed foreign
fence reaped it on the first observation, so `proofPublication()` ran roughly once per acquire.
Post-`560bf41` the acquirer defers (`:656-658`) and loops back through `recoverOccupiedFence()` —
and therefore through both unguarded reads — on every one of up to `FENCE_ACQUIRE_RETRIES = 100`
attempts, against a live owner that is concurrently unlinking exactly those two files. The bug
predates round 66; the retry loops rounds 64 and 66 added are what make it easy to hit.

The fix is local and small: give the two reads the same ENOENT-tolerant treatment the rest of the
module already uses and `return null` on failure, which puts `beginFence()` back on its designed
sleep-and-retry path (`:705-707`).

### P2 — round 66's `deferForeignCommitted` makes a crashed publisher's committed fence permanently unreclaimable once its recorded pid is recycled: 30.8 s of busy-wait and a hard `EEXIST` on every later publication to that leaf

`lib/fs-atomic-publication.js:654-658` against `:174-182`, reached via `:704`.

```js
      const foreignLiveOwner = Number(proof.ownerPid) !== process.pid
        && proofOwnerIsAlive(proof);
      if ((options.deferCommitted || (options.deferForeignCommitted && foreignLiveOwner))
          && !verifiedLifecycleSuccessor(proof, options)
          && (proofOwnerIsAlive(proof) || !fenceIsStale(fencePath, proof))) return false;
```

`proofOwnerIsAlive()` decides liveness from `proof.ownerPid` alone (`:179-181`: `process.kill(pid,
0)`, with `EPERM` counted as alive). A publisher that dies hard inside window B — payload renamed to
the canonical destination, fence not yet cleaned — leaves a complete `active` proof carrying its
pid. Once the operating system recycles that pid, `proofOwnerIsAlive()` is permanently `true`, and
because the third clause is `proofOwnerIsAlive(proof) || !fenceIsStale(...)`, **staleness can never
break the tie**: an hour-old fence with a live-looking pid is deferred to exactly like a
microsecond-old one.

Nothing else reclaims it. The maintenance sweep passes `deferCommitted: true`
(`lib/fs-atomic.js:738-739`) and hits the same clause. `cache` is a `ReservedRootEntries` member so
`removeBins`' root sweep never touches it, and `pruneOrphans`/`pruneOrphanDirs` skip recovery names.

Reproduction, isolated temp directory, real product code: a child publisher paused at the real
`write-after-final-rename` interlock, `SIGKILL`ed there (payload committed, fence intact), its
proof's `ownerPid` then pointed at an unrelated live `node` process and `createdAtMs` aged one hour
— i.e. exactly what pid recycling produces:

```
fence entries after crash: [ 'publication.json' ]
destination after crash:   "victim-payload\n"
proof ownerPid (crashed):  37348   ownerState: active
patched ownerPid ->        37664   (live, unrelated)
acquirer outcome after 30817 ms: FAILED:EEXIST: EEXIST: file already exists,
  mkdir '…\leaf.json.cah-owned-publish'
fence still present: true
```

Counterfactual on the same fixture, proving this is a regression and not a pre-existing hole:

```
maintenance swept   : []                       ← deferCommitted also refuses
maintenance preserved: [ 'leaf.json.cah-owned-publish' ]
pre-560bf41 acquirer option set recovered the fence: true   ← {deferFresh:true, deferCommitted:false}
fence after that call: false
```

The 30.8 s is not idle waiting. `beginFence()`'s backoff is `sleepSync()`
(`lib/fs-atomic-publication.js:67-70`), a `while (Date.now() < end) {}` spin, so the budget
`20+40+80+160 + 95×320 ms = 30 700 ms` (`FENCE_ACQUIRE_RETRIES = 100` at `:15`, backoff at `:707`)
is 30 seconds of one core at 100 %, and each of the 100 iterations additionally re-reads and
re-hashes the destination through `destinationIsPublished()` (`:542-547`).

Production reach: `cah-status` publishes `~/.claude/cah-bin/cache/rate-limits.json` on every
statusLine render (`bin/cah-status.js:109-119` → `persistRateLimitsCache` →
`lib/transcript-stats.js:576`). One stuck fence on that leaf means every render burns a core for
30.8 s and then silently loses the write (`writeJsonAtomic` swallows, `lib/transcript-stats.js:391-399`).
The statusLine has a 60 s refresh interval, so the bar stalls indefinitely. `cah-stamp`'s
`cache/stamp-state/…json` sidecars are behind a per-sidecar lease, but the lease does not help here:
the stuck fence is a *dead* predecessor's, not a live peer's.

The trade round 66 made is therefore net negative: it removed a benign P3 (a live foreign publisher
seeing a spurious `ERR_ATOMIC_RECOVERY_REQUIRED` over data that already landed, which round 66's own
analysis showed every production caller swallows) and installed a permanent, CPU-burning hard
failure in its place. The narrow fix is to bound the new deferral by staleness the way the flag's
own intent implies — `foreignLiveOwner && !fenceIsStale(fencePath, proof)` — so a live peer still
gets its microsecond-long window B but a recycled pid cannot wedge the leaf forever. Round 65's
same-process test (`test/fs-atomic.test.js:174-197`) is unaffected, since `foreignLiveOwner` is
already `false` for our own pid.

### P2 — `pruneOrphanDirs()`'s "close the widest practical race" `readdirSync` is the one read in that function with no ENOENT guard, so a concurrently removed orphan skill directory aborts `cah install` with a raw errno

`lib/fsutil.js:286`, against its own guarded siblings at `:226-231` and `:250-256`.

```js
    // Close the widest practical race before removing the manifest: if any
    // entry appeared or the manifest changed type, preserve the directory.
    const current = readdirSync(dirPath, { withFileTypes: true });
```

The same function reads `root` (`:227`) and `dirPath` (`:252`) inside `try` blocks that translate
`ENOENT` into `return`/`continue`, and the handling this case needs already exists five lines below
(`:288-292`: `addUnique(preserved, entry.name); continue;`). The window is everything between
`:252` and `:286` — most of it `captureRegularFileSnapshot(manifestPath)` at `:265`, which reads the
manifest and hashes it twice — so it scales with the orphan manifest's size.

Reproduction, isolated temp directory, real product code: one orphan directory carrying a managed
`SKILL.md`, `pruneOrphanDirs()` called directly, and a separate process removing the directory
during the snapshot. Ten delays from 10 ms to 160 ms, all ten identical:

```
THREW ENOENT: no such file or directory, scandir '…\zzz-orphan'
    at readdirSync (node:fs:1569:26)
    at pruneOrphanDirs (lib/fsutil.js:286:21)
```

`pruneOrphanDirs()` is called by `writeSkills()` (`lib/skills.js:154-157`) and neither catches, so
the errno surfaces as `cah install: skills: ENOENT …` and exit 1 after part of the install has
already been written. This is P2 rather than P1 because it needs an *orphan* skill directory (a
skill name retired in an earlier release) plus a concurrent remover, and because the natural window
with a normal few-kilobyte `SKILL.md` is sub-millisecond — the reproduction above widens it with a
large manifest to make the hit deterministic. It is the same defect class as the P1 above at an
independent site, which is why both are reported: the pattern, not just the instance, is what wants
fixing.

### P3 — `reportClass()`'s new `maintenance preserved:` lines duplicate artifacts the same report already prints under `recovery:`, `kept:` or `skipped:`

`lib/cli.js:283-285` (and the `preserved N` counter at `:271-272`).

`maintainRecoveryArtifacts()` puts every non-swept, still-present artifact into `preserved`
(`lib/fs-atomic.js:800-802`), *including* the `.cah-tmp-` entries it also puts into `unprovedTemps`
(`:801`). Both installers then project the same artifact twice: `mergeCacheMaintenance()` copies
`unprovedTemps`/`recovery` into the class `recovery` list (`lib/binstall.js:897-902`) while
`mergeMaintenanceReport()` copies `preserved` into `maintenance.preserved`
(`lib/fsutil.js:78-83`); `pruneOrphans()` copies `maintenanceReport.preserved` into the class
`preserved` list (`lib/fsutil.js:100`), and `writeSkills`/`removeSkills` do the same through
`mergeRecoveryMaintenance()` (`lib/skills.js:780-782`). Round 64 gave the swept side one line per
artifact; round 66's mirror gives the preserved side a *second* line for artifacts that already had
one.

Verified end to end in a sandbox `HOME`/`USERPROFILE`, both installer paths:

```
  bins: wrote 17, skipped 0 (foreign or canonical survivor), recovery 2 (quarantine)
    recovery: cache/stamp-state/.cah-tmp-1-bbbb
    recovery: cache/rate-context/.cah-tmp-1-aaaa
    maintenance: visits 75, recovery 0, temps 2, swept 1, preserved 2
    maintenance swept: cache/stamp-state/dead-session.json.cah-owned-publish
    maintenance preserved: cache/stamp-state/.cah-tmp-1-bbbb      ← duplicate of line 2
    maintenance preserved: cache/rate-context/.cah-tmp-1-aaaa     ← duplicate of line 3

  skills (subset: clock): wrote 1, skipped 0 (…), preserved 1 (user data)
    kept: clock/leaf.md.cah-owned-remove
    maintenance: visits 9, recovery 0, temps 0, swept 0, preserved 1
    maintenance preserved: clock/leaf.md.cah-owned-remove          ← duplicate of `kept:`
```

Secondary, same block: `swept` is bounded by `RECOVERY_SWEEP_LIMIT = 32` per sweep
(`lib/fs-atomic.js:46`), but `preserved` is every enumerated artifact, bounded only by
`RECOVERY_LIMIT = 128` per category × three categories (`:45`, `:599-613`) × the five roots
`mergeCacheMaintenance()` scans (`lib/binstall.js:847`, `:870`). A badly damaged cache can therefore
emit far more `maintenance preserved:` lines than `maintenance swept:` ever could. Behaviour is
correct in both cases; only the report is noisier than it needs to be. Deduplicating against the
class-level `recovery`/`preserved`/`skipped` lists before printing, or printing a count plus the
first N, would close it.

### P3 — `EXPECTED_CALL_SITES`'s new explanatory comment mis-states the decomposition it exists to explain: there are three forwarding shims, not two

`test/interlocks.test.js:176-181`.

```js
    // A drift detector, not a production rendezvous count: 58 real
    // production rendezvous points + 2 forwarding shims that pass only
    // identifiers (lib/lease-lock.js's options.testInterlock(phase, stage)
    // and lib/fs-atomic-publication.js's options?.testInterlock?.(...phases)),
    // excluding the single `function testInterlock(` definition itself.
    const EXPECTED_CALL_SITES = 60;
```

Re-running the test's own scan over `lib/` + `bin/` with file:line attribution returns 60 call
starts / 60 parsed, and three of them are forwarding shims that pass only identifiers, not two:

| site | shape |
|---|---|
| `lib/lease-lock.js:394` | `options.testInterlock(phase, stage)` — named in the comment |
| `lib/fs-atomic-publication.js:49` | `options?.testInterlock?.(...phases)` — named in the comment |
| `lib/fs-atomic.js:935-937` | `options?.testInterlock?.(...phases)` — **not named** |

The total `60` is right and the drift detector works; the decomposition is `57 + 3`, not `58 + 2`.
The omitted shim is textually identical to the one that *is* named, one file away, so the comment
reads as if it were exhaustive when it is not — which matters because the comment is the only
documentation of what the constant means when a future change moves it.

### P3 — the scan's `callStartRe` is a module-level `/g` regex shared between a `matchAll` consumer and an `exec` consumer, so the guard test is silently order-dependent

`test/interlocks.test.js:11` against `:191` and `:222`.

Round 66 hoisted `callStartRe` to module scope so the new nested-paren test could reuse it. The two
consumers treat its `lastIndex` differently:

- `:191` `source.matchAll(callStartRe)` — per spec, `RegExp.prototype[@@matchAll]` copies the
  original's `lastIndex` onto the clone it iterates, and leaves the original's untouched.
- `:222` `callStartRe.exec(source)` — advances the original's `lastIndex`.

Measured:

```
lastIndex before: 0   matchAll matches: 5   lastIndex after: 0
lastIndex = 3     →   matchAll matches: 2   (the first three are skipped)
exec on the nested-paren fixture → lastIndex now 33
```

Today the scan runs first (node:test executes an `it` sequence in declaration order) so the effect
is nil. Reverse the two tests, or add a third `exec` consumer above the scan, and every scanned file
in `lib/` and `bin/` is read from byte 33 onward — silently, because the scan's own self-check
(`callStarts === parsedCalls`) compares two numbers that both shrink together. That is precisely the
"never under-count silently" property the surrounding comment (`:159-164`) claims. A local
`new RegExp(...)` per consumer, or `callStartRe.lastIndex = 0` before each use, removes the coupling.

### P3 — `test/interlocks.test.js` is the only tracked text file with no trailing newline

`test/interlocks.test.js:233` (`});` with no terminating `\n`; introduced by `560bf41`, whose diff
ends `\ No newline at end of file`).

A sweep over all 137 tracked `.js/.mjs/.cjs/.md/.json/.sh/.bat/.toml/.yml/.yaml` files finds exactly
one such file. No behaviour change; it makes the next diff that touches the last line noisier than
it needs to be, and it is the sort of drift the repository is otherwise free of.

## Disposition

Useful order if these are worked:

1. **The P1** (`lib/fs-atomic-publication.js:391`/`:395`). Two lines, no design decision, and it is
   the only defect here that a user can hit today without a crash, a recycled pid, or an orphan
   directory. Fix both reads and the fence loop does what it was built to do.
2. **The pid-reuse P2** (`lib/fs-atomic-publication.js:656-658`). It is a live regression from
   `560bf41` with a worse blast radius than the P3 that change was closing, and the correction is a
   single added conjunct. This one should not sit: unlike most findings in this cycle it degrades a
   *user-visible* surface (the statusLine) and does so permanently.
3. **The `pruneOrphanDirs` P2** (`lib/fsutil.js:286`) — same class as (1), one `try`/`catch` with a
   `continue`, matching the two guarded reads already in that function.
4. The three `test/interlocks.test.js` P3s together (one commit; none touches product code).
5. The report duplication (`lib/cli.js:283-285`).

Round 66's three changes were checked individually:

- **The empty-proof-less publication-fence reclaim is correct and complete for its own artifact
  class.** `reclaimableUnprovedPublicationFence()` (`lib/fs-atomic.js:694-699`) re-checks identity,
  emptiness and age, and the sweep re-checks identity and emptiness again immediately before
  `rmdirSync` (`:728-743`), so a concurrently repopulated or recreated fence fails `ENOTEMPTY` or an
  identity mismatch and is preserved. The freshness window is the same `FENCE_STALE_MS = 1 000 ms`
  an *acquirer* already applies to a proof-less fence (`fenceIsStale()` at
  `lib/fs-atomic-publication.js:165-172`, reached from `:680`), so the sweep grants itself exactly
  the authority `recoverLegacyFence()`'s empty-directory branch (`:585-600`) already had — no new
  exposure. Verified in a sandbox home: a planted stale
  `cache/stamp-state/dead-session.json.cah-owned-publish` is now swept and reported
  (`maintenance swept: …`), while round 66's own new test proves the fresh case is refused.
- **The symmetric gap the prompt asked about is real but already dispositioned.** The sweep knows
  three namespace kinds; rounds 65 and 66 taught it to reclaim an empty, proof-less member of two of
  them (`.cah-owned-remove`, `.cah-owned-publish`) and the third, `lease-quarantine`, still has no
  sweep branch at all. Verified in an isolated directory: an hour-old empty `.cah-lease-quarantine`
  is `preserved` and never swept, and one containing only an empty `.slot-0` is classified
  `displacedData: true` and reported as `recovery` forever even though it holds nothing. Both states
  are reachable by a crash inside `quarantineFenceDir()` (`lib/lease-lock.js:467-484`) between
  `mkdirSync(quarantineRoot)` and the compensating `rmdirSync` at `:479`. This is *not* filed as a
  new finding: round 63 already reported the empty-root leak (its `lib/lease-lock.js:467` bullet)
  and round 65 explicitly dispositioned the read-only handling of
  `kind: 'lease-quarantine'` as intended. Round 66 simply widened the asymmetry between the three
  classes; if it is ever closed, the reclaim predicate is the one it just wrote.
- **The balanced-paren scan itself is sound.** `scanCallArguments()` and `splitArguments()`
  (`test/interlocks.test.js:32-86`) were re-implemented independently and run over `lib/` + `bin/`
  with file:line attribution: 60 call starts, 60 parsed, no unparseable site, and the recovered
  `args[1]` literal set is exactly `STAGE_NAMES` ∪ the six declared probe aliases. The blind spot
  round 66 named (a `)` inside the arguments) is genuinely closed; the two remaining weaknesses are
  the P3s above (a mis-stated comment and shared regex state), plus two structural limits worth
  recording without filing: the walker does not model regular-expression literals (a
  `testInterlock(/\(/.test(x), 'stage')` would mis-balance) and `splitArguments()` skips strings but
  not comments. Neither shape exists in the tree.
- **The `deferForeignCommitted` split does hold for the case it was written for.** A three-way and a
  five-way race of real publisher processes on one leaf shows no livelock, no starvation and no
  stranded fence: with 3 publishers × 40 publications, 93/120 succeeded and 26 got the classified
  conflict in 1.28 s; with 5 publishers, 160/200 succeeded in 2.40 s; `leftovers: []` in both. The
  deferral cannot deadlock across leaves either, since a publisher holds at most one fence at a
  time. Its defect is the *liveness oracle*, not the deferral (finding 2).
- **The `maintenance preserved:` visibility half achieves what it set out to.** With a fresh empty
  fence planted in `cache/stamp-state/`, the refusal is now named in the report instead of being
  silent; the only complaint is that artifacts which already had a line now have two (finding 4).

Verification that the rest of the tree has not drifted:

- Every generated and hand-written invariant still holds: 44 model definitions → 88 bodies, 23 Codex
  agents, 11 skills, no duplicate or overlapping names, every skill's template + `name:` +
  `npx cah install --only <name>` README line present, no orphan template directory, no stale
  `SkillDeps` key, `--only commands` / `--only codex-agents` / `--only bins` examples present,
  `package.json` `0.8.0` = `lib/update-check.js`'s `CURRENT_VERSION`, `BinFiles` 17 entries in
  dependency-first order with `validateBinFileOrder()` passing at module load.
- The mechanical hygiene sweeps come back empty apart from finding 7: zero unused import bindings
  across all 69 tracked JavaScript files; all 137 tracked text files decode as strict UTF-8 with no
  CRLF, and the only two `U+FEFF` occurrences remain the deliberate compatibility literal in
  `test/probe.test.js` and round 62's quotation of it.
- The long-standing P3 that rounds 63-66 all deferred is unchanged: `quarantineFenceDir()`'s 32-slot
  loop (`lib/lease-lock.js:473-478`) is still not deadline-gated, and `lib/lease-lock.js` is still
  **999** lines against `test/source-size.test.js`'s `maximumLines = 1000`, so that fix still needs
  an extraction first.
- `lib/probe.js`, `lib/binstall/runtime.js`, `lib/binstall-repair.js`, `lib/skills.js`,
  `lib/marker-state.js`, `lib/transcript-stats.js`, the four companion bins, the manifest, the doc
  generator and the eleven skill templates were read again; beyond the items above no additional
  confirmed P0-P3 defect was identified. That is not a claim that every filesystem race has been
  eliminated — this round's two strongest findings came from a contention harness no earlier round
  had built, and the same technique applied to the lease and marker-capacity layers is the obvious
  next probe.

**On convergence.** Round 66 was the first clean-ish round of this cycle and read like a plateau.
It was not. The two defects above that a user can actually observe were both found by changing the
*method* — running several real publisher processes against one leaf instead of pausing one process
at an injected crash boundary — rather than by reading more carefully. Nine rounds of single-process
crash injection had normalised a code path (`beginFence()` → `recoverOccupiedFence()`) that is only
ever exercised under genuine contention, and the two unguarded reads sitting in it survived every
one of them. The cycle has not converged; it has exhausted one technique.

## Verification

- `env -u FORCE_COLOR npm test`: 622 total, 616 passed, 6 skipped, 0 failed, 78 suites (192.2 s).
- `FORCE_COLOR=1 npm test`: 622 total, 616 passed, 6 skipped, 0 failed, 78 suites (195.9 s).
  Round 58's `FORCE_COLOR` fix remains closed.
- The counts are +5 tests / +2 suites over round 66's 617/611/6/76, matching exactly what `560bf41`
  added (two tests in the new `empty proof-less publication fences` suite, one in the new
  `a foreign acquirer racing a live committed fence` suite, one in `test/cli.test.js`, one in
  `test/interlocks.test.js`). The skip count is unchanged at 6.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`): one "hardlink metadata is not portable on this Windows runner"
  (`test/binstall.test.js:642`), three "POSIX mode bits are not portable on Windows"
  (`test-support/installer-atomic.cases.js:36`, `:51`, `:178`), two "nanosecond mtime restoration is
  not deterministic on Windows" (`test/probe.test.js:578`, `:601`). Every round-58 … round-66
  regression test really runs on this host.
- `node --check` over all 69 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- **Finding 1 (P1) reproduction.** `N` separate `node` processes each looping
  `writeFileAtomic(leaf.json)` 120 times with a fresh `expectedDestination`, in an isolated temp
  directory: with 6 publishers, 4 exited non-zero with a raw `ENOENT` (two at
  `lib/fs-atomic-publication.js:391`, two at `:395`); with 2 publishers, 2 of 3 runs hit it. Full
  stacks captured and quoted above; every run ended with `leftovers: []`. CLI-level reproduction:
  two concurrent `cah install --only agents` into one sandbox `HOME`/`USERPROFILE`, 14 runs — 13
  produced the correct classified `managed destination leaf changed concurrently` conflict, one
  produced `cah install: agents: ENOENT: … 'fl.md.cah-owned-publish\publication.json.tmp'`, exit 1.
- **Finding 2 (P2) reproduction and counterfactual.** A real child publisher paused at the product's
  own `write-after-final-rename` interlock and `SIGKILL`ed there; its proof's `ownerPid` repointed at
  a live unrelated process and `createdAtMs` aged 1 h. The parent's `writeFileAtomic()` on the same
  leaf returned `FAILED:EEXIST` after 30 817 ms with the fence still present. On the same fixture,
  `maintainRecoveryArtifacts()` swept nothing and listed the fence only under `preserved`, while
  `recoverPublicationFence(dest, { deferFresh: true, deferCommitted: false })` — the exact option set
  `beginFence()` used before `560bf41` — returned `true` and removed it.
- **Finding 3 (P2) reproduction.** `pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill)` over
  one orphan directory holding a managed `SKILL.md`, with a separate process removing that directory
  during `captureRegularFileSnapshot()`. Ten delays (10, 20, 30, 40, 50, 60, 80, 100, 130, 160 ms),
  ten identical `ENOENT … scandir` throws from `lib/fsutil.js:286`.
- **Finding 4 (P3) reproduction.** Sandbox `HOME`/`USERPROFILE`, two planted `.cah-tmp-` leftovers
  plus a stale empty `cache/stamp-state/dead-session.json.cah-owned-publish`: `cah install --only
  bins` printed `maintenance: visits 75, recovery 0, temps 2, swept 1, preserved 2`, one
  `maintenance swept:` line and two `maintenance preserved:` lines duplicating the two `recovery:`
  lines above them. Second sandbox with a planted
  `skills/clock/leaf.md.cah-owned-remove`: `kept: clock/leaf.md.cah-owned-remove` and
  `maintenance preserved: clock/leaf.md.cah-owned-remove` in the same block.
- **Finding 5 (P3).** The test's scan re-implemented independently over `lib/` + `bin/`: 60 call
  starts, 60 parsed, all sites attributed; the three identifier-only forwarding shims are
  `lib/lease-lock.js:394`, `lib/fs-atomic-publication.js:49` and `lib/fs-atomic.js:936`, leaving 57
  real rendezvous points.
- **Finding 6 (P3).** `matchAll` honours and preserves the source regex's `lastIndex`
  (`lastIndex = 3` over `'aaaaa'` yields 2 matches, original left at 3); `callStartRe.exec()` on the
  nested-paren fixture leaves `lastIndex = 33`.
- **Finding 7 (P3).** Trailing-newline sweep over every tracked text file: 137 files, one offender
  (`test/interlocks.test.js`).
- **Concurrency sanity for round 66's own change:** 3 and 5 real publisher processes × 40
  publications each on one leaf — 93/120 and 160/200 published, the remainder classified conflicts,
  `leftovers: []` and a consistent final payload in both.
- **Lease-quarantine symmetric-gap probe:** an hour-old empty `.cah-lease-quarantine` →
  `swept: []`, `preserved: ['.cah-lease-quarantine']`, still present; the same directory holding
  only an empty `.slot-0` → `kind: 'lease-quarantine'`, `displacedData: true`, reported as
  `recovery`, still present.
- **CLI smoke test** in a sandbox `HOME`/`USERPROFILE` outside the repository: `install` (agents 44,
  skills 11, bins 17, zero skipped/recovery), `doctor` → `mine: 72, legacy: 0, foreign: 0,
  missing: 0`, exit 0.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this document;
  every temp directory and sandbox home was created and deleted outside the repository, and the real
  `~/.claude` was never written to. No version change, no push.
