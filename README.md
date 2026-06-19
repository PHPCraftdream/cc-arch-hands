# cc-arch-hands (`cah`)

Installer for the artifacts that turn Claude Code into an architect's
workshop: per-model slash-commands, per-model delegated sub-agents, and
skills. Zero runtime dependencies — only Node.js built-ins.

```bash
npx cc-arch-hands install        # that's it — installs commands, agents & skills into ~/.claude/
```

> Other ways to run: [npm global install](#quick-start), [from source](#from-source). Full command reference in [Use](#use).

## What it installs

Three kinds of Claude Code artifacts, all generated from a single model
registry so they stay in lockstep.

### 1. Per-model slash-commands (35)

A short slash-command for every `{model, effort}` pair, so you can switch
the model **and** reasoning effort for a single turn just by how you start
the message. The command name encodes both — model letter + version +
effort suffix:

```
/oh   run this turn on Opus (top) at high effort
/o47x run this turn on Opus 4.7 at xhigh effort
/sm   Sonnet (top), medium effort
/fxx  Fable 5, max effort
/hl   Haiku, low effort
```

Suffixes: `l` low · `m` medium · `h` high · `x` xhigh · `xx` max.
Whatever you type after the command becomes the prompt for that turn.

### 2. Per-model sub-agents (35)

The same matrix as `a<name>` (`aoh`, `ao47x`, `afxx`, …) — but as
**delegated sub-agents** instead of inline commands. Use them to hand a
self-contained task to a fresh context window on a chosen model/effort; it
runs autonomously and returns only the result. Each agent body carries two
hardcoded safety clauses: a **git-safety** rule (no mutating git commands
in a shared worktree) and a **test-scope** rule (run only scoped tests, not
the whole suite).

### Naming matrix

Command name = **model letter** (+ version) + **effort suffix**. The agent
name is just the command name with an `a` prefix. Effort suffixes:
`l` low · `m` medium · `h` high · `x` xhigh · `xx` max.

Rows are sorted by tier (strongest first). Bold rows are **top** shortcuts
that always point at the freshest version of each family — use them when
you don't care about pinning an exact version.

**Slash-commands**

| Model | model id | low | medium | high | xhigh | max |
|---|---|---|---|---|---|---|
| **Fable** (top) | `claude-fable-5` | `/fl` | `/fm` | `/fh` | `/fx` | `/fxx` |
| **Opus** (top) | `claude-opus-4-8` | `/ol` | `/om` | `/oh` | `/ox` | `/oxx` |
| Opus 4.7 | `claude-opus-4-7` | `/o47l` | `/o47m` | `/o47h` | `/o47x` | `/o47xx` |
| Opus 4.6 | `claude-opus-4-6` | `/o46l` | `/o46m` | `/o46h` | `/o46x` | `/o46xx` |
| **Sonnet** (top) | `claude-sonnet-4-6` | `/sl` | `/sm` | `/sh` | — | — |
| Sonnet 4.6 | `claude-sonnet-4-6` | `/s46l` | `/s46m` | `/s46h` | — | — |
| Sonnet 4.5 | `claude-sonnet-4-5` | `/s45l` | `/s45m` | `/s45h` | — | — |
| **Haiku** (top) | `claude-haiku-4-5` | `/hl` | `/hm` | `/hh` | — | — |
| Haiku 4.5 | `claude-haiku-4-5` | `/h45l` | `/h45m` | `/h45h` | — | — |

**Sub-agents** (same matrix, `a` prefix)

| Model | model id | low | medium | high | xhigh | max |
|---|---|---|---|---|---|---|
| **Fable** (top) | `claude-fable-5` | `afl` | `afm` | `afh` | `afx` | `afxx` |
| **Opus** (top) | `claude-opus-4-8` | `aol` | `aom` | `aoh` | `aox` | `aoxx` |
| Opus 4.7 | `claude-opus-4-7` | `ao47l` | `ao47m` | `ao47h` | `ao47x` | `ao47xx` |
| Opus 4.6 | `claude-opus-4-6` | `ao46l` | `ao46m` | `ao46h` | `ao46x` | `ao46xx` |
| **Sonnet** (top) | `claude-sonnet-4-6` | `asl` | `asm` | `ash` | — | — |
| Sonnet 4.6 | `claude-sonnet-4-6` | `as46l` | `as46m` | `as46h` | — | — |
| Sonnet 4.5 | `claude-sonnet-4-5` | `as45l` | `as45m` | `as45h` | — | — |
| **Haiku** (top) | `claude-haiku-4-5` | `ahl` | `ahm` | `ahh` | — | — |
| Haiku 4.5 | `claude-haiku-4-5` | `ah45l` | `ah45m` | `ah45h` | — | — |

35 commands, 35 agents — one line per row-cell in
[`lib/manifest.js`](lib/manifest.js).

### 3. Skills (8)

Reusable capability packs Claude Code loads on demand. Each is invoked as
`/skill-name` from a chat. Grouped by purpose:

**Onboarding**

| Skill | Purpose |
|---|---|
| `/repo-sight` | Diagnose an unfamiliar repository from its git history, structure and behavior *before* reading code, and return a ranked reading list with explicit caveats. |

**Planning & execution**

| Skill | Purpose |
|---|---|
| `/task` | Analyze a free-form request, decompose it into prioritized sub-tasks with dependencies, and register them in the session via TaskCreate. Plans only — does not execute. Usage: `/task <description>`. |
| `/babygoal` | Decompose a goal into tasks, immediately start executing them, and invoke `/babysit` to monitor progress. At the end, prints a copy-paste `/goal` line so you can optionally set a Stop-hook guard. Usage: `/babygoal [interval] <goal>`. |
| `/babysit` | Start a `/loop` (default `15m`) that detects when a goal stalled — network error, API timeout, missed continuation — and resumes work automatically. Usage: `/babysit [interval]`. |

**Session memory**

| Skill | Purpose |
|---|---|
| `/checkpoint` | Persist current session state (active `/goal`, TaskList with `blockedBy`, recent decisions, open questions, repo state) to a markdown file under `docs/checkpoints/`. Usage: `/checkpoint` (auto-timestamped) or `/checkpoint <name>` (named, re-runs overwrite). |
| `/resume` | Reload a checkpoint, rebuild the TaskList via TaskCreate, restate the goal as a copy-paste line, surface open questions. Usage: `/resume` (most recent), `/resume <name>` (exact or prefix), `/resume --list` (browse without restoring). |
| `/checkpoint-prune` | Delete checkpoints. Arg auto-detected: `<name>` (one file), `14d`/`48h` (older than), bare number (keep last N), no arg (all). Confirms before batch deletes; `--dry` reports only. Usage: `/checkpoint-prune`, `/checkpoint-prune 14d`, `/checkpoint-prune 10`, `/checkpoint-prune <name>`. |
| `/triage` | TaskList hygiene — flag stale `in_progress`, orphan blockers, dead-end chains, trivial sibling clusters, completed clutter, duplicate subjects. Advisory by default; asks before mutating. Usage: `/triage` or `/triage --dry`. |

#### Session memory in detail

`/checkpoint` and `/resume` pair up to survive auto-compaction, machine
switches, and long pauses. The flow:

```bash
# In a session, before a context compact or before stepping away:
/checkpoint pre-refactor       # writes docs/checkpoints/pre-refactor.md
                               # (or ~/.claude/checkpoints/ if not in a git repo)

# Iteratively update the same named checkpoint as work progresses:
/checkpoint pre-refactor       # overwrites the same file

# Later — same session after compact, or a brand-new session:
/resume --list                 # see what's available
/resume pre-refactor           # restore TaskList + goal + decisions + open questions

# Housekeeping when the directory fills up:
/checkpoint-prune 14d            # drop anything older than two weeks
/checkpoint-prune 5              # keep the 5 most recent, delete the rest
/checkpoint-prune pre-refactor   # remove one specific checkpoint
/checkpoint-prune                # delete ALL (asks to confirm)
# (or just `rm docs/checkpoints/<name>.md` — it's a plain file)
```

What goes into a checkpoint:

- **Active goal** — the current `/goal` Stop-hook condition, verbatim.
- **TaskList snapshot** — every task with `id`, `status`, `subject`,
  `blockedBy`, grouped by status.
- **Decision log** — up to 5 recent material decisions (chose X over Y
  because Z) extracted from conversation context.
- **Open questions** — anything flagged as needing user input.
- **Repo state** — `git status --short` and `git log --oneline -5`.

Empty sections stay empty with a one-line reason — the skill never
invents content to look complete. Checkpoints are not added to git
automatically; that decision stays with you.

What `/resume` does:

1. Locates the checkpoint directory (repo-local first, `~/.claude/` fallback).
2. With `--list`: prints a table (name, size, mtime, title) and stops.
3. Otherwise resolves the target file by exact-match or prefix-match
   (ambiguous prefix → asks, never silently picks).
4. Re-creates pending/in_progress tasks via TaskCreate, re-wires
   `blockedBy` by `subject` matching (IDs will differ from the snapshot).
5. Prints the prior goal as a copy-paste `/goal <text>` block — `/goal`
   is a user-side command, so you re-arm the Stop hook yourself.
6. Warns if the checkpoint is older than 7 days, since repo state may
   have drifted.

### Where it goes

| Artifact | Count | Destination |
|---|---|---|
| Slash-commands | 35 | `<scope>/.claude/commands/<name>.md` |
| Sub-agents | 35 | `<scope>/.claude/agents/a<name>.md` |
| Skills | 8 | `<scope>/.claude/skills/<name>/` |

`<scope>` is `~/` by default (global install). Use `--local` or `--cwd`
to target a specific project directory instead.

The `/crush` slash-command is **intentionally NOT installed by `cah`** —
it belongs to the [crush](https://github.com/PHPCraftdream/crush) fork
and is owned by its own `claude-init` command.

## Quick start

No install needed — run directly with `npx`:

```bash
npx cc-arch-hands install                # install globally into ~/.claude/
npx cc-arch-hands uninstall              # remove everything we own
npx cc-arch-hands list                   # show what's installed
npx cc-arch-hands doctor                 # health check
```

Or install globally for repeated use:

```bash
npm install -g cc-arch-hands
cah install                              # same as npx, but faster (no download)
```

### From source

```bash
git clone https://github.com/PHPCraftdream/cc-arch-hands
cd cc-arch-hands

# Install globally into ~/.claude/ (idempotent — safe to re-run):
./install.sh                    # Linux/macOS/BSD
install.bat                     # Windows

# Reinstall (clean uninstall + install):
./reinstall.sh
reinstall.bat

# Uninstall:
./uninstall.sh
uninstall.bat
```

All wrapper scripts forward flags, e.g. `./install.sh --only skills` or
`install.bat --local`.

## Use

Via npx (no install):

```bash
npx cah install                          # global (default): ~/.claude/{commands,agents,skills}
npx cah install --local                  # local: <cwd>/.claude/... (must already exist)
npx cah install --cwd /path/to/project   # local at a specific path
npx cah install --only skills            # subset: any combo of commands,agents,skills

npx cah uninstall                        # symmetric remove (sentinel-gated)
npx cah uninstall --only agents          # subset uninstall

npx cah list                             # tabular: NAME | KIND | STATE
npx cah list --json                      # NDJSON for scripting
npx cah doctor                           # condensed health verdict
npx cah version                          # version + counts
```

From source (same commands, prefix with `node bin/cah.js`):

```bash
node bin/cah.js install
node bin/cah.js install --templates ./templates  # dev: load from disk instead of embedded
node bin/cah.js list --json
```

## Ownership and safety

Every file `cah` writes carries one of three HTML-comment sentinels
buried at the end of the file:

```
<!-- cah-model-command:v1 -->
<!-- cah-model-agent:v1 -->
<!-- cah-skill:v1 -->
```

A file under `.claude/{commands,agents,skills}/` is recognised as
**ours** if it contains any of these. Files without a recognised marker
are foreign — `cah` never overwrites or deletes them, only logs a
warning.

### Orphan sweep

When a `{model, effort}` pair or a skill is dropped from `lib/manifest.js`,
the previously installed file would otherwise sit forever in
`~/.claude/`. To prevent that, `cah install` finishes each class with a
**prune** step: any file (or skill directory) that carries our sentinel
but is no longer in the manifest is deleted, and the count is reported
on a `pruned N (orphan)` tail. Foreign files are never touched by the
prune step.

### Migration from `crush claude-init`

Per-model commands and agents used to ship inside the crush fork under
the older `crush-*` sentinels:

```
<!-- crush-model-command:v1 -->
<!-- crush-model-agent:v1 -->
```

`cah` recognises both families as "ours" and migrates legacy files on
the next `cah install` (overwritten and re-stamped with the new
sentinel). `cah uninstall` removes either family.

The legacy `<!-- crush-slash-command:v1 -->` marker (the `/crush`
slash-command body) is intentionally **not** in this set — `cah` neither
installs nor removes `/crush`. That's still owned by the crush fork's
`claude-init` command.

## Layout

```
cc-arch-hands/
├── bin/cah.js                   # CLI entry point (#!/usr/bin/env node)
├── lib/
│   ├── cli.js                   # dispatch, arg parsing (node:util parseArgs)
│   ├── manifest.js              # AllModelCommands (35 entries) + AllSkills (8)
│   ├── sentinel.js              # new + legacy markers, ownership classifier
│   ├── scope.js                 # global vs local target dir resolution
│   ├── templates.js             # bundled / disk template abstraction
│   ├── fsutil.js                # readFileMaybe + orphan-prune helpers
│   ├── commands.js              # render + install + remove (35 .md files)
│   ├── agents.js                # render + install + remove (35 a*.md files)
│   └── skills.js                # mirror templates/skills/<n>/ tree
├── templates/
│   └── skills/                  # repo-sight, task, babygoal, babysit,
│       └── <name>/SKILL.md      # checkpoint, resume, checkpoint-prune, triage
├── test/
│   ├── installer.test.js        # installer tests (node:test + node:assert)
│   └── cli.test.js              # CLI layer tests (scope, parseOnly, dispatch)
├── .github/workflows/ci.yml    # CI: npm test on 3 OS × 3 Node versions
├── install.sh / install.bat     # quick install wrappers
├── reinstall.sh / reinstall.bat # uninstall + install
├── uninstall.sh / uninstall.bat # quick uninstall wrappers
├── LICENSE-MIT                  # MIT license
├── LICENSE-APACHE               # Apache 2.0 license
└── package.json
```

The 35 per-model command/agent bodies are **rendered parametrically** at
install time from `AllModelCommands`, not stored as 70 nearly-identical
files. Adding a new `{model, effort}` pair = one object in `lib/manifest.js`.

Skills are static directory trees, mirrored verbatim, so authoring a
new skill = drop a directory under `templates/skills/` and append its
name to `AllSkills`.

## Development

```bash
# Edit a template without rebuilding:
node bin/cah.js install --templates ./templates --only skills --cwd /tmp/sandbox

# Run the test suite:
npm test
```

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
