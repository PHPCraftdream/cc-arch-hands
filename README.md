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

### 1. Per-model slash-commands (37)

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

### 2. Per-model sub-agents (37)

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

| Model | model id | low | medium | high | xhigh | max |
|---|---|---|---|---|---|---|
| Opus 4.7 | `claude-opus-4-7` | `o47l` | `o47m` | `o47h` | `o47x` | `o47xx` |
| Opus 4.6 | `claude-opus-4-6` | `o46l` | `o46m` | `o46h` | `o46x` | `o46xx` |
| Sonnet 4.6 | `claude-sonnet-4-6` | `s46l` | `s46m` | `s46h` | — | `s46xx` |
| Sonnet 4.5 | `claude-sonnet-4-5` | `s45l` | `s45m` | `s45h` | — | — |
| Haiku 4.5 | `claude-haiku-4-5` | `h45l` | `h45m` | `h45h` | — | — |
| **Opus** (top) | `claude-opus-4-8` | `ol` | `om` | `oh` | `ox` | `oxx` |
| **Sonnet** (top) | `claude-sonnet-4-6` | `sl` | `sm` | `sh` | — | `sx` |
| **Haiku** (top) | `claude-haiku-4-5` | `hl` | `hm` | `hh` | — | — |
| **Fable** (top) | `claude-fable-5` | `fl` | `fm` | `fh` | `fx` | `fxx` |

The **top** rows are moving shortcuts that always point at the freshest
version of each family — use them when you don't care about pinning an
exact version. (Note: Sonnet-top's max tier is `sx`, since that family
exposes no separate xhigh tier.) Agents: `o47l` → `ao47l`, `oh` → `aoh`,
`fxx` → `afxx`, and so on. 37 commands, 37 agents — one line per row-cell
in [`lib/manifest.js`](lib/manifest.js).

### 3. Skills

Reusable capability packs Claude Code loads on demand. Bundled so far:

- **`repo-sight`** — diagnose an unfamiliar repository from its git
  history, structure and behavior *before* reading code, and return a
  ranked reading list with explicit caveats.

### Where it goes

| Artifact | Count | Destination |
|---|---|---|
| Slash-commands | 37 | `<scope>/.claude/commands/<name>.md` |
| Sub-agents | 37 | `<scope>/.claude/agents/a<name>.md` |
| Skills | 1 | `<scope>/.claude/skills/<name>/` |

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
│   ├── manifest.js              # AllModelCommands (37 entries) + AllSkills
│   ├── sentinel.js              # new + legacy markers, ownership classifier
│   ├── scope.js                 # global vs local target dir resolution
│   ├── templates.js             # bundled / disk template abstraction
│   ├── commands.js              # render + install + remove (37 .md files)
│   ├── agents.js                # render + install + remove (37 a*.md files)
│   └── skills.js                # mirror templates/skills/<n>/ tree
├── templates/
│   └── skills/repo-sight/
│       └── SKILL.md             # bundled skill assets
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

The 37 per-model command/agent bodies are **rendered parametrically** at
install time from `AllModelCommands`, not stored as 74 nearly-identical
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
