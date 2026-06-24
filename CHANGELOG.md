# Changelog

All notable changes to `cc-arch-hands` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
