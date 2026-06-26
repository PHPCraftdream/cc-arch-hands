# cc-arch-hands (`cah`)

Installer for the artifacts that turn Claude Code into an architect's
workshop: per-model slash-commands, per-model delegated sub-agents, and
skills. Zero runtime dependencies — only Node.js built-ins.

```bash
npx cc-arch-hands install        # that's it — installs commands, agents & skills into ~/.claude/
```

> Other ways to run: [npm global install](#quick-start), [from source](#from-source). Full command reference in [Use](#use).

## What it installs

Three kinds of Claude Code artifacts under `~/.claude/` (commands, agents,
skills), all generated from a single model registry so they stay in
lockstep — plus the three companion bins that some skills use as hooks or
statusLine commands, copied into `~/.claude/cah-bin/` at install time.

The artifacts:
- **per-model slash-commands** (35) under `~/.claude/commands/`,
- **per-model sub-agents** (35) under `~/.claude/agents/`,
- **skills** (10) under `~/.claude/skills/`,
- **companion bins** under `~/.claude/cah-bin/` (since 0.4.0).

> **Since 0.4.0:** `cah install` copies the companion bins into
> `~/.claude/cah-bin/` and `settings.json` references them by absolute path
> (`node "<HOME>/.claude/cah-bin/bin/cah-status.js"`) rather than a bare PATH
> name. This means `/clock` and `/checkpoint-watch` keep working even if the
> `cc-arch-hands` npm package is moved, relinked, or uninstalled. Re-running
> `/clock` (or `/checkpoint-watch`) migrates a pre-0.4.0 bare-name command to
> the new absolute path automatically.

The companion bins:
- **`cah`** (and its alias `cc-arch-hands`) — the installer CLI itself.
- **`cah-checkpoint-hint`** — Stop hook bin invoked by `/checkpoint-watch`. Emits one `[hint] Context at 90%…` per session when context fills past 90%.
- **`cah-status`** — statusLine command invoked by `/clock`. Renders `<model> · X.XX% (Nk/Mk)` with a usage bar and, for Pro/Max accounts, the 5-hour and weekly quota use with reset info (`5h N% →48м · wk N% →сб 27.06 16:19`). Refreshes on each turn boundary.
- **`cah-stamp`** — Stop hook bin invoked by `/clock` on both `Stop` AND `PostToolUse`. Emits an `HH:MM · model · X.XX% · 5h N% · wk N%` line as a `systemMessage` (no bars, compact text). Throttled to one emission per 10s so the dual-hook install does not spam the scrollback.
- **`cah-status-probe`** — diagnostic statusLine bin armed by `cah probe statusline start`. Captures the raw stdin envelope to a JSONL log so you can inspect exactly which fields Claude Code delivers on your account (added in 0.4.1).

All three hook bins share `lib/transcript-stats.js` for transcript
parsing — including the **cache-aware** token sum (`input_tokens +
cache_creation_input_tokens + cache_read_input_tokens`) that matches
Claude Code's own `used_percentage` formula. Without this, raw
`input_tokens` after the first turn is ~1 token (everything else is
served from the prompt cache) and a naive percentage would always read 0%.

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

The same matrix as the commands — but as **delegated sub-agents** instead
of inline commands. Use them to hand a self-contained task to a fresh
context window on a chosen model/effort; the agent runs autonomously and
returns only the result. Each agent body carries two hardcoded safety
clauses: a **git-safety** rule (no mutating git commands in a shared
worktree) and a **test-scope** rule (run only scoped tests, not the whole
suite).

**v0.2.0 dropped the `a` prefix on agent names.** Old `aoh`, `ao47x`,
`afxx` are now plain `oh`, `o47x`, `fxx` — the same string as the command
and the model selector. Slash commands and the `Agent` tool use separate
lookup tables, so there is no namespace collision. Upgrade is automatic:
`cah install` 0.2.0 deletes the old `a*.md` files (sentinel-gated) and
writes the new ones; `cah uninstall` cleans both layouts.

### Naming matrix

Command name = **model letter** (+ version) + **effort suffix**. The
agent name is the same string (no prefix). Effort suffixes:
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

**Sub-agents** share the same names as the commands above. `/oh` is the
slash-command body; `oh` (no prefix) is the agent invoked by the `Agent`
tool with `subagent_type: "oh"`. The two live in separate lookup tables
inside Claude Code, so identical names do not collide.

35 commands, 35 agents — one line per row-cell in
[`lib/manifest.js`](lib/manifest.js).

### 3. Skills (10)

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
| `/babygoal` | Investigate the problem domain first (skipped if already covered by the session — uses `/repo-sight` or focused reads when needed), choose an execution strategy, decompose the work into tasks via TaskCreate with the strategy and key findings recorded in each `description`, mark the first ready task `in_progress`, and hand off to `/babysit`. TaskList-driven — does NOT use `/goal`. Usage: `/babygoal [interval] <description>`. |
| `/babysit` | Start a `/loop` (default `15m`) that monitors the TaskList: resumes stalled `in_progress` tasks, picks the next ready `pending` when nothing is in flight, and stops itself when the list has no open tasks. Usage: `/babysit [interval]`. |

**Session memory**

| Skill | Purpose |
|---|---|
| `/checkpoint` | Persist current session state (active `/goal`, TaskList with `blockedBy`, recent decisions, open questions, repo state) to a markdown file under `docs/checkpoints/`. Usage: `/checkpoint` (auto-timestamped) or `/checkpoint <name>` (named, re-runs overwrite). |
| `/resume` | Reload a checkpoint, rebuild the TaskList via TaskCreate, restate the goal as a copy-paste line, surface open questions. Usage: `/resume` (most recent), `/resume <name>` (exact or prefix), `/resume --list` (browse without restoring). |
| `/checkpoint-prune` | Delete checkpoints. Arg auto-detected: `<name>` (one file), `14d`/`48h` (older than), bare number (keep last N), no arg (all). Confirms before batch deletes; `--dry` reports only. Usage: `/checkpoint-prune`, `/checkpoint-prune 14d`, `/checkpoint-prune 10`, `/checkpoint-prune <name>`. |
| `/triage` | TaskList hygiene — flag stale `in_progress`, orphan blockers, dead-end chains, trivial sibling clusters, completed clutter, duplicate subjects. Advisory by default; asks before mutating. Usage: `/triage` or `/triage --dry`. |
| `/checkpoint-watch` | Per-project Stop hook that shows a one-time `[hint]` when context hits 90%, suggesting `/checkpoint`. `/checkpoint-watch --off` to remove, `--status` to inspect. |

**Workspace HUD**

| Skill | Purpose |
|---|---|
| `/clock` | Per-scope Claude Code statusLine showing `HH:MM · model · X% (Nk/Mk)` at the bottom of the terminal, plus a Stop hook that emits the same line as a `systemMessage` after each assistant turn for a timestamped chat audit trail. Refreshes every second. Does not consume LLM context. Usage: `/clock` (global), `/clock --here` (project-local), `/clock --off`, `/clock --status`. |

#### Workspace HUD in detail

`/clock` installs two complementary signals into the same `settings.json`:

- **statusLine** (`cah-status` process): a persistent one-line bar at the bottom
  of the terminal that refreshes every second and shows `HH:MM · model · X% (Nk/Mk)`.
  It runs as a separate process and never enters LLM context.
- **chat turn-stamp** (`cah-stamp` Stop hook): after every assistant turn, the hook
  reads the session transcript JSONL to find the latest `usage.input_tokens` and
  `model`, then emits the same `HH:MM · model · X%` line as a `systemMessage` that
  lands in the chat scrollback. This gives you a permanent audit trail — scrolling
  back through a long session you can see exactly when each exchange happened and
  what the context state was at that moment. The `systemMessage` is user-facing only
  and does not add any tokens to the LLM context.

Both pieces are installed together by `/clock`, removed together by `/clock --off`,
and reported together by `/clock --status`. Foreign entries in either surface are
never touched.

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

- **Session summary** — a 5–15 sentence narrative recap in the agent's
  own words: what's being worked on, what's done, what's in flight,
  what hypotheses are alive, what files/URLs were inspected, what
  timers are running. **This is the part that survives auto-compact** —
  the structured fields below stay accurate by themselves, but
  qualitative context only survives if it's written down here.
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

`cah` also installs `/checkpoint-watch` globally, but invoking it in a project
writes a Stop hook into *that project's* `.claude/settings.json` (never the
global one). On each turn the hook reads the session transcript, takes the
latest assistant message's `usage.input_tokens`, and compares it to the model's
context limit (1M for Opus/Fable, 200K for Sonnet/Haiku). When usage first
crosses 90% it emits a single `systemMessage` — a plain-ASCII `[hint]` line
suggesting `/checkpoint` — and records a per-session marker so it never fires
twice. The 90% threshold is a soft suggestion, not a forced action: the agent
keeps working and you decide when to actually checkpoint. Foreign hooks in
`settings.json` are never touched; `/checkpoint-watch --off` removes only our
sentinel-tagged entry.

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
| Sub-agents | 35 | `<scope>/.claude/agents/<name>.md` |
| Skills | 10 | `<scope>/.claude/skills/<name>/` |

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
npx cah install                          # global (default): ~/.claude/{commands,agents,skills,cah-bin}
npx cah install --local                  # local: <cwd>/.claude/... (must already exist); bins still go global
npx cah install --cwd /path/to/project   # local at a specific path; bins still go global

# --only takes install classes, individual skill names, or any mix.
npx cah install --only skills                       # all 10 skills
npx cah install --only bins                         # companion bins (cah-status, cah-stamp,
                                                    #   cah-checkpoint-hint, cah-status-probe,
                                                    #   + their shared lib/transcript-stats.js)

# One example per skill (every installable artefact has its own line).
# clock and checkpoint-watch auto-pull `bins` with a notice.
npx cah install --only repo-sight
npx cah install --only babysit
npx cah install --only babygoal
npx cah install --only task
npx cah install --only checkpoint
npx cah install --only checkpoint-prune
npx cah install --only resume
npx cah install --only triage
npx cah install --only checkpoint-watch             # auto-pulls bins
npx cah install --only clock                        # auto-pulls bins

# Comma-separated combos work as expected.
npx cah install --only clock,checkpoint-watch       # two skills (auto-pulls bins once)
npx cah install --only babysit,babygoal,task        # task-list trio
npx cah install --only commands,clock               # mix class + skill name

# reinstall and uninstall accept the same --only selector.
# reinstall does uninstall + install with the same args, so subset is honoured.
# uninstall is explicit-only — it never auto-pulls deps (so you can drop
# clock without losing the bins that checkpoint-watch needs).
npx cah reinstall --only clock                      # uninstall + install of just the clock skill
npx cah uninstall                                   # symmetric remove (sentinel-gated)
npx cah uninstall --only agents                     # remove only agents
npx cah uninstall --only clock                      # remove only the clock skill, keep bins

npx cah list                             # tabular: NAME | KIND | STATE
npx cah list --json                      # NDJSON for scripting
npx cah doctor                           # condensed health verdict
npx cah version                          # version + counts

npx cah probe statusline start           # diagnostic: capture raw statusLine envelope
npx cah probe statusline stop            # restore + print captured envelope
npx cah probe statusline status          # is the probe armed?
```

`cah probe statusline` atomically rewires `settings.statusLine` to a
capturing bin and backs up the original. `stop` restores the original and
prints the parsed envelope so you can see exactly which fields Claude Code
delivers on your account (e.g. whether `rate_limits.five_hour.resets_at` is
populated). No manual `settings.json` edits.

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
├── bin/cah-checkpoint-hint.js   # Stop-hook bin: emits the 90% [hint] (#!/usr/bin/env node)
├── bin/cah-status.js            # statusLine bin: model · ctx% + 5h/wk on Pro/Max (#!/usr/bin/env node)
├── bin/cah-stamp.js             # Stop+PostToolUse bin: chat audit-trail line (#!/usr/bin/env node)
├── bin/cah-status-probe.js      # diagnostic statusLine bin used by `cah probe statusline`
├── lib/
│   ├── cli.js                   # dispatch, arg parsing (node:util parseArgs), --only resolver
│   ├── manifest.js              # AllModelCommands (35 entries), AllSkills (10), SkillDeps
│   ├── sentinel.js              # new + legacy markers, ownership classifier
│   ├── scope.js                 # global vs local target dir resolution
│   ├── templates.js             # bundled / disk template abstraction
│   ├── fsutil.js                # readFileMaybe + orphan-prune helpers
│   ├── transcript-stats.js      # shared: stats, formatStatusLine, makeBar, reset formatters
│   ├── commands.js              # render + install + remove (35 .md files)
│   ├── agents.js                # render + install + remove (35 .md files)
│   ├── skills.js                # mirror templates/skills/<n>/ tree, optional subset
│   ├── binstall.js              # copy companion bins into ~/.claude/cah-bin/ (// cah-bin:v1)
│   └── probe.js                 # enable/disable cah-status-probe via settings.json edits
├── templates/
│   └── skills/                  # repo-sight, task, babygoal, babysit,
│       └── <name>/SKILL.md      # checkpoint, resume, checkpoint-prune, triage,
│                                # checkpoint-watch, clock
├── test/
│   ├── installer.test.js        # installer tests (node:test + node:assert)
│   ├── cli.test.js              # CLI layer tests (scope, parseOnly, resolveDeps, --only subset)
│   ├── binstall.test.js         # bin-copy / prune / sentinel / resolveBinDir tests
│   ├── clock.test.js            # cah-status bin tests
│   ├── stamp.test.js            # cah-stamp bin tests (incl. throttle, rate_limits cache)
│   ├── transcript-stats.test.js # transcript-stats helper unit tests (incl. makeBar)
│   ├── checkpoint-hint.test.js  # cah-checkpoint-hint bin tests
│   └── probe.test.js            # lib/probe.js enable/disable/readLog tests
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
