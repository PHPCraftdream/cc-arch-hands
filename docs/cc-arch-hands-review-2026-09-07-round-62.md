# cc-arch-hands review — round 62

- Baseline: `ade9a60` (`fix: close round 61 fence-quarantine and cleanup gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 61's `releaseLease()` terminal
  `quarantineUnexpectedFence()` fallback and its shared-deadline change — including a sandboxed
  revert-and-compare that measures what the shared deadline costs, plus the hunt for the gap the
  fallback leaves. Second, a fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`, `templates/`,
  `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`), a
  third serialized TAP run enumerated the skips exactly, the doc-generation gate and a full
  `node --check` were run, and seven isolated temp-directory reproductions plus one throwaway
  `lib/` copy and one throwaway `scripts/`+`README.md` copy were built outside the repository.
  Nothing outside this document was modified.
- P0 findings: none
- Result: 2 P2, 1 P3 batch (14 items). Round 61's fix is confirmed genuinely fixed and
  load-bearing for the stray-entry case by experiment; it is nevertheless inert on both failure
  modes its own code comment names, and it shrank the transient-retry window by 3× in the process
  (see the first P2 below).

## Findings

### P2 — `releaseLease()`'s terminal `quarantineUnexpectedFence()` fallback cannot fire for either failure mode its own comment claims to cover, and round 61 simultaneously cut the transient budget from 3 × 250 ms to one shared 250 ms

`lib/lease-lock.js:884-895`, against `lib/lease-lock.js:449-473` and `lib/lease-lock.js:296-316`.

Round 61 replaced the round-60 loop tail with:

```js
  for (let attempt = 0; attempt < RELEASE_CLAIM_REMOVAL_ATTEMPTS; attempt += 1) {
    testInterlock(releaseOptions.interlockPhase, 'claim-removal', releaseOptions);
    if (removeClaimPath(fence.path, options.ownerFile, releaseOptions.recoveryDeadline)) return true;
  }
  // A rejection that never reads the deadline (the stray-entry guard, a
  // non-transient unlink error) cannot succeed by retrying. Dispose of the
  // fence through the same quarantine a later reclaimer would use, which
  // preserves the fence contents instead of stranding the claim directory.
  if (quarantineUnexpectedFence(fence.path, options.ownerFile, releaseOptions.recoveryDeadline)) {
    return true;
  }
  return false;
```

**(a) The fallback has a precondition the comment does not mention.**
`quarantineUnexpectedFence()` bails out at its third line:

```js
    const entries = readdirSync(fencePath);
    if (!entries.some((entry) => entry !== ownerFile)) return false;   // lib/lease-lock.js:453
```

So the fallback only ever engages when the fence holds an entry *other than* `owner.json`. Of the
four ways `removeClaimPath()` can return `false`, exactly one leaves such an entry behind:

| `removeClaimPath()` rejection | fence contents afterwards | quarantine fires? |
|---|---|---|
| stray-entry guard, `lib/lease-lock.js:301` | `owner.json` + stray | **yes** |
| non-transient `unlinkSync(owner.json)`, `:303-304` | `owner.json` only | no (`:453`) |
| non-transient `rmdirSync(fence)`, `:306-307` | empty | no (`:453`) |
| non-ENOENT `lstatSync`, `:313-315` | unknown/unreadable | no (`readdirSync` throws → `:470` catch) |
| transient code whose budget expired in `withTransientRetry` (`:136-151`, codes at `:19`) | `owner.json` only, or empty | no (`:453`) |

The comment names two triggers — "the stray-entry guard, a non-transient unlink error". The
second one is **not** covered. Neither is the transient-but-persistent case, which is the exact
scenario the comment round 61 wrote three files away describes:

```js
// A transiently pinned claim directory (a live handle on Windows) can outlast
// one recovery window, so the release is retried …          // lib/marker-state.js:457-459
```

Round 61's own regression test (`test/lease-lock.test.js:134-169`) injects a `stray` file at the
`vacancy` interlock — i.e. it exercises the one row of that table where the fallback works, and
never the rows where it does not.

Reproduction, lease level, isolated temp directory importing the unmodified repository library.
Case B injects an `owner.json` that cannot be unlinked (a directory in its place; `EPERM` on
Windows, `EISDIR` on POSIX) at the first `claim-removal` interlock — a stand-in for any
unlink/rmdir rejection that leaves the fence holding at most `owner.json`, including a transient
code whose budget expires:

```
A stray-entry (round 61 test case)  released=true   removals=3  ms=3    leftoverFences=0  quarantine=["claim.taken-…"]  successor=acquired
B owner.json unlink fails           released=false  removals=3  ms=263  leftoverFences=1  quarantine=null              successor=BLOCKED (null)
C empty fence                       released=true   removals=1  ms=1    leftoverFences=0  quarantine=null              successor=acquired
```

263 ms in case B is the whole `releaseLease` budget: attempt 1 spent it inside
`withTransientRetry`, attempts 2 and 3 returned immediately (`remaining <= 0` at
`lib/lease-lock.js:146`), and the fallback declined at `:453`.

End to end through `migrateLegacyStateFiles()`, injecting once at phase
`legacy-claim-reclaim-release` / stage `claim-removal` (the target claim's release, the sole call
site of `releaseClaimLease()` at `lib/marker-state.js:494`):

```
stray entry (round 61 covered case)  blocked=false  removals=4  ms=19   targetClaimPresent=true   stranded=[]                     acquireStampLock=acquired
owner.json unlink fails (uncovered)  blocked=true   removals=4  ms=271  targetClaimPresent=false  stranded=["…json.lock.taken-…"]  acquireStampLock=null (stamp dropped)
```

`lib/marker-state.js:494` returns `INDETERMINATE`, `migrateLegacyStateFiles` reports `blocked`,
and `bin/cah-stamp.js:338` returns before `acquireStampLock()` — round 58's P1 symptom verbatim,
on the sub-branch round 61's own fix does not cover. Round 61's fix *is* load-bearing: the same
harness on the stray-entry branch now converges (`blocked=false`, lock acquirable), which it did
not before `ade9a60`.

**(b) Round 61 also removed the only transient retry budget the loop had.** Replacing
`Date.now() + LEASE_RECOVERY_WAIT_MS` with the shared `releaseOptions.recoveryDeadline` means
`RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3` (`lib/lease-lock.js:27`) now buys **one** 250 ms transient
window, shared with `takeFence`, instead of up to three. An obstruction that clears between
250 ms and 750 ms was recoverable under round 60 and is a stranded fence under `ade9a60`.
Measured directly: a detached helper process releases the pin 400 ms after it appears, and the
same scenario is run against HEAD and against a throwaway `lib/` copy whose only difference is
the restored round-60 deadline expression.

| `lib/lease-lock.js` | released | claim-removal calls | elapsed | stranded fences |
|---|---|---|---|---|
| HEAD (`ade9a60`, shared deadline) | `false` | 3 | 264 ms | 1 |
| round-60 tail (fresh deadline per attempt) | `true` | 2 | 442 ms | 0 |

This is a defensible latency/robustness trade — round 61 made it deliberately, to close the
"latency multiplier" P3 — but the terminal quarantine it added as compensation does not cover the
window it gave up, because a transiently pinned `owner.json` leaves the fence holding nothing but
`owner.json`.

Blast radius is one invocation, not a five-minute outage, and it converges: the fence's operator
pid dies with this process, and a later invocation's `recoverFence()` (`lib/lease-lock.js:475-522`)
restores the claim through `restoreWithoutOverwrite()` at `:521` and reclaims it as expired.
Verified:

```
released=false  stranded=1  sameProcessAcquire=null (BLOCKED)  laterProcessAcquire=acquired (converged)  homeAfter=["claim"]
```

That is the same severity profile rounds 59, 60 and 61 assigned their versions of this finding.

Fix direction: the fallback's precondition is the bug. Either give `releaseLease()` a disposal
path for a fence that holds *only* `ownerFile` (it is provably this process's own fence —
`takeFence()` named it with `process.pid` and `sameOwnerSnapshot()` validated its contents at
`lib/lease-lock.js:553`), or let `recoverFence()` treat `operatorPid === process.pid` as
self-owned rather than "a live third party" and call it directly. Whatever is chosen, the
transient window given up in (b) should be restored under one explicit total budget rather than
silently traded away. `lib/lease-lock.js` is 968 lines against `test/source-size.test.js`'s
1000-line cap, so there are 32 lines of headroom.

### P2 — `probeStatus()` rejects settings files that `enableProbe()`/`disableProbe()` explicitly accept, so `cah probe statusline status` is the only probe entry point that fails on them

`lib/probe.js:539-541` and `lib/probe.js:40-52`, against `lib/probe.js:33-38` and
`lib/probe.js:262-271`.

`lib/probe.js` reads `settings.json` through two different parsers.

- The mutating paths (`enableProbe`, `disableProbe`) go through
  `readSettingsSnapshot` → `readJsonSnapshot` → `parseJsonText`, which strips **both** a real
  `U+FEFF` and the Latin-1-decoded UTF-8 BOM the file explicitly commits to supporting
  (`lib/probe.js:34-37`: *"Keep compatibility with older files/tests containing the UTF-8 BOM
  decoded once as Latin-1"*), and converts a parse failure into `MalformedSettingsError` — which
  `lib/cli.js:773-780` turns into a path-specific message with a recovery procedure.
- `probeStatus` goes through `readJsonMaybe` (`lib/probe.js:40-52`), whose only BOM handling is
  `text.replace(/^﻿/, '')` at `:51`, and which lets a raw `SyntaxError` escape.

`probeStatusReport` (`lib/cli.js:808-817`) has no try/catch, so the error reaches `bin/cah.js:13`
and prints the generic `cah: unexpected error: …` with exit 1.

Reproduction, isolated temp directory, three settings files:

```
malformed      -> probeStatus THROWS SyntaxError: Expected property name or '}' in JSON at position 2
mojibake-BOM   -> probeStatus THROWS SyntaxError: Unexpected token 'ï', "ï»¿{"statu"... is not valid JSON
real-BOM       -> probeStatus {"active":true,"backupExists":false,"logSize":0,"logRecords":0}
```

and the same mojibake-BOM file driven through the mutating paths:

```
enableProbe  -> OK
probeStatus  -> {"active":true,...}      (only after enableProbe rewrote the file without the BOM)
disableProbe -> {"restored":{"type":"command","command":"old"}}
```

So on a settings file carrying the compatibility BOM `lib/probe.js:36` exists for,
`cah probe statusline start` and `stop` work while `cah probe statusline status` — the read-only
inspection command a user would reach for first — exits 1 with a raw JSON parser message. The
malformed-JSON case is the same defect one notch milder: `status` loses the path-specific error
and the recovery hint that `stop` gives for the identical condition.

Narrow blast radius (no data at risk, both mutating commands still work), deterministic trigger,
one-line-per-parser fix: route `probeStatus`'s settings read through `readJsonSnapshot`/
`readSettingsSnapshot` like every other entry point, or give `probeStatusReport` the same
`MalformedSettingsError` branch `probeStop` already has.

### P3 — quarantine litter, now-inert retry constants, an unclosed round-61 item, and dead conditions

None of these change behaviour. Several are in files mirrored verbatim into
`~/.claude/cah-bin/`, so they ship to users.

- `lib/lease-lock.js:464-468` — the bounded-slot loop calls
  `mkdirSync(slotDir, { recursive: true })` **before** attempting the move and never removes the
  slot when the move fails, so a `moveFenceContents()` failure that is not a name collision
  leaves up to 32 empty `.slot-N` directories behind. Newly reachable from the release path in
  round 61 (previously only from `recoverFence()`). Reproduced by pinning a stray sub-directory
  inside the fence with an open descendant handle:
  `released=false, strandedFences=1, quarantineEntries=[".slot-0" … ".slot-31", "claim.taken-…"], emptySlotDirs=32`.
  Bounded overall (the 32 names are fixed, so it cannot grow past 32), but never pruned and never
  reported.
- `lib/lease-lock.js:20`, `:455` — the `.cah-lease-quarantine` tree is never enumerated, swept,
  or surfaced through any `maintenance` report. `describeRecoveryArtifact()`
  (`lib/fs-atomic.js:775-816`) recognizes only `.cah-tmp-`, `.cah-owned-remove` and
  `.cah-owned-publish`, and the entries land in `~/.claude/cah-bin/cache/` and
  `…/cache/stamp-state/`, both of which the bin lifecycle treats as reserved
  (`lib/binstall.js:92`, `:816-817`). Round 61 added a second, far more frequently reached
  producer of these entries without a corresponding reporting path.
- `lib/lease-lock.js:884-887` — with one shared deadline, `RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3`
  (`:27`) is observationally equal to `1` for every rejection the loop can actually see: a
  transient failure has already exhausted the budget on attempt 1, and every other rejection
  returns without reading the deadline and without changing state. The only way a later iteration
  helps is a third party clearing the obstruction in the microseconds between two calls — which is
  precisely what round 61's regression harness simulates through the `claim-removal` interlock,
  not something that happens on its own.
- `lib/marker-state.js:461-465` — `releaseClaimLease()`'s wall-clock budget is unreachable. Each
  `releaseLease()` is internally capped at one 250 ms `LEASE_RECOVERY_WAIT_MS` window, the outer
  budget is `2 * LEASE_RECOVERY_WAIT_MS = 500 ms`, and the check runs *after* the attempt — so
  `Date.now() >= deadline` cannot be true after the first iteration (measured: 263-271 ms). The
  function is exactly `releaseLease(lease) || releaseLease(lease)`.
- `test-support/interlocks.js:25` — round 61's own P3 was **not** closed. `makeInterlock()` still
  maps any stage other than `'before'`/`'vacancy'` onto `'before'`, so round 60's `'claim-removal'`
  stage shares the `.before` rendezvous suffix used by the three-party staged protocol
  (`:38-41`). One correction to round 61's description: the stage *is* reachable through
  `CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE`, because `aliases = args.slice(1)` (`:26`) puts
  `'claim-removal'` into `candidates`; it is only the staged-suffix path that collapses. Harmless
  today because `wait()` returns immediately once its `.go` file exists.
- `lib/fs-atomic-publication.js:868-869` —
  `if (isOwnershipLoss(error) && publication.published) throw error;` followed immediately by
  `throw error;`. Both branches rethrow the same value, so the guard is a no-op. Present since
  round 45 (`8ba9b76`); not previously reported.
- `lib/transcript-stats.js:275-276` —
  `if (m.includes('sonnet') || m.includes('haiku')) return SONNET_HAIKU_LIMIT;` followed by
  `return SONNET_HAIKU_LIMIT;`. The condition is unconditionally redundant; the two lines are one
  default.
- `lib/transcript-stats.js:603-612` — `let contextWindowSize = null;` is dead (overwritten by the
  next statement at `:605`), and `:607` recomputes `isFresh(base.capturedAt, nowMs)` instead of
  reusing `globalFresh`, which `:602` computed from the identical expression.
- `scripts/gen-docs.js:196-204` — round 61's new catch prints
  ``README.md is out of sync with lib/manifest.js — run `npm run gen:docs`.`` on **both** paths,
  so `npm run gen:docs` now instructs the user to run `npm run gen:docs` while declining to write
  and exiting 1. Verified in a throwaway copy with one README sentence duplicated: identical
  output and exit 1 for `node scripts/gen-docs.js` and `node scripts/gen-docs.js --check`. Only
  the second line (`String(error?.message)`) is actionable. The `check` flag is already in scope
  at `:193`.
- `scripts/gen-docs.js:154-164` vs `:184-189` — `substituteLiteralCounts()` re-runs the exact
  "matches exactly once" assertion that `validateMarkers()` performed one statement earlier in
  `main()` (`:197-198`); the copy inside `substituteLiteralCounts` is unreachable from `main()`.
- `lib/marker-capacity-ops.js:477` —
  `if (fenceRoot.status === (helpers.indeterminate || 'indeterminate')) return false;`. The
  `|| 'indeterminate'` fallback is dead (`makeCapacityRecoveryHelpers`'s `ops()` always sets
  `indeterminate`, `lib/marker-capacity-recovery.js:27`) and inconsistent with every other
  `helpers.indeterminate` use in the same file.
- `lib/marker-capacity-ops.js:238`, `:574` — bare `'absent'` string literals where the injected
  `h.absent` / `absent` constant is used everywhere else in the same functions.
- `lib/skills.js:750` — `const rel = relative(root, result.preservedPath)…` shadows the `rel`
  binding of the enclosing `for (const [rel, expected] of entries)` loop at `:739`.
- `lib/cli.js:284-290` — `prepareInstall` declares `let parsed;` and assigns it on the very next
  statement (every sibling command uses `parsed = parseScopeFlags(...)` inside a `try`, which is
  why the split exists there and not here), and the options object literal is indented two
  columns past its block. Cosmetic only.

## Disposition

Round 61 is not clean. Close both P2s and the P3 batch, then repeat the read-only review.

Round 61's remaining changes were checked individually and hold:

- The quarantine fallback is genuinely load-bearing on the branch it covers. The stray-entry
  scenario now returns `released=true` with zero stranded fences and a preserved fence body under
  `.cah-lease-quarantine/`, and the end-to-end `migrateLegacyStateFiles()` harness reports
  `blocked=false` with `acquireStampLock` succeeding — both of which failed before `ade9a60`.
- The shared-deadline change does what it says (worst-case `releaseClaimLease()` stall measured at
  ~271 ms against the prior ~1.5-3 s product of nested counts), at the cost quantified in the
  first P2.
- `test/discovery-contract.test.js`'s second discovery rule and the added `*_test` pattern are
  correct; the repository currently has no `.js` under `test/` that is not `*.test.js`
  (`git ls-files test/` — 20 entries, all `*.test.js`), so both scans agree and the contract test
  passes without being a tautology (both directions are still asserted).
- Every dead parameter and dead binding round 61 removed is gone and nothing new appeared: a
  mechanical sweep over all 68 tracked JavaScript files (import clauses, top-level and
  block-scoped declarations, and named-function parameters) reports zero unused bindings, and the
  only unused parameters left are the three intentional `_templates` placeholders
  (`lib/agents.js:59`, `lib/codex-agents.js:26`, `lib/commands.js:29`).
- Collapsing `assertBinLifecycleOwnership` into `requireBinLifecycleLease` is behaviour-preserving:
  the removed wrapper was a pure pass-through with identical arity, and both remaining consumers
  in the repair path (`lib/binstall-repair.js:194`, `:292`) call it as
  `helpers.assertOwnership(lease, binDir)`, whose `undefined` return still passes
  `assertOwnership()`'s `=== false` test in `lib/fs-atomic.js:52`.
- `dependencyGraph.get(file.dest) || new Set()` makes `dependencies.size > 0`
  (`lib/binstall-repair.js:97`, `:106`) meaningful again.
- `ops().transactionStillCurrent` is now the raw closure; every consumer passes exactly three
  arguments, and the function closes over `h` in the same scope, so the wrapper's removal is a
  no-op.
- `reconcileExpiredRetirements()` returns `{ ok }` only and its sole caller
  (`lib/marker-capacity-recovery.js:137`) reads only `.ok`.
- The `reconcileLegacyCapacityStages()` truncation asymmetry is now documented at
  `lib/marker-capacity-stage.js:188-193`; the claim in that comment holds — a stage is
  pre-publication state (`lib/marker-state.js:333-340` renames the stage into the transaction
  directory *before* the victim is moved), so an unreconciled legacy stage genuinely cannot hold a
  victim.
- All seven gen-docs literal patterns still match README.md exactly once, and the manifest/README
  invariants are intact (see Verification).

The concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`, `lib/marker-capacity-*.js`,
`lib/marker-state.js`) was read in full again, along with the installers, the repair path, the
runtime description, the CLI, the probe, the four companion bins, the shared transcript library,
the manifest, the doc generator and the skill templates. Beyond the items above, no additional
confirmed P0-P3 defect was identified in that scope. That is not a claim that every filesystem
race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 591 total, 585 passed, 6 skipped, 0 failed (174.3 s).
- `FORCE_COLOR=1 npm test`: 591 total, 585 passed, 6 skipped, 0 failed (175.7 s). Round 58's
  `FORCE_COLOR` fix remains closed.
- The counts are +1 test / +1 pass over round 61's 590/584 with the skip count unchanged at 6,
  i.e. the single test round 61 added (`test/lease-lock.test.js:134`) actually executes on this
  host rather than skipping through a platform guard.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are all legitimate platform guards:
  `test-support/installer-atomic.cases.js:36`, `:51`, `:178` ("POSIX mode bits are not portable on
  Windows"), `test/binstall.test.js:434` ("hardlink metadata is not portable on this Windows
  runner"), and `test/probe.test.js:578`, `:601` ("nanosecond mtime restoration is not
  deterministic on Windows"). No test is silently disabled; in particular the two
  `this.skip('platform does not block rename of a directory held as a child process CWD')` guards
  (`test/lease-lock.test.js:69`, `test/marker-state.test.js:1091`) do **not** fire on this host,
  so the round-58/59/60/61 regression tests all really run.
- `node --check` over all 68 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names and no overlap between the
  two registries; every skill in `AllSkills` has a matching `templates/skills/<name>/SKILL.md`, a
  `SKILL.md` `name:` equal to its directory name, and an `npx cah install --only <name>` line in
  README.md; no template directory is missing from `AllSkills`; every `SkillDeps` key is a real
  skill; README.md carries `--only commands`, `--only codex-agents` and `--only bins` examples;
  all 7 gen-docs literal-count patterns match README.md exactly once; `package.json` version
  `0.8.0` equals `lib/update-check.js`'s `CURRENT_VERSION`.
- Unused-binding sweep over all 68 tracked JavaScript files (import clauses, non-exported
  top-level declarations, indented `const`/`let`/`class` declarations, and named-function
  parameters): zero unused bindings; the only unused parameters are the three deliberate
  `_templates` placeholders.
- Encoding sweep over every tracked `.js/.mjs/.cjs/.md/.json/.sh/.bat/.toml/.yml/.yaml` file
  (131 files): all decode as strict UTF-8, and the only double-encoded sequence is round 59's own
  quotation of the artefact it fixed, at `docs/cc-arch-hands-review-2026-09-07-round-59.md:136` —
  identical to what rounds 60 and 61 reported.
- P2 #1 reproduction 1 (lease level): temp directory, `acquireLease()` with a `testInterlock` that
  contaminates the fence at the first `claim-removal` stage. Case A (stray file) →
  `released=true`, quarantined, successor acquired. Case B (unlinkable `owner.json`) →
  `released=false`, `claim-removal calls=3`, `elapsed=263 ms`, one leftover
  `claim.taken-<pid>-<uuid>`, no quarantine directory created, and a same-process `acquireLease()`
  on the same path returns `null`.
- P2 #1 reproduction 2 (end to end): `migrateLegacyStateFiles()` with a legacy source claim that
  wins the freshness comparison, injecting once at phase `legacy-claim-reclaim-release` /
  stage `claim-removal`. Stray-entry variant → `blocked=false`, target claim restored,
  `acquireStampLock` acquired. Unlinkable-`owner.json` variant → `blocked=true`, state directory
  holding only `last-stamp.json.session-<hash>.json.lock.taken-<pid>-<uuid>`, and
  `acquireStampLock after migration: null (stamp dropped)` in 271 ms.
- P2 #1 reproduction 3 (shared-deadline cost): a detached helper process releases the pin 400 ms
  after the fence appears; the same scenario is run against HEAD and against a throwaway `lib/`
  copy outside the repository whose only difference is `releaseLease()`'s removal deadline
  restored to `Date.now() + LEASE_RECOVERY_WAIT_MS` — results in the table above
  (`false`/3/264 ms/1 stranded vs `true`/2/442 ms/0 stranded).
- P2 #1 reproduction 4 (convergence): after the stranded-fence state above, repairing the pin and
  calling `acquireLease()` with `pidIsAlive: () => false` (modelling a later hook invocation whose
  operator pid is dead) → `laterProcessAcquire: acquired (converged)`, home directory back to
  `["claim"]`.
- P2 #2 reproduction: three temp settings files driven through `probeStatus()` — malformed JSON
  and the Latin-1 mojibake BOM both throw a bare `SyntaxError`, a real `U+FEFF` BOM parses; the
  same mojibake-BOM file drives `enableProbe()` → OK and `disableProbe()` → restored.
- P3 slot-litter reproduction: a stray sub-directory inside the fence pinned by an open descendant
  handle → `released=false`, `strandedFences=1`, `.cah-lease-quarantine` containing 32 empty
  `.slot-N` directories plus a partially-populated primary destination.
- P3 gen-docs reproduction: throwaway copy of `lib/`, `scripts/`, `package.json` and `README.md`
  with `### 4. Skills (11)` duplicated → `node scripts/gen-docs.js` and
  `node scripts/gen-docs.js --check` both print
  ``README.md is out of sync with lib/manifest.js — run `npm run gen:docs`.`` and exit 1.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; every temp directory, the throwaway `lib/` copy and the throwaway `scripts/`+README
  copy were created and deleted outside the repository. No real `~/.claude` state was touched; no
  install, no version change, no push.
