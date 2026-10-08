import { AllSkills, AllCodexSkills } from './manifest.js';
import { OmpCommands } from './omp-commands.js';
import { OpencodeCommands } from './opencode-commands.js';
import { OpencodeSkills } from './opencode-skills.js';
import { OpencodeAgents } from './opencode-agents.js';

export const USAGE = `cc-arch-hands - install Claude Code commands, agents and skills, plus optional Codex, OMP and OpenCode artifacts.

Installed skills: ${AllSkills.join(', ')}.
Optional Codex skills: ${AllCodexSkills.join(', ')}.
Optional OMP commands: ${OmpCommands.join(', ')}.
Optional OpenCode skills/commands: ${OpencodeSkills.join(', ')} (skills and commands share names; the slash command wins for slash UX, the skill stays available via the skill tool).

Usage:
  cah install   [--global|--local] [--cwd PATH] [--templates DIR] [--only SELECTOR] [--commands] [--codex-agents] [--codex-skills] [--omp] [--omp-agents] [--omp-commands] [--opencode] [--opencode-agents] [--opencode-skills] [--opencode-commands] [--omp-profile NAME]
  cah reinstall [--global|--local] [--cwd PATH] [--templates DIR] [--only SELECTOR] [--commands] [--codex-agents] [--codex-skills] [--omp] [--omp-agents] [--omp-commands] [--opencode] [--opencode-agents] [--opencode-skills] [--opencode-commands] [--omp-profile NAME]
  cah uninstall [--global|--local] [--cwd PATH] [--only SELECTOR] [--commands] [--codex-agents] [--codex-skills] [--omp] [--omp-agents] [--omp-commands] [--opencode] [--opencode-agents] [--opencode-skills] [--opencode-commands] [--omp-profile NAME]
  cah list      [--global|--local] [--cwd PATH] [--json] [--opencode] [--opencode-agents] [--opencode-commands] [--opencode-skills] [--omp-profile NAME]
  cah doctor    [--global|--local] [--cwd PATH] [--opencode] [--opencode-agents] [--opencode-commands] [--opencode-skills] [--omp-profile NAME]
  cah probe statusline start|stop|status
  cah models --json    print the model manifest as one JSON line: Claude and Codex aliases, context windows, accepted Codex efforts
  cah version

Scope flags:
  (default)  write to ~/.claude/ (applies everywhere) — same as --global.
  --global   explicit: write to ~/.claude/.
  --local    operate ONLY when <cwd>/.claude/ already exists — refuse to
             create a new .claude/ in an unrelated directory. Combines
             with --cwd to point the guard at a different path.
  --cwd PATH use PATH/.claude/ instead of the process working directory
             (implies local scope).

--global and --local are mutually exclusive.

SELECTOR for --only is a comma-separated list of:
  - install classes: commands, agents, skills, bins, plus the opt-in
    codex-agents, codex-skills, omp-agents, omp-commands, opencode-agents,
    opencode-skills and opencode-commands
  - OR individual skill names: ${AllSkills.join(', ')}
Examples:
  --only skills                 install every skill
  --only clock                  install just the /clock skill (auto-pulls bins)
  --only clock,checkpoint-watch two skills, auto-pulls bins for both
  --only commands,bins          per-model commands + companion bins
  --only clock,agents           skill + class — mix freely

--commands                 install/remove only the per-model slash-commands
                           (/oh, /fh, ...) when used without --only; when
                           combined with --only, also include them. Part of
                           the default install set.
--codex-agents             install/remove only Codex custom agents when used without --only;
                           when combined with --only, also include Codex agents.
--codex-skills             install/remove only Codex skills when used without --only;
                           when combined with --only, also include Codex skills.
                           Also manages global AGENTS.md, including with --local,
                           and the cli-run MCP entry in the scope's Codex config.toml.
--only codex-agents        alternative: select Codex agents as a class (opt-in,
                           not part of the default install set).
--only codex-skills        alternative: select Codex skills as a class (opt-in).
--omp                      install/remove all OMP artifacts: agents, tag rule,
                           workflow commands and runtime helpers. Alone selects
                           only OMP; with --only adds both OMP classes.
--omp-agents               install/remove only OMP agents and the managed APPEND_SYSTEM.md
                           rule when used alone; with --only, also include this class.
--only omp-agents          alternative: select the OMP class (opt-in).
--omp-commands             install/remove OMP workflow commands and their runtime helpers.
                           Alone selects only this class; with --only adds it.
--only omp-commands        alternative: select the OMP workflow class (opt-in).
                           /checkpoint-resume avoids OMP's built-in /resume.
                           /babysit uses a session-only OMP extension, not Claude cron.
--opencode                 install/remove all OpenCode artifacts: 40 subagents,
                           the AGENTS.md agent-tag rule, nine workflow skills,
                           nine commands and the babysit plugin runtime. Alone
                           selects only OpenCode; with --only adds all three
                           OpenCode classes.
--opencode-agents          install/remove only OpenCode subagents (mode: subagent,
                           model openai/<model>, literal reasoningEffort) plus the
                           managed agent-tag rule; with --only adds the class.
--opencode-skills          install/remove the nine OpenCode skills under
                           <root>/skills/<name>/SKILL.md; auto-adds
                           opencode-commands (babysit plugin runtime).
--opencode-commands        install/remove the nine OpenCode commands under
                           <root>/commands/<name>.md plus the runtime leaves
                           (babysit scheduler + checkpoint commit helper in
                           <root>/cah-opencode/, babysit plugin in
                           <root>/plugins/). Owned files from the old singular
                           <root>/plugin/ placement are pruned as migration
                           orphans; foreign files are never touched.
--only opencode-*          alternative selectors for the three OpenCode classes.

OpenCode scope: the global root is $OPENCODE_CONFIG_DIR, else
$XDG_CONFIG_HOME/opencode, else ~/.config/opencode; --local/--cwd target
<path>/.opencode instead (--local requires it to exist). The resolved root is
reported on install. Restart OpenCode after installation; agent and plugin
changes are not hot-reloaded. reasoningEffort (including max and ultra) is
written literally: unsupported values fail upstream and are never remapped.
--omp-profile NAME         target ~/.omp/profiles/NAME/agent instead of ~/.omp/agent;
                           applies to OMP install/reinstall/uninstall/list/doctor.
                           OMP targets are always global, regardless of Claude scope.
                           All Ultra agents are installed literally; unsupported
                           use may fail and must not be silently remapped.
                           Restart OMP after changes.
--opencode (list/doctor)   report/check only OpenCode artifacts, so an
                           OpenCode-only install can be healthy. Per-class
                           flags (--opencode-agents/--opencode-commands/
                           --opencode-skills) narrow the report to that group;
                           an explicit selection counts missing files even when
                           nothing is installed (fresh machine is not healthy).

On install, dependencies are added automatically with a notice. Uninstall is
explicit-only — it removes exactly what you named, never more. A bare
uninstall keeps the shared global companion bins; use \`--only bins\` to remove
those explicitly (a warning is shown because every scope may reference them).

Note: the 'bins' class (companion bins for /clock and /checkpoint-watch) is
always written to the global ~/.claude/cah-bin/, regardless of scope flags.
`;
