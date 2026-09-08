# cc-arch-hands review — round 66

- Baseline: `ab9fb6d` (`fix: close round 65 committed-fence race and cleanup gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 65's four changes — the
  `deferCommitted: true` maintenance guard in `lib/fs-atomic.js`, the explicit
  `deferCommitted: false` in `beginFence()`, the `RESERVATION_FRESH_MS` freshness guard on the
  quarantine sweep branch, and the hardened `STAGE_NAMES` regression test in
  `test/interlocks.test.js` — each probed with isolated reproductions rather than by reading the
  commit message, plus a full trace of the publication lifecycle from `beginFence()` through
  `finishPublication()`'s `cleanupPublicationFence()` looking for a *third* exposure window.
  Second, a fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`, `templates/`, `scripts/`,
  `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), a
  third serialized TAP run enumerated the skips exactly, the doc-generation gate and a full
  `node --check` were run, a 12-cell publication-lifecycle race matrix and three further isolated
  reproductions were built outside the repository, and the CLI was smoke-tested end to end in a
  sandbox `HOME`/`USERPROFILE`. Nothing outside this document was modified. The real `~/.claude`
  was never touched.
- P0 findings: none
- Result: 3 P3, no P0/P1/P2. **Round 65's headline fix is complete on the maintenance side**: a
  12-cell matrix that pauses a real publisher at every crash boundary in `publishWithFence()` and
  races `maintainRecoveryArtifacts()` against it shows the sweep now sweeps nothing and the
  publisher always succeeds — at every phase, not just the two the fix names. The three findings
  below are the *residue* around that fix: one third path into the same window B that is not
  maintenance, one artifact class no sweep branch can reach and no report line can show, and one
  test assertion that cannot detect the case its own message names. None changes behaviour that a
  user sees today.

## Findings

### P3 — `beginFence()`'s `deferCommitted: false` is a third path into window B: a *foreign*, live publisher's committed fence is still reaped, and that publisher still throws `ERR_ATOMIC_RECOVERY_REQUIRED` over data it already committed

`lib/fs-atomic-publication.js:699-700` against `:644-658`.

Round 65 closed window B for the maintenance sweep and deliberately left it open for fence
acquirers:

```js
      if (!recoverOccupiedFence(destPath, path,
        { ...options, deferFresh: true, deferCommitted: false })) {
```

The stated reason (`lib/fs-atomic-publication.js:645-651`) is correct but only covers one of the
two cases the flag conflates:

> an acquirer must finish a committed predecessor's fence unconditionally — including one this
> same process created — or a re-publication would spin against a fence nobody will clean.

The same-process case is real: `proofOwnerIsAlive()` returns `true` unconditionally when
`pid === process.pid` (`lib/fs-atomic-publication.js:178`), so a same-process deferral would never
expire and `beginFence()` would burn all 100 attempts. Round 65's own regression test
(`test/fs-atomic.test.js:137-159`) pins exactly that. But the flag is `false` for *every* acquirer,
so a second **process** publishing to the same leaf also reaps a live peer's committed fence — and
the victim gets the identical symptom round 65 set out to eliminate.

Reproduction, isolated temp directory, real product code, a child paused at each of the library's
own crash boundaries while the parent either runs `maintainRecoveryArtifacts()` (the round-65 case)
or runs `writeFileAtomic()` against the same leaf (this case):

| child paused at | parent = maintenance | parent = second publisher |
|---|---|---|
| `write-after-temp-create` | swept `[]`, child `PUBLISHED` | parent `PUBLISHED`, child `PUBLISHED` |
| `write-before-rename` | swept `[]`, child `PUBLISHED` | parent `PUBLISHED`, child `PUBLISHED` |
| `write-after-proof-before-final-operation` (window A) | swept `[]`, child `PUBLISHED` | parent `PUBLISHED` — but only after ~30 s of `deferFresh` backoff (see note) |
| `write-after-rename-before-sync` (window B) | swept `[]`, child `PUBLISHED` | parent `PUBLISHED`, **child exit 3 `FAILED:ERR_ATOMIC_RECOVERY_REQUIRED`** |
| `write-after-final-rename` (window B) | swept `[]`, child `PUBLISHED` | parent `PUBLISHED`, **child exit 3 `FAILED:ERR_ATOMIC_RECOVERY_REQUIRED`** |
| `write-after-rename` (post-cleanup) | swept `[]`, child `PUBLISHED` | parent `PUBLISHED`, child fails on its own CAS (correct) |

The mechanism is the mirror image of round 65's: the acquirer reaches the `committed` branch,
`options.deferCommitted` is `false`, so it runs `cleanupPublicationFence()` on the victim's fence;
the victim's `finishPublication()` (`lib/fs-atomic-publication.js:549-555`) then finds
`directoryIdentity(publication.path)` no longer matching its own, `cleanupPublicationFence()`
returns `false` at `:463-464`, and `writeFileAtomic()` throws — with its payload already at the
canonical destination. No data is lost, no recovery state is stranded (`leftovers: []` in every
cell), and the acquirer's own publication is correct.

Why this stays P3 rather than P2: every production caller that can have two *unsynchronised*
publishers on one leaf swallows the throw or already fails.

- `cache/rate-limits.json` and `cache/rate-context/<hash>.json` — written by `cah-status` with no
  lock at all (`lib/transcript-stats.js:576`, `:580` via `writeJsonAtomic` at `:391-399`). Two
  Claude Code windows render concurrently against the same global file, so this is the one
  genuinely reachable pair — and `writeJsonAtomic` returns `false` silently, the winner's value is
  the newer one, and the next render republishes. Benign.
- `cache/stamp-state/…json` — serialised by the per-sidecar lease `acquireStampLock()`
  (`bin/cah-stamp.js:256-265`); `removeStampSidecar()` takes the same lock
  (`bin/cah-stamp.js:162-163`), so round 65's symptom cannot recur here.
- `cache/update-check.json` — serialised by `acquireRefreshLock()` (`lib/update-check.js:44-52`),
  and the `!published` branch at `:172-177` already re-reads the concurrent winner.
- marker leaves and `transaction.json` — under claim/capacity leases.
- Two concurrent `cah install` runs on `agents`/`commands`/`skills` (no lease) — the reap turns
  "one success plus one clean `managed destination leaf changed concurrently` conflict" into two
  failures. Same class of outcome, worse message.

Fix direction if this is ever closed: the deferral needs to distinguish the two cases the single
`false` conflates, i.e. defer in the committed branch when
`Number(proof.ownerPid) !== process.pid && proofOwnerIsAlive(proof)`, and never otherwise. That
keeps round 65's same-process test green while removing the last path into window B.

Side observation from the window-A cell, not itself a finding: `beginFence()`'s deferral budget is
`20+40+80+160 + 95×320 ms ≈ 30.7 s` (`FENCE_ACQUIRE_RETRIES = 100`,
`lib/fs-atomic-publication.js:15`, backoff at `:703`). A peer genuinely wedged inside window A
therefore blocks the acquirer synchronously for half a minute. That is the deliberate cost of
round 64's `deferFresh`, and it has no realistic trigger (window A is microseconds unless the peer
is itself stuck), but it is the reason the child in that cell hit its own 20 s interlock deadline
before the parent returned.

### P3 — an empty, proof-less `*.cah-owned-publish` fence is unreachable by every sweep branch and invisible in every report

`lib/fs-atomic.js:710-711` and `:832-834` against `lib/fs-atomic.js:734-744`.

The sweep engages a publication namespace only when a proof exists:

```js
    } else if (artifact.kind === 'publication' && !artifact.displacedData
      && (artifact.publicationProof || provenOwnedPath(artifact.path, options.ownedPublicationPaths))) {
```

`publicationProof` is `Boolean(readPublicationProof(path) || lstat(publication.json.tmp))`
(`lib/fs-atomic.js:832-834`), and `ownedPublicationPaths` is passed by exactly one caller in the
repository — `test-support/installer-atomic.cases.js:416` — never by
`lib/binstall.js:884`, `lib/fsutil.js:94`, `lib/fsutil.js:237`, or
`lib/skills.js:168`/`:668`/`:772`. So a fence directory that is empty (no `publication.json`, no
`publication.json.tmp`, no `old` child) matches no branch and falls straight through to
`preserved.push(artifact.path)` at `lib/fs-atomic.js:755`.

That state is not hypothetical: it is exactly what `cleanupPublicationFence()` leaves if the
process dies, or `rmdirSync` transiently fails, between its `unlinkSync` loop and its `rmdirSync`
(`lib/fs-atomic-publication.js:484-490`), and what `beginFence()`'s own unwind leaves if its
`rmdirSync` fails (`lib/fs-atomic-publication.js:722-724` — one attempt, no retry, error
swallowed).

Reproduction, isolated temp directory, real product code:

```
sweep#1  swept=0  preserved=[leaf.json.cah-owned-publish]  recovery=0  unprovedTemps=0
         fence still present after sweep: true
sweep#2 (fence now 1.5 s old)  swept=0  present: true
after republication of leaf.json          fence present: false   dir: [ 'leaf.json' ]
```

Two things follow.

1. **The sibling branch does the opposite.** An empty `*.cah-owned-remove` reservation carries
   exactly as much proof as an empty `*.cah-owned-publish` fence — none — and round 65 kept
   sweeping it, adding only a freshness guard (`lib/fs-atomic.js:742-744`). The code to reclaim the
   publication side already exists and is already reached by an *acquirer*:
   `recoverLegacyFence()`'s empty-directory branch (`lib/fs-atomic-publication.js:585-600`) is what
   removes it on republication in the trace above. Maintenance simply never gets there, because
   `recoverPublicationFence()` is only called when a proof was found.
2. **Nothing else will ever remove it for an abandoned leaf.** `cache` is a `ReservedRootEntries`
   member so neither `removeBins`' root sweep (`lib/binstall.js:818-831`) nor `rmdirIfEmpty` touch
   it; `pruneOrphans`/`pruneOrphanDirs` skip it by name (`lib/fsutil.js:119`, `:234`);
   `pruneStampSidecars` matches only `…json` regular files (`bin/cah-stamp.js:209-213`). A dead
   session's sidecar is never republished, so its leaked fence directory is permanent.

The second half of the finding is the reporting gap that makes it invisible.
`maintainRecoveryArtifacts()` puts such an artifact only in `preserved`
(`lib/fs-atomic.js:777-785`); `mergeCacheMaintenance()` projects only `unprovedTemps` and
`recovery` into the installer's `recovery` list (`lib/binstall.js:897-902`); and `reportClass()`
prints `skipped`, `recovery`, `preserved` (the *class* one, which `writeBins` does not return),
the `visits / recovery / temps / swept` counters and the `maintenance swept:` lines — but never
`maintenance.preserved` (`lib/cli.js:242-288`). Verified end to end in a sandbox home: with a
planted `cache/stamp-state/dead-session.json.cah-owned-publish`,

```
  bins: wrote 17, skipped 0 (foreign or canonical survivor), recovery 2 (quarantine)
    recovery: cache/stamp-state/.cah-tmp-1-bbbb
    recovery: cache/rate-context/.cah-tmp-1-aaaa
    maintenance: visits 75, recovery 0, temps 2, swept 0
```

— the two `.cah-tmp-` leftovers are reported (they land in `unprovedTemps`), the fence directory is
not mentioned anywhere, and the survivor listing confirms it is still there.

This is the mirror of the obligation round 64 introduced at `lib/cli.js:273-274` ("A destructive
maintenance action inside a namespace the installer does not own must be visible, never silent"):
an artifact the sweep *refused* to reclaim is equally worth showing, and rounds 64 and 65 moved
strictly more artifacts into that silent bucket (every live-publisher deferral now lands there
too).

Impact is genuinely small — one empty directory per abandoned leaf that crashed in a microsecond
window — which is why this is P3 and not P2. The escalation path is bounded and self-announcing:
past `RECOVERY_VISIT_LIMIT = 128` (`lib/fs-atomic.js:47`) the namespace scan reports `truncated`,
which `reportClass` does surface as `warning: cache maintenance … truncated`
(`lib/cli.js:278-287`).

### P3 — round 65's hardened interlock test cannot detect the failure mode its own assertion message names

`test/interlocks.test.js:90-91` and `:124-126`.

Round 65 replaced the single-line-only scan with a two-regex scheme and added a self-check:

```js
    const callStartRe = /testInterlock(?:\s*\?.\s*)?\(/g;
    const callArgsRe = /testInterlock(?:\s*\?.\s*)?\(([^)]*)\)/g;
...
    assert.equal(callStarts, parsedCalls,
      'every testInterlock call site must be fully parseable by the scan; '
      + 'a call whose arguments contain a ")" breaks the argument regex');
```

The multi-line half is genuinely fixed: re-running the test's own scan over `lib/` + `bin/` with
file:line attribution now yields 61 matched call sites including the three round 65 identified as
invisible (`lib/marker-capacity-ops.js:293`, `lib/marker-capacity-stage.js:65`, `:119`), and their
`'before'` / `'marker-capacity-stage-reconcile'` arguments are parsed.

The self-check, however, cannot fire for the case it describes. `callArgsRe`'s `[^)]*` stops at the
*first* `)`, so a call whose arguments contain a `)` still produces exactly one `callArgsRe` match
— a truncated one — and the two counters stay equal:

```
source:      testInterlock(phaseFor(config), 'brand-new-stage');
callStarts   1
parsedCalls  1
group1       "phaseFor(config"
args[1]      undefined
```

A future call site of that shape introducing a new stage would raise `parsedCalls` and
`EXPECTED_CALL_SITES` in lockstep, silently contribute no stage literal, and pass — which is
precisely round 62's regression class the test exists to prevent. The `EXPECTED_CALL_SITES = 61`
constant itself is fine as a drift detector (any change to the count fails loudly and the message
tells the developer to re-check `STAGE_NAMES`); the weak link is only the `)` case. Balancing
parentheses in the scan, or asserting that every matched call's argument text ends where the
following `;`/newline does, would close it.

Two cosmetic notes on the same test, no behaviour change: `EXPECTED_CALL_SITES` counts
`lib/lease-lock.js:393` (the `testInterlock` *definition*) and `:394` (its internal forwarding
call) as call sites, so the constant is 61 where the number of real production rendezvous points is
59.

## Disposition

The three findings are independent and none is urgent. If they are worked, the useful order is:

1. The `test/interlocks.test.js` blind spot — it is the guard against re-introducing round 62's
   regression class, and it is a two-line change with no product risk.
2. The unreachable/invisible empty publication fence — the reclaim side is a one-line addition to
   the sweep's publication branch (`directoryIsEmpty(...) && isOlderThan(...)`, symmetric with the
   quarantine branch two blocks below it), and the report side is one `for` loop in `reportClass`
   plus one projection in `mergeCacheMaintenance`.
3. The `beginFence()` acquirer path — real, reproducible, but no production caller currently turns
   it into a user-visible outcome, and closing it needs care not to regress round 65's
   same-process test.

Round 65's changes were checked individually and all hold:

- **The `deferCommitted` fix is complete on the maintenance side, and it is complete across the
  *whole* lifecycle, not just window B.** The 12-cell matrix above pauses a real
  `writeFileAtomic()` at six distinct boundaries and races `maintainRecoveryArtifacts()` against
  each; the sweep reports `swept: []` in every one and the publisher exits `PUBLISHED` in every
  one. Tracing the lifecycle by hand agrees and explains why: the fence is only ever visible to
  maintenance in five states, and each is now guarded by a different mechanism —
  (a) `mkdir` → first proof byte: no proof at all, so the sweep branch is not entered (production
  never passes `ownedPublicationPaths`);
  (b) a partially written `publication.json.tmp`: `readPublicationProof()` returns `null`, so
  `recoverOccupiedFence()` falls to `lib/fs-atomic-publication.js:676`'s `deferFresh` +
  `fenceIsStale(fencePath)` fence-mtime check, which is fresh;
  (c) complete proof, uncommitted: round 64's `deferFresh` at `:660-662`;
  (d) committed, fence not yet cleaned: round 65's `deferCommitted` at `:652-654`;
  (e) `cleanupPublicationFence()` between its `unlinkSync` loop and its `rmdirSync`: no proof
  again, so the branch is not entered. State (e) is where finding 2 lives, but it is a leak, not a
  race — maintenance cannot damage a live publisher there.
- **`deferCommitted: false` in `beginFence()` really is required for the same-process case**, and
  round 65's new test at `test/fs-atomic.test.js:137-159` is not a tautology: it drives a real
  post-commit failure through the `write-after-final-rename` interlock, confirms the payload
  committed and the fence survived, and then proves the next same-process publication removes it.
  Finding 1 is that the flag is also `false` for foreign acquirers, not that the flag is wrong.
- **The `RESERVATION_FRESH_MS` guard has no remaining production gap.** The reservation is empty in
  exactly two spans of `removeOwnedRegularFile()` — `mkdirSync` → payload `renameSync`
  (`lib/fs-atomic.js:506` → `:452` in `renameForRemoval`), and payload `unlinkSync` → reservation
  release (`:480` → `:404`). The second span refreshes the directory mtime as its first act, so it
  is always fresh. The first span costs one `directoryIdentity`, one
  `captureRegularFileSnapshot` of a small managed leaf, and at most 300 ms of
  `renameForRemoval` backoff (20+40+80+160 ms across `RENAME_RETRIES = 5`) — comfortably inside
  the 1 000 ms window even with the `assertOwnership` → `renewLease` calls on the binstall path
  (a cheap `owner.json` read; the fenced heartbeat only fires past `maxLeaseMs / 2` = 2.5 min).
  `isOlderThan()` is also correctly conservative in both degenerate directions: a non-bigint
  `mtimeNs` or a future mtime (clock skew) yields `false`, i.e. preservation
  (`lib/fs-atomic-identity.js:131-134`). Verified end to end in a sandbox home: a fresh
  `cache/fresh.cah-owned-remove` survives `cah install --only bins` while a
  `cache/stale.cah-owned-remove` aged 5 s is swept and reported as
  `maintenance swept: cache/stale.cah-owned-remove`.
- **No other unguarded bare-`mkdirSync()` reservation is exposed to a sweep.** The seven other
  non-recursive `mkdirSync` sites were checked against `describeRecoveryArtifact`'s name rules:
  `lib/lease-lock.js:333` (`restoreWithoutOverwrite`) and `:606` (the lease directory itself) use
  names the sweep does not recognise and are governed by `claimExpired()`'s 30 s / 5 min policy
  instead; `lib/lease-lock.js:428` (`moveFenceContents`) and `:770`
  (`quarantineOwnedFileFence`, `…​.fence.quarantine`) live under names that map to
  `kind: 'lease-quarantine'` or to no kind at all, and neither matches a sweep branch;
  `lib/marker-capacity-ops.js:239`/`:261` (`.cah-retired-…`) are reconciled explicitly under
  `assertOwnership` in `transactionInspection()` (`lib/marker-capacity-recovery.js:79-117`);
  `lib/marker-capacity-ops.js:423` (`.cah-tmp-victim-…`) *is* classified `kind: 'temp'`, but the
  temp branch requires `provenOwnedTemp()` and production never supplies `ownedTempPaths`, so it is
  preserved (and, for the marker namespaces, reported as an unproved temp);
  `lib/marker-state.js:333` and `lib/skills.js:435` are not under a scanned root.
- **The hardened `STAGE_NAMES` test really does see the previously invisible call sites.** The
  scan re-implemented independently over `lib/` + `bin/` returns 61/61 with no per-file mismatch,
  and the three multi-line sites round 65 named are present with their stage literals. Finding 3 is
  about a different, still-open blind spot.
- **The unused-import cleanup is closed and no new one appeared.** A comment-stripped sweep of
  every import clause (including multi-line and `as` forms) across all 69 tracked JavaScript files
  reports zero unused bindings; round 65's `test-support/stamp-state.cases.js:3` `spawn` is gone.
- **The corrected `quarantineFenceDir()` comment (`lib/lease-lock.js:463-466`) now matches the
  code**, and the underlying P3 that rounds 63/64/65 all deferred is unchanged and still open: the
  32-slot loop at `lib/lease-lock.js:473-478` is still not deadline-gated (only the
  `withTransientRetry()` calls inside each `moveFenceContents()` are, at `:431-435`).
  `lib/lease-lock.js` is still **999** lines against `test/source-size.test.js`'s
  `maximumLines = 1000`, so that fix still cannot land here without an extraction first.

Two candidates were investigated and deliberately dropped:

- `maintainRecoveryArtifacts()`'s post-sweep categorisation loop does a raw
  `lstatMaybe(artifact.path)` (`lib/fs-atomic.js:782`) *outside* the `try/catch` that wraps
  `sweepRecoveryArtifacts()` (`:762-770`), and `lstatMaybe` rethrows every non-`ENOENT` error. Two
  of the three callers that reach it — `pruneOrphans` (`lib/fsutil.js:94`) and `writeSkills` /
  `removeSkills` (`lib/skills.js:168`/`:668`/`:772`) — do not catch, so such a throw would surface
  as a raw errno from `cah install`, contradicting the "maintenance is never part of the
  transaction" rule that `lib/binstall.js:856-860` states and implements. It is only reachable if a
  path becomes unstattable between enumeration and that loop. I could not build a deterministic
  reproduction on this host: `readdirSync` + explicit `DENY` ACEs on both a file and a directory
  still let `lstatSync` succeed (NTFS answers from the parent index entry), and the delete-pending
  `EPERM` shape needs a genuine cross-process race. Reported here as an observation rather than a
  finding, since prior rounds' bar is a reproduction.
- `cah-status` can block up to ~30.7 s in `beginFence()` when a peer holds a fresh window-A fence
  (see the note under finding 1). This is the intended cost of round 64's `deferFresh`, the
  trigger requires a peer wedged mid-publication, and the alternative is the bug round 64 fixed.

Beyond these items, the concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`,
`lib/marker-capacity-*.js`, `lib/marker-state.js`), the installers, the repair path, the runtime
description, the CLI, the probe, the four companion bins, the shared transcript library, the
manifest, the doc generator and the skill templates were read again and no additional confirmed
P0-P3 defect was identified. That is not a claim that every filesystem race has been eliminated.

**On convergence.** This is the ninth round of the cycle and the first with no P2 or higher. That
is a signal, not an accident, and the specific evidence for it is: (a) the finding that drove
rounds 64 and 65 — a maintenance sweep damaging a live publisher — is now closed at *every* phase
of the publication lifecycle, verified by a matrix that enumerates the phases rather than by
checking the two the fix names; (b) the two mechanical hygiene sweeps that produced findings in
recent rounds now come back empty (zero unused bindings across 69 files; 136 files all strict
UTF-8, LF-only, with the only two `U+FEFF` occurrences deliberate); (c) every generated and
hand-written invariant still holds (44 model definitions → 88 bodies, 23 Codex agents, 11 skills,
no duplicate or overlapping names, every skill's template/`name:`/README line present, no orphan
template directory, no stale `SkillDeps` key, `package.json` `0.8.0` = `CURRENT_VERSION`,
`BinFiles` 17 entries in dependency-first order); and (d) the suite grew by exactly the four tests
`ab9fb6d` added, with the skip set unchanged and identical results under both `FORCE_COLOR`
settings. What remains are residues: a deliberate trade-off with one uncovered case (finding 1),
one artifact class that fell between two branches (finding 2), and one assertion that is weaker
than its message (finding 3). None of them is a behaviour a user can observe today.

## Verification

- `env -u FORCE_COLOR npm test`: 617 total, 611 passed, 6 skipped, 0 failed, 76 suites (222.6 s).
- `FORCE_COLOR=1 npm test`: 617 total, 611 passed, 6 skipped, 0 failed, 76 suites (208.6 s).
  Round 58's `FORCE_COLOR` fix remains closed.
- The counts are +4 tests / +4 passes over round 65's 613/607, matching exactly the four tests
  `ab9fb6d` added (two in `test/binstall.test.js`, two in `test/fs-atomic.test.js`; the
  `test/cli.test.js` and `test/interlocks.test.js` changes modified existing tests). The skip count
  is unchanged at 6.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are all legitimate platform guards: `test/binstall.test.js`
  ("hardlink metadata is not portable on this Windows runner"), three "POSIX mode bits are not
  portable on Windows" guards in `test-support/installer-atomic.cases.js`, and two "nanosecond
  mtime restoration is not deterministic on Windows" guards in `test/probe.test.js`. Every
  round-58 … round-65 regression test really runs on this host.
- `node --check` over all 69 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names and no overlap between the
  two registries; every skill in `AllSkills` has a matching `templates/skills/<name>/SKILL.md`
  whose `name:` equals its directory name, and an `npx cah install --only <name>` line in
  README.md; no template directory is missing from `AllSkills`; every `SkillDeps` key is a real
  skill; README.md carries `--only commands`, `--only codex-agents` and `--only bins` examples;
  `package.json` version `0.8.0` equals `lib/update-check.js`'s `CURRENT_VERSION`. The
  hand-written skill counts in README.md (lines 25, 196, 333, 396, 528) are all covered by
  `scripts/gen-docs.js`'s `LITERAL_COUNT_ANNOTATIONS` and therefore by the `gen:docs:check` gate.
- `BinFiles` re-checked against CLAUDE.md's documented list: 17 destinations, `package.json` first,
  the twelve `lib/` leaves in dependency-first order, the four `bin/` executables last;
  `validateBinFileOrder()` runs at module load and passes.
- Publication-lifecycle race matrix (finding 1 and the round-65 verification): a child runs the
  real `writeFileAtomic()` and pauses at `write-after-temp-create`, `write-before-rename`,
  `write-after-proof-before-final-operation`, `write-after-rename-before-sync`,
  `write-after-final-rename` and `write-after-rename`; the parent then runs either
  `maintainRecoveryArtifacts()` on the directory or `writeFileAtomic()` on the same leaf. 12 cells,
  results in the table under finding 1. Maintenance swept nothing in all 6 cells and the child
  exited 0 with `PUBLISHED` in all 6; the second-publisher column shows the two window-B failures.
  Every cell ended with `leftovers: []`.
- Finding 2 reproduction: an empty `leaf.json.cah-owned-publish` beside a live `leaf.json`;
  `maintainRecoveryArtifacts()` swept nothing and listed it only under `preserved` both immediately
  and 1.5 s later; a subsequent `writeFileAtomic(leaf.json)` removed it. Repeated end to end in a
  sandbox `HOME`/`USERPROFILE` with the fence planted in `cache/stamp-state/`: `cah install --only
  bins` printed `maintenance: visits 75, recovery 0, temps 2, swept 0` and no line naming the
  fence, and the directory survived.
- Finding 3 reproduction: the test's own two regexes run against
  `testInterlock(phaseFor(config), 'brand-new-stage');` — `callStarts = 1`, `parsedCalls = 1`,
  captured group `"phaseFor(config"`, `args[1]` `undefined`. The equality assertion therefore
  cannot fire and the new stage is silently missed. Separately, the test's scan was
  re-implemented with file:line attribution over `lib/` + `bin/`: 61 call starts, 61 parsed, no
  per-file mismatch, and all three previously invisible multi-line sites present.
- `RESERVATION_FRESH_MS` boundary check in a sandbox `HOME`/`USERPROFILE`: with a fresh
  `cache/fresh.cah-owned-remove` and a `cache/stale.cah-owned-remove` aged 5 s plus two
  `.cah-tmp-` leftovers, `cah install --only bins` reported
  `maintenance: visits 78, recovery 0, temps 2, swept 1` and
  `maintenance swept: cache/stale.cah-owned-remove`; only the fresh reservation survived.
- Windows-ACL probe for the dropped `maintainRecoveryArtifacts()` candidate: explicit `DENY`
  ACEs (`RA,REA,RD,S,X` on a directory; `RA,REA,R` on a file) left `readdirSync` + `lstatSync`
  both succeeding, so no deterministic non-`ENOENT` `lstat` failure could be produced. ACEs removed
  and the fixture deleted.
- Unused-binding sweep over all 69 tracked JavaScript files (comment-stripped; import clauses
  including multi-line and `as` forms): zero.
- Encoding sweep over every tracked `.js/.mjs/.cjs/.md/.json/.sh/.bat/.toml/.yml/.yaml` file
  (136 files): all decode as strict UTF-8, none contains CRLF. The only two `U+FEFF` occurrences
  are the deliberate compatibility literal in `test/probe.test.js` and round 62's quotation of it.
- Node-version floor re-checked against `engines: >=18.19.0`: no runtime file uses an API newer
  than that floor (`.at(-1)` is Node 16.6, `replaceAll` is Node 15; no `toSorted`/`findLast`/
  `Object.hasOwn`/`Promise.withResolvers`/`fs.glob`), and `--test-concurrency` — the one flag
  `npm test` depends on — is exactly the reason `test/discovery-contract.test.js:83` pins that
  floor.
- CLI smoke test in a sandbox `HOME`/`USERPROFILE` outside the repository: `install` (agents 44,
  skills 11, bins 17, zero skipped/recovery), `doctor` → `mine: 72, legacy: 0, foreign: 0,
  missing: 0`, exit 0; then the two crash-leftover scenarios above.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; every temp directory and sandbox home was created and deleted outside the repository,
  and the real `~/.claude` was never written to. No version change, no push.
