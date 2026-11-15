// `cah probe statusline start|stop|status`: wires the diagnostic statusLine bin
// and reports what it captured.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Scope } from './scope.js';
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

export function cmdProbe(rest) {
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
    if (e instanceof MalformedSettingsError) {
      process.stderr.write(
        `cah probe start: ${e.message}\n`
        + `  To recover: fix the JSON in ${paths.settingsPath}, then retry start.\n`,
      );
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
    let pretty;
    try {
      pretty = JSON.stringify(JSON.parse(last.raw), null, 2);
    } catch {
      process.stdout.write('(raw stdin was not valid JSON — printing as text)\n');
    }
    process.stdout.write(`${pretty ?? last.raw}\n`);
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
    process.stderr.write(`cah probe status: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(
    `probe: ${s.active ? 'ACTIVE' : 'inactive'}\n`
    + `  settings: ${paths.settingsPath}\n`
    + `  backup:   ${paths.backupPath} ${s.backupExists ? '(present)' : '(absent)'}\n`
    + `  log:      ${paths.logPath} (${s.logRecords} record(s), ${s.logSize} bytes)\n`,
  );
  return 0;
}
