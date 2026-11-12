# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cah` (cc-arch-hands) — a Node.js CLI that installs/removes/inspects Claude Code per-model slash-commands, sub-agents, and skills under `~/.claude/` (global) or `<cwd>/.claude/` (local). Zero runtime dependencies — only Node.js built-ins (`node:fs`, `node:path`, `node:os`, `node:util`, `node:test`).

The npm package also ships **four bins** on PATH: `cah` (the main CLI, also aliased as `cc-arch-hands`), `cah-checkpoint-hint` (Stop hook of the pre-mod `/checkpoint-watch`, kept for projects that still have it), `cah-status` (statusLine command used by `/clock`), and `cah-stamp` (Stop hook used by `/clock` for the chat audit trail).

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

**Manifest-driven generation.** The 67 current Claude model definitions live in `lib/manifest.js` as `AllModelCommands`; each renders one command body and one agent body, for 134 installed bodies total. Both Claude commands and Claude agents are rendered parametrically at install time from this single registry. The current `AllCodexAgents` registry contains 46 optional Codex agents, installed only with `--codex-agents`. Every record also carries its model's `contextWindow` (Claude and Codex) and `maxContextWindow` (Codex); the Codex windows and accepted efforts come from the generated `lib/codex-model-specs.js`.

**Skills are static trees.** Each skill is a directory under `templates/skills/<name>/`. The `AllSkills` array in `lib/manifest.js` is the registry. Adding a skill = drop a directory + append the name.

**Sentinel-based ownership.** Every file `cah` writes carries a sentinel — an HTML comment for markdown (`<!-- cah-model-command:v1 -->`, etc.) or a line comment for the copied bin files (`// cah-bin:v1`). Install/uninstall/list use `string.includes()` on file content to classify files as mine/legacy/foreign/missing. Foreign files are never touched. Legacy sentinels (`<!-- crush-model-command:v1 -->`, `<!-- crush-model-agent:v1 -->`) from the crush fork are recognized and migrated on install.

**Scope resolution.** `lib/scope.js` resolves target directories. Default is `--global` (`~/.claude/`). `--local` (strict mode) refuses to create `.claude/` if it doesn't already exist. `--cwd PATH` implies local scope at that path.

**Templates.** `lib/templates.js` resolves skill trees from either the bundled `templates/` directory (relative to package root via `import.meta.url`) or from an arbitrary disk path via `--templates <dir>`.

**Shared fragments.** Behaviour common to every harness (Claude, Codex, OpenCode, OMP) is written once in `templates/shared/<name>.md` and pulled into a Markdown template with a line holding only `{{include:<name>}}`. `Templates.skillTree` expands it, so every installer gets the same text. A missing fragment, an inline include or a nested include throws. Fragments must stay harness-neutral (no `TaskList`, `todo`, `~/.claude` …): harness-specific wording stays in the template around the include. `test/templates-include.test.js` fails on an unused or unresolved fragment. Change shared behaviour in the fragment, never by editing each harness copy.

**The checkpoint-watch mod.** `templates/skills/checkpoint-watch/` is both a skill and a Claude Code plugin: `.claude-plugin/plugin.json` + `hooks/hooks.json` → `hooks/register.mjs` → `hooks/engine.mjs`. Claude Code loads a `~/.claude/skills/<name>/` folder holding a plugin manifest as `<name>@skills-dir` (here `cah-checkpoint-watch@skills-dir`) while its `SKILL.md` stays a skill, so the ordinary skills installer ships the mod, ccgp profiles included. The engine acts only in a project whose `.claude/settings.local.json` holds `cahCheckpointWatch.mode` (`checkpoint` | `commit`), written by `cah checkpoint-watch on [--commit]` (`lib/cli-checkpoint-watch.js` → `lib/checkpoint-watch.js`, shared settings lock + CAS); `/checkpoint-watch` and `/ccheckpoint-watch` only run that command. The cycle: abort the main turn at ≥90% → hold (drop + record) every non-own `prompt.submit` and abort stray main-loop turns → `$.command.run` `/checkpoint <name>` → `$.session.compact` → append `## Held events`, commit in `commit` mode → `$.command.run` `/resume <name>`. Claude Code's idle compaction reaches mods as trigger `auto`, like the threshold one; the engine takes an `auto` `session.compact` with no main turn running and ≥30 min (`IDLE_MIN_MS`) since the last main turn ended for the idle one, answers `{ skip }` and starts the same cycle. The cycle also starts from the engine's own silence timer (`armIdle`/`idleFire`): armed when a main turn ends, disarmed by the next turn or a cycle, fired only with no turn running, ≥200k tokens (`IDLE_MIN_TOKENS`) and inside a Git repository; a failed silence cycle sets `idleBlocked` until the context shrinks. Its switch is the separate `cahCheckpointIdle` key (`{ mode, minutes }`, 5–50 min), read through `$.settings.read` from the project's local file first and the user file second (a local `{ mode: "off" }` mutes a global one); `cah checkpoint-idle on|off|status` (`lib/cli-checkpoint-idle.js` → `lib/checkpoint-idle.js`, targets from `lib/settings-targets.js`) writes it, and the `/checkpoint-idle` and `/ccheckpoint-idle` skills only run that command. `lib/checkpoint-idle.js` mirrors the engine's `idleOf()` (the engine cannot import `lib/`); a test keeps them equal. Mod code has no Node built-ins and Claude Code's validator follows `# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cah` (cc-arch-hands) — a Node.js CLI that installs/removes/inspects Claude Code per-model slash-commands, sub-agents, and skills under `~/.claude/` (global) or `<cwd>/.claude/` (local). Zero runtime dependencies — only Node.js built-ins (`node:fs`, `node:path`, `node:os`, `node:util`, `node:test`).

The npm package also ships **four bins** on PATH: `cah` (the main CLI, also aliased as `cc-arch-hands`), `cah-checkpoint-hint` (Stop hook of the pre-mod `/checkpoint-watch`, kept for projects that still have it), `cah-status` (statusLine command used by `/clock`), and `cah-stamp` (Stop hook used by `/clock` for the chat audit trail).

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

**Manifest-driven generation.** The 67 current Claude model definitions live in `lib/manifest.js` as `AllModelCommands`; each renders one command body and one agent body, for 134 installed bodies total. Both Claude commands and Claude agents are rendered parametrically at install time from this single registry. The current `AllCodexAgents` registry contains 46 optional Codex agents, installed only with `--codex-agents`. Every record also carries its model's `contextWindow` (Claude and Codex) and `maxContextWindow` (Codex); the Codex windows and accepted efforts come from the generated `lib/codex-model-specs.js`.

**Skills are static trees.** Each skill is a directory under `templates/skills/<name>/`. The `AllSkills` array in `lib/manifest.js` is the registry. Adding a skill = drop a directory + append the name.

**Sentinel-based ownership.** Every file `cah` writes carries a sentinel — an HTML comment for markdown (`<!-- cah-model-command:v1 -->`, etc.) or a line comment for the copied bin files (`// cah-bin:v1`). Install/uninstall/list use `string.includes()` on file content to classify files as mine/legacy/foreign/missing. Foreign files are never touched. Legacy sentinels (`<!-- crush-model-command:v1 -->`, `<!-- crush-model-agent:v1 -->`) from the crush fork are recognized and migrated on install.

**Scope resolution.** `lib/scope.js` resolves target directories. Default is `--global` (`~/.claude/`). `--local` (strict mode) refuses to create `.claude/` if it doesn't already exist. `--cwd PATH` implies local scope at that path.

**Templates.** `lib/templates.js` resolves skill trees from either the bundled `templates/` directory (relative to package root via `import.meta.url`) or from an arbitrary disk path via `--templates <dir>`.

**Shared fragments.** Behaviour common to every harness (Claude, Codex, OpenCode, OMP) is written once in `templates/shared/<name>.md` and pulled into a Markdown template with a line holding only `{{include:<name>}}`. `Templates.skillTree` expands it, so every installer gets the same text. A missing fragment, an inline include or a nested include throws. Fragments must stay harness-neutral (no `TaskList`, `todo`, `~/.claude` …): harness-specific wording stays in the template around the include. `test/templates-include.test.js` fails on an unused or unresolved fragment.  only into top-level functions, so engine state is passed explicitly (`w`); `claude plugin validate <installed folder>` must pass. `test/checkpoint-watch.test.js` drives the engine with a fake `# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cah` (cc-arch-hands) — a Node.js CLI that installs/removes/inspects Claude Code per-model slash-commands, sub-agents, and skills under `~/.claude/` (global) or `<cwd>/.claude/` (local). Zero runtime dependencies — only Node.js built-ins (`node:fs`, `node:path`, `node:os`, `node:util`, `node:test`).

The npm package also ships **four bins** on PATH: `cah` (the main CLI, also aliased as `cc-arch-hands`), `cah-checkpoint-hint` (Stop hook of the pre-mod `/checkpoint-watch`, kept for projects that still have it), `cah-status` (statusLine command used by `/clock`), and `cah-stamp` (Stop hook used by `/clock` for the chat audit trail).

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

**Manifest-driven generation.** The 67 current Claude model definitions live in `lib/manifest.js` as `AllModelCommands`; each renders one command body and one agent body, for 134 installed bodies total. Both Claude commands and Claude agents are rendered parametrically at install time from this single registry. The current `AllCodexAgents` registry contains 46 optional Codex agents, installed only with `--codex-agents`. Every record also carries its model's `contextWindow` (Claude and Codex) and `maxContextWindow` (Codex); the Codex windows and accepted efforts come from the generated `lib/codex-model-specs.js`.

**Skills are static trees.** Each skill is a directory under `templates/skills/<name>/`. The `AllSkills` array in `lib/manifest.js` is the registry. Adding a skill = drop a directory + append the name.

**Sentinel-based ownership.** Every file `cah` writes carries a sentinel — an HTML comment for markdown (`<!-- cah-model-command:v1 -->`, etc.) or a line comment for the copied bin files (`// cah-bin:v1`). Install/uninstall/list use `string.includes()` on file content to classify files as mine/legacy/foreign/missing. Foreign files are never touched. Legacy sentinels (`<!-- crush-model-command:v1 -->`, `<!-- crush-model-agent:v1 -->`) from the crush fork are recognized and migrated on install.

**Scope resolution.** `lib/scope.js` resolves target directories. Default is `--global` (`~/.claude/`). `--local` (strict mode) refuses to create `.claude/` if it doesn't already exist. `--cwd PATH` implies local scope at that path.

**Templates.** `lib/templates.js` resolves skill trees from either the bundled `templates/` directory (relative to package root via `import.meta.url`) or from an arbitrary disk path via `--templates <dir>`.

**Shared fragments.** Behaviour common to every harness (Claude, Codex, OpenCode, OMP) is written once in `templates/shared/<name>.md` and pulled into a Markdown template with a line holding only `{{include:<name>}}`. `Templates.skillTree` expands it, so every installer gets the same text. A missing fragment, an inline include or a nested include throws. Fragments must stay harness-neutral (no `TaskList`, `todo`, `~/.claude` …): harness-specific wording stays in the template around the include. `test/templates-include.test.js` fails on an unused or unresolved fragment. .

**Companion bins.** Five companion runtime bins are installed under the shared bin root:
the legacy `/checkpoint-watch` hook → `cah-checkpoint-hint`, `/clock` → `cah-status`
(statusLine) + `cah-stamp` (Stop+PostToolUse hook), the opt-in probe →
`cah-status-probe`, and `/rewake` → `cah-rewake` (async `StopFailure` hook with
`asyncRewake` that backs off and exits 2 to wake a session an API error cut
off, plus an async `Stop` hook that resets its per-session counter). `cah-rewake`
imports no local module. Its hooks are written by `cah rewake on|off|status`
(`lib/cli-rewake.js` → `lib/rewake.js`, under the shared settings lock; global
scope also covers every ccgp profile's `settings.json`); the `/rewake` skill only
runs that command. The checkpoint, status, and stamp bins share
`lib/transcript-stats.js` for transcript JSONL walking, cache-aware token sum
(`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`),
model→limit mapping, per-turn `requestId` extraction (used by `cah-stamp` for
per-message dedup so a long turn produces one chat stamp, not many), and the
`HH:MM · <model> [effort] · X% (Nk/Mk)` formatter. **Don't recompute these
values inline in any new bin — extend `transcript-stats.js`.** The `effort`
level (`low/medium/high/xhigh/max`) is rendered as a one-letter bracketed
suffix matching the slash-command convention (`/sl /sm /sh /sx /sxx` →
`[l] [m] [h] [x] [xx]`); models without effort support render the bare name.
The statusLine envelope carries `effort.level` directly, so `cah-status`
renders it live and accurately every render. **`cah-stamp` never renders
effort** — Claude Code exposes `effort.level` only in the statusLine envelope,
never in the transcript or the Stop/PostToolUse hook payload, so the only way to
get it into the chat stamp would be to echo the cached value `cah-status` last
wrote, which can lag one turn behind a model/effort switch (e.g. right after
`/oxx`). Omitting it in the stamp avoids showing a misleading effort for the
wrong turn.

**Update check (`lib/update-check.js`, since 0.5.3).** Both `cah-status` and `cah-stamp` check whether a newer `cc-arch-hands` is published on npm, sharing a TTL-cached (`24h`) registry read at `~/.claude/cah-bin/cache/update-check.json` — whichever bin runs first populates it, so the actual network call (`curl` against `registry.npmjs.org`, 1.5s timeout, fully fail-silent) happens at most once a day, never on every render. `cah-status` appends `· 🔵 vX.Y.Z` to the statusLine when a newer version is cached. `cah-stamp` emits a one-shot **per-session** notice (marker file, same pattern as `cah-checkpoint-hint`) appended to the chat stamp — but **only on a real `Stop` event** (`payload.hook_event_name === 'Stop'`), never on `PostToolUse`, since that fires once per tool call and would spam the chat. `CURRENT_VERSION` in `lib/update-check.js` is a hardcoded literal kept in sync with `package.json`'s `version` by `test/update-check.test.js` — bump both together on release.

**The `bins` install class (since 0.4.0).** `cah install` copies the four
companion runtime bins and their shared library leaves
(`lib/sentinel.js`, `lib/fs-atomic-identity.js`, `lib/lease-clock.js`,
`lib/fs-atomic-publication.js`, `lib/stale-temps.js`,
`lib/fs-atomic.js`, `lib/fsutil.js`, `lib/lease-lock.js`,
`lib/marker-capacity-ops.js`, `lib/marker-capacity-stage.js`,
`lib/marker-capacity-recovery.js`, `lib/marker-state.js`, `lib/rate-limits-cache.js`,
`lib/transcript-stats.js`, `lib/update-check.js`, and `lib/proxy-model.js`) into
`~/.claude/cah-bin/`, mirroring the package's `bin/` + `lib/` layout so
the bins' relative imports resolve unchanged. `settings.json` then references
them by absolute path (`node "<HOME>/.claude/cah-bin/bin/cah-status.js"`)
instead of a bare PATH name. This decouples `/clock` and
`/rewake` from where the npm package lives — moving, relinking, or
uninstalling the package no longer breaks the statusLine/hooks. Each copied file
carries the `// cah-bin:v1` sentinel (rides the line after the shebang); install
does a wipe-and-prune of orphans, foreign files are never touched. The bins are
**always written to the global `~/.claude/cah-bin/`** regardless of scope flags
(`Scope.resolveBinDir()` ignores `--local`/`--cwd`) — there is one stable
copy, and even project-local `settings.json` points at it. The npm package still
declares the bins in `package.json` `bin` for backward compat, but the skills
no longer rely on PATH resolution. **The `/clock`
SKILL.md migrates a pre-0.4.0 bare-name `command` to the absolute path on
re-run.**

Publication is dependency-first: the managed package boundary, `sentinel.js`,
`fs-atomic-identity.js`, `lease-clock.js`, `fs-atomic-publication.js`, `stale-temps.js`,
`fs-atomic.js`, `fsutil.js`,
`lease-lock.js`, `marker-capacity-ops.js`, `marker-capacity-stage.js`,
`marker-capacity-recovery.js`, `marker-state.js`,
`rate-limits-cache.js`, `transcript-stats.js`, `update-check.js`, and `proxy-model.js` are replaced before any executable
bin. A new executable is
never exposed before its complete mirrored dependency chain is present.

## Key files

| File | Role |
|---|---|
| `bin/cah.js` | Main CLI entry point (`#!/usr/bin/env node`) |
| `bin/cah-checkpoint-hint.js` | Legacy Stop hook bin of the pre-mod `/checkpoint-watch`: one-shot 90% hint via systemMessage |
| `bin/cah-status.js` | statusLine bin: renders rich JSON envelope to one line |
| `bin/cah-stamp.js` | Stop hook bin: per-turn audit-trail systemMessage |
| `bin/cah-status-probe.js` | diagnostic statusLine bin: captures raw envelopes for `cah probe` |
| `bin/cah-rewake.js` | `StopFailure` (`wait`: back off 60→900 s, at most 6 tries, exit 2 wakes the session) and `Stop` (`reset`) hook bin; logs to `cah-bin/cache/rewake.log` |
| `lib/cli.js` | CLI dispatch, arg parsing (`node:util parseArgs`), presentation |
| `lib/manifest.js` | `AllModelCommands` registry + `AllCodexAgents` registry + `AllSkills` and `AllCodexSkills` lists + `SkillDeps` (skill → class) and `SkillSkillDeps` (skill → skill) |
| `lib/codex-model-specs.js` | Generated by `npm run sync:codex`: per Codex model `contextWindow`, `maxContextWindow` and accepted `efforts`; never hand-edit |
| `lib/cli-info.js` | `cah version` and `cah models --json` (the manifest as data, `schemaVersion` 1) |
| `lib/sentinel.js` | Sentinel constants, `classifyContent` |
| `lib/scope.js` | `Scope` class, `resolve*Dir()`, strict-mode guard; `claudeDir` pins the Claude root (ccgp profiles) |
| `lib/ccgp-profiles.js` | `discoverCcgpProfiles` / `syncCcgpProfiles` — a global install/uninstall repeats its commands/agents/skills phases in every ccgp profile dir (`<ccgp home>/claude/<name>` with `.ccgp-mirror.ktav`); a default ccgp home outside the current home dir is ignored so sandboxed tests never reach real profiles |
| `lib/templates.js` | Bundled / disk template abstraction, `skillTree` walker, `{{include:<name>}}` expansion from `templates/shared/` |
| `templates/shared/` | Harness-neutral fragments included by templates of every harness (e.g. `checkpoint-main-worktree.md`) |
| `lib/fsutil.js` | Read/list/prune helpers plus compatibility re-exports for filesystem primitives |
| `lib/fs-atomic-identity.js` | Exact BigInt identities and stable file snapshots |
| `lib/fs-atomic-publication.js` | Generation-fenced no-overwrite publication transaction |
| `lib/stale-temps.js` | `sweepStaleAtomicTemps` / `sweepStaleCacheTemps` (aged exact-name `.cah-tmp-<pid>-<token>` orphans, never recursive) and `sweepStaleTempsDaily` (once-a-day sweep driven by `cah-status`; also run by `cah install`/`uninstall`) |
| `lib/lease-clock.js` | Shared lease heartbeat/expiry rule (`LEASE_MAX_MS`, `ownerTimestamp`, `leaseExpired`) used by both lease-lock and fs-atomic-publication |
| `lib/settings-lock.js` | Shared cross-process settings.json lock — acquire/release with ownership-verified reclaim and release, built on lease-lock; used by lib/probe.js and the skills' published protocol |
| `lib/fs-atomic.js` | Atomic publication, quarantine, and conditional removal |
| `lib/transcript-stats.js` | Shared transcript walker + status-line formatter for all hook bins; re-exports cache helpers |
| `lib/rate-limits-cache.js` | Session-scoped quota/context-window sidecars, freshness, migration and bounded cleanup |
| `lib/proxy-model.js` | Optional local ccgp backend-label metadata with bounded fail-silent caching |
| `lib/marker-capacity-ops.js` | Durable marker-capacity transitions, exact victim CAS, and surfaced mismatch recovery |
| `lib/marker-capacity-stage.js` | Deterministic bounded staging and recovery for marker capacity transactions |
| `lib/marker-capacity-recovery.js` | Generation-aware transaction retirement, publication recovery, and victim restoration |
| `lib/marker-state.js` | Shared marker migration, claims, and bounded capacity transactions for hook bins |
| `lib/update-check.js` | `CURRENT_VERSION`, `isNewerVersion`, `getLatestVersion` — TTL-cached npm registry check shared by `cah-status`/`cah-stamp` |
| `lib/commands.js` | `writeModelCommands` / `removeModelCommands` |
| `lib/agents.js` | `writeModelAgents` / `removeModelAgents`, git-safety & test-scope clauses |
| `lib/codex-agents.js` | `writeCodexAgents` / `removeCodexAgents` for optional Codex TOML custom agents |
| `lib/codex-skills.js` | Reuses the owned skill-tree installer for optional Codex skills under `.codex/skills/` |
| `lib/codex-instructions.js` | Manages only the marked `cli-run` section in global Codex `AGENTS.md`; refuses masked or malformed state |
| `lib/codex-mcp-config.js` | Manages only the marked `[mcp_servers.cli-run]` block in the scope's Codex `config.toml`; refuses an unmanaged `cli-run` server or malformed markers |
| `templates/codex-skills/cli-run/scripts/mcp-server.mjs` | Zero-dependency stdio MCP server (`run`/`status`); takes the target thread from `tools/call` `_meta.threadId` because Codex does not set `CODEX_THREAD_ID` for MCP servers |
| `lib/skills.js` | `writeSkills` / `removeSkills` — overwrite owned files in place (atomic), never wipe the whole dir; user-added files inside a managed skill are preserved and reported |
| `lib/binstall.js` | `writeBins` / `removeBins` + `BinFiles` registry — copies companion bins into `~/.claude/cah-bin/` with `// cah-bin:v1` sentinel |
| `lib/binstall/runtime.js` | `BinFileDefinitions` — frozen data description of the companion runtime files, plus the derived local import graph and publication order used by install/repair |
| `lib/binstall-repair.js` | `sameRollbackState` / `republishConnectedGeneration` — rollback repair that re-publishes the connected runtime generation after an interrupted bin install |
| `lib/lease-lock.js` | portable directory leases — acquire/renew/release with reclaim fences, owned-file fence recovery/quarantine, and the shared bounded directory-scan primitives used by the hook bins |
| `templates/skills/checkpoint-watch/hooks/engine.mjs` | checkpoint-watch mod engine: threshold check, hold/record, checkpoint → compact → Held events → commit → resume |
| `lib/checkpoint-watch.js` | `updateWatch` / `readWatchState` — the `cahCheckpointWatch` key in a project's `settings.local.json`, plus removal of the legacy Stop hint hook from its `settings.json` |
| `lib/cli-checkpoint-watch.js` | `cah checkpoint-watch on [--commit]` / `off` / `status` `[--cwd PATH]`; refuses a folder outside a Git repository |
| `lib/checkpoint-idle.js` | `updateIdle` / `readIdleState` / `idleIn` — the `cahCheckpointIdle` key (`enable` with mode and minutes, `mute`, `disable`) in one settings file, via the shared `editSettings` of `lib/checkpoint-watch.js` |
| `lib/cli-checkpoint-idle.js` | `cah checkpoint-idle on [--commit] [--minutes N]` / `off` / `status` `[--global\|--local] [--cwd PATH]`: project default, `--global` = `~/.claude` + every ccgp profile |
| `lib/cli-settings-commands.js` | `SettingsCommands` — `rewake`, `checkpoint-watch` and `checkpoint-idle` keyed by subcommand name; `lib/cli.js` dispatches to it from its `default` branch (keeps `cli.js` under the 1000-line limit) |
| `lib/settings-targets.js` | `settingsTargets` — the settings.json files for `--global` (user + ccgp profiles) or `--local`/`--cwd`; shared by `cah rewake` and `cah checkpoint-idle` |
| `lib/rewake.js` | `updateRewake` / `readRewakeState` — add/remove the sentinel-tagged (`cah-hook:v1`, `cah-name: rewake`) StopFailure/Stop hooks in one settings.json with lock + CAS publish |
| `lib/cli-rewake.js` | `cah rewake on` / `off` / `status`, with `--global`, `--local` or `--cwd PATH`: global = `~/.claude/settings.json` + every ccgp profile |
| `lib/probe.js` | `enableProbe` / `disableProbe` / `readProbeLog` / `probeStatus` — atomic settings.json swap to wire `cah-status-probe` as the statusLine bin, with a sidecar backup file |
| `test/*.test.js` | Full test suite (`node:test` + `node:assert/strict`) — installer, cli, binstall, checkpoint-hint, clock, stamp, transcript-stats, probe, gen-docs |
| `scripts/sync-codex-models.js` | `npm run sync:codex` — rewrites `lib/codex-model-specs.js` from `codex debug models` (`--check`, `--from FILE`, `--out FILE`); exits 1 on effort drift between the manifest and Codex. Logic lives in `scripts/codex-models.js` |
| `scripts/gen-docs.js` | Regenerates README.md's model-commands table, Codex-agents table, and item counts from `lib/manifest.js` — run `npm run gen:docs` after editing the manifest; `npm run gen:docs:check` (also wired into `npm test` via `test/gen-docs.test.js`) fails if README.md has drifted |

## Conventions

- The `/crush` slash-command (`<!-- crush-slash-command:v1 -->`) is intentionally NOT managed by `cah`. Never add install/remove logic for it.
- Tests use `node:test` (describe/it) + `node:assert/strict`. No external test dependencies.
- Tests that mutate `AllSkills` must save/restore the array in a try/finally block — it's a module-level mutable export.
- Agent bodies include two hardcoded clauses (git-safety, test-scope) — these are contract text, not templates. Edit with care.
- **README install examples must cover every installable artefact.** The `Use` section must contain a one-line `npx cc-arch-hands install --only <name>` example for **every** skill in `AllSkills`, for `bins`, and for the class-flag classes (`commands`, `codex-agents`, `codex-skills`). Class `agents` is exempt — it has no point-install story. Document any new `AllCodexSkills` entry in the Codex skills section; Codex skills are selected as a class, not by individual name.
- **Codex windows and efforts are synced, not typed.** Run `npm run sync:codex` before a release (and after adding a Codex model entry). Each model needs exactly one agent per accepted effort: `test/manifest-windows.test.js` enforces that offline, and `test/codex-model-sync.test.js` compares against the live `codex debug models` when Codex is installed (skipped otherwise). Claude windows live in `ClaudeWindows` in `lib/manifest.js` and must match the `(1M)`/`(200k)` display label and `modelLimit()`.
- **The model-commands table, the Codex-agents table, and every generated count in README.md are generated, not hand-written.** They live between `<!--gen:table:KEY-->`/`<!--/gen:table:KEY-->` and `<!--gen:count:KEY-->N<!--/gen-->` markers. After editing `AllModelCommands` or `AllCodexAgents`, run `npm run gen:docs` — never hand-edit the content between those markers, it will just be overwritten. `test/gen-docs.test.js` runs `npm run gen:docs:check` and fails the suite if README.md has drifted from the manifest.
- **Opus, Fable, and Sonnet use "releases behind top" command/agent naming, not a version number.** `o1*` means "whichever Opus was top before the current one", `o2*` the one before that, etc. — `lib/manifest.js`'s Opus block must be renumbered (not the model ids) every time a new Opus generation ships and everyone shifts back one slot. Fable, Sonnet and Haiku follow the identical convention (`f1*`/`s1*`/`h1*` = previous top), renumbered the same way when a new generation ships. Claude Code applies no effort to Haiku 4.5, so the `h1*` commands differ only by name; the retired bare `h` and literal `h45` aliases must not come back.
- **Skill ⇄ dependency map is centralised in `lib/manifest.js` `SkillDeps`.** When a new skill needs companion bins or any other class, register it there — `lib/cli.js resolveDeps()` reads from that map and prints the `notice: auto-added 'bins' (required by: …)` line on install. A skill that needs another skill goes into `SkillSkillDeps` (`ccheckpoint-watch` → `checkpoint-watch`, which carries the mod); `resolveDeps()` adds it with `auto-added skill '…'`. Uninstall is explicit-only and never consults either map.
- **`parseOnly` returns `{classes, skills}`, not a flat array.** When wiring a new subcommand that takes `--only`, use `resolveDeps(parseOnly(vals.only))` and pass `skillsSubset` into `writeSkills` / `removeSkills` so subset installs/uninstalls leave foreign skills untouched.
- **Never recursively delete a skill directory based only on the `SKILL.md` sentinel.** `writeSkills`/`removeSkills`/`pruneOrphanDirs` must classify per-file: anything beyond the owned template tree is user data — preserve it and report via the `preserved` list. All file writes that carry an end-of-body sentinel go through `writeFileAtomic` (tmp + rename) so a torn write can't strand a file in `foreign` state.
- **`cah doctor` exits non-zero when unhealthy** — 2 if any `foreign` files block a clean install, 1 if expected files are `missing`, 0 only when fully healthy. It is a CI/script health gate; don't regress it back to always-0.
- **Class flags (`--codex-agents`, `--codex-skills`, `--commands`) share one flag-handling path.**
  `lib/cli.js`'s `OPT_IN_FLAG_CLASSES` + `applyOptInFlags()` is the single
  place that implements "`--<flag>` alone replaces the default class set;
  `--<flag>` combined with `--only` adds to it." Add a new flag-selectable
  class here rather than hand-rolling another `applyXFlag` function. A class
  is opt-in only if it is absent from `SELECTOR_CLASSES` (the default-install
  set) — today those are `codex-agents` and `codex-skills`. `cmdDoctor()` gates
  each opt-in class with zero installed items out of the health count.
  `commands` was opt-in in 0.8.0 because of
  [anthropics/claude-code#81318](https://github.com/anthropics/claude-code/issues/81318);
  it is back in the default set since that was fixed in Claude Code v2.1.280.
