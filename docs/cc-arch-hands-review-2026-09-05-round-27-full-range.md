# cc-arch-hands review — round 27 (36-hour retrospective, full range)

- Date: 2026-09-05
- Reviewer: independent read-only review; tests were not run, no source files were modified
- Range: `b9a333e..0b8e070` (6 commits: `19b7ffb`, `bced02e`, `5722191`, `1a20b19`, `6b21cdc`, `0b8e070`)
- Reviewed HEAD: `0b8e070`
- Result: 1 P1, 4 P2, 11 P3
- Filename note: `docs/cc-arch-hands-review-2026-09-05-round-27.md` was already present in the
  working tree as another reviewer's untracked, in-flight deliverable when this review started, so
  this file uses a distinct name rather than overwriting it.
- Verification gap: the repository has no configured remote, so the three-OS CI matrix in
  `.github/workflows/ci.yml` (ubuntu/macos/windows × node 18/20/22) has never executed against any
  commit in this range. Every claim below is from reading the code at `0b8e070` and tracing the
  paths by hand; nothing was executed.

## Per-commit summary

- `19b7ffb` docs(review): round 22 review only. Nothing to flag.
- `bced02e` release: agent-tree extraction, commands opt-in, Fable 5.1 mapping. Extraction is
  complete (no `agent-tree`/`AllAgentTreeSkills`/`SentinelAgentTree` residue in `lib/`, `bin/`,
  `templates/`, `scripts/`, `package.json`; `templates/skills/` has exactly the eleven `AllSkills`
  trees). Only a release-process note (P3-10).
- `5722191` fix: Haiku no-effort aliases, publish gate, bare uninstall keeps bins, session-partitioned
  stamp state, `.bat` caller-cwd fix. Mostly sound; P3-5, P3-7 originate here.
- `1a20b19` fix: CAS-safe `/ccheckpoint`, template validation, request-bound transcript fields.
  Sound; the bash block and its contract tests hold up.
- `6b21cdc` fix: the bulk of the path-safety, lock/fence, and atomic-removal code. The P1 and three
  of the four P2s originate here.
- `0b8e070` fix: dependency closure for installed bins, update-check refresh lock, detached-HEAD and
  linked-worktree checkpoint fixes, Astra agents. P2-A originates here; the round-26 P1 is
  genuinely closed (see "What holds up").

## Findings

### P1 — first-time skill install fails whenever any ancestor of a not-yet-existing skills root is a symlink (macOS `$TMPDIR`/`/tmp`, symlinked `/home`, Windows junctions)

`lib/skills.js:334` `ensureSafeDirectory(path, anchor)` collects the missing directories up to the
first existing ancestor, then — when the anchor (the skills root) does not exist yet — calls
`assertSafePath(cursor, null, 'directory')` (`lib/skills.js:349`), and again with a `null` anchor
after each `mkdirSync` while the anchor is still missing. `assertSafePath` (`lib/skills.js:292`)
has two early-return conditions and both are guarded by `anchor !== null`, so with a `null` anchor
the loop walks every component up to the filesystem root and throws on the first component whose
`lstat` is not a plain directory — which is what a symlink looks like to `lstat`.

Concrete trace on macOS: `mkdtempSync(join(tmpdir(), 'cah-test-'))` yields
`/var/folders/xx/yy/T/cah-test-abc`; `/var` is a symlink to `/private/var`. `writeSkills` on that
sandbox → `ensureSafeDirectory('/var/folders/.../cah-test-abc/.claude/skills/<skill>', root)` →
anchor missing → `assertSafePath('/var/folders/.../cah-test-abc', null, 'directory')` → walks
`T`, `yy`, `xx`, `folders`, reaches `/var` → `!info.isDirectory()` → throws
`destination path component is not a directory: /var`. The same happens for the dev loop documented
in `CLAUDE.md` (`node bin/cah.js install --templates ./templates --only skills --cwd /tmp/sandbox`)
on macOS, since `/tmp → /private/tmp`, and for any Linux home under a symlinked mount or any
Windows `--cwd` target beneath a junction (this machine relocates directories with junctions).

Two properties make it worse than a plain policy decision: it only fires when the skills root does
not exist yet (once `skills/` exists the walk stops at the anchor), so the second run succeeds and
the failure looks intermittent; and it contradicts the comment two functions above at
`lib/skills.js:281-283` ("do not impose a policy on unrelated ancestors such as a symlinked home
directory"). `test/installer.test.js` (`writeSkills` → `embedded smoke install`, every
`Scope({ cwd: tmpDir() })` skill test) and `test/cli.test.js` (every `mkdtempSync(join(tmpdir(), …))`
install) build exactly this shape, so the macOS leg of `npm test` should fail the first time CI runs.

Fix: when the anchor is absent, stop the walk at the first existing ancestor (mirror the
`anchorInfo === null` early return instead of passing `null`), or resolve the scope root once with
`realpathSync.native` and treat that as the anchor. Add a test that installs into a sandbox reached
through a directory symlink.

Validation: confirmed by trace; not executed.

### P2-A — update-check refresh lock can stall the statusLine and the Stop/PostToolUse hook for 10 s per invocation, and a dead owner is honored for 30 s regardless of liveness

`lib/update-check.js:151` `acquireRefreshLock` spins (`Atomics.wait` 10 ms) until
`LOCK_WAIT_MS = 10_000` (`:35`). `lockIsStale` (`:89`) checks
`nowMs - owner.startedAt <= LOCK_STALE_MS` (`:91`) *before* `processIsAlive`, so a lock whose owner
is already dead is treated as live for 30 s. The trigger is one the codebase already documents as
routine: `bin/cah-status.js` header explains that Claude Code cancels in-flight statusLine scripts,
and `cah-status` now holds this lock across a 1.5 s `curl`. Sequence: cache TTL expires (once per
24 h) → `cah-status` takes the lock and is cancelled mid-fetch → for the next 30 s every
`cah-status` render and every `cah-stamp` Stop/PostToolUse invocation blocks the full 10 s before
falling back to the cached value. A hook that blocks 10 s per tool call is a user-visible stall.

The test `recovers a refresh lock left by a crashed process` (`test/update-check.test.js:255`) uses
`startedAt: Date.now() - 60_000`, so the ≤30 s dead-owner window is untested. Contrast the other two
lock implementations in the same range (`bin/cah-checkpoint-hint.js:359` `claimExpired`,
`bin/cah-stamp.js` `stampLockClaimExpired`), which check liveness first — the three disagree on the
same question. `removeStaleLock` (`:103`) also leaves `update-check.json.lock.stale-<pid>-<hex>`
directories behind forever whenever the moved owner token does not match.

Fix: a statusLine or hook caller should never wait on someone else's network fetch — return the
cached value immediately when the lock is held (the file's own contract is "never on every render"),
check liveness before age, and bound the wait to something well under a statusLine budget.

Validation: confirmed by trace.

### P2-B — lock/claim/fence staleness is keyed on PID liveness alone; PID reuse silently and permanently disables stamping or hints for a session

`bin/cah-stamp.js` `stampLockClaimExpired`/`acquireStampLock`, `bin/cah-checkpoint-hint.js:359`
`claimExpired`, and `recoverAbandonedFence` (`bin/cah-checkpoint-hint.js:286`, mirrored in
`cah-stamp.js`) via `fenceOperatorPid` (`:267`) all decide "still owned" purely by
`process.kill(pid, 0)` when an owner record or a `.taken-<pid>-…` fence exists. `startedAt` /
`claimedAt` are written but never consulted once an owner exists. Every hook is a fresh short-lived
`node` process, and Windows recycles PIDs aggressively, so a hook killed between `mkdirSync(lock)`
and release leaves a lock that any later unrelated process with the same PID keeps alive. Effect:
`acquireStampLock` returns `null` → `main` returns before emitting anything → no stamps for that
session until that unrelated process exits; for the hint, the one-shot 90% message never fires. For
`update-check.json.lock` (global, shared by every session) the same coincidence combines with P2-A
into a permanent 10 s stall on every render/hook and a cache that can never refresh; only manually
deleting `~/.claude/cah-bin/cache/update-check.json.lock` recovers.

Rounds 26 and 27 both listed PID reuse as residual risk. It is promoted here because the new code
made PID liveness the *only* criterion; the fix is one line per implementation — an absolute upper
bound on owner-present locks (a few minutes is plenty for a hook), using the `startedAt` that is
already persisted.

Validation: confirmed by trace.

### P2-C — the `skills` class now refuses a symlinked `~/.claude` or `~/.claude/skills`, while every other class writes through the same symlink; undocumented, no escape hatch

`lib/skills.js:275` `assertSafeDestinationRoot` throws `destination root parent is a symlink`
(`:285`) when `<scope>/.claude` is a symlink, and `assertSafePath` throws when `skills/` itself is
one. Symlinking `~/.claude` (or the whole dotfiles-managed skills directory) into a stow/chezmoi repo
is a common setup. `writeModelAgents`, `writeModelCommands`, `writeCodexAgents` and `writeBins` all
still follow the symlink happily, so a bare `cah install` writes agents, then aborts with exit 1 in
the skills phase — a partial install that `cah doctor` reports as `missing` with no hint why. Nothing
in `CHANGELOG.md` or `README.md` mentions the new requirement, and there is no flag to accept it.

Either treat the realpath of the scope root as the trust anchor (the parent-identity snapshots
already protect everything below it) or document the policy and apply it to all classes uniformly.

Validation: confirmed by trace.

### P2-D — three divergent lock implementations, roughly 350 lines duplicated verbatim between two bins

`restoreMovedPath`, `takeOwnerPath`, `fencePaths`, `fenceOperatorPid`, `quarantineUnexpectedFence`,
`recoverAbandonedFence`, `hasInFlightFence`, `rollbackOwnedPath`, `cleanupCreatedClaim`,
`removePathIfUnchanged`, `fileIdentity`, `sameFileIdentity`, `pathIdentity`, `samePathIdentity`,
`ownerSnapshot`, `sameOwnerSnapshot`, `removeClaimPath`, `testOwnerInterlock`, the
`acquire*Claim`/`release*Claim`/`markDelivered`/`claimMarker` family and `pruneStaleMarkers` exist
in `bin/cah-checkpoint-hint.js` and again in `bin/cah-stamp.js` with identical bodies (the stamp copy
merely threads a `readOwner` parameter), and `lib/update-check.js` carries a third mkdir-lock with
its own staleness rules. `CLAUDE.md`'s instruction to extend the shared lib rather than recompute
inline exists to prevent exactly this; the divergence has already produced P2-A (age-before-liveness
in one copy only). A `lib/lockfile.js` shipped through `BinFiles` with one acquire/release and one
staleness policy would collapse all three and make P2-B a single fix.

### P3-1 — `ensureSafeDirectory` replaced the idempotent recursive mkdir with `mkdirSync(dir)`

`lib/skills.js:353` creates each missing component with a plain `mkdirSync`, which throws `EEXIST`
if a concurrent `cah install` (two terminals, or reinstall racing a hook-triggered install) creates
it first. Previously `writeFileAtomic`'s `mkdirSync(..., { recursive: true })` tolerated this.
Catch `EEXIST` and fall through to the `assertSafePath` re-check that already follows.

### P3-2 — `removeOwnedRegularFile` has no transient-error retry; Windows EBUSY/EPERM now aborts install, reinstall and uninstall mid-way

`lib/fsutil.js:227` renames the owned file to quarantine and rethrows anything except
`ENOENT`/`ENOTDIR`. `writeFileAtomic` in the same file retries `EPERM/EACCES/EBUSY/ENOTEMPTY` with
backoff precisely because Windows AV/indexer briefly locks recently-written files, but the removal
path (used by `removeSkills`, `pruneOrphanDirs` during *install*, and the sidecar pruners) does not.
A locked orphan manifest therefore fails `cah install` with exit 1 after some skills were written.
Related: when `restoreWithoutOverwrite` (`:276`) cannot hard-link (exFAT, SMB, unstable inode ids),
the `.cah-owned-remove-*` sibling is stranded inside the skill directory, later reported as
`preserved … (user data)` and permanently blocks directory removal; `removeSkills` also labels a
plain `rmdir` EBUSY as "user data".

### P3-3 — every file `cah` writes is now mode `0o600`

`lib/fsutil.js:92` opens the temp with mode `0o600` and the rename carries that mode to the
destination, so installed `SKILL.md`, agents, commands, Codex TOML, `settings.json` (via
`lib/probe.js`) and all caches lose group/other read. Previously they were umask-default (`0644`).
Harmless in `~/.claude`, surprising for a project-local `.claude/` on a shared checkout, and not
mentioned in the changelog. Pass an explicit mode or `chmod` after rename.

### P3-4 — `persistRateLimitsCache` re-stamps stale quota slots as fresh

`lib/transcript-stats.js:461` writes `fiveHour: fiveHour || existing.fiveHour` (same for
`sevenDay`) with `capturedAt: nowMs` whenever *either* slot is present. If the envelope stops
carrying one slot (plan change, API change), the last value is carried forward and its timestamp
refreshed on every render, so the 1 h staleness guard in `readRateLimitsCache` never expires it and
`cah-stamp` shows a frozen number indefinitely. The pre-range code wrote what it received.

### P3-5 — parseArgs exit codes diverged between install/reinstall and uninstall

`lib/cli.js:284` and `:367` map only `ERR_PARSE_ARGS_UNKNOWN_OPTION` and
`ERR_PARSE_ARGS_INVALID_OPTION_VALUE` to exit 2; `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`
(`cah install extra`) now exits 1, while `cah uninstall extra` still exits 2 and every parse error
exited 2 before this range. Match on the `ERR_PARSE_ARGS_` prefix.

### P3-6 — `bin/cah-stamp.js` hygiene left by the last edits

- Line 532 contains a mojibake literal (`ðŸ”µ`, the UTF-8 bytes of U+1F535 double-encoded) and line
  536 repairs it at runtime with `notice.text.replace(/^\n[^ ]+ cc-arch-hands/, …)`. Output is
  correct, but a source file patching its own corrupted literal is a maintenance trap; write the
  emoji (or `\u{1F535}`) directly and delete the replace.
- Lines 59–61 are a garbled three-line comment (a sentence was replaced mid-way).
- The `try` body in `main()` (lines 794–939) is not indented under its `try`.
- `const lockPath = acquireStampLock(…)` holds `{ path, owner }`, not a path.
- `pruneStaleMarkers` second pass tests `candidates.length > UPDATE_MARKER_MAX_SESSIONS` inside a
  loop that only runs when that is already true (same tautology in the hint bin).

### P3-7 — `lib/binstall.js` comment contradicts the code, and `writeBins` is the one writer still non-atomic

`lib/binstall.js:6-7` still says "each bin imports only lib/transcript-stats.js, which in turn
imports only node:fs" while `BinFiles` now ships `fsutil.js` and `sentinel.js` for exactly the
opposite reason. `writeBins` (`:71`) still uses `writeFileSync` although every other writer in the
range moved to `writeFileAtomic`; with `/clock` installed, the statusLine re-runs `cah-status.js`
every 60 s and at each turn boundary, so a `cah install` while Claude Code is open can hand the bar
a half-written file (blank bar until the next tick, or a SyntaxError in the hook).

### P3-8 — checkpoint-hint marker migration and `~/.claude` littering

`bin/cah-checkpoint-hint.js:31` `MARKER_NAME_RE` accepts only the new 64-hex names, so every
pre-upgrade `cah-hint-shown-<raw session id>` marker is now invisible to `pruneStaleMarkers` and
stays in `~/.claude/` forever (and in-flight sessions may get the hint a second time after upgrade).
The new claim directories (`.cah-marker-claim-*`) and tombstones (`*.taken-*`, `*.prune-*`,
`*.orphan-*`, `*.abandoned-*`) are created directly in `~/.claude/` rather than under
`~/.claude/cah-bin/cache/` where every other piece of hook state lives. Sweep the legacy prefix once
and move the markers into the cache directory.

### P3-9 — test scaffolding ships inside the production bins

`lib/fsutil.js:288` `waitForTestInterlock`, `testOwnerInterlock` (both bins), `fetchFromTestHook`
in `lib/update-check.js` and the `readChunk` injection in `scanTranscriptReverse` are all copied into
`~/.claude/cah-bin/`. They are gated on `CAH_TEST_ONLY === '1'` plus a path variable, so this is not
a security boundary, but it is ~100 lines of env-driven code in hooks that run on every tool call and
lets anyone who controls the environment make every hook block 10 s or spoof the "new version"
notice. Consider stripping these at `writeBins` time or moving the interlocks behind a test-only
import.

### P3-10 — release bookkeeping

`CHANGELOG.md` has the Astra agents under `[Unreleased]` while `package.json` and `CURRENT_VERSION`
are `0.8.0` and the new publish gate requires `tag == package.json == CURRENT_VERSION`; tagging
`v0.8.0` now ships six undocumented agents. `gpt-5.6-astra` availability is not verifiable from the
repository (also noted by the concurrent round-27 reviewer). And, as noted at the top, no remote is
configured, so the 3-OS CI matrix that would have caught the P1 has not run for any of these commits.

### P3-11 — concurrence with the other round-27 findings

The concurrent round-27 review's P2 (an atomic replacement of the destination leaf between
classification and `rename` is overwritten — inherent to rename-publish without a lock) and its two
P3s (`pruneOrphans` still does classify-then-`unlinkSync`; `/ccheckpoint`'s EXIT trap can remove a
successor `index.lock` in the window between `mv` and `sync_lock_owned=0`) are confirmed on reading
and not repeated here.

## What holds up

- Round-26 P1 is closed: `BinFiles` ships `lib/fsutil.js` and `lib/sentinel.js`; the static import
  closure is complete (`fsutil` → `sentinel` only, `update-check`/`transcript-stats` → `fsutil`,
  `cah-status-probe` → node builtins), and `test/binstall.test.js` spawns each installed bin from
  the mirrored tree.
- `/ccheckpoint`: symbolic-vs-detached identity is captured before the CAS, the post-CAS check uses
  `committed_head`, `git update-ref HEAD new old` dereferences a symbolic HEAD atomically, the real
  index is published through `index.lock` + rename with an EXIT trap, and `/checkpoint` resolves the
  repo with `git rev-parse --show-toplevel` (linked worktrees). The contract tests in
  `test/release-contract.test.js` exercise detached HEAD, staged-path skip, CAS retry, same-OID
  switch, merge/rebase state, pre-existing `index.lock`, and a linked worktree.
- `lib/transcript-stats.js` reverse scan: bounded (4 MB / 10 000 records / 64 KB chunks), no full-file
  fallback, request-bound merging that never mixes turns, user entries excluded, byte-level carry
  across chunk boundaries so multi-byte UTF-8 is never split before decoding.
- `writeFileAtomic`: exclusive-create random temp with `O_NOFOLLOW` where available, full-write loop,
  parent-identity re-checks, temp cleanup on every failure path.
- `pruneOrphanDirs` no longer descends or follows anything; a directory is removed only when its sole
  direct entry is the owned regular manifest, re-verified by identity immediately before removal.
- Haiku no-effort aliases: `effort: null` handled in `lib/agents.js`, `lib/commands.js`,
  `scripts/gen-docs.js` (new "no effort" column) with marker validation; README counts regenerated.
- `.github/workflows/publish.yml` triple version gate and `--tag next` for prereleases.
- `Scope.codexRoot()` honours `--local` strictness; `.bat` wrappers keep the caller's cwd and exit
  code; `classifyPath` reports a directory or unreadable file at an owned path as `foreign` (doctor
  exit 2); bare `cah uninstall` keeps the shared bins with an explicit warning on `--only bins`.
- Agent-tree extraction leaves the orphan sweep sentinel-gated, so legacy `<!-- cah-agent-tree:v1 -->`
  directories are preserved for the standalone package.

## Disposition

Not clean. Blocking before any tag or push: P1 (first-run skill install fails through a symlinked
ancestor; will also turn the macOS CI leg red the day a remote is added). Should land before
`v0.8.0`: P2-A and P2-B (lock stall and PID-only staleness — both are small, both are in code that
runs on every tool call) and a decision on P2-C (document the symlinked-`.claude` refusal or relax
it), ideally by way of P2-D so the fix is made once. The P3s can follow in a hygiene pass.
