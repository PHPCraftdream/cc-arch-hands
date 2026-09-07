import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from './scope.js';
import { AllModelCommands, AllCodexAgents, AllSkills, SkillDeps } from './manifest.js';
import { SetForModelCommand, SetForModelAgent, SetForCodexAgent, SetForSkill, SetForBin, Ownership, classifyContent } from './sentinel.js';
import { SKILL_MANIFEST_LEAF } from './scope.js';
import { embeddedTemplates, diskTemplates } from './templates.js';
import { writeModelCommands, removeModelCommands } from './commands.js';
import { writeModelAgents, removeModelAgents } from './agents.js';
import { writeCodexAgents, removeCodexAgents } from './codex-agents.js';
import { validateSkillTree, writeSkills, removeSkills } from './skills.js';
import { writeBins, removeBins, BinFiles } from './binstall.js';
import {
  enableProbe,
  disableProbe,
  readProbeLog,
  probeStatus,
  ProbeAlreadyActiveError,
  ProbeNotActiveError,
  MissingBackupError,
  MalformedSettingsError,
  MalformedBackupError,
  PROBE_NAME,
} from './probe.js';

const PACKAGE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const USAGE = `cc-arch-hands - install Claude Code per-model commands, agents and skills, plus optional Codex agents.

Installed skills: ${AllSkills.join(', ')}.

Usage:
  cah install   [--global|--local] [--cwd PATH] [--templates DIR] [--only SELECTOR] [--commands] [--codex-agents]
  cah reinstall [--global|--local] [--cwd PATH] [--templates DIR] [--only SELECTOR] [--commands] [--codex-agents]
  cah uninstall [--global|--local] [--cwd PATH] [--only SELECTOR] [--commands] [--codex-agents]
  cah list      [--global|--local] [--cwd PATH] [--json]
  cah doctor    [--global|--local] [--cwd PATH]
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
  - install classes: agents, skills, bins, plus the opt-in commands,
    codex-agents
  - OR individual skill names: ${AllSkills.join(', ')}
Examples:
  --only skills                 install every skill
  --only clock                  install just the /clock skill (auto-pulls bins)
  --only clock,checkpoint-watch two skills, auto-pulls bins for both
  --only commands,bins          per-model commands + companion bins
  --only clock,agents           skill + class — mix freely

--commands                 install/remove only the per-model slash-commands
                           (/oh, /fh, ...) when used without --only; when
                           combined with --only, also include them. Opt-in:
                           Claude Code's interactive path currently ignores
                           these commands' model:/effort: frontmatter
                           (anthropics/claude-code#81318) — the per-model
                           sub-agents (@oh, @fh, ...) are unaffected and stay
                           in the default install.
--only commands            alternative: select the per-model commands as a
                           class (opt-in, not part of the default install set).
--codex-agents             install/remove only Codex custom agents when used without --only;
                           when combined with --only, also include Codex agents.
--only codex-agents        alternative: select Codex agents as a class (opt-in,
                           not part of the default install set).

On install, dependencies are added automatically with a notice. Uninstall is
explicit-only — it removes exactly what you named, never more. A bare
uninstall keeps the shared global companion bins; use \`--only bins\` to remove
those explicitly (a warning is shown because every scope may reference them).

Note: the 'bins' class (companion bins for /clock and /checkpoint-watch) is
always written to the global ~/.claude/cah-bin/, regardless of scope flags.
`;

const SELECTOR_CLASSES = ['agents', 'skills', 'bins'];
const VALID_CLASSES = ['commands', 'agents', 'codex-agents', 'skills', 'bins'];
// Classes that are never part of the default install set — selectable only
// via their own --<flag> or explicit --only <class>. `commands` joined this
// list because Claude Code's interactive TUI path silently ignores the
// per-command model:/effort: frontmatter override these files rely on
// (anthropics/claude-code#81318) — the `agents` half of the same registry is
// unaffected (the Agent-tool dispatch path honors the override), so it stays
// in the default set.
const OPT_IN_FLAG_CLASSES = ['codex-agents', 'commands'];

export function run(argv) {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case 'install':
      return cmdInstall(rest);
    case 'reinstall':
      return cmdReinstall(rest);
    case 'uninstall':
      return cmdUninstall(rest);
    case 'list':
      return cmdList(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'probe':
      return cmdProbe(rest);
    case 'version':
      return cmdVersion();
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`cah: unknown subcommand "${sub}"\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

function parseScopeFlags(rest, extra = {}) {
  const options = {
    global: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    cwd: { type: 'string', default: '' },
    ...extra,
  };
  return parseArgs({ args: rest, options, strict: true });
}

function isParseArgsError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
}

export function resolveScope(values) {
  if (values.global && values.local) {
    throw new Error('--global and --local are mutually exclusive');
  }
  if (values.global && values.cwd) {
    throw new Error('--global and --cwd are mutually exclusive');
  }
  if (values.local || values.cwd) {
    return new Scope({ global: false, strict: values.local, cwd: values.cwd });
  }
  return new Scope({ global: true });
}

/**
 * Parse a `--only foo,bar,baz` selector. Each item is either an install class
 * (commands/agents/skills/bins, plus the opt-in codex-agents) OR
 * an individual skill name from AllSkills.
 *
 * Returns { classes: string[], skills: string[] }:
 *   - classes — install classes in canonical order, deduplicated.
 *   - skills  — individual skill names (only meaningful when `classes` does
 *     not already include 'skills', which subsumes everything).
 *
 * Empty / missing selector → the default classes, no individual
 * skills. Unknown name → throw.
 */
export function parseOnly(only) {
  if (!only || only.trim() === '') {
    return { classes: [...SELECTOR_CLASSES], skills: [] };
  }
  const parts = only.split(',').map((s) => s.trim()).filter(Boolean);
  const classes = new Set();
  const skills = new Set();
  for (const p of parts) {
    if (VALID_CLASSES.includes(p)) {
      classes.add(p);
    } else if (AllSkills.includes(p)) {
      skills.add(p);
    } else {
      throw new Error(
        `unknown name "${p}" in --only `
        + `(valid classes: ${VALID_CLASSES.join(', ')}; `
        + `valid skill names: ${AllSkills.join(', ')})`,
      );
    }
  }
  if (classes.size === 0 && skills.size === 0) {
    throw new Error('--only resolved to no classes');
  }
  return {
    classes: VALID_CLASSES.filter((c) => classes.has(c)),
    skills: [...skills].sort(),
  };
}

// Applies any --<opt-in-class> boolean flags (--codex-agents, --commands).
// Used alone (no --only), a flag narrows the install to JUST that opt-in
// class, replacing the default set entirely; combined with --only, it adds
// the class to whatever was already selected. Multiple opt-in flags stack.
function applyOptInFlags(selection, flagValues, only) {
  const activeFlags = OPT_IN_FLAG_CLASSES.filter((c) => flagValues[c]);
  if (activeFlags.length === 0) return selection;
  if (!only || only.trim() === '') {
    return { classes: VALID_CLASSES.filter((c) => activeFlags.includes(c)), skills: [] };
  }
  const classes = new Set(selection.classes);
  for (const c of activeFlags) classes.add(c);
  return { classes: VALID_CLASSES.filter((c) => classes.has(c)), skills: selection.skills };
}

// Given a parseOnly selection, expand auto-dependencies (e.g. clock → bins)
// and return both the final classes list (with deps merged in) and any
// notices to surface to the user. Pure — no side effects.
export function resolveDeps(selection) {
  const classes = [...selection.classes];
  const notices = [];
  // If 'skills' (whole class) is selected, every skill is effectively included.
  const effectiveSkills = classes.includes('skills') ? AllSkills : selection.skills;
  for (const cls of new Set(['bins'])) {
    if (classes.includes(cls)) continue;
    const triggers = effectiveSkills.filter((s) => SkillDeps[s] && SkillDeps[s].includes(cls));
    if (triggers.length === 0) continue;
    classes.push(cls);
    notices.push(`auto-added '${cls}' (required by: ${triggers.join(', ')})`);
  }
  return {
    classes: VALID_CLASSES.filter((c) => classes.includes(c)),
    skills: selection.skills,
    notices,
  };
}

function reportClass(
  cls, verb, n, skipped, pruned = 0, preserved = [], recovery = [], maintenance = null,
) {
  const extras = [];
  if (pruned > 0) extras.push(`pruned ${pruned} (orphan)`);
  if (preserved && preserved.length > 0) extras.push(`preserved ${preserved.length} (user data)`);
  if (recovery && recovery.length > 0) extras.push(`recovery ${recovery.length} (quarantine)`);
  const tail = extras.length > 0 ? `, ${extras.join(', ')}` : '';
  process.stdout.write(`  ${cls}: ${verb} ${n}, skipped ${skipped.length} (foreign or canonical survivor)${tail}\n`);
  for (const p of skipped) {
    process.stdout.write(`    skipped: ${p}\n`);
  }
  for (const p of recovery || []) {
    process.stdout.write(`    recovery: ${p}\n`);
  }
  for (const p of preserved || []) {
    process.stdout.write(`    kept: ${p}\n`);
  }
  if (maintenance && (maintenance.visits > 0
      || maintenance.incomplete || maintenance.truncated
      || (maintenance.failures || []).length > 0
      || (maintenance.recovery || []).length > 0
      || (maintenance.unprovedTemps || []).length > 0)) {
    process.stdout.write(
      `    maintenance: visits ${maintenance.visits || 0}, `
      + `recovery ${maintenance.recovery?.length || 0}, `
      + `temps ${maintenance.unprovedTemps?.length || 0}\n`,
    );
  }
  if (maintenance?.incomplete || maintenance?.truncated || maintenance?.failures?.length > 0) {
    const details = [
      maintenance.incomplete ? 'incomplete' : null,
      maintenance.truncated ? 'truncated' : null,
    ].filter(Boolean).join(', ');
    process.stdout.write(`    warning: cache maintenance ${details}; recovery state was preserved and may need manual review\n`);
    for (const failure of maintenance.failures || []) {
      process.stdout.write(`    maintenance failure: ${failure.code || 'UNKNOWN'} ${failure.path || ''}\n`);
    }
  }
}

function prepareInstall(rest) {
  const parsed = parseScopeFlags(rest, {
    templates: { type: 'string', default: '' },
    only: { type: 'string', default: '' },
    'codex-agents': { type: 'boolean', default: false },
    commands: { type: 'boolean', default: false },
  });
  const vals = parsed.values;

  const scope = resolveScope(vals);
  const resolved = resolveDeps(applyOptInFlags(parseOnly(vals.only), vals, vals.only));
  const templates = vals.templates ? diskTemplates(vals.templates) : embeddedTemplates();

  // Resolve every target touched by this selection before any write or
  // uninstall. This also makes --local's strict .claude guard part of the
  // reinstall preflight, including Codex-only selections.
  if (resolved.classes.some((c) => ['commands', 'agents', 'skills'].includes(c))
      || resolved.skills.length > 0) scope.claudeRoot();
  if (resolved.classes.includes('codex-agents')) scope.resolveCodexAgentsDir();

  const skillNames = resolved.classes.includes('skills') ? AllSkills : resolved.skills;
  for (const name of skillNames) {
    validateSkillTree(templates, name);
  }
  return { vals, scope, resolved, templates };
}

function cmdInstall(rest, prepared = null) {
  let request;
  try {
    request = prepared || prepareInstall(rest);
  } catch (e) {
    process.stderr.write(`cah install: ${e.message}\n`);
    return isParseArgsError(e) ? 2 : 1;
  }
  const { vals, scope, resolved, templates: t } = request;

  process.stdout.write(`installing into ${scope.describe()} from ${t.label}\n`);
  for (const note of resolved.notices) {
    process.stdout.write(`notice: ${note}\n`);
  }
  if (!scope.global && resolved.classes.includes('bins')) {
    process.stdout.write('notice: bins always target the global ~/.claude/cah-bin/, ignoring --local/--cwd\n');
  }

  // If individual skills were named and 'skills' (whole class) is NOT also
  // selected, the skills phase runs over that subset only — leaving any
  // other installed skills untouched.
  const skillsSubset = resolved.classes.includes('skills') ? null : resolved.skills;
  const runSkills = resolved.classes.includes('skills') || (skillsSubset && skillsSubset.length > 0);

  // Build the ordered phase list so subset-only-skill installs still emit a
  // 'skills' line in the report.
  const phases = resolved.classes.includes('skills')
    ? resolved.classes
    : runSkills
      ? [...resolved.classes, 'skills']
      : resolved.classes;

  for (const cls of VALID_CLASSES.filter((c) => phases.includes(c))) {
    let result;
    try {
      switch (cls) {
        case 'commands':
          result = writeModelCommands(t, scope);
          break;
        case 'agents':
          result = writeModelAgents(t, scope);
          break;
        case 'codex-agents':
          result = writeCodexAgents(t, scope);
          break;
        case 'skills':
          result = writeSkills(t, scope, { subset: skillsSubset });
          break;
        case 'bins':
          result = writeBins(scope.resolveBinDir(), PACKAGE_ROOT);
          break;
      }
    } catch (e) {
      process.stderr.write(`cah install: ${cls}: ${e.message}\n`);
      return 1;
    }
    const label = cls === 'skills' && skillsSubset
      ? `skills (subset: ${skillsSubset.join(', ')})`
      : cls;
    reportClass(
      label, 'wrote', result.written, result.skipped, result.pruned, result.preserved, result.recovery,
      result.maintenance,
    );
  }
  return 0;
}

// Drop `--templates DIR` (and the `--templates=DIR` form) from an argv slice.
// `--templates` is install-only; reinstall forwards the same argv to both
// phases, so we strip it before the uninstall phase to keep cmdUninstall strict
// about unknown flags rather than teaching it to swallow one it never uses.
function stripTemplatesFlag(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--templates') {
      i++; // also skip its value
      continue;
    }
    if (args[i].startsWith('--templates=')) continue;
    out.push(args[i]);
  }
  return out;
}

function cmdReinstall(rest) {
  let prepared;
  try {
    // Complete the install-side validation before uninstalling anything:
    // scope, selector, --templates value/path, and each selected template tree.
    prepared = prepareInstall(rest);
  } catch (e) {
    process.stderr.write(`cah reinstall: ${e.message}\n`);
    return isParseArgsError(e) ? 2 : 1;
  }
  process.stdout.write('reinstall: phase 1 — uninstall\n');
  const u = cmdUninstall(stripTemplatesFlag(rest), prepared.templates);
  if (u !== 0) {
    process.stderr.write(`cah reinstall: uninstall phase failed with exit ${u}; aborting before install.\n`);
    return u;
  }
  process.stdout.write('reinstall: phase 2 — install\n');
  return cmdInstall(rest, prepared);
}

function cmdUninstall(rest, templatesOverride = null) {
  let parsed;
  try {
    parsed = parseScopeFlags(rest, {
      only: { type: 'string', default: '' },
      'codex-agents': { type: 'boolean', default: false },
      commands: { type: 'boolean', default: false },
    });
  } catch (e) {
    process.stderr.write(`cah uninstall: ${e.message}\n`);
    return 2;
  }
  const vals = parsed.values;

  let scope;
  try {
    scope = resolveScope(vals);
  } catch (e) {
    process.stderr.write(`cah uninstall: ${e.message}\n`);
    return 1;
  }

  let selection;
  try {
    selection = applyOptInFlags(parseOnly(vals.only), vals, vals.only);
  } catch (e) {
    process.stderr.write(`cah uninstall: ${e.message}\n`);
    return 1;
  }
  // Shared companion bins are dependencies of skills and can be referenced by
  // project-local settings. A bare uninstall therefore leaves them in place;
  // removing them requires an explicit `--only bins` selection.
  if (!vals.only && !vals.commands && !vals['codex-agents']) {
    selection = { ...selection, classes: selection.classes.filter((c) => c !== 'bins') };
  }
  // Uninstall does NOT auto-pull deps — explicit-only — so you can remove
  // `clock` while keeping the bins for `checkpoint-watch`.

  const skillsSubset = selection.classes.includes('skills') ? null : selection.skills;
  const runSkills = selection.classes.includes('skills') || (skillsSubset && skillsSubset.length > 0);
  const phases = selection.classes.includes('skills')
    ? selection.classes
    : runSkills
      ? [...selection.classes, 'skills']
      : selection.classes;

  process.stdout.write(`uninstalling from ${scope.describe()}\n`);
  if (selection.classes.includes('bins')) {
    process.stdout.write('warning: removing shared companion bins from global ~/.claude/cah-bin/ affects every scope; use --only bins only when this is intentional\n');
  }
  if (!scope.global && selection.classes.includes('bins')) {
    process.stdout.write('notice: bins always target the global ~/.claude/cah-bin/, ignoring --local/--cwd\n');
  }

  for (const cls of VALID_CLASSES.filter((c) => phases.includes(c))) {
    let result;
    try {
      switch (cls) {
        case 'commands':
          result = removeModelCommands(scope);
          break;
        case 'agents':
          result = removeModelAgents(scope);
          break;
        case 'codex-agents':
          result = removeCodexAgents(scope);
          break;
        case 'skills':
          result = removeSkills(templatesOverride || embeddedTemplates(), scope, { subset: skillsSubset });
          break;
        case 'bins':
          result = removeBins(scope.resolveBinDir());
          break;
      }
    } catch (e) {
      process.stderr.write(`cah uninstall: ${cls}: ${e.message}\n`);
      return 1;
    }
    const label = cls === 'skills' && skillsSubset
      ? `skills (subset: ${skillsSubset.join(', ')})`
      : cls;
    reportClass(
      label, 'removed', result.removed, result.skipped, result.pruned || 0,
      result.preserved, result.recovery, result.maintenance,
    );
  }
  return 0;
}

export function classifyPath(path, set) {
  try {
    const data = readFileSync(path);
    return classifyContent(true, data, set).toString();
  } catch (e) {
    if (e.code === 'ENOENT') return Ownership.missing;
    // A directory at a file path, EACCES, and all other read conflicts are
    // present-but-unusable target conflicts, not missing files.
    return Ownership.foreign;
  }
}

function enumerate(scope) {
  const commandsDir = scope.resolveCommandsDir();
  const agentsDir = scope.resolveAgentsDir();
  const codexAgentsDir = scope.resolveCodexAgentsDir();
  const skillsDir = scope.resolveSkillsDir();
  const rows = [];

  for (const mc of AllModelCommands) {
    rows.push({
      name: mc.name,
      kind: 'command',
      state: classifyPath(join(commandsDir, `${mc.name}.md`), SetForModelCommand),
    });
  }
  for (const mc of AllModelCommands) {
    rows.push({
      name: mc.name,
      kind: 'agent',
      state: classifyPath(join(agentsDir, `${mc.name}.md`), SetForModelAgent),
    });
  }
  for (const agent of AllCodexAgents) {
    rows.push({
      name: agent.name,
      kind: 'codex-agent',
      state: classifyPath(join(codexAgentsDir, `${agent.name}.toml`), SetForCodexAgent),
    });
  }
  for (const name of AllSkills) {
    rows.push({
      name,
      kind: 'skill',
      state: classifyPath(join(skillsDir, name, SKILL_MANIFEST_LEAF), SetForSkill),
    });
  }
  const binDir = scope.resolveBinDir();
  for (const f of BinFiles) {
    rows.push({
      name: f.dest,
      kind: 'bin',
      state: classifyPath(join(binDir, f.dest), SetForBin),
    });
  }
  return rows;
}

function cmdList(rest) {
  let parsed;
  try {
    parsed = parseScopeFlags(rest, {
      json: { type: 'boolean', default: false },
    });
  } catch (e) {
    process.stderr.write(`cah list: ${e.message}\n`);
    return 2;
  }
  const vals = parsed.values;

  let scope;
  try {
    scope = resolveScope(vals);
  } catch (e) {
    process.stderr.write(`cah list: ${e.message}\n`);
    return 1;
  }

  let rows;
  try {
    rows = enumerate(scope);
  } catch (e) {
    process.stderr.write(`cah list: ${e.message}\n`);
    return 1;
  }

  if (vals.json) {
    for (const r of rows) {
      process.stdout.write(JSON.stringify(r) + '\n');
    }
    return 0;
  }

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const kindW = Math.max(4, ...rows.map((r) => r.kind.length));
  const header = `${'NAME'.padEnd(nameW)}  ${'KIND'.padEnd(kindW)}  STATE\n`;
  process.stdout.write(header);
  for (const r of rows) {
    process.stdout.write(`${r.name.padEnd(nameW)}  ${r.kind.padEnd(kindW)}  ${r.state}\n`);
  }
  return 0;
}

function cmdDoctor(rest) {
  let parsed;
  try {
    parsed = parseScopeFlags(rest);
  } catch (e) {
    process.stderr.write(`cah doctor: ${e.message}\n`);
    return 2;
  }
  const vals = parsed.values;

  let scope;
  try {
    scope = resolveScope(vals);
  } catch (e) {
    process.stderr.write(`cah doctor: ${e.message}\n`);
    return 1;
  }

  let rows;
  try {
    rows = enumerate(scope);
  } catch (e) {
    process.stderr.write(`cah doctor: ${e.message}\n`);
    return 1;
  }

  const hasCodexAgents = rows.some((r) => r.kind === 'codex-agent' && r.state !== 'missing');
  const hasModelCommands = rows.some((r) => r.kind === 'command' && r.state !== 'missing');
  const healthRows = rows.filter((r) =>
    (r.kind !== 'codex-agent' || hasCodexAgents)
    && (r.kind !== 'command' || hasModelCommands));

  let mine = 0, legacy = 0, foreign = 0, missing = 0;
  for (const r of healthRows) {
    switch (r.state) {
      case 'mine': mine++; break;
      case 'legacy': legacy++; break;
      case 'foreign': foreign++; break;
      case 'missing': missing++; break;
    }
  }

  process.stdout.write(`scope: ${scope.describe()}\n`);
  process.stdout.write(`mine: ${mine}, legacy: ${legacy}, foreign: ${foreign}, missing: ${missing} (out of ${healthRows.length} total)\n`);

  if (legacy > 0) {
    process.stdout.write("hint: run 'cah install' to migrate legacy files to new sentinels\n");
  }
  if (foreign > 0) {
    process.stdout.write(`warning: ${foreign} foreign files in our target paths — they will not be touched. Inspect with 'cah list'.\n`);
  }
  // Exit non-zero so `cah doctor` is usable as a health gate in CI/scripts:
  // 2 when conflicting foreign files block a clean install, 1 when expected
  // files are simply not installed yet.
  if (foreign > 0) return 2;
  if (missing > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

// Paths are derived from Scope.resolveBinDir() — bins always live in the
// global ~/.claude/cah-bin/ — so probe state lives next to the bin it controls,
// regardless of which project the user invoked `cah probe` from.
function probePaths(scope) {
  const binDir = scope.resolveBinDir();
  return {
    settingsPath: join(scope.claudeRoot(), 'settings.json'),
    probeBinAbsPath: join(binDir, 'bin', 'cah-status-probe.js'),
    backupPath: join(binDir, 'cache', 'probe-backup.json'),
    logPath: join(binDir, 'cache', 'envelope-probe.log'),
  };
}

function cmdProbe(rest) {
  if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
    process.stdout.write(
      'Usage:\n  cah probe statusline start\n  cah probe statusline stop\n  cah probe statusline status\n',
    );
    return rest.length === 0 ? 2 : 0;
  }
  const target = rest[0];
  if (target !== 'statusline') {
    process.stderr.write(`cah probe: unknown target "${target}" (only "statusline" is supported)\n`);
    return 2;
  }
  const action = rest[1];
  if (!action) {
    process.stderr.write('cah probe statusline: missing action (start|stop|status)\n');
    return 2;
  }

  // Reject any trailing flags so typos (`--globl`) fail loudly instead of
  // silently succeeding — matching the strict contract every other subcommand
  // enforces via parseScopeFlags.
  try {
    parseArgs({ args: rest.slice(2), options: {}, strict: true, allowPositionals: false });
  } catch (e) {
    process.stderr.write(`cah probe statusline: ${e.message}\n`);
    return 2;
  }

  // Probe always reaches into the global ~/.claude/ (matches resolveBinDir).
  const scope = new Scope({ global: true });
  const paths = probePaths(scope);

  switch (action) {
    case 'start':
      return probeStart(paths);
    case 'stop':
      return probeStop(paths);
    case 'status':
      return probeStatusReport(paths);
    default:
      process.stderr.write(`cah probe statusline: unknown action "${action}" (start|stop|status)\n`);
      return 2;
  }
}

function probeStart(paths) {
  if (!existsSync(paths.probeBinAbsPath)) {
    process.stderr.write(
      `probe bin missing: ${paths.probeBinAbsPath}\n  run \`cah install --only bins\` first.\n`,
    );
    return 1;
  }
  try {
    enableProbe(paths);
  } catch (e) {
    if (e instanceof ProbeAlreadyActiveError) {
      process.stderr.write(`cah probe: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`cah probe start: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(
    `probe armed. statusLine → ${paths.probeBinAbsPath}\n`
    + 'now interact with Claude Code so the statusLine fires a few times,\n'
    + 'then run `cah probe statusline stop` to restore and dump the log.\n',
  );
  return 0;
}

function probeStop(paths) {
  let result;
  try {
    result = disableProbe(paths);
  } catch (e) {
    if (e instanceof ProbeNotActiveError) {
      process.stderr.write(`cah probe: ${e.message}\n`);
      return 1;
    }
    if (e instanceof MissingBackupError) {
      process.stderr.write(`cah probe stop: ${e.message}\n  refusing to guess at the original statusLine; restore it manually.\n`);
      return 1;
    }
    if (e instanceof MalformedBackupError) {
      process.stderr.write(
        `cah probe stop: ${e.message}\n`
        + `  To recover: fix the JSON in ${paths.backupPath}, then retry stop; do not restore statusLine from this malformed backup.\n`,
      );
      return 1;
    }
    if (e instanceof MalformedSettingsError) {
      process.stderr.write(
        `cah probe stop: ${e.message}\n`
        + `  To recover: fix the JSON in ${paths.settingsPath}, remove the statusLine probe entry\n`
        + `  (the one carrying "cah-name": "${PROBE_NAME}"), then restore from ${paths.backupPath}.\n`,
      );
      return 1;
    }
    process.stderr.write(`cah probe stop: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(
    result.restored === null
      ? 'probe disarmed. (statusLine key removed — there was none before)\n'
      : 'probe disarmed. statusLine restored.\n',
  );
  const records = readProbeLog(paths.logPath);
  process.stdout.write(`captured ${records.length} envelope(s) at ${paths.logPath}\n`);
  if (records.length > 0) {
    const last = records[records.length - 1];
    process.stdout.write('\n--- latest envelope (parsed) ---\n');
    let envelope = null;
    try {
      envelope = JSON.parse(last.raw);
    } catch {
      process.stdout.write('(raw stdin was not valid JSON — printing as text)\n');
      process.stdout.write(last.raw + '\n');
    }
    if (envelope) {
      process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    }
  }
  return 0;
}

function probeStatusReport(paths) {
  let s;
  try {
    s = probeStatus(paths);
  } catch (e) {
    if (e instanceof MalformedSettingsError) {
      process.stderr.write(
        `cah probe status: ${e.message}\n`
        + `  To recover: fix the JSON in ${paths.settingsPath}, then retry status.\n`,
      );
      return 1;
    }
    throw e;
  }
  process.stdout.write(
    `probe: ${s.active ? 'ACTIVE' : 'inactive'}\n`
    + `  settings: ${paths.settingsPath}\n`
    + `  backup:   ${paths.backupPath} ${s.backupExists ? '(present)' : '(absent)'}\n`
    + `  log:      ${paths.logPath} (${s.logRecords} record(s), ${s.logSize} bytes)\n`,
  );
  return 0;
}

function cmdVersion() {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  let version = '(dev)';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    version = pkg.version || version;
  } catch {}
  process.stdout.write(
    `cc-arch-hands ${version} commands=${AllModelCommands.length} agents=${AllModelCommands.length} codex-agents=${AllCodexAgents.length} skills=${AllSkills.length}\n`,
  );
  return 0;
}
