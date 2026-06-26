# Changelog

All notable changes to `cc-arch-hands` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
