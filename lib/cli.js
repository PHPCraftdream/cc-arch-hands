import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from './scope.js';
import { AllModelCommands, AllSkills } from './manifest.js';
import { SetForModelCommand, SetForModelAgent, SetForSkill, SetForBin, classifyContent } from './sentinel.js';
import { SKILL_MANIFEST_LEAF } from './scope.js';
import { embeddedTemplates, diskTemplates } from './templates.js';
import { writeModelCommands, removeModelCommands } from './commands.js';
import { writeModelAgents, removeModelAgents } from './agents.js';
import { writeSkills, removeSkills } from './skills.js';
import { writeBins, removeBins, BinFiles } from './binstall.js';
import {
  enableProbe,
  disableProbe,
  readProbeLog,
  probeStatus,
  ProbeAlreadyActiveError,
  ProbeNotActiveError,
  MissingBackupError,
} from './probe.js';

const PACKAGE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const USAGE = `cc-arch-hands — install Claude Code per-model commands, agents and skills.

Usage:
  cah install   [--global|--local] [--cwd PATH] [--templates DIR] [--only commands,agents,skills,bins]
  cah reinstall [--global|--local] [--cwd PATH] [--templates DIR] [--only commands,agents,skills,bins]
  cah uninstall [--global|--local] [--cwd PATH] [--only commands,agents,skills,bins]
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

Note: the 'bins' class (companion bins for /clock and /checkpoint-watch) is
always written to the global ~/.claude/cah-bin/, regardless of scope flags.
`;

const VALID_CLASSES = ['commands', 'agents', 'skills', 'bins'];

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

export function parseOnly(only) {
  if (!only || only.trim() === '') return [...VALID_CLASSES];
  const parts = only.split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of parts) {
    if (!VALID_CLASSES.includes(c)) {
      throw new Error(`unknown class "${c}" in --only (valid: ${VALID_CLASSES.join(', ')})`);
    }
  }
  const seen = new Set(parts);
  const out = VALID_CLASSES.filter((c) => seen.has(c));
  if (out.length === 0) throw new Error('--only resolved to no classes');
  return out;
}

function reportClass(cls, verb, n, skipped, pruned = 0) {
  const tail = pruned > 0 ? `, pruned ${pruned} (orphan)` : '';
  process.stdout.write(`  ${cls}: ${verb} ${n}, skipped ${skipped.length} (foreign)${tail}\n`);
  for (const p of skipped) {
    process.stdout.write(`    ${p}\n`);
  }
}

function cmdInstall(rest) {
  let parsed;
  try {
    parsed = parseScopeFlags(rest, {
      templates: { type: 'string', default: '' },
      only: { type: 'string', default: '' },
    });
  } catch (e) {
    process.stderr.write(`cah install: ${e.message}\n`);
    return 2;
  }
  const vals = parsed.values;

  let scope;
  try {
    scope = resolveScope(vals);
  } catch (e) {
    process.stderr.write(`cah install: ${e.message}\n`);
    return 1;
  }

  let classes;
  try {
    classes = parseOnly(vals.only);
  } catch (e) {
    process.stderr.write(`cah install: ${e.message}\n`);
    return 1;
  }

  let t;
  try {
    t = vals.templates ? diskTemplates(vals.templates) : embeddedTemplates();
  } catch (e) {
    process.stderr.write(`cah install: load templates: ${e.message}\n`);
    return 1;
  }

  process.stdout.write(`installing into ${scope.describe()} from ${t.label}\n`);

  for (const cls of classes) {
    let result;
    try {
      switch (cls) {
        case 'commands':
          result = writeModelCommands(t, scope);
          break;
        case 'agents':
          result = writeModelAgents(t, scope);
          break;
        case 'skills':
          result = writeSkills(t, scope);
          break;
        case 'bins':
          result = writeBins(scope.resolveBinDir(), PACKAGE_ROOT);
          break;
      }
    } catch (e) {
      process.stderr.write(`cah install: ${cls}: ${e.message}\n`);
      return 1;
    }
    reportClass(cls, 'wrote', result.written, result.skipped, result.pruned);
  }
  return 0;
}

function cmdReinstall(rest) {
  process.stdout.write('reinstall: phase 1 — uninstall\n');
  const u = cmdUninstall(rest);
  if (u !== 0) {
    process.stderr.write(`cah reinstall: uninstall phase failed with exit ${u}; aborting before install.\n`);
    return u;
  }
  process.stdout.write('reinstall: phase 2 — install\n');
  return cmdInstall(rest);
}

function cmdUninstall(rest) {
  let parsed;
  try {
    parsed = parseScopeFlags(rest, {
      only: { type: 'string', default: '' },
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

  let classes;
  try {
    classes = parseOnly(vals.only);
  } catch (e) {
    process.stderr.write(`cah uninstall: ${e.message}\n`);
    return 1;
  }

  process.stdout.write(`uninstalling from ${scope.describe()}\n`);

  for (const cls of classes) {
    let result;
    try {
      switch (cls) {
        case 'commands':
          result = removeModelCommands(scope);
          break;
        case 'agents':
          result = removeModelAgents(scope);
          break;
        case 'skills':
          result = removeSkills(scope);
          break;
        case 'bins':
          result = removeBins(scope.resolveBinDir());
          break;
      }
    } catch (e) {
      process.stderr.write(`cah uninstall: ${cls}: ${e.message}\n`);
      return 1;
    }
    reportClass(cls, 'removed', result.removed, result.skipped);
  }
  return 0;
}

function classifyPath(path, set) {
  try {
    const data = readFileSync(path);
    return classifyContent(true, data, set).toString();
  } catch {
    return classifyContent(false, null, set).toString();
  }
}

function enumerate(scope) {
  const commandsDir = scope.resolveCommandsDir();
  const agentsDir = scope.resolveAgentsDir();
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

  let mine = 0, legacy = 0, foreign = 0, missing = 0;
  for (const r of rows) {
    switch (r.state) {
      case 'mine': mine++; break;
      case 'legacy': legacy++; break;
      case 'foreign': foreign++; break;
      case 'missing': missing++; break;
    }
  }

  process.stdout.write(`scope: ${scope.describe()}\n`);
  process.stdout.write(`mine: ${mine}, legacy: ${legacy}, foreign: ${foreign}, missing: ${missing} (out of ${rows.length} total)\n`);

  if (legacy > 0) {
    process.stdout.write("hint: run 'cah install' to migrate legacy files to new sentinels\n");
  }
  if (foreign > 0) {
    process.stdout.write(`warning: ${foreign} foreign files in our target paths — they will not be touched. Inspect with 'cah list'.\n`);
  }
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
  const s = probeStatus(paths);
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
    `cc-arch-hands ${version} commands=${AllModelCommands.length} agents=${AllModelCommands.length} skills=${AllSkills.length}\n`,
  );
  return 0;
}
