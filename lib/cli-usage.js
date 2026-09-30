import { AllSkills, AllCodexSkills } from './manifest.js';
import { OmpCommands } from './omp-commands.js';

export const USAGE = `cc-arch-hands - install Claude Code commands, agents and skills, plus optional Codex and OMP artifacts.

Installed skills: ${AllSkills.join(', ')}.
Optional Codex skills: ${AllCodexSkills.join(', ')}.
Optional OMP commands: ${OmpCommands.join(', ')}.

Usage:
  cah install   [--global|--local] [--cwd PATH] [--templates DIR] [--only SELECTOR] [--commands] [--codex-agents] [--codex-skills] [--omp] [--omp-agents] [--omp-commands] [--omp-profile NAME]
  cah reinstall [--global|--local] [--cwd PATH] [--templates DIR] [--only SELECTOR] [--commands] [--codex-agents] [--codex-skills] [--omp] [--omp-agents] [--omp-commands] [--omp-profile NAME]
  cah uninstall [--global|--local] [--cwd PATH] [--only SELECTOR] [--commands] [--codex-agents] [--codex-skills] [--omp] [--omp-agents] [--omp-commands] [--omp-profile NAME]
  cah list      [--global|--local] [--cwd PATH] [--json] [--omp-profile NAME]
  cah doctor    [--global|--local] [--cwd PATH] [--omp-profile NAME]
  cah probe statusline start|stop|status
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
    codex-agents, codex-skills, omp-agents and omp-commands
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
--omp-profile NAME         target ~/.omp/profiles/NAME/agent instead of ~/.omp/agent;
                           applies to OMP install/reinstall/uninstall/list/doctor.
                           OMP targets are always global, regardless of Claude scope.
                           All Ultra agents are installed literally; unsupported
                           use may fail and must not be silently remapped.
                           Restart OMP after changes.

On install, dependencies are added automatically with a notice. Uninstall is
explicit-only — it removes exactly what you named, never more. A bare
uninstall keeps the shared global companion bins; use \`--only bins\` to remove
those explicitly (a warning is shown because every scope may reference them).

Note: the 'bins' class (companion bins for /clock and /checkpoint-watch) is
always written to the global ~/.claude/cah-bin/, regardless of scope flags.
`;
