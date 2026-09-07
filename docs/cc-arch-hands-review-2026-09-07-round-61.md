# cc-arch-hands review — round 61

- Baseline: `588baad` (`fix: close round 60 lease-release-after-fence and cleanup gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 60's `releaseLease()` fence-resume
  retry — including a sandboxed revert-and-compare that proves the fix is load-bearing, plus the
  hunt for the gap it left. Second, a fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`,
  `templates/`, `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`),
  the doc-generation gate and a full `node --check` were run, and four isolated temp-directory
  reproductions plus one throwaway `lib/` copy were built outside the repository. Nothing
  outside this document was modified.
- P0 findings: none
- Result: 1 P2, 1 P3 batch (15 items). Round 60's fix is confirmed genuinely fixed and
  load-bearing by experiment; it is nevertheless inert on the exact forcing function round 60's
  own reproduction used (see the P2 below).

## Findings

### P2 — `releaseLease()`'s fence-resume retry is one attempt for every failure `removeClaimPath()` rejects without touching its transient budget — including the stray-entry guard round 60 reproduced with

`lib/lease-lock.js:882-888`, against `lib/lease-lock.js:296-316`.

Round 60 replaced the single post-fence `removeClaimPath()` with a bounded loop:

```js
for (let attempt = 0; attempt < RELEASE_CLAIM_REMOVAL_ATTEMPTS; attempt += 1) {
  testInterlock(releaseOptions.interlockPhase, 'claim-removal', releaseOptions);
  if (removeClaimPath(fence.path, options.ownerFile, Date.now() + LEASE_RECOVERY_WAIT_MS)) return true;
}
return false;
```

The loop has no wait and no state change between iterations. The **only** thing an iteration
adds is a freshly computed `Date.now() + LEASE_RECOVERY_WAIT_MS`, and that deadline is consumed
by exactly one thing: `withTransientRetry()` (`lib/lease-lock.js:136-151`) sleeping on an error
code in `TRANSIENT_LEASE_ERRORS` (`lib/lease-lock.js:19`). Every other way `removeClaimPath()`
returns `false` returns *immediately*, without reading the deadline at all:

- `lib/lease-lock.js:301` — `entries.some((entry) => entry !== ownerFile)` → `return false`;
- `lib/lease-lock.js:304`, `:307`, `:310` — a non-transient code out of
  `unlinkSync(owner.json)` / `rmdirSync` / `unlinkSync(file)` short-circuits `withTransientRetry`
  at its `!isTransientLeaseError(error)` branch;
- `lib/lease-lock.js:313-315` — `lstatSync` throwing anything but `ENOENT`.

For all of those, `RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3` (`lib/lease-lock.js:27`) is
observationally identical to `1`. Line `:301` is precisely the forcing function round 60 built
its own reproduction on ("an entry appearing inside the claim directory during the fence
window", round 60's P2).

When the loop is exhausted the fence `"<lease.path>.taken-<pid>-<uuid>"` is stranded and
unreachable for the rest of the process's life:

- `hasInFlightFence()` (`lib/lease-lock.js:524-531`) sees it and blocks every later
  `acquireLease()` on that path (`:593`, `:600`, `:616`, `:621`);
- `recoverFence()` (`lib/lease-lock.js:475-484`) refuses to act while
  `pidIsAlive(operatorPid) && !fenceExpired` — and `takeFence()` names the fence with
  `process.pid` (`lib/lease-lock.js:545`), so the operator pid is *this* live process;
- `quarantineUnexpectedFence()` (`lib/lease-lock.js:449-473`) is the routine that exists for
  exactly this fence shape, but the only call site is inside `recoverFence()` at
  `lib/lease-lock.js:485`, behind that same liveness guard. `releaseLease()` never reaches it.

Two reproductions, both in isolated temp directories importing the unmodified repository
library.

- Lease level — acquire, contaminate the fence at the release's `vacancy` interlock, never clean
  it up:

  ```
  released           : false
  claim-removal calls: 3
  elapsed ms         : 6
  home entries       : ["claim.taken-40784-2c1cf6a3-e0ef-436d-b765-a2ab45d4e93e"]
  lease.path exists  : false
  re-acquire same pid: null (BLOCKED)
  releaseLease #2/#3 : false false
  ```

  6 ms for three attempts is the measurement: no budget was spent, nothing changed between
  them. The last line is `releaseClaimLease()`'s outer retry (`lib/marker-state.js:461-463`)
  applied by hand — still inert, because `lease.path` is vacant and `leaseOwned()`
  (`lib/lease-lock.js:857`) fails the fast-check.

- End to end through `migrateLegacyStateFiles()`, injecting once at phase
  `legacy-claim-reclaim-release` / stage `vacancy` (the target claim's release):

  ```
  injected fence entry : true
  claim-removal calls  : 4
  elapsed ms           : 21
  migration blocked    : true
  target claim present : false
  state dir entries    : ["last-stamp.json.session-<hash>.json.lock.taken-17076-<uuid>"]
  acquireStampLock after migration: null (stamp dropped)
  ```

  (3 calls for the target-claim release plus 1 for the source lease's own successful release.)
  `lib/marker-state.js:489` returns `INDETERMINATE`, `migrateLegacyStateFiles` reports
  `blocked`, and `bin/cah-stamp.js:338` returns before `acquireStampLock()` — round 58's P1
  symptom verbatim, on the sub-branch round 60's fix does not cover. 21 ms end to end, so no
  retry window was actually waited out.

Blast radius is one invocation, not a five-minute outage: the fence's operator pid dies with
this process, a later hook invocation is a new process, and `recoverFence()` then converges the
state. That is the same severity profile rounds 59 and 60 assigned their versions of this
finding.

Fix direction: a fresh deadline cannot help a failure that never reads the deadline. The loop
needs either a bounded wait between attempts or — better, given the latency note in the P3 batch
below — a terminal fallback that disposes of *its own* fence: call
`quarantineUnexpectedFence(fence.path, options.ownerFile, …)` when the stray-entry guard is what
rejected the removal, and/or let `recoverFence()` treat `operatorPid === process.pid` as
self-owned rather than "a live third party". `lib/lease-lock.js` is 961 lines against
`test/source-size.test.js`'s 1000-line cap, so there are 39 lines of headroom for that.

### P3 — round-60 leftovers, dead bindings/parameters, unsurfaced truncation, and a latency multiplier

None of these change behaviour. Several are in files mirrored verbatim into
`~/.claude/cah-bin/`, so they ship to users.

- `test/discovery-contract.test.js:18-49` — `discoveryCandidates()` mirrors only the four
  default *name* patterns and its doc comment names only those. Node's default discovery has a
  second rule: every `.js`/`.cjs`/`.mjs` file inside a directory named `test` is a test file
  regardless of its name. Verified empirically on this host's Node v24.12.0 (a temp project with
  `test/helper.js`, `test/a.test.js`, `sub/plain.js` → bare `node --test` ran 2 tests, including
  `test/helper.js`; `sub/plain.js` was not picked up). A helper `.js` dropped into `test/` would
  therefore be executed by `npm test` while being invisible to both `filesystemTests()`
  (`:11-16`, filters `.endsWith('.test.js')`) and `discoveryCandidates()`, and the contract test
  would stay green — the residue of exactly the tautology round 60 set out to remove.
- `test/discovery-contract.test.js:57` — `const expected = filesystemTests();` is now dead.
  Round 60 replaced its only consumer (`const discovered = expected;`) with a second
  `filesystemTests()` call at `:67` and left the binding behind.
- `test/checkpoint-hint.test.js:15` and `:155-159` — `const BIN = …` and `function
  replaceClaim(path, owner)` are declared and never referenced. Same class as the
  `test-support/stamp-helpers.js` `BIN` binding round 59 removed and the `others` binding round
  60 removed. `unlinkSync` and `rmdirSync` in the import at `:4` exist only to serve
  `replaceClaim`.
- `test-support/stamp-helpers.js:1`, `:4`, `:6` — six unused import bindings (`describe`, `it`,
  `utimesSync`, `symlinkSync`, `lstatSync`, `homedir`). After round 60's sweep this is the only
  tracked JavaScript file left with any unused import binding; it fell outside round 60's own
  enumeration, which named "`test-support/*.cases.js` and `test-support/installer-test-helpers.js`".
- Dead parameters — four, all silently ignored by their bodies:
  `lib/marker-capacity-stage.js:20` `emptyDirectory(inspectPath, path)`;
  `lib/marker-state.js:382` `migrationCollision(sourcePath, targetPath, source)`;
  `lib/marker-state.js:508` `migrationCandidates(home, cfg, sessionId)`;
  `lib/skills.js:730-731` `removeCapturedFiles(…, preserved, recovery, …)` — the callers at
  `lib/skills.js:635` and `:641` pass `preserved`, but only `recovery` is written to.
- `lib/marker-capacity-recovery.js:22-23` — the `ops()` wrapper calls
  `transactionStillCurrent(markerDir, state, context, options, h)` with a fifth argument, while
  the function is declared with four parameters at `:392` and already closes over `h`. The
  fourth parameter is dead too: every consumer of `ops().transactionStillCurrent`
  (`lib/marker-capacity-ops.js:214`, `:244`, `:256`, `:266`, `:273`, `:275`, `:635`, `:654`,
  `:688`, …) passes exactly three arguments.
- `lib/marker-capacity-recovery.js:362` — `reconcileExpiredRetirements()` returns
  `{ ok, complete }`; its sole caller (`:135-140`) reads only `.ok`. The `complete` field is
  computed on every return path and never consumed.
- `lib/marker-capacity-recovery.js:600` —
  `if (publication === h.indeterminate || publication !== h.present) return false;`. The first
  disjunct is subsumed by the second (`indeterminate !== present` is always true), so the
  condition reduces to `publication !== h.present`.
- `lib/marker-capacity-stage.js:193` — `reconcileLegacyCapacityStages()` discards the
  `streamDirectoryEntries()` result, so a *truncated* scan of the shared parent directory is
  reported as success (`return !indeterminate` at `:253`). Its sibling
  `reconcileLegacyCapacityFences()` returns `scan.complete && !indeterminate` (`:84`, `:110`).
  The consequence is bounded — the pass is migration support for UUID stage siblings that fresh
  code no longer creates, and an unreconciled stage cannot lose a victim — but the asymmetry is
  not documented and the truncation is not surfaced through `maintenance` either.
- `lib/binstall-repair.js:97` and `:106` — `const dependencies = dependencyGraph.get(file.dest)
  || []` followed by `dependencies.size > 0`. The fallback is an `Array`, whose `.size` is
  `undefined`, so the fallback silently reads as "no dependencies" instead of failing loudly.
  Unreachable today (`companionImportGraph()` sets a `Set` for every `BinFiles` entry, and
  `publicationFiles` is a subset of it), but the `[]`/`Set` type mismatch is a trap for a future
  caller that passes a partial graph.
- `lib/binstall.js:131-137` — `assertBinLifecycleOwnership(lease, binDir)` is a pure
  pass-through to `requireBinLifecycleLease(lease, binDir)`. Both names are used throughout the
  file for the same behaviour, which makes the ownership-vs-lease distinction in the call sites
  look meaningful when it is not.
- `test-support/interlocks.js:25` — `makeInterlock()` recognizes only `'before'` and
  `'vacancy'` as stages, so round 60's new `'claim-removal'` stage collapses to `'before'` and
  shares the `.before` file suffix used by the three-party staged interlock (`:38-41`). Harmless
  today, because `wait()` returns immediately once its `.go` file exists and the extra calls are
  idempotent; but the env-var interlock protocol cannot target the new stage at all — only a
  direct `testInterlock` callback can, which is what `test/lease-lock.test.js:103-117` uses.
- Latency multiplier — `lib/marker-state.js:461-463` retries `releaseLease()` three times, and
  round 60 made each `releaseLease()` internally worth up to `takeFence` (250 ms transient
  budget) + 3 × 250 ms of `removeClaimPath`. The worst-case synchronous stall of
  `releaseClaimLease()` therefore went from ~1.5 s to ~3 s, inside `migrateClaim()` on
  `bin/cah-stamp.js`'s per-`Stop`/per-`PostToolUse` path. Nothing bounds the product of the two
  nested retry counts. Any fix for the P2 above should be designed against one total budget
  rather than adding a third multiplier.
- `lib/binstall.js:734` and `lib/skills.js:358` — a statement and a comment continuation line
  indented two columns past their block. Cosmetic only.
- `scripts/gen-docs.js:104-133` — the literal-count gate grew from one registry annotation to
  seven, and four of the six new patterns match *prose* rather than a registry name
  (`/# all \d+ skills/`, `/\| Skills \| \d+ \|/`, `/### 4\. Skills \(\d+\)/`,
  `/\*\*skills\*\* \(\d+\)/`). `validateMarkers()` (`:184-189`) and `substituteLiteralCounts()`
  (`:154-164`) both throw when a pattern matches zero or two or more times, and `main()`
  (`:192-211`) has no try/catch, so an ordinary README edit that reworks or duplicates one of
  those sentences fails `npm run gen:docs` *and* `npm run gen:docs:check` with a raw stack trace
  instead of the "out of sync — run `npm run gen:docs`" message. That tradeoff already existed
  for the single `AllCodexAgents (23)` key; it now applies to six more places, none of which is
  documented in CLAUDE.md's "generated, not hand-written" convention.

## Disposition

Round 61 is not clean. Close the P2 and the P3 batch, then repeat the read-only review.

Round 60's disposition is confirmed by direct experiment rather than inspection alone. Its
`releaseLease()` change was reverted in a throwaway copy of `lib/` and the round-60 scenario
re-run against both trees:

| | released | claim-removal calls | leftover fences | successor acquired |
|---|---|---|---|---|
| HEAD (`588baad`) | `true` | 2 | 0 | `true` |
| `releaseLease()` reverted | `false` | 0 | 1 | `false` |

So the fix genuinely closes the case where the obstruction clears between attempts; it does not
close the case where the obstruction persists, which is the case its own finding text described.
Round 60's other changes were checked individually and hold: the three removed
`Ownership.missing` branches are provably unreachable (`classifyContent()`
(`lib/sentinel.js:45-46`) returns `missing` only for `present === false`, and each call site
guards with `if (!snapshot.present) continue;` on the line above — `lib/commands.js:76-77`,
`lib/agents.js:108-109`, `lib/codex-agents.js:70-71`); every import binding removed from
`lib/fs-atomic.js` and `lib/fsutil.js` is still absent from the bodies and still present in the
`export … from` lists; `BinFileDefinitions` is deep-frozen and no consumer mutates it or its
elements (`lib/binstall.js:84`, `lib/binstall/runtime.js:36-37`); all seven gen-docs literal
patterns match exactly once; and the two new README `--only` examples are present.

The concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`, `lib/marker-capacity-*.js`,
`lib/marker-state.js`) was read in full again, along with the installers, the repair path, the
CLI, the probe, the companion bins, the shared transcript library, the manifest, the doc
generator and the skill templates. Beyond the items above, no additional confirmed P0–P3 defect
was identified in that scope. That is not a claim that every filesystem race has been eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 590 total, 584 passed, 6 skipped, 0 failed (196.9 s).
- `FORCE_COLOR=1 npm test`: 590 total, 584 passed, 6 skipped, 0 failed (188.3 s). Round 58's
  `FORCE_COLOR` fix remains closed.
- The counts are +2 tests / +2 passes over round 60's 588/582 with the skip count unchanged at 6,
  i.e. both tests round 60 added (`test/lease-lock.test.js:97` and
  `test/conditional-publication.test.js:323`) actually execute on this host rather than skipping
  through a platform guard.
- The 6 skips were enumerated exactly (`node --test --test-concurrency=1 --test-reporter=tap`,
  filtered on `# SKIP`) and are all legitimate platform guards:
  `test-support/installer-atomic.cases.js:36`, `:51`, `:178` ("POSIX mode bits are not portable
  on Windows"), `test/binstall.test.js:434` ("hardlink metadata is not portable on this Windows
  runner"), and `test/probe.test.js:578`, `:601` ("nanosecond mtime restoration is not
  deterministic on Windows"). No test is silently disabled; in particular the symlink guards and
  the two `this.skip('platform does not block rename of a directory held as a child process
  CWD')` guards (`test/lease-lock.test.js:69`, `test/marker-state.test.js:1091`) do **not** fire
  on this host, so the round-58/59/60 regression tests all really run.
- `node --check` over all 68 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names and no overlap between
  the two registries; every skill in `AllSkills` has a matching
  `templates/skills/<name>/SKILL.md`, a `SKILL.md` `name:` equal to its directory name, and an
  `npx cah install --only <name>` line in README.md; no template directory is missing from
  `AllSkills`; every `SkillDeps` key is a real skill; README.md carries `--only commands`,
  `--only codex-agents` and `--only bins` examples; `package.json` version `0.8.0` equals
  `lib/update-check.js`'s `CURRENT_VERSION`.
- Unused-binding sweep over all 68 tracked JavaScript files (import clauses, non-exported
  top-level declarations, indented `const`/`let` declarations, and named-function parameters):
  the only hits are the P3 items listed above.
- Encoding sweep over every tracked `.js/.md/.json/.sh/.bat/.toml` file (128 files): all decode
  as strict UTF-8 and none contains a double-encoded dash/quote sequence. The only two hits are
  round 59's own quotation of the artefact it fixed, at
  `docs/cc-arch-hands-review-2026-09-07-round-59.md:133` and `:136` — identical to what round 60
  reported.
- P2 reproduction 1 (lease level): temp directory, `acquireLease()` with a `testInterlock` that
  writes a `stray` file into the fence at stage `vacancy` and never removes it →
  `released=false`, `claim-removal calls=3`, `elapsed=6 ms`, one leftover
  `claim.taken-<pid>-<uuid>`, and a same-process `acquireLease()` on the same path returns
  `null`.
- P2 reproduction 2 (end to end): `migrateLegacyStateFiles()` with the same injection once at
  phase `legacy-claim-reclaim-release` → `migration blocked: true`, the state directory holding
  only `last-stamp.json.session-<hash>.json.lock.taken-<pid>-<uuid>`, and
  `acquireStampLock after migration: null (stamp dropped)` in 21 ms.
- Round-60 fix revert-and-compare: `lib/` copied to a throwaway directory outside the repository
  with `releaseLease()`'s tail restored to
  `return removeClaimPath(fence.path, options.ownerFile, releaseOptions.recoveryDeadline);`, then
  the round-60 scenario (stray removed on the second `claim-removal`) run against both trees —
  results in the table above.
- Node default-discovery behaviour for the first P3 item was verified in a throwaway project
  (`test/helper.js` + `test/a.test.js` + `sub/plain.js`, bare `node --test` → `tests 2`,
  including `helper-in-test-dir`).
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; every temp directory and the throwaway `lib/` copy were created and deleted outside
  the repository. No real `~/.claude` state was touched; no install, no version change, no push.
