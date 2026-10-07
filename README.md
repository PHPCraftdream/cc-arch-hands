# cc-arch-hands (`cah`)

Installer for the artifacts that turn Claude Code into an architect's
workshop: per-model slash-commands, per-model delegated sub-agents, and
skills. Requires Node.js >=18.19.0 and has zero runtime dependencies — only
Node.js built-ins.

```bash
npx cc-arch-hands install        # that's it — installs commands, agents & skills into ~/.claude/
```

> Other ways to run: [npm global install](#quick-start), [from source](#from-source). Full command reference in [Use](#use).

## What it installs

Three kinds of Claude Code artifacts under `~/.claude/` (commands, agents,
skills), all generated from a single model registry so they stay in
lockstep — plus the four companion runtime bins that skills use as hooks,
statusLine commands, or diagnostics, copied into `~/.claude/cah-bin/` at
install time.

The artifacts:
- **per-model slash-commands** (<!--gen:count:model-commands-->54<!--/gen-->) under `~/.claude/commands/`,
- **per-model sub-agents** (<!--gen:count:model-commands-->54<!--/gen-->) under `~/.claude/agents/`,
- **skills** (11) under `~/.claude/skills/`,
- **companion bins** under `~/.claude/cah-bin/` (since 0.4.0).

Optional artifacts are installed only when requested:
- **Codex custom agents** (<!--gen:count:codex-agents-->39<!--/gen-->) under `~/.codex/agents/`, via `--codex-agents`.
- **Codex skills** (<!--gen:count:codex-skills-->4<!--/gen-->) under `~/.codex/skills/`, via `--codex-skills`.
- **OMP agents** and the agent-tag rule in global `APPEND_SYSTEM.md`, via `--omp-agents`. OMP uses Markdown definitions, not Codex TOML.

> **Since 0.4.0:** `cah install` copies the companion bins into
> `~/.claude/cah-bin/` and `settings.json` references them by absolute path
> (`node "<HOME>/.claude/cah-bin/bin/cah-status.js"`) rather than a bare PATH
> name. This means `/clock` and `/checkpoint-watch` keep working even if the
> `cc-arch-hands` npm package is moved, relinked, or uninstalled. Re-running
> `/clock` (or `/checkpoint-watch`) migrates a pre-0.4.0 bare-name command to
> the new absolute path automatically.

The installed companion tree also contains a managed `package.json` with
`"type": "module"`. This explicit ESM boundary keeps the copied `.js` files
working on the package's supported Node >=18.19.0 runtime. A pre-existing foreign
`~/.claude/cah-bin/package.json` is preserved and reported as foreign.
Updates publish that package boundary first, then `sentinel.js`,
`fs-atomic-identity.js`, `lease-clock.js`, `fs-atomic-publication.js`,
`fs-atomic.js`, `fsutil.js`, `lease-lock.js`, `marker-capacity-ops.js`,
`marker-capacity-stage.js`, `marker-capacity-recovery.js`, `marker-state.js`,
`transcript-stats.js` and `update-check.js`, and
only then replace executable leaves. This dependency-first closure keeps a new
executable from becoming visible before its complete sibling dependency chain.

The companion runtime bins:
- **`cah-checkpoint-hint`** — Stop hook bin invoked by `/checkpoint-watch`. Emits one `[hint] Context at 90%…` per session when context fills past 90%.
- **`cah-status`** — statusLine command invoked by `/clock`. Renders `<model> [effort] · X.XX% (Nk/Mk)` with a usage bar and, for Pro/Max accounts, the 5-hour and weekly quota use with reset info (`5h N% →48м · wk N% →сб 27.06 16:19`). The bracketed effort code matches the slash-command suffix convention — `[l]/[m]/[h]/[x]/[xx]` for low/medium/high/xhigh/max; omitted for models without effort support (Haiku). Refreshes every 60 s (`refreshInterval` on the entry) and on every turn boundary.
- **`cah-stamp`** — Stop hook bin invoked by `/clock` on both `Stop` AND `PostToolUse`. Emits an `HH:MM:SS · model · X.XX% · 5h N% · wk N%` line as a `systemMessage` (no effort suffix or bars; compact text). Two safeguards prevent scrollback spam: **per-message dedup** (every assistant entry of the same turn shares an API `requestId` — if we already stamped this turn, the next hook of the same turn is suppressed) and a **session-scoped time-throttle safety net** (default 10 s, configurable via `CAH_STAMP_MIN_INTERVAL_MS`). A newer-version notice is Stop-only, even when PostToolUse already deduped the turn.
- **`cah-status-probe`** — diagnostic statusLine bin armed by `cah probe statusline start`. Captures the raw stdin envelope to a JSONL log so you can inspect exactly which fields Claude Code delivers on your account (added in 0.4.1).

The checkpoint, status, and stamp bins share `lib/transcript-stats.js` for transcript
parsing — including the **cache-aware** token sum (`input_tokens +
cache_creation_input_tokens + cache_read_input_tokens`) that matches
Claude Code's own `used_percentage` formula. Without this, raw
`input_tokens` after the first turn is ~1 token (everything else is
served from the prompt cache) and a naive percentage would always read 0%.

### 1. Per-model slash-commands (<!--gen:count:model-commands-->54<!--/gen-->)

Part of the default install. To manage only the commands, use `--commands`,
or select them as a class via `--only commands` (also combinable, e.g.
`--only skills,commands`):

```bash
npx cc-arch-hands install --commands
npx cc-arch-hands reinstall --commands
npx cc-arch-hands uninstall --commands
```

A short slash-command for every supported `{model, effort}` pair, plus
no-effort aliases for Haiku. The command name normally encodes model letter +
version + effort suffix:

```
/oh   run this turn on Opus (top) at high effort
/o2x  run this turn on Opus 4.7 (2 releases behind top) at xhigh effort
/sm   Sonnet (top), medium effort
/fxx  Fable 5.1, max effort
/h    Haiku (top), no effort control
```

Haiku also has `/h45` as the literal-version alias. Both Haiku aliases have
no effort suffix because Claude Code does not expose effort control for Haiku.

Suffixes: `l` low · `m` medium · `h` high · `x` xhigh · `xx` max.
Whatever you type after the command becomes the prompt for that turn.

> **Note.** Claude Code v2.1.220–v2.1.27x silently ignored these commands'
> `model:`/`effort:` frontmatter on the interactive path
> ([anthropics/claude-code#81318](https://github.com/anthropics/claude-code/issues/81318)).
> Fixed in v2.1.280 — update Claude Code if a command runs on the session's
> model instead of the requested one. The `cah-stamp` line `/clock` installs
> shows the model that actually served each turn.

### 2. Per-model sub-agents (<!--gen:count:model-commands-->54<!--/gen-->)

The same supported effort matrix as the commands, plus Haiku's no-effort
aliases — but as **delegated sub-agents** instead of inline commands. Use them to hand a self-contained task to a fresh
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

**Opus, Fable, and Sonnet use "releases behind top" numbering, not a
version number.** `o1*` is whichever Opus was top before the current one,
`o2*` the one before that, and so on — so `o1x` today means Opus 5, but
after the next Opus release `o1x` will mean today's `ox` (the model, not
the number, shifts). Fable and Sonnet follow the same convention: `f1*`
is whichever Fable was top before the current one, `s1*` whichever Sonnet
was. Haiku still encodes the actual version number where the alias has
one (`h45`) — it has no N-back tiers.

**Slash-commands**

<!--gen:table:model-commands (run `npm run gen:docs` after editing lib/manifest.js) -->
| Model | model id | no effort | low | medium | high | xhigh | max |
|---|---|---|---|---|---|---|---|
| **Fable** (top, 1M) | `claude-fable-5-1` | — | `/fl` | `/fm` | `/fh` | `/fx` | `/fxx` |
| Fable 5 (1M) | `claude-fable-5` | — | `/f1l` | `/f1m` | `/f1h` | `/f1x` | `/f1xx` |
| **Opus** (top, 1M) | `claude-opus-5-5` | — | `/ol` | `/om` | `/oh` | `/ox` | `/oxx` |
| Opus 5 (1M) | `claude-opus-5` | — | `/o1l` | `/o1m` | `/o1h` | `/o1x` | `/o1xx` |
| Opus 4.8 (1M) | `claude-opus-4-8` | — | `/o2l` | `/o2m` | `/o2h` | `/o2x` | `/o2xx` |
| Opus 4.7 (1M) | `claude-opus-4-7` | — | `/o3l` | `/o3m` | `/o3h` | `/o3x` | `/o3xx` |
| Opus 4.6 (1M) | `claude-opus-4-6` | — | `/o4l` | `/o4m` | `/o4h` | `/o4x` | `/o4xx` |
| **Sonnet** (top, 1M) | `claude-sonnet-5-5` | — | `/sl` | `/sm` | `/sh` | `/sx` | `/sxx` |
| Sonnet 5 (1M) | `claude-sonnet-5` | — | `/s1l` | `/s1m` | `/s1h` | `/s1x` | `/s1xx` |
| Sonnet 4.6 (200k) | `claude-sonnet-4-6` | — | `/s2l` | `/s2m` | `/s2h` | — | `/s2xx` |
| Sonnet 4.5 (200k) | `claude-sonnet-4-5` | — | `/s3l` | `/s3m` | `/s3h` | — | — |
| **Haiku** (top, 200k) | `claude-haiku-4-5` | `/h` | — | — | — | — | — |
| Haiku 4.5 (200k) | `claude-haiku-4-5` | `/h45` | — | — | — | — | — |
<!--/gen:table:model-commands-->

**Sub-agents** share the same names as the commands above. `/oh` is the
slash-command body; `oh` (no prefix) is the agent invoked by the `Agent`
tool with `subagent_type: "oh"`. The two live in separate lookup tables
inside Claude Code, so identical names do not collide.

<!--gen:count:model-commands-->54<!--/gen--> commands, <!--gen:count:model-commands-->54<!--/gen--> agents — one line per row-cell in
[`lib/manifest.js`](lib/manifest.js).

### 3. Optional Codex custom agents (<!--gen:count:codex-agents-->39<!--/gen-->)

Codex agents are not part of the default install. Install them explicitly with `--codex-agents`, or select them as a class via `--only codex-agents` (also combinable, e.g. `--only skills,codex-agents`):

```bash
npx cc-arch-hands install --codex-agents
npx cc-arch-hands reinstall --codex-agents
npx cc-arch-hands uninstall --codex-agents
```

Generated agent names use an effort prefix plus a model suffix. Current Sol 6.1 (`s`, model ID `gpt-6.1-sol`) uses `l/m/h/x/xx/u` for `low/medium/high/xhigh/max/ultra`. Older Sol releases shift back one slot: Sol 6 uses suffix `1` (`ls1`, etc.) with its existing five levels, and Sol 5.6 uses suffix `2` (`ls2`, etc.) with six levels. Luna (`l`, model ID `gpt-6-luna`) keeps five levels and its 5.6 predecessor keeps suffix `1` with six levels. Terra (`t`) uses all six levels; Astra (`a`) uses five (`l/m/h/x/xx`). Their model IDs are `gpt-5.6-terra` and `gpt-6-astra`. These aliases write TOML custom-agent files for Codex under `~/.codex/agents/`.

<!--gen:table:codex-agents (run `npm run gen:docs` after editing lib/manifest.js) -->
| Model | Agents by effort |
|---|---|
| Sol 6.1 | `ls` low · `ms` medium · `hs` high · `xs` xhigh · `xxs` max · `us` ultra |
| Sol 6 | `ls1` low · `ms1` medium · `hs1` high · `xs1` xhigh · `xxs1` max |
| Sol 5.6 | `ls2` low · `ms2` medium · `hs2` high · `xs2` xhigh · `xxs2` max · `us2` ultra |
| Luna | `ll` low · `ml` medium · `hl` high · `xl` xhigh · `xxl` max |
| Terra | `lt` low · `mt` medium · `ht` high · `xt` xhigh · `xxt` max · `ut` ultra |
| Luna 5.6 | `ll1` low · `ml1` medium · `hl1` high · `xl1` xhigh · `xxl1` max · `ul1` ultra |
| Astra | `la` low · `ma` medium · `ha` high · `xa` xhigh · `xxa` max |
<!--/gen:table:codex-agents-->

Install the optional Codex skills with `--codex-skills`. They are Codex-only
and are never installed for Claude Code.

- `cli-run` is a stdio MCP server with three tools. `run` requires a task name
  and starts an array of CLI commands in a detached Node.js worker. It returns
  the task name and generated UID immediately. When all jobs finish, one brief
  `codex queue` message reports the task name, UID, and success/failure count
  without command output. `status` and `logs` accept the UID or exact task name;
  repeated names select the most recent run. Native spawned agents can use
  inline delivery to receive results without `codex queue`.
- `checkpoint` saves project-scoped session state under `docs/checkpoints/`,
  `resume` restores it, and `ccheckpoint` additionally commits only that file
  locally. Invoke them in Codex as `$checkpoint`, `$ccheckpoint`, and
  `$resume`.

Existing foreign skills at the destination are preserved. The same flag
manages two marked blocks outside the skill directory:

- **`config.toml`** of the selected Codex scope (`~/.codex/config.toml`, or
  `<cwd>/.codex/config.toml` with `--local`/`--cwd`) gets a block that
  registers the MCP server as `[mcp_servers.cli-run]`. Installation refuses
  if an unmanaged `cli-run` server is already defined there. Restart Codex
  after installing so it loads the server.
- **The global `~/.codex/AGENTS.md`** gets a section routing potentially
  long-running CLI commands through `cli-run`; quick Git, search, and file
  reads run directly. This global change also applies with
  `--local`/`--cwd`. An active global `AGENTS.override.md` masks the main
  file, so installation refuses until the override is resolved.

Reinstall refreshes only these blocks, and uninstall removes only them. Other
text in both files is preserved.

#### cli-run: temporary completion workaround

`cli-run` is a **temporary workaround for Codex's background-command completion
and wakeup gaps**, not an upstream Codex fix. It applies only to commands
submitted through its MCP `run` tool; it does not patch native `exec_command`,
`write_stdin`, subagent delivery, or terminal UI state.

With `delivery: "queue"`, the detached worker waits without model-driven polling,
persists results, and sends one brief `codex queue` completion message to the
calling thread after all jobs finish. Successful delivery can wake an idle
parent so it can inspect the result and continue. With `delivery: "inline"`,
results return in the still-open MCP call instead; this is not an asynchronous
wakeup.

The following upstream reports describe the gaps and related symptoms.
“Workaround” means coverage for jobs launched through `cli-run`, not that the
upstream issue is fixed or should be closed.

| Codex issue | Reported problem | cli-run coverage |
|---|---|---|
| [#42908](https://github.com/openai/codex/issues/42908) | Desktop parent does not resume after a background exec session completes. | Queue-delivery workaround for our jobs. [Our Windows reproduction and workaround](https://github.com/openai/codex/issues/42908#issuecomment-5808801833). |
| [#32188](https://github.com/openai/codex/issues/32188) | Missing event-driven wakeup when a background exec session completes. | Queue-delivery workaround; no native `ExecCommandEnd` / `on_exit` integration. |
| [#33542](https://github.com/openai/codex/issues/33542) | Background task callbacks should resume the original thread without polling. | Queue-delivery workaround for task completion. |
| [#33712](https://github.com/openai/codex/issues/33712) | Background terminal exit while idle never starts a follow-up turn. | Same completion workaround; [consolidated into #32188](https://github.com/openai/codex/issues/33712#issuecomment-4998088037), not closed because a native fix landed. |
| [#22003](https://github.com/openai/codex/issues/22003) | Inject background-command output into an active session without polling. | Partial: completion message and persisted logs, not automatic stdout/stderr streaming into the conversation. |
| [#29865](https://github.com/openai/codex/issues/29865) | Wake Codex when a background command emits new output. | Partial: wakes on task completion, not each output update; [closed as a duplicate of #22003](https://github.com/openai/codex/issues/29865#issuecomment-4791371300). |
| [#15723](https://github.com/openai/codex/issues/15723) | Background subprocesses and subagents do not wake the calling agent. | CLI-process workaround only; native subagent completion delivery is unchanged. |
| [#13733](https://github.com/openai/codex/issues/13733) | Empty `write_stdin` polls trigger full model turns and waste tokens. | Avoids polling our jobs; does not change polling of other processes. |
| [#45974](https://github.com/openai/codex/issues/45974) | Repeated high-effort polling of long jobs exhausts usage limits. | Avoids polling our jobs; does not suppress unrelated goal/subagent continuation loops. |
| [#14314](https://github.com/openai/codex/issues/14314) | Agent keeps waiting for a background terminal after its command finishes. | Uses a separate worker/result path; does not fix native terminal waiting. |
| [#22957](https://github.com/openai/codex/issues/22957) | Codex hangs on “Waited for background terminal”. | Uses a separate worker/result path; does not fix native terminal waiting. |
| [#12033](https://github.com/openai/codex/issues/12033) | Waiting indicator remains after background terminals terminate. | Not covered: native terminal UI state is unchanged. |
| [#23603](https://github.com/openai/codex/issues/23603) | Requests command-completion feedback instead of continuous polling. | Provides external task-completion feedback, not a native Codex hook or timeout/self-check mechanism. |
| [#45081](https://github.com/openai/codex/issues/45081) | Requests user-facing terminal completion notifications and active-terminal indicators across chats. | Not covered: our agent-thread message is not a desktop notification or UI indicator. |

Limits: queue delivery depends on `codex queue` reaching the target thread;
unloaded threads, access restrictions, or delivery errors can prevent wakeup.
The notification is a queued message, not a typed terminal/tool completion
event. `status` and `logs` expose saved results when delivery fails; they are
not a reason to poll running jobs. Output remains in logs unless requested.

`run` still needs Codex approval or explicit user trust. MCP jobs do not inherit
Codex's per-turn filesystem sandbox; granting trust does not repair
`apply_patch` or native Git permissions. See the installed `$cli-run` skill's
Permissions section before enabling `tools.run.approval_mode = "approve"`.


### Install everything for OMP

`--omp` selects both optional OMP classes: model agents and their global tag
rule, plus every supported workflow command and its runtime helpers. Used
alone it installs only OMP artifacts, not the default Claude set. Combined
with `--only`, it adds the OMP classes to that selection.

```bash
npx cc-arch-hands install --omp
npx cc-arch-hands reinstall --omp
npx cc-arch-hands uninstall --omp
npx cc-arch-hands install --omp --omp-profile work
```

After updating the package, repeat `install --omp` to refresh all owned OMP
artifacts. Restart OMP after changes. The ordinary profile is the default;
named profiles must be selected explicitly. Every registered agent is installed,
including all four Ultra aliases, without querying OMP capabilities.

### Optional OMP agents

OMP agents are opt-in and reuse the complete Codex model/alias registry.
`us`, `us2`, `ut` and `ul1` all carry the literal `thinking-level: ultra`,
even when the installed OMP or the provider does not advertise support.
Install/reinstall/list/doctor do not invoke OMP to filter those definitions.

The local OMP build forwards explicit Ultra as `reasoning.effort: "ultra"`.
It does not map it to `max`, `xhigh`, a model-native delegation preset or another
model. This intentionally differs from current native Codex orchestration
semantics. Unsupported use may fail; those failures remain visible rather than
being hidden behind a compatible effort. Automatic/coarse hints do not choose
Ultra, and explicit lower resource ceilings reject it instead of downgrading it.

The local implementation is based on v18.4.4 and is installed from regular
package tarballs, not a source-directory link. Upstream feedback is tracked in
[OMP #13809](https://github.com/can1357/oh-my-pi/issues/13809). Registration of
an Ultra alias is not a claim that the provider implements that literal tier.

```bash
npx cc-arch-hands install --omp-agents
npx cc-arch-hands reinstall --omp-agents
npx cc-arch-hands uninstall --omp-agents
```

The ordinary profile uses `~/.omp/agent/agents/<name>.md` and
`~/.omp/agent/APPEND_SYSTEM.md`. OMP destinations are always global, even with
`--local` or `--cwd`; those flags still select the Claude/Codex destinations
when classes are combined. Named profiles are separate; select each explicitly:

```bash
npx cc-arch-hands install --omp-agents --omp-profile work
npx cc-arch-hands reinstall --omp-agents --omp-profile work
npx cc-arch-hands uninstall --omp-agents --omp-profile work
npx cc-arch-hands list --json --omp-profile work
npx cc-arch-hands doctor --omp-profile work
```

`--omp-profile default` selects the ordinary profile. The installer does not
implicitly follow `OMP_PROFILE` or install into every profile.

Repeated `install` updates owned definitions and prunes obsolete owned files;
after updating the npm package, run `cah install --omp-agents` again (with the
same `--omp-profile` if applicable). `reinstall` performs uninstall then install.
Foreign definitions are preserved and reported, including unmarked definitions
installed manually. The agent-tag rule is maintained inside
`<!-- cah-omp-agent-tags:start -->` / `<!-- cah-omp-agent-tags:end -->`; bytes
outside that block are preserved. Broken or duplicate markers abort before
reinstall removes definitions. `uninstall` removes only owned definitions and
that block, not personal instructions. `SYSTEM.md` is never written.

Restart OMP after changes. The rule interprets agent names in ordinary chat
only as delegation requests when the user explicitly asks to launch them; it
does not switch the main model. Project agents with matching names take
precedence. Highlighting and autocomplete are separate OMP UI features.
`list` reports OMP files; `doctor` includes the optional class once an agent
or the managed rule is present, with its existing missing/foreign exit codes.

### Optional OMP workflow commands

Install all nine OMP-native workflow commands with `--omp-commands` (or
`--only omp-commands`). They are separate from Claude skills and model-switch
commands and are not included in the default install:

| Command | Behavior |
|---|---|
| `/checkpoint [name]` | Save session context and the actual OMP `todo` plan under the caller repository's `docs/checkpoints/` |
| `/ccheckpoint [name]` | Save a checkpoint and commit only that file through the shared Node helper, preserving unrelated staged changes |
| `/checkpoint-resume [name\|--list]` | Restore/list saved checkpoint context; does not replace OMP's built-in `/resume` session switcher |
| `/checkpoint-prune [--dry] [selection]` | Preview or delete selected project checkpoints; batch deletion requires confirmation |
| `/task <request>` | Register an ordered leaf-level todo plan without executing the work |
| `/triage [--dry]` | Inspect the live todo plan and propose cleanup, with consent before mutations |
| `/repo-sight [target]` | Evidence-based repository map and prioritized reading list |
| `/babysit [interval\|--status\|--off]` | Arm, inspect or stop the session-only todo heartbeat |
| `/babygoal [interval] <request>` | Investigate, register leaf tasks, confirm the heartbeat and begin the first ready task |

```bash
npx cc-arch-hands install --omp-commands
npx cc-arch-hands reinstall --omp-commands
npx cc-arch-hands uninstall --omp-commands

# Agents and workflow commands together:
npx cc-arch-hands install --only omp-agents,omp-commands

# Named profiles must be selected explicitly:
npx cc-arch-hands install --omp-commands --omp-profile work
```

Commands live in `~/.omp/agent/commands/<name>.md`, the heartbeat extension in
`~/.omp/agent/extensions/cah-babysit.js`, and the checkpoint commit helper in
`~/.omp/agent/cah/commit-checkpoint.mjs`. `--omp-profile NAME` changes the root
to `~/.omp/profiles/NAME/agent/`; Claude scope flags do not change OMP targets.
Restart OMP after installation or updating. Re-run `install` after updating the
package to refresh owned commands/runtime; `reinstall` is uninstall then install.
Runtime dependencies are published before commands. Foreign commands are
preserved and reported; a foreign runtime at either managed helper path blocks
install/reinstall rather than exposing commands with an unknown runtime.
Missing custom templates are also rejected before reinstall removes anything.
`--templates DIR` requires `omp-commands/<name>/command.md`,
`omp-commands/runtime/babysit.js` and the existing
`codex-skills/ccheckpoint/scripts/commit-checkpoint.mjs` under that directory.
`list` and `doctor` track commands and runtime dependencies independently of
the optional OMP agent class. Uninstall preserves personal files and agents.

OMP has `todo`, not Claude `TaskCreate`/`TaskList` or `CronCreate`. These command
bodies use OMP's verbatim task contents, phase order, blockers and single-active
task semantics. They do not automatically launch agents or change the main model.
`babysit` uses the installed `cah_babysit` extension tool and a real managed timer:
default `15m`, positive integer `s`/`m`/`h` intervals from one second to seven days.
Repeated arming does not create duplicates; use `--off` before changing intervals.
Ticks wake only idle sessions with actionable todo work, skip active turns and
queued messages, and do not unblock external waits. Completion stops the timer;
an all-blocked plan remains waiting without model calls.

The heartbeat is session-only, expires after seven days, and stops on session
switching, branch navigation or shutdown. It cannot revive a closed OMP process
or promise recovery from provider connectivity failures. Checkpoint restoration
does not automatically re-arm it. `/clock` and `/checkpoint-watch` are not
installed for OMP: their current statusLine/hook implementations are Claude-only.


### Optional OpenCode artifacts

`--opencode` groups three opt-in classes for OpenCode v1.18.34. Used alone it
installs only OpenCode artifacts; combined with `--only` it adds all three
classes. Nothing is queried at install time: OpenCode, the provider connection
and model availability are never checked.

- **`--opencode-agents`** — all 39 subagents from the Codex model/alias
  registry (see the Codex-agents table above). Each `<name>.md` lands in
  `<root>/agents/` with `mode: subagent`, `model: openai/<manifest model>`
  and a literal `options.reasoningEffort` (including `max` and `ultra`; no
  `variant` is written, nothing is remapped). A managed delegation rule lives
  in a `<!-- cah-opencode-agent-tags:start -->`/`:end -->` section of
  `<root>/AGENTS.md` — for `--local`/`--cwd` the **project-root**
  `AGENTS.md`, because `.opencode/AGENTS.md` is not loaded globally. The rule
  says: an agent name in a request means "delegate to that subagent", a mere
  mention is not a launch, the parent model is never switched, `ultra` stays
  literal. Foreign bytes around the section are preserved; uninstall removes
  an `AGENTS.md` that held only our section.
- **`--opencode-commands`** — nine workflow slash commands (checkpoint,
  ccheckpoint, checkpoint-resume, checkpoint-prune, babysit, babygoal, task,
  triage, repo-sight) under `<root>/commands/<name>.md`, plus runtime files:
  the babysit scheduler and the isolated-index checkpoint commit helper in
  `<root>/cah-opencode/`, and the plugin `<root>/plugins/cah-babysit.js`.
- **`--opencode-skills`** — the same nine workflows as skills under
  `<root>/skills/<name>/SKILL.md`. The slash command wins slash UX; the skill
  stays reachable through the `skill` tool. Installing this class auto-adds
  `opencode-commands`, because babysit and babygoal need the plugin.

The plugin registers two tools. OpenCode has no `todoread`, so the workflows
read the plan with **`cah_todos`** (a read-only view of `session.todo`) and
write it with the native `todowrite`. **`cah_babysit`** (`arm`/`status`/`off`)
is a session-only heartbeat: one timer per session, 1 s–7 d intervals, 7-day
expiry, armed only with unfinished todos in a main (not child) session. It
wakes only an idle session, never queues a second wake while one is unresolved
and reuses the last user message's agent and model (it stops visibly if they
are missing). It stops on completion, session deletion, an assistant error or
abort (including Esc), and after 30 minutes without a resolved wake. A stop
raises a TUI toast and is reported by `status` as `stopped`. It cannot revive
a closed OpenCode process or retract a prompt OpenCode already accepted.

Scope: the global root is `$OPENCODE_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`; `--local`/`--cwd`
target `<path>/.opencode` instead (`--local` requires it to exist; there is no
`.claude` guard for OpenCode-only selections). Restart OpenCode after
installation: agents and plugins are not hot-reloaded. Unsupported model or
effort values may fail upstream. `list --json --opencode` and
`doctor --opencode` check only OpenCode files, so an OpenCode-only install can
be healthy; this is file health, not provider availability.

```bash
npx cc-arch-hands install --opencode            # all OpenCode artifacts
npx cc-arch-hands install --opencode-agents     # 39 subagents + AGENTS.md tag rule
npx cc-arch-hands install --opencode-skills     # nine skills (auto-adds opencode-commands)
npx cc-arch-hands install --opencode-commands   # nine commands + plugin runtime
npx cc-arch-hands list --json --opencode        # or per-class: --opencode-agents / -commands / -skills
npx cc-arch-hands doctor --opencode
```

Checked against a real OpenCode 1.18.34 (`debug agent`, `debug skill`,
`debug config` and direct `cah_todos`/`cah_babysit` calls): agent
registration with model and effort, discovery of all skills and commands, and
plugin loading. No inference ran, so provider support for a given effort and a
model-driven babysit wake are untested.


### 4. Skills (11)

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
| `/ccheckpoint` | Same as `/checkpoint`, plus a local `git commit` of the checkpoint file it writes (skipped, not erred, when the target isn't inside a git repo). Usage: same as `/checkpoint`. |
| `/resume` | Reload a checkpoint, rebuild the TaskList via TaskCreate, restate the goal as a copy-paste line, surface open questions. Usage: `/resume` (most recent), `/resume <name>` (exact or prefix), `/resume --list` (browse without restoring). |
| `/checkpoint-prune` | Delete checkpoints. Arg auto-detected: `<name>` (one file), `14d`/`48h` (older than), bare number (keep last N), no arg (all). Confirms before batch deletes; `--dry` reports only. Usage: `/checkpoint-prune`, `/checkpoint-prune 14d`, `/checkpoint-prune 10`, `/checkpoint-prune <name>`. |
| `/triage` | TaskList hygiene — flag stale `in_progress`, orphan blockers, dead-end chains, trivial sibling clusters, completed clutter, duplicate subjects. Advisory by default; asks before mutating. Usage: `/triage` or `/triage --dry`. |
| `/checkpoint-watch` | Per-project Stop hook that shows a one-time `[hint]` when context hits 90%, suggesting `/checkpoint`. `/checkpoint-watch --off` to remove, `--status` to inspect. |

**Workspace HUD**

| Skill | Purpose |
|---|---|
| `/clock` | Per-scope Claude Code statusLine showing `<model> [effort] · X% (Nk/Mk)` at the bottom of the terminal, plus a Stop+PostToolUse hook that emits an `HH:MM:SS · <model> · X%` line as a `systemMessage` once per assistant turn (per-message dedup) for a timestamped chat audit trail. statusLine refreshes every 60 s and on every turn boundary. Does not consume LLM context. Usage: `/clock` (global), `/clock --here` (project-local), `/clock --off`, `/clock --status`. |

#### Workspace HUD in detail

`/clock` installs two complementary signals into the same `settings.json`:

- **statusLine** (`cah-status` process): a persistent one-line bar at the bottom
  of the terminal that refreshes every 60 s (and on every turn boundary) and shows
  `<model> [effort] · X% (Nk/Mk)` plus, for Pro/Max accounts, the 5-hour and weekly
  quota use. It runs as a separate process and never enters LLM context.
- **chat turn-stamp** (`cah-stamp` on Stop AND PostToolUse): once per assistant turn,
  the hook reads the session transcript JSONL to find the latest `usage.input_tokens`,
  `model`, and per-turn API `requestId`, then emits an `HH:MM:SS · model · X%`
  line as a `systemMessage` that lands in the chat scrollback. Per-message dedup
  (via `requestId`) guarantees one stamp per assistant message — even a long turn with
  many tool calls produces exactly one stamp. The `systemMessage` is user-facing only
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
                               # (refuses outside a git repo — never a shared global path)

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
automatically; that decision stays with you — unless you use
`/ccheckpoint` instead of `/checkpoint`, which commits only that checkpoint
through an isolated temporary index (never the real index and never a push).

`cah` also installs `/checkpoint-watch` globally, but invoking it in a project
writes a Stop hook into *that project's* `.claude/settings.json` (never the
global one). On each turn the hook reads the session transcript, takes the
latest assistant message's `usage.input_tokens`, and compares it to the actual
valid `context_window.context_window_size` from the hook envelope or matching
status cache when available. If neither is available, it falls back to the
model limit (1M for Opus/Fable/Sonnet 5 and 5.5, 200K for older Sonnet/Haiku), honoring
`CLAUDE_CODE_DISABLE_1M_CONTEXT`. When usage first
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
| Slash-commands | <!--gen:count:model-commands-->54<!--/gen--> | `<scope>/.claude/commands/<name>.md` (only with `--commands`) |
| Sub-agents | <!--gen:count:model-commands-->54<!--/gen--> | `<scope>/.claude/agents/<name>.md` |
| Skills | 11 | `<scope>/.claude/skills/<name>/` |
| Codex custom agents | <!--gen:count:codex-agents-->39<!--/gen--> | `<scope>/.codex/agents/<name>.toml` (only with `--codex-agents`) |
| Codex skills | <!--gen:count:codex-skills-->4<!--/gen--> | `<scope>/.codex/skills/<name>/` (only with `--codex-skills`) |
| OMP agents and tag rule | Full registry + rule | `~/.omp/agent/agents/<name>.md` and `~/.omp/agent/APPEND_SYSTEM.md` (only with `--omp-agents`; `--omp-profile NAME` selects `~/.omp/profiles/NAME/agent/`) |
| OMP workflow commands | 9 commands + 2 runtime files | `~/.omp/agent/commands/`, `extensions/cah-babysit.js` and `cah/commit-checkpoint.mjs` (only with `--omp-commands`; supports `--omp-profile NAME`) |
| OpenCode subagents + tag rule | 39 | `<cfg>/agents/<name>.md` and a marked section in `<cfg>/AGENTS.md` (only with `--opencode-agents`; `<cfg>` = `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`) |
| OpenCode skills | 9 | `<cfg>/skills/<name>/SKILL.md` (only with `--opencode-skills`) |
| OpenCode commands + runtime | 9 commands + 3 runtime files | `<cfg>/commands/<name>.md`, `<cfg>/cah-opencode/` (scheduler + helper) and `<cfg>/plugins/cah-babysit.js` (only with `--opencode-commands`) |

`<scope>` is `~/` by default (global install). Use `--local` or `--cwd`
to target a specific project directory instead.

The `/crush` slash-command is **intentionally NOT installed by `cah`** —
it belongs to the [crush](https://github.com/PHPCraftdream/crush) fork
and is owned by its own `claude-init` command.

## Quick start

No install needed — run directly with `npx`:

Use the package name `cc-arch-hands` with `npx`. The shorter `cah` name is an
executable alias available after an npm installation, not the package name.

```bash
npx cc-arch-hands install                # install globally into ~/.claude/
npx cc-arch-hands uninstall              # remove our Claude files; keep shared bins
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
npx cc-arch-hands install                          # global (default): ~/.claude/{commands,agents,skills,cah-bin}
npx cc-arch-hands install --local                  # local: <cwd>/.claude/... (must already exist); bins still go global
npx cc-arch-hands install --cwd /path/to/project   # local at a specific path; bins still go global
npx cc-arch-hands install --commands               # install only the per-model slash-commands
npx cc-arch-hands install --codex-agents           # optional: install only Codex agents into ~/.codex/agents
npx cc-arch-hands install --codex-skills           # optional: install Codex skills into ~/.codex/skills
npx cc-arch-hands install --omp-agents             # optional: global OMP agents + agent-tag rule
npx cc-arch-hands install --omp-commands           # optional: all OMP workflow commands + runtime
npx cc-arch-hands install --omp                    # optional: all supported OMP agents, rule, commands and runtime
npx cc-arch-hands install --opencode-agents        # optional: 39 OpenCode subagents + AGENTS.md tag rule
npx cc-arch-hands install --opencode-skills        # optional: nine OpenCode skills (auto-adds the plugin runtime class)
npx cc-arch-hands install --opencode-commands      # optional: nine OpenCode commands + babysit plugin runtime
npx cc-arch-hands install --opencode               # optional: all OpenCode artifacts

# --only takes install classes, individual skill names, or any mix.
npx cc-arch-hands install --only skills                       # all 11 skills
npx cc-arch-hands install --only commands                     # all per-model slash-commands
npx cc-arch-hands install --only codex-agents                 # all Codex agents into ~/.codex/agents (opt-in)
npx cc-arch-hands install --only codex-skills                 # Codex skills into ~/.codex/skills (opt-in)
npx cc-arch-hands install --only omp-agents                   # OMP agents + APPEND_SYSTEM.md rule (opt-in)
npx cc-arch-hands install --only omp-commands                 # nine OMP workflow commands + runtime (opt-in)
npx cc-arch-hands install --only bins                         # companion bins (cah-status, cah-stamp,
                                                    #   cah-checkpoint-hint, cah-status-probe,
                                                    #   + shared lib leaves: transcript-stats.js,
                                                    #     update-check.js, lease-lock.js, marker-capacity-ops.js,
                                                    #     fs-atomic-publication.js, marker-capacity-stage.js,
                                                    #     marker-capacity-recovery.js,
                                                    #     marker-state.js, fsutil.js,
                                                    #     fs-atomic-identity.js, lease-clock.js, fs-atomic.js,
                                                    #     sentinel.js)

# One example per skill (every installable artefact has its own line).
# clock and checkpoint-watch auto-pull `bins` with a notice.
npx cc-arch-hands install --only repo-sight
npx cc-arch-hands install --only babysit
npx cc-arch-hands install --only babygoal
npx cc-arch-hands install --only task
npx cc-arch-hands install --only checkpoint
npx cc-arch-hands install --only ccheckpoint
npx cc-arch-hands install --only checkpoint-prune
npx cc-arch-hands install --only resume
npx cc-arch-hands install --only triage
npx cc-arch-hands install --only checkpoint-watch             # auto-pulls bins
npx cc-arch-hands install --only clock                        # auto-pulls bins

# Comma-separated combos work as expected.
npx cc-arch-hands install --only clock,checkpoint-watch       # two skills (auto-pulls bins once)
npx cc-arch-hands install --only babysit,babygoal,task        # task-list trio
npx cc-arch-hands install --only commands,clock               # mix class + skill name

# reinstall and uninstall accept the same --only selector.
# reinstall does uninstall + install with the same args, so subset is honoured.
# uninstall is explicit-only — it never auto-pulls deps (so you can drop
# clock without losing the bins that checkpoint-watch needs).
npx cc-arch-hands reinstall --only clock                      # uninstall + install of just the clock skill
npx cc-arch-hands reinstall --commands                        # reinstall only the per-model slash-commands
npx cc-arch-hands reinstall --codex-agents                    # reinstall only Codex agents
npx cc-arch-hands reinstall --codex-skills                    # reinstall only Codex skills
npx cc-arch-hands uninstall                                   # remove Claude files; keeps shared bins
npx cc-arch-hands uninstall --only bins                       # remove shared bins globally (warning shown)
npx cc-arch-hands uninstall --only agents                     # remove only Claude agents
npx cc-arch-hands uninstall --commands                        # remove only the per-model slash-commands
npx cc-arch-hands uninstall --codex-agents                    # remove only Codex agents
npx cc-arch-hands uninstall --codex-skills                    # remove only Codex skills
npx cc-arch-hands uninstall --only clock                      # remove only the clock skill, keep bins
npx cc-arch-hands uninstall --opencode                        # remove all OpenCode artifacts
npx cc-arch-hands list --json --opencode                      # only OpenCode kinds (agents, rule, commands, skills, runtime)
npx cc-arch-hands doctor --opencode                           # health gate over OpenCode artifacts only

npx cc-arch-hands list                             # tabular: NAME | KIND | STATE
npx cc-arch-hands list --json                      # NDJSON for scripting
npx cc-arch-hands doctor                           # condensed health verdict
npx cc-arch-hands version                          # version + counts

npx cc-arch-hands probe statusline start           # diagnostic: capture raw statusLine envelope
npx cc-arch-hands probe statusline stop            # restore + print captured envelope
npx cc-arch-hands probe statusline status          # is the probe armed?
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

Managed skill writes and removals also reject malformed paths, links, and
changed parent-directory identities. This is a portable same-user concurrency
check, not a security boundary against another same-UID process: because Node
core has no portable `openat`-style anchored operation, callers must not
replace managed ancestors while an install or uninstall is running.

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
│   ├── manifest.js              # AllModelCommands (54 definitions), AllCodexAgents (39), AllSkills (11), SkillDeps
│   ├── sentinel.js              # new + legacy markers, ownership classifier
│   ├── scope.js                 # global vs local target dir resolution
│   ├── templates.js             # bundled / disk template abstraction
│   ├── fsutil.js                # readFileMaybe + orphan-prune helpers
│   ├── fs-atomic-identity.js    # exact filesystem identity and snapshot helpers
│   ├── fs-atomic-publication.js # generation-fenced no-overwrite publication
│   ├── marker-capacity-ops.js    # durable capacity transitions and victim CAS
│   ├── marker-capacity-stage.js  # bounded marker transaction staging/recovery
│   ├── marker-capacity-recovery.js # generation-aware transaction retirement/recovery
│   ├── fs-atomic.js             # atomic publication, identity, quarantine helpers
│   ├── transcript-stats.js      # shared: stats, formatStatusLine, makeBar, reset formatters
│   ├── commands.js              # render + install + remove (54 .md bodies)
│   ├── agents.js                # render + install + remove (54 .md bodies)
│   ├── skills.js                # mirror templates/skills/<n>/ tree, optional subset
│   ├── codex-skills.js          # optional Codex skill installation
│   ├── codex-mcp-config.js      # marked [mcp_servers.cli-run] block in Codex config.toml
│   ├── binstall.js              # copy companion bins into ~/.claude/cah-bin/ (// cah-bin:v1)
│   └── probe.js                 # enable/disable cah-status-probe via settings.json edits
├── templates/
│   ├── skills/                  # Claude Code skill templates
│   │   └── <name>/SKILL.md
│   └── codex-skills/            # cli-run, checkpoint, ccheckpoint, resume
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

The <!--gen:count:model-commands-->54<!--/gen--> model definitions render
<!--gen:count:model-bodies-->108<!--/gen--> command+agent bodies, which are
**rendered parametrically** at install time from `AllModelCommands`, not stored
as nearly-identical files. Adding a new `{model, effort}` pair = one object in
`lib/manifest.js`.

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
