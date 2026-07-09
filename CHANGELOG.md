# Changelog

All notable changes to `cc-arch-hands` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] - 2026-07-10

### Fixed

- Corrected the Sol Codex model identifier from `sun` to `sol` for `ls`, `ms`,
  `hs`, `xs`, `xxs`, and `us`.

## [0.6.1] - 2026-07-09

### Added

- Added six optional Codex custom agents for Terra and Luna: `xt`, `xxt`, `ut`,
  `xl`, `xxl`, and `ul`, using `extra`, `max`, and `ultra` reasoning efforts.
- Added six optional Sol agents: `ls`, `ms`, `hs`, `xs`, `xxs`, and `us`, using
  the full `low`/`medium`/`high`/`extra`/`max`/`ultra` effort range.
- Added the standard `low`/`medium`/`high` agents for Terra (`lt`, `mt`, `ht`)
  and Luna (`ll`, `ml`, `hl`).

## [0.6.0]

### Added

- **Optional Codex custom agents.** A new install class installs 12 TOML
  custom-agent files for Codex under `~/.codex/agents/`, covering
  `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini` across four reasoning-effort
  levels (`low`/`medium`/`high`/`xhigh`). Codex agents are **opt-in** and
  never installed by the default `cah install`.
  - Activated via the `--codex-agents` flag, or selected as a class with
    `--only codex-agents` (combinable, e.g. `--only skills,codex-agents`).
  - New registry `AllCodexAgents` in `lib/manifest.js`, new module
    `lib/codex-agents.js` (`writeCodexAgents`/`removeCodexAgents`), new
    sentinel `# cah-codex-agent:v1`, and new scope resolver
    `resolveCodexAgentsDir()` → `~/.codex/agents/`.
  - Generated names: `l55 m55 h55 x55` · `l54 m54 h54 x54` ·
    `l54m m54m h54m x54m`.
  - Orphan pruning on install removes stale Codex TOML files whose names
    are no longer in the manifest (same pattern as commands/agents).
  - `cah list` and `cah doctor` report Codex agents; `cah doctor` excludes
    them from its health totals when none are installed (so it doesn't
    report 12 phantom "missing" files for a user who never opted in).

### Changed

- **`o46*` → `o4*` — Opus 4.6 command/agent names shortened.** The five
  Opus 4.6 entries are renamed: `o46l o46m o46h o46x o46xx` →
  `o4l o4m o4h o4x o4xx`. The underlying `model` id
  (`claude-opus-4-6`) and display strings are unchanged.
  - **Breaking for existing installs:** the `/o46l` … `/o46xx`
    slash-commands and the `ao46*` sub-agents move to their new names.
  - Running `cah install` (or `cah reinstall`) automatically prunes the
    five orphaned `o46*.md` / `ao46*.md` files and writes the new `o4*`
    ones — no manual cleanup needed.

## [0.5.3]

### Added

- **New-version check for `/clock`.** `cah-status` and `cah-stamp` now check
  whether a newer `cc-arch-hands` is published on npm, via a TTL-cached
  (24h) registry read shared between the two bins — the actual network
  call (`curl`, 1.5s timeout, fully fail-silent offline/no-curl) happens at
  most once a day, not on every render.
  - `cah-status` appends `· 🔵 vX.Y.Z` to the statusLine when a newer
    version is available.
  - `cah-stamp` emits a one-shot per-session notice in the chat, appended
    to the Stop-event stamp only (never on `PostToolUse`, which fires per
    tool call), with copy-pasteable update commands for both global and
    local installs:
    `npm install -g cc-arch-hands@latest && npx cah reinstall` /
    `npm install cc-arch-hands@latest && npx cah reinstall --local`.
  - New shared module `lib/update-check.js`, added to the `bins` install
    class's copied files (`~/.claude/cah-bin/lib/update-check.js`).

## [0.5.2]

### Changed

- **Model-command note shortened, and no longer explains itself as an
  Agent-tool disclaimer only implicitly.** Every model slash-command
  (`/ox`, `/sl`, etc.) now carries a short, static note before
  `$ARGUMENTS` clarifying that the command just switches the current
  turn's model/effort and is **not** a request to launch the `Agent`
  tool with a matching `subagent_type` — Claude Code registers a
  same-named sub-agent for every model command, and without this note
  the assistant could mistake `/ox <task>` for a delegation request.
  The note was later trimmed to drop the model/effort values it
  already duplicated from the command's frontmatter (`model:`/`effort:`),
  leaving just: `(Switches this turn's model/effort — not a request to
  launch an Agent.)`.

## [0.5.1]

### Changed

- **`cah-stamp` no longer renders an effort suffix in the chat audit trail.**
  Claude Code only exposes `effort.level` in the statusLine envelope, never
  in the transcript or the Stop/PostToolUse hook payload — the chat stamp
  could only ever echo the value `cah-status` last cached, which can lag one
  turn behind a model/effort switch (e.g. right after `/oxx`). The
  statusLine itself is unaffected and keeps rendering effort live and
  accurately on every render.

## [0.5.0]

### Changed

- **Sonnet (top) is now `claude-sonnet-5`.** `/sl /sm /sh /sx /sxx` (and the
  matching `Agent` selectors `sl/sm/sh/sx/sxx`) now point at the new
  `claude-sonnet-5` model on its full five-level effort scale (low → max,
  including `xhigh` for the first time on Sonnet) and a **1M** context
  window — display strings updated from `Sonnet (top, 200k)` to
  `Sonnet (top, 1M)`, and `modelLimit()` in `lib/transcript-stats.js` now
  special-cases `claude-sonnet-5` to report 1M tokens (affects the `/clock`
  statusLine and chat audit stamp percentage).
- **Sonnet 4.6 renamed `s46* → s4*` and gains `max`.** The old duplicate
  `/s46l /s46m /s46h` block (3 entries, no `max`) is replaced by
  `/s4l /s4m /s4h /s4xx` (4 entries). Total model commands/agents goes from
  36 → 38: +1 for Sonnet (top)'s new `xhigh` slot, +1 for Sonnet 4.6's new
  `max` slot.
- Running `cah reinstall` (or `cah install` after a prior install) cleans up
  all old `s46*`/old-mapping `sl/sm/sh/sxx` sentinel-owned files automatically
  — removal is sentinel-based, not name-list-based, so no manual cleanup is
  needed when upgrading.

## [0.4.6]

### Added

- **Sonnet (top) max — `/sxx`.** `claude-sonnet-4-6` at the `max` effort level
  is now available as a slash-command, sub-agent, and `Agent` selector
  (`/sxx`, `sxx`). Sonnet's effort scale jumps straight from `high` to `max`
  in Claude Code (no `xhigh`), so only one new entry is added — total goes
  from 35 → 36 model commands.
- **Effort code rendered next to the model name** in both the statusLine and
  the chat audit stamp:
  `Opus 4.7 [h] · 24% (240k/1M) · 5h 12% · wk 95%`. The bracketed code matches
  the slash-command suffix convention — `[l]` low, `[m]` medium, `[h]` high,
  `[x]` xhigh, `[xx]` max. Models without effort support (Haiku) render the
  bare name with no brackets.
- **Per-message dedup for `cah-stamp`.** Every assistant entry of the same
  turn shares an API `requestId`; the stamp records it and skips emission
  when the same turn would otherwise produce a second stamp (e.g. a long turn
  with many `PostToolUse` hooks crossing the throttle window). One stamp per
  assistant message, guaranteed.

### Changed

- **`CAH_STAMP_MIN_INTERVAL_MS` default lowered to 10 s** (was 60 s). The
  per-message dedup above is now the primary spam guard; the time-throttle
  is a safety net for odd hook bursts and a short value is fine.
- `readTranscriptStats` now also returns `requestId` (a third field alongside
  `usedTokens` and `modelId`). The on-disk `rate-limits.json` cache layout
  gains `effort` (string|null); old cache files without it read as
  `effort: null` and degrade gracefully.

## [0.4.5]

Hardening release addressing a third-party Node.js code review. No new
features; the focus is preventing data loss, fixing CLI contract gaps, and
improving cross-platform robustness.

### Fixed

- **Skill install/uninstall no longer destroys user files.** Previously a
  whole skill directory was deleted based only on the `SKILL.md` sentinel, so
  any file you dropped into a managed skill dir — or a `cp -r` copy of an
  installed skill carrying the sentinel — was silently wiped on the next
  `install`/`reinstall`/`uninstall`. Ownership is now decided per file: only
  files cah owns are overwritten/removed, and anything extra is preserved and
  reported (`preserved N (user data)` / `kept: <path>`).
- **Atomic writes for sentinel-bearing files.** Model command/agent `.md`
  files and skill manifests are written via a temp file + rename, so an
  interrupted or failed write can no longer strand a file in the unrecoverable
  `foreign` state (the sentinel sits at the end of the body).
- **`cah reinstall --templates DIR` no longer aborts.** The flag is documented
  but every invocation failed in the uninstall phase with
  `Unknown option '--templates'`; it now passes through cleanly.
- **`cah probe statusline` survives a UTF-8 BOM / preserves formatting.**
  A BOM-prefixed `settings.json` (some editors add one) no longer makes
  `probe stop` throw and strand the probe; existing indentation is preserved
  instead of being forced to 2-space; parse failures now print recovery
  guidance.
- **Probe command is cross-platform.** The `statusLine` command path is
  normalized to forward slashes (works under POSIX-like shells on Windows and
  across synced dotfiles) and embedded double-quotes are escaped.
- **Companion bins are installed executable** (`0o755`) and the sentinel is
  injected without producing mixed line endings when source files are checked
  out with CRLF. Added `.gitattributes` to keep `bin/`+`lib/` LF-only.
- **`cah-checkpoint-hint` cleans up after itself.** Stale one-shot marker
  files in `~/.claude/` (one per session) are pruned after 7 days; the bin is
  now strictly fail-silent (no stray stderr) and its displayed percentage is
  derived from the threshold constant.
- **Transcript stats read only the tail** of large transcripts instead of the
  whole file on every Stop/PostToolUse hook, and skip `type:"user"` entries
  entirely so a tool result echoing an upstream `usage`/`model` can't be
  mistaken for session context or mispaired with assistant usage. Guarded a
  `limit == 0` division that produced `Infinity%`.

### Changed

- **`cah doctor` now exits non-zero when unhealthy** — `2` if conflicting
  `foreign` files block a clean install, `1` if expected files are `missing`,
  `0` only when fully healthy. This makes `doctor` usable as a CI/script health
  gate (e.g. `cah doctor || cah install`). **Note:** scripts that relied on
  `doctor` always exiting `0` — including a fresh check before any install,
  which now returns `1` — must be updated.
- **`cah probe statusline <action>` rejects unknown trailing flags** (exit `2`),
  matching the strict-flag contract of every other subcommand. A typo like
  `--globl` now fails loudly instead of silently succeeding.
- **Install/uninstall now warn** when `--local`/`--cwd` is combined with the
  `bins` class, since bins always target the global `~/.claude/cah-bin/`.
- Top-level exception boundary in `bin/cah.js` turns an unexpected internal
  throw into a clean `cah: unexpected error: …` + exit 1 instead of a raw
  stack trace, and guards against a non-numeric exit code.

## [0.4.4]

### Added

- **statusLine now refreshes on a 60-second timer** (`refreshInterval: 60000`)
  in addition to turn boundaries. Keeps the bar visibly live during long, quiet
  stretches (no more frozen `5h N% (→HH:MM)` countdown). 60s sits safely above
  the Windows Node cold-start cost (1–3s) — no more harness-cancels-in-flight
  races that plagued the old sub-second tickers.
- **Env override `CAH_STATUSLINE_REFRESH_MS`** for users who want a different
  cadence (e.g. `3000` on Linux/macOS where cold-start is sub-second, or
  `300000` on a heavily-loaded machine).
- **Migration on re-install.** Re-running `/clock` on a pre-0.4.4 install
  rewrites the existing sentinel'd `statusLine` entry to include
  `refreshInterval`, reporting `statusLine: migrated`. Foreign entries are
  left untouched as always.

## [0.4.3]

### Changed

- **Chat-stamp throttle default raised from 10s to 60s.** PostToolUse + Stop
  hooks no longer produce a stamp on every tool call — at most one per
  minute. Override with `CAH_STAMP_MIN_INTERVAL_MS` (set to `10000` for
  the previous behaviour, or `300000` for a five-minute cadence).
- **Chat-stamp timestamp is now `HH:MM:SS`** (was `HH:MM`). The extra
  precision makes throttle/cadence bugs diagnosable from the chat
  scrollback alone — the original report of this fix was impossible to
  triage without per-second resolution.

### Added

- New `currentHhMmSs()` helper alongside `currentHhMm()` in
  `lib/transcript-stats.js`.

## [0.4.2]

### Added

- **Targeted install by skill name.** `--only` now accepts individual skill
  names from the embedded registry alongside install classes, e.g.
  `cah install --only clock`, `cah install --only clock,checkpoint-watch`,
  or any mix like `cah install --only commands,clock,bins`. The same
  selector is honoured by `install`, `reinstall`, and `uninstall`.
- **Auto-dependencies with notice.** When a skill is installed by name and
  it requires companion bins (currently `clock` and `checkpoint-watch`),
  the `bins` class is added automatically and the action is reported as
  `notice: auto-added 'bins' (required by: clock)`. `uninstall` is
  explicit-only and never auto-pulls.
- `cah` help (and `cah --help`) now lists every embedded skill name.

### Changed

- `parseOnly` returns `{classes, skills}` instead of a flat string array
  (internal API; the `--only` user-facing syntax is a strict superset of
  the previous one and stays backward-compatible).

## [0.4.1]

### Added

- **statusLine: 5-hour and weekly quota (Pro/Max).** `cah-status` reads
  `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` from the
  statusLine envelope and persists them to `~/.claude/cah-bin/cache/rate-limits.json`
  so `cah-stamp` (which receives a different envelope) can include them in the
  chat audit trail.
- **Progress bars in statusLine** for context, 5h, and weekly windows.
  Limit bars use square brackets and precise 8-level subblocks `[████▍░░░░░]`;
  time-elapsed bars use round brackets and medium-shade fill `(▓▓▓▒░░░░░░)`
  so the two axes are visually distinct.
- **`cah probe statusline start|stop|status`** — installer-driven diagnostic
  for the statusLine envelope. Atomically swaps `settings.statusLine` to a
  capturing bin (`cah-status-probe`), backs up the original, dumps each tick
  as JSONL, and restores the original on `stop` while printing the parsed
  envelope. Cross-platform, no manual `settings.json` edits.
- **Throttle for chat-stamp**: `cah-stamp` skips if it already emitted within
  `CAH_STAMP_MIN_INTERVAL_MS` (default 60s, was 10s in 0.4.1). Lets the stamp safely run on
  both `Stop` and `PostToolUse` hooks without spamming the scrollback.

### Changed

- **`/clock` installs chat-stamp on BOTH `Stop` AND `PostToolUse`** so the
  audit line ticks while a long turn is still running, not only at end of
  turn.
- Percentages formatted to two decimals with trailing zeros trimmed
  (`12.34%`, `50%`, `66.4%`) — previously rounded to whole percents.
- Reset times for 5h and weekly windows shown as `DD.MM HH:MM` (was
  `HH:MM` / `wd HH:MM`) — explicit date even when reset is on another day.
- Chat-stamp output stays **bar-free** (compact text); progress bars live
  only in the statusLine.

## [0.4.0]

### Added

- **`bins` install class.** `cah install` now copies the three companion bins
  (`cah-status`, `cah-stamp`, `cah-checkpoint-hint`) **and** their lone shared
  dependency `lib/transcript-stats.js` into the global `~/.claude/cah-bin/`,
  mirroring the package's `bin/` + `lib/` layout so the bins' relative import
  resolves unchanged. Drive it alone with `cah install --only bins`.
- New `// cah-bin:v1` sentinel on every copied bin file (rides the line after
  the shebang) — install does a sentinel-gated wipe-and-prune of orphans;
  foreign files are never touched.
- `Scope.resolveBinDir()` — always resolves to the global `~/.claude/cah-bin/`,
  ignoring `--local`/`--cwd`. There is one stable copy of the bins.
- `lib/binstall.js` (`writeBins` / `removeBins` / `BinFiles`) and matching test
  coverage (`test/binstall.test.js`, plus CLI-level integration tests in
  `test/cli.test.js`).

### Changed

- **`/clock` and `/checkpoint-watch` now reference the bins by absolute path**
  (`node "<HOME>/.claude/cah-bin/bin/<name>.js"`) in `settings.json` instead of
  a bare PATH name. This decouples them from where the `cc-arch-hands` npm
  package lives — moving, relinking (`npm link`), or uninstalling the package no
  longer breaks the statusLine or the Stop hooks.
- Both skills migrate a pre-0.4.0 bare-name `command` (e.g. `cah-status`) to the
  new absolute path automatically on re-run, preserving the ownership sentinel.
- `list` / `doctor` now enumerate the bin files alongside commands, agents, and
  skills (`kind: "bin"`).

### Notes

- The npm package still declares the companion bins in `package.json` `bin` for
  backward compatibility, but the skills no longer depend on PATH resolution.

## [0.3.x]

- `/clock` chat audit-trail, shared `transcript-stats`, cache-aware token sum.
- `/checkpoint-watch` Stop hook, `/babysit` / `/babygoal` task-list machinery,
  expanded skill surface.
