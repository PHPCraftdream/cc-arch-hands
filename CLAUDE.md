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

**Manifest-driven generation.** The 35 model entries live in `lib/manifest.js` as `AllModelCommands`. Both commands and agents are rendered parametrically at install time from this single registry. Adding a new model/effort pair = one object in the array.

**Skills are static trees.** Each skill is a directory under `templates/skills/<name>/`. The `AllSkills` array in `lib/manifest.js` is the registry. Adding a skill = drop a directory + append the name.

**Sentinel-based ownership.** Every file `cah` writes carries an HTML-comment sentinel (`<!-- cah-model-command:v1 -->`, etc.). Install/uninstall/list use `string.includes()` on file content to classify files as mine/legacy/foreign/missing. Foreign files are never touched. Legacy sentinels (`<!-- crush-model-command:v1 -->`, `<!-- crush-model-agent:v1 -->`) from the crush fork are recognized and migrated on install.

**Scope resolution.** `lib/scope.js` resolves target directories. Default is `--global` (`~/.claude/`). `--local` (strict mode) refuses to create `.claude/` if it doesn't already exist. `--cwd PATH` implies local scope at that path.

**Templates.** `lib/templates.js` resolves skill trees from either the bundled `templates/` directory (relative to package root via `import.meta.url`) or from an arbitrary disk path via `--templates <dir>`.

**Companion bins.** Three skills ship a companion bin used as the Stop hook or statusLine command in user `settings.json`: `/checkpoint-watch` → `cah-checkpoint-hint`, `/clock` → `cah-status` (statusLine) + `cah-stamp` (Stop hook). All three bins share `lib/transcript-stats.js` for transcript JSONL walking, cache-aware token sum (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`), model→limit mapping, and the `HH:MM · model · X% (Nk/Mk)` formatter. **Don't recompute these values inline in any new bin — extend `transcript-stats.js`.**

## Key files

| File | Role |
|---|---|
| `bin/cah.js` | Main CLI entry point (`#!/usr/bin/env node`) |
| `bin/cah-checkpoint-hint.js` | Stop hook bin: one-shot 90% hint via systemMessage |
| `bin/cah-status.js` | statusLine bin: renders rich JSON envelope to one line |
| `bin/cah-stamp.js` | Stop hook bin: per-turn audit-trail systemMessage |
| `lib/cli.js` | CLI dispatch, arg parsing (`node:util parseArgs`), presentation |
| `lib/manifest.js` | `AllModelCommands` registry (35 entries) + `AllSkills` list |
| `lib/sentinel.js` | Sentinel constants, `classifyContent`, `isOurs` |
| `lib/scope.js` | `Scope` class, `resolve*Dir()`, strict-mode guard |
| `lib/templates.js` | Bundled / disk template abstraction, `skillTree` walker |
| `lib/fsutil.js` | `readFileMaybe` + `pruneOrphans` + `pruneOrphanDirs` helpers |
| `lib/transcript-stats.js` | Shared transcript walker + status-line formatter for all hook bins |
| `lib/commands.js` | `writeModelCommands` / `removeModelCommands` |
| `lib/agents.js` | `writeModelAgents` / `removeModelAgents`, git-safety & test-scope clauses |
| `lib/skills.js` | `writeSkills` / `removeSkills` (wipe-and-reinstall on upgrade) |
| `test/*.test.js` | Full test suite (`node:test` + `node:assert/strict`) — installer, cli, checkpoint-hint, clock, stamp, transcript-stats |

## Conventions

- The `/crush` slash-command (`<!-- crush-slash-command:v1 -->`) is intentionally NOT managed by `cah`. Never add install/remove logic for it.
- Tests use `node:test` (describe/it) + `node:assert/strict`. No external test dependencies.
- Tests that mutate `AllSkills` must save/restore the array in a try/finally block — it's a module-level mutable export.
- Agent bodies include two hardcoded clauses (git-safety, test-scope) — these are contract text, not templates. Edit with care.
