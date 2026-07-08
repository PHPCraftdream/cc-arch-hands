# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cah` (cc-arch-hands) — a Node.js CLI that installs/removes/inspects Claude Code per-model slash-commands, sub-agents, and skills under `~/.claude/` (global) or `<cwd>/.claude/` (local). Zero runtime dependencies — only Node.js built-ins (`node:fs`, `node:path`, `node:os`, `node:util`, `node:test`).

The npm package also ships **four bins** on PATH: `cah` (the main CLI, also aliased as `cc-arch-hands`), `cah-checkpoint-hint` (Stop hook used by `/checkpoint-watch`), `cah-status` (statusLine command used by `/clock`), and `cah-stamp` (Stop hook used by `/clock` for the chat audit trail).

## Build & test

```bash
node bin/cah.js install             # run directly
npm test                            # run the full test suite
node --test test/installer.test.js  # run a single test file
```

Dev-loop for template editing:
```bash
node bin/cah.js install --templates ./templates --only skills --cwd /tmp/sandbox
```

## Architecture

The codebase has two layers: a thin CLI (`lib/cli.js`) that does arg parsing and dispatch, and the installer modules (`lib/*.js`) that own all side effects.

**Manifest-driven generation.** The Claude model entries live in `lib/manifest.js` as `AllModelCommands`. Both Claude commands and Claude agents are rendered parametrically at install time from this single registry. Optional Codex agents live in `AllCodexAgents` and are installed only with `--codex-agents`.

**Skills are static trees.** Each skill is a directory under `templates/skills/<name>/`. The `AllSkills` array in `lib/manifest.js` is the registry. Adding a skill = drop a directory + append the name.

**Sentinel-based ownership.** Every file `cah` writes carries a sentinel — an HTML comment for markdown (`<!-- cah-model-command:v1 -->`, etc.) or a line comment for the copied bin files (`// cah-bin:v1`). Install/uninstall/list use `string.includes()` on file content to classify files as mine/legacy/foreign/missing. Foreign files are never touched. Legacy sentinels (`<!-- crush-model-command:v1 -->`, `<!-- crush-model-agent:v1 -->`) from the crush fork are recognized and migrated on install.

**Scope resolution.** `lib/scope.js` resolves target directories. Default is `--global` (`~/.claude/`). `--local` (strict mode) refuses to create `.claude/` if it doesn't already exist. `--cwd PATH` implies local scope at that path.

**Templates.** `lib/templates.js` resolves skill trees from either the bundled `templates/` directory (relative to package root via `import.meta.url`) or from an arbitrary disk path via `--templates <dir>`.

**Companion bins.** Three skills ship a companion bin used as the Stop hook or statusLine command in user `settings.json`: `/checkpoint-watch` → `cah-checkpoint-hint`, `/clock` → `cah-status` (statusLine) + `cah-stamp` (Stop+PostToolUse hook). All three bins share `lib/transcript-stats.js` for transcript JSONL walking, cache-aware token sum (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`), model→limit mapping, per-turn `requestId` extraction (used by `cah-stamp` for per-message dedup so a long turn produces one chat stamp, not many), and the `HH:MM · <model> [effort] · X% (Nk/Mk)` formatter. **Don't recompute these values inline in any new bin — extend `transcript-stats.js`.** The `effort` level (`low/medium/high/xhigh/max`) is rendered as a one-letter bracketed suffix matching the slash-command convention (`/sl /sm /sh /sx /sxx` → `[l] [m] [h] [x] [xx]`); models without effort support render the bare name. The statusLine envelope carries `effort.level` directly, so `cah-status` renders it live and accurately every render. **`cah-stamp` never renders effort** — Claude Code exposes `effort.level` only in the statusLine envelope, never in the transcript or the Stop/PostToolUse hook payload, so the only way to get it into the chat stamp would be to echo the cached value `cah-status` last wrote, which can lag one turn behind a model/effort switch (e.g. right after `/oxx`). Omitting it in the stamp avoids showing a misleading effort for the wrong turn.

**Update check (`lib/update-check.js`, since 0.5.3).** Both `cah-status` and `cah-stamp` check whether a newer `cc-arch-hands` is published on npm, sharing a TTL-cached (`24h`) registry read at `~/.claude/cah-bin/cache/update-check.json` — whichever bin runs first populates it, so the actual network call (`curl` against `registry.npmjs.org`, 1.5s timeout, fully fail-silent) happens at most once a day, never on every render. `cah-status` appends `· 🔵 vX.Y.Z` to the statusLine when a newer version is cached. `cah-stamp` emits a one-shot **per-session** notice (marker file, same pattern as `cah-checkpoint-hint`) appended to the chat stamp — but **only on a real `Stop` event** (`payload.hook_event_name === 'Stop'`), never on `PostToolUse`, since that fires once per tool call and would spam the chat. `CURRENT_VERSION` in `lib/update-check.js` is a hardcoded literal kept in sync with `package.json`'s `version` by `test/update-check.test.js` — bump both together on release.

**The `bins` install class (since 0.4.0).** `cah install` copies the three companion bins **and** their lone dependency `lib/transcript-stats.js` into `~/.claude/cah-bin/`, mirroring the package's `bin/` + `lib/` layout so the bins' relative import resolves unchanged. `settings.json` then references them by absolute path (`node "<HOME>/.claude/cah-bin/bin/cah-status.js"`) instead of a bare PATH name. This decouples `/clock` and `/checkpoint-watch` from where the npm package lives — moving, relinking, or uninstalling the package no longer breaks the statusLine/hooks. Each copied file carries the `// cah-bin:v1` sentinel (rides the line after the shebang); install does a wipe-and-prune of orphans, foreign files are never touched. The bins are **always written to the global `~/.claude/cah-bin/`** regardless of scope flags (`Scope.resolveBinDir()` ignores `--local`/`--cwd`) — there is one stable copy, and even project-local `settings.json` points at it. The npm package still declares the bins in `package.json` `bin` for backward compat, but the skills no longer rely on PATH resolution. **The `/clock` and `/checkpoint-watch` SKILL.md migrate a pre-0.4.0 bare-name `command` to the absolute path on re-run.**

## Key files

| File | Role |
|---|---|
| `bin/cah.js` | Main CLI entry point (`#!/usr/bin/env node`) |
| `bin/cah-checkpoint-hint.js` | Stop hook bin: one-shot 90% hint via systemMessage |
| `bin/cah-status.js` | statusLine bin: renders rich JSON envelope to one line |
| `bin/cah-stamp.js` | Stop hook bin: per-turn audit-trail systemMessage |
| `lib/cli.js` | CLI dispatch, arg parsing (`node:util parseArgs`), presentation |
| `lib/manifest.js` | `AllModelCommands` registry + `AllCodexAgents` registry + `AllSkills` list |
| `lib/sentinel.js` | Sentinel constants, `classifyContent`, `isOurs` |
| `lib/scope.js` | `Scope` class, `resolve*Dir()`, strict-mode guard |
| `lib/templates.js` | Bundled / disk template abstraction, `skillTree` walker |
| `lib/fsutil.js` | `readFileMaybe` + `writeFileAtomic` + `listFilesRel` + `pruneOrphans` + `pruneOrphanDirs` helpers |
| `lib/transcript-stats.js` | Shared transcript walker + status-line formatter for all hook bins |
| `lib/update-check.js` | `CURRENT_VERSION`, `isNewerVersion`, `getLatestVersion` — TTL-cached npm registry check shared by `cah-status`/`cah-stamp` |
| `lib/commands.js` | `writeModelCommands` / `removeModelCommands` |
| `lib/agents.js` | `writeModelAgents` / `removeModelAgents`, git-safety & test-scope clauses |
| `lib/codex-agents.js` | `writeCodexAgents` / `removeCodexAgents` for optional Codex TOML custom agents |
| `lib/skills.js` | `writeSkills` / `removeSkills` — overwrite owned files in place (atomic), never wipe the whole dir; user-added files inside a managed skill are preserved and reported |
| `lib/binstall.js` | `writeBins` / `removeBins` + `BinFiles` registry — copies companion bins into `~/.claude/cah-bin/` with `// cah-bin:v1` sentinel |
| `lib/probe.js` | `enableProbe` / `disableProbe` / `readProbeLog` / `probeStatus` — atomic settings.json swap to wire `cah-status-probe` as the statusLine bin, with a sidecar backup file |
| `test/*.test.js` | Full test suite (`node:test` + `node:assert/strict`) — installer, cli, binstall, checkpoint-hint, clock, stamp, transcript-stats, probe |

## Conventions

- The `/crush` slash-command (`<!-- crush-slash-command:v1 -->`) is intentionally NOT managed by `cah`. Never add install/remove logic for it.
- Tests use `node:test` (describe/it) + `node:assert/strict`. No external test dependencies.
- Tests that mutate `AllSkills` must save/restore the array in a try/finally block — it's a module-level mutable export.
- Agent bodies include two hardcoded clauses (git-safety, test-scope) — these are contract text, not templates. Edit with care.
- **README install examples must cover every installable artefact.** The `Use` section must contain a one-line `npx cah install --only <name>` example for **every** skill in `AllSkills` AND for `bins`. Classes `commands` and `agents` are exempt — they have no point-install story. When adding a new skill to `AllSkills`, add its example line in `README.md` in the same PR; CI does not enforce this, the project does.
- **Skill ⇄ dependency map is centralised in `lib/manifest.js` `SkillDeps`.** When a new skill needs companion bins or any other class, register it there — `lib/cli.js resolveDeps()` reads from that map and prints the `notice: auto-added 'bins' (required by: …)` line on install. Uninstall is explicit-only and never consults `SkillDeps`.
- **`parseOnly` returns `{classes, skills}`, not a flat array.** When wiring a new subcommand that takes `--only`, use `resolveDeps(parseOnly(vals.only))` and pass `skillsSubset` into `writeSkills` / `removeSkills` so subset installs/uninstalls leave foreign skills untouched.
- **Never recursively delete a skill directory based only on the `SKILL.md` sentinel.** `writeSkills`/`removeSkills`/`pruneOrphanDirs` must classify per-file: anything beyond the owned template tree is user data — preserve it and report via the `preserved` list. All file writes that carry an end-of-body sentinel go through `writeFileAtomic` (tmp + rename) so a torn write can't strand a file in `foreign` state.
- **`cah doctor` exits non-zero when unhealthy** — 2 if any `foreign` files block a clean install, 1 if expected files are `missing`, 0 only when fully healthy. It is a CI/script health gate; don't regress it back to always-0.
