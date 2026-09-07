# cc-arch-hands review — round 60

- Baseline: `a5d7afd` (`fix: close round 59 lease-release and unwind-guard gaps`); working tree clean.
- Scope: two halves. First, adversarial verification of round 59's three fixes — including
  three sandboxed revert-and-compare runs that prove each fix is load-bearing, plus a hunt
  for the gap each fix left. Second, a fresh sweep of `lib/*.js`, `lib/binstall/`, `bin/*.js`,
  `templates/`, `scripts/`, `test/`, `test-support/`.
- Mode: read-only for product code. The suite was run twice (with and without `FORCE_COLOR`),
  the doc-generation gate and a full `node --check` were run, and two isolated
  temp-directory reproductions plus one throwaway `lib/` copy were built outside the
  repository. Nothing outside this document was modified.
- P0 findings: none
- Result: 1 P2, 1 P3 batch (13 items). All three of round 59's fixes are confirmed genuinely
  fixed and load-bearing by experiment; its `migrateClaim` fix is nevertheless incomplete on
  the second failure mode round 59's own finding text named (see the P2 below).

## Findings

### P2 — `releaseClaimLease()`'s retry is inert on the exact failure mode round 59 named: a release that failed *after* its fence was taken

`lib/marker-state.js:456-463` and `:489`, against `lib/lease-lock.js:854-878`.

Round 59's finding described two ways a failed target-claim release strands the path
`acquireStampLock()`/`acquireClaim()` is about to take:

1. "the lease directory at `targetPath` is still owned by this live pid", i.e. `takeFence()`'s
   rename never happened; and
2. "if `removeClaimPath` was the step that failed, a `.taken-<pid>-<uuid>` fence sits beside it
   and `hasInFlightFence()` blocks every acquire".

The fix it shipped is a three-attempt retry:

```js
function releaseClaimLease(lease) {
  return releaseLease(lease) || releaseLease(lease) || releaseLease(lease);
}
```

That closes (1) and only (1). In case (2) the canonical `lease.path` no longer exists — it was
renamed onto the fence at `lib/lease-lock.js:875` — so the very first line of `releaseLease()`
(`lib/lease-lock.js:855`: `!leaseOwned(lease)` → `readLeaseOwner(lease.path)` → `ENOENT` → `null`)
makes attempts 2 and 3 return `false` immediately, without ever touching the stranded fence.
There is no code path anywhere in the module that resumes a release from its own fence: once
`takeFence()` has succeeded and `removeClaimPath()` (`lib/lease-lock.js:294-314`) has failed,
the fence is only reachable through `hasInFlightFence()`/`recoverFence()`
(`lib/lease-lock.js:522-529`, `:473-520`), which refuse to act while the fence's operator pid is
alive and its mtime is younger than `LEASE_MAX_MS` (`lib/lease-lock.js:481-483`).

Two reproductions, both in isolated temp directories against the unmodified shipped library.
The forcing function is `removeClaimPath`'s own guard at `lib/lease-lock.js:299`
(`entries.some((entry) => entry !== ownerFile)` → `return false`): an entry appearing inside
the claim directory during the fence window. In production the same step fails on
`EPERM/EACCES/EBUSY/ENOTEMPTY` from the fence's `unlinkSync(owner.json)`/`rmdirSync` outliving
the (now correctly refreshed) 250 ms budget — precisely the codes `TRANSIENT_LEASE_ERRORS`
(`lib/lease-lock.js:19`) exists for.

- Lease level — `acquireLease()`, then force the failure at the release's `vacancy` interlock,
  then call `releaseLease()` three times exactly as `releaseClaimLease()` does:

  | attempt | `leaseOwned()` before | `releaseLease()` |
  |---|---|---|
  | 1 | `true` | `false` |
  | 2 | `false` | `false` |
  | 3 | `false` | `false` |

  Directory left behind: `claim.taken-29344-fb2615ce-…`. Attempts 2 and 3 are provably no-ops.

- End to end through `migrateLegacyStateFiles()`, with the same forcing function fired once at
  phase `legacy-claim-reclaim-release` / stage `vacancy` (the target claim's release):

  ```
  injected fence entry: true
  migration blocked   : true
  target claim present: false
  state dir entries   : ["last-stamp.json.session-<hash>.json.lock.taken-29204-<uuid>"]
  acquireStampLock after migration: null (stamp dropped)
  ```

  That last line is the round-58 P1 symptom verbatim — `bin/cah-stamp.js:329-341` returns early
  on `stampMigration.blocked`, and the `acquireStampLock()` at `:339` on the identical path is
  refused — reproduced on the sub-branch round 59's fix does not cover.

Blast radius is one turn, not a five-minute outage: the fence's operator pid belongs to the
process that is running, so it blocks only for the remainder of that invocation (the turn
produces no chat stamp and no update notice). A later hook invocation is a new process, the old
operator pid is gone, and `recoverFence()` converges the state — `migrateClaim()`'s
`target.status === ABSENT` fast path (`lib/marker-state.js:471-473`) renames the source claim
back into place and the fence is then reclaimed. That is the same severity profile round 59
assigned its own version of this finding.

Fix direction: make release resumable from the fence it created (finish `removeClaimPath()` on
`fence.path` on a retry) rather than retrying from `lease.path`, which by then is vacant.

### P3 — round-59 leftovers, dead bindings, unreachable branches, and doc/test-fidelity gaps

None of these change behaviour. Several are in files mirrored verbatim into
`~/.claude/cah-bin/`, so they ship to users.

- `lib/fs-atomic.js:4` — round 59's commit message claims unused imports were cleaned up
  "across lease-lock.js, sentinel.js, **fs-atomic.js**, probe.js, update-check.js …", and its
  own P3 list named this exact binding. The only change the commit made to the file was the
  mojibake comment on `:299`; `writeFileSync` is still imported from `node:fs` and never used.
- `lib/fs-atomic.js:7-11` and `lib/fsutil.js:4-22` — 12 further import bindings exist only to be
  re-exported by a *separate* `export … from` statement in the same file and are never
  referenced in the body: `fs-atomic.js` — `readFileMaybe`, `captureDirectoryIdentities`,
  `sameDeviceIdentity`, `mtimeMsForAge`, `isOlderThan`; `fsutil.js` — `writeFileAtomic`,
  `directoryIdentity`, `captureDirectoryIdentities`, `directoryIdentitiesMatch`,
  `sameDeviceIdentity`, `mtimeMsForAge`, `isOlderThan`, `isQuarantinePath`. The
  `export { … } from './…'` lists at `lib/fs-atomic.js:22-26` and `lib/fsutil.js:33-55` already
  carry every one of them, so the import clauses are pure dead weight.
- `lib/marker-state.js:448` — `catch (error)` binds `error` and never reads it. It is the only
  such binding in `lib/`, `bin/` and `scripts/`; every other catch in the codebase uses the
  bare `catch {` form.
- `test/marker-state.test.js:1186` — `const others = ['retry-bound-a', 'retry-bound-b'].map(…)`
  is assigned and never read (same class as the `test-support/stamp-helpers.js` `BIN` binding
  round 59 removed).
- `test/discovery-contract.test.js:39-45` — the case named "runs every filesystem test entry
  exactly once" does `const discovered = expected;` and then asserts only that a
  `readdirSync`-derived list has no duplicates and that `relative(ROOT, join(ROOT, entry))`
  round-trips. Both are tautologies. The only load-bearing assertions in the test are the
  `package.json` `scripts.test` token check (`:30-37`) and the `engines.node` pin; nothing
  verifies that bare `node --test` discovery actually reaches every `test/*.test.js`.
- `lib/fs-atomic-publication.js:842-845` — the comment round 59 added to justify its own guard
  ends with "and the committed-publication attachment below must still run". That block only
  executes when `committed === false`, and `attachCommittedPublication()` (`:57-59`) returns
  immediately unless `publication.published` is true, so the attachment can never do anything
  on this path. The stated justification is inert.
- `lib/fs-atomic-publication.js:563-567` — the test-only failure injection round 59 added sits
  at the very top of `abortPublication()`, before any filesystem work. The realistic failure
  its own finding described — a throw out of `unlinkSync(publication.tempPath)` /
  `syncParentDirectory()` / `captureRegularFileSnapshot()` inside `exactTemp()`, i.e. a
  *partially completed* abort — therefore remains untested.
- `lib/commands.js:79`, `lib/codex-agents.js:73`, `lib/agents.js:111` —
  `if (ownership === Ownership.missing) continue;` is unreachable: the `if (!snapshot.present)
  continue;` two lines above already covers the only input for which `classifyContent()`
  returns `missing` (`lib/sentinel.js:46`).
- `scripts/gen-docs.js:99-104` — `LITERAL_COUNT_ANNOTATIONS` gates exactly one literal registry
  annotation, `AllCodexAgents (23)`. `README.md:526` carries `AllModelCommands (44 definitions)`
  and `AllSkills (11)` in the same sentence, ungated, and four more hand-written skill counts
  live at `README.md:25`, `:196`, `:333` and `:396`. All are currently correct, but only one
  third of that line is protected by `npm run gen:docs:check`.
- `README.md` "Use" section (`:383-437`) — CLAUDE.md's convention requires a one-line
  `npx cah install --only <name>` example for the opt-in classes. `--only commands` appears only
  incidentally inside `--only commands,clock` (`:424`), and `--only codex-agents` does not
  appear in `Use` at all; it is documented only in the section-3 prose at `:177`. The flag forms
  (`:393`, `:432`, `:437`) are present. Judgement call, but the convention reads as literal.
- `test-support/*.cases.js` and `test-support/installer-test-helpers.js` — a copy-pasted import
  header leaves 80 unused bindings across eight files (`beforeEach`, `afterEach`, `mkdtempSync`,
  `tmpdir`, `Worker`, `lstatSync`, `rmdirSync`, `symlinkSync`, several sentinel sets, …).
  `test/cli.test.js:12` also imports `Scope` unused.
- `lib/binstall/runtime.js:11` — CLAUDE.md's key-files table calls `BinFileDefinitions` a
  "**frozen** data description of the companion runtime files"; the array and its element
  objects are plain and mutable. Only the derived `BinFiles` array is frozen
  (`lib/binstall.js:84`), and that freeze is shallow.
- `test/lease-lock.test.js:43-69` and `test/marker-state.test.js:1065-1112` — both new
  regression tests depend on a spawned child reaching its `cwd` inside a 50–80 ms synchronous
  spin. If the child starts more slowly the rename is never blocked, the release succeeds on its
  first attempt, and the test passes green without exercising the retry it exists to protect.
  Neither test asserts that a retry actually happened (e.g. that the release outlived one
  `LEASE_RECOVERY_WAIT_MS` window, or that the first attempt was observed to fail). Both were
  verified to exercise the intended path on this host by the revert-and-compare runs below, but
  that property is not enforced.

## Disposition

Round 60 is not clean. Close the P2 and the P3 batch, then repeat the read-only review.

Round 59's disposition is confirmed by direct experiment rather than by inspection alone: each
of its three fixes was reverted individually in a throwaway copy of `lib/` and each time the
corresponding new test failed, while HEAD passes all three (numbers in Verification). Its P3
cleanup is complete except for the single `lib/fs-atomic.js` import the commit message claims
to have removed.

The concurrency core (`lib/fs-atomic*.js`, `lib/lease-lock.js`, `lib/marker-capacity-*.js`,
`lib/marker-state.js`) was read in full again, along with the installers, the repair path, the
CLI, the probe, all four companion bins, the shared transcript library, the manifest, the
doc generator and the skill templates. Beyond the items above, no additional confirmed P0–P3
defect was identified in that scope. That is not a claim that every filesystem race has been
eliminated.

## Verification

- `env -u FORCE_COLOR npm test`: 588 total, 582 passed, 6 skipped, 0 failed (220.5 s).
- `FORCE_COLOR=1 npm test`: 588 total, 582 passed, 6 skipped, 0 failed (202.8 s). Round 58's
  `FORCE_COLOR` fix remains closed.
- The counts are +3 tests / +3 passes over round 59's 585/579 with the skip count unchanged at
  6, i.e. all three tests round 59 added actually execute on this host rather than skipping
  through their platform guards.
- The 6 skips are all legitimate platform guards (POSIX mode bits, symlink/junction creation,
  nanosecond mtime restoration on Windows). No test is silently disabled.
- `node --check` over all 68 tracked JavaScript files: no failures.
- `npm run gen:docs:check`: "README.md is already in sync with lib/manifest.js."
- Manifest/doc invariants re-checked programmatically: 44 model definitions (→ 88 bodies),
  23 Codex agents, 11 skills, no duplicate command or Codex-agent names; every skill in
  `AllSkills` has a matching `templates/skills/<name>/SKILL.md` and an
  `npx cah install --only <name>` line in README.md; no template directory is missing from
  `AllSkills`; every `SkillDeps` key is a real skill; `package.json` version `0.8.0` equals
  `lib/update-check.js`'s `CURRENT_VERSION`.
- Encoding sweep over every tracked `.js/.md/.json/.sh/.bat/.toml` file: all decode as strict
  UTF-8 and none contains a double-encoded dash/quote sequence. The only hit is this round's
  and round 59's own quotation of the artefact inside
  `docs/cc-arch-hands-review-2026-09-07-round-59.md:136`. `lib/probe.js:36` (`ï»¿`) and `:51`
  (`U+FEFF`) were byte-inspected and are the intended BOM literals, not corruption.
- Round-59 fix 1 (`releaseLease` fresh recovery deadline), revert-and-compare in a copied `lib/`
  tree: `test/lease-lock.test.js` → **fail** — `release must retry transient contention instead
  of spending the stale acquire-time budget: false !== true` (609 ms). At HEAD: pass.
- Round-59 fix 2 (`migrateClaim` release retry), same technique with `releaseClaimLease`
  replaced by a single `releaseLease`: `test/marker-state.test.js` → **fail** — `migration must
  recover once the transient contention clears: true !== false` (448 ms), 26/27 passing. At
  HEAD: 27/27.
- Round-59 fix 3 (guarded `abortPublication` in the publication unwind), same technique with the
  guard reverted to `if (!abortPublication(publication) && inspected)`:
  `test/conditional-publication.test.js` → **fail** — the assertion receives
  `Error: test-only abort publication failure` instead of the caller's original
  `test-only forward publication failure`. At HEAD: pass.
- The P2 was reproduced twice as described above (lease-level retry-is-inert table, and the
  end-to-end `migrateLegacyStateFiles()` run ending in `acquireStampLock … null (stamp
  dropped)`), both in throwaway temp directories importing the unmodified repository library.
- `git status --porcelain` and `git diff --check`: clean before and after, apart from this
  document; the throwaway `lib/` copy was created and deleted outside the repository. No real
  `~/.claude` state was touched; no install, no version change, no push.
