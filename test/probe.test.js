import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';

import {
  enableProbe,
  disableProbe,
  readProbeLog,
  probeStatus,
  ProbeAlreadyActiveError,
  ProbeBusyError,
  ProbeNotActiveError,
  MissingBackupError,
  MalformedSettingsError,
  MalformedBackupError,
  PROBE_SENTINEL,
  PROBE_NAME,
} from '../lib/probe.js';
import { regularFileIdentity, sameFileIdentity } from '../lib/fsutil.js';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cah-probe-'));
  return {
    settingsPath: join(root, 'settings.json'),
    backupPath: join(root, 'cache', 'probe-backup.json'),
    logPath: join(root, 'cache', 'envelope-probe.log'),
    probeBinAbsPath: join(root, 'bin', 'cah-status-probe.js'),
  };
}

async function waitForPath(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function runProbeWorker(action, paths, interlock, phase) {
  const probeUrl = new URL('../lib/probe.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_PROBE_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_PROBE_INTERLOCK_PHASE = workerData.phase;
      const probe = await import(workerData.probeUrl);
      try {
        const value = probe[workerData.action](workerData.paths);
        parentPort.postMessage({ ok: true, value });
      } catch (error) {
        parentPort.postMessage({ ok: false, name: error.name, message: error.message });
      }
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { action, paths, interlock, phase, probeUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

function makeSymlinkOrSkip(t, linkPath, targetPath) {
  try {
    symlinkSync(targetPath, linkPath, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES')) {
      t.skip('symbolic links are unavailable on this Windows runner');
      return false;
    }
    throw e;
  }
}

describe('enableProbe', () => {
  it('creates settings.json with probe entry when file is missing', () => {
    const h = harness();
    enableProbe(h);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(s.statusLine['cah-sentinel'], PROBE_SENTINEL);
    assert.equal(s.statusLine['cah-name'], PROBE_NAME);
    assert.ok(s.statusLine.command.includes('cah-status-probe.js'));
    const b = JSON.parse(readFileSync(h.backupPath, 'utf8'));
    assert.equal(b.previous, null);
  });

  it('preserves the original statusLine into backup', () => {
    const h = harness();
    const original = { type: 'command', command: 'foo', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original, other: 'keep' }));
    enableProbe(h);
    const b = JSON.parse(readFileSync(h.backupPath, 'utf8'));
    assert.deepEqual(b.previous, original);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(s.other, 'keep', 'unrelated keys must survive');
    assert.equal(s.statusLine['cah-sentinel'], PROBE_SENTINEL);
  });

  it('does not overwrite a pre-existing foreign .tmp file', () => {
    const h = harness();
    const tempPath = `${h.settingsPath}.tmp`;
    const foreignTemp = '{"foreign":true}\n';
    writeFileSync(tempPath, foreignTemp);

    enableProbe(h);

    assert.equal(readFileSync(tempPath, 'utf8'), foreignTemp);
    const settings = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(settings.statusLine['cah-sentinel'], PROBE_SENTINEL);
  });

  it('does not follow a pre-existing .tmp symlink while publishing JSON', (t) => {
    const h = harness();
    const tempPath = `${h.settingsPath}.tmp`;
    const victimPath = `${h.settingsPath}.victim`;
    const victim = '{"victim":"untouched"}\n';
    writeFileSync(victimPath, victim);
    if (!makeSymlinkOrSkip(t, tempPath, victimPath)) return;

    enableProbe(h);

    assert.equal(lstatSync(tempPath).isSymbolicLink(), true);
    assert.equal(readFileSync(tempPath, 'utf8'), victim);
    assert.equal(readFileSync(victimPath, 'utf8'), victim);
    const settings = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(settings.statusLine['cah-sentinel'], PROBE_SENTINEL);
  });

  it('refuses to re-arm when probe already active (would erase backup)', () => {
    const h = harness();
    enableProbe(h);
    assert.throws(() => enableProbe(h), ProbeAlreadyActiveError);
  });

  it('truncates the log file on start so each session is clean', () => {
    const h = harness();
    enableProbe(h);
    writeFileSync(h.logPath, '{"old":"record"}\n');
    // re-enable would throw; simulate fresh state instead
    disableProbe(h);
    enableProbe(h);
    assert.equal(readFileSync(h.logPath, 'utf8'), '');
  });
});

describe('disableProbe', () => {
  it('restores the previous statusLine verbatim', () => {
    const h = harness();
    const original = { type: 'command', command: 'foo', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(h);
    const { restored } = disableProbe(h);
    assert.deepEqual(restored, original);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.deepEqual(s.statusLine, original);
    assert.ok(!existsSync(h.backupPath), 'backup is consumed on stop');
  });

  it('removes statusLine key when there was none originally', () => {
    const h = harness();
    enableProbe(h);
    disableProbe(h);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.ok(!('statusLine' in s), 'statusLine key removed when previous was null');
  });

  it('throws ProbeNotActiveError when probe is not wired', () => {
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'foreign' } }));
    assert.throws(() => disableProbe(h), ProbeNotActiveError);
  });

  it('throws MissingBackupError when backup vanished mid-session', () => {
    const h = harness();
    enableProbe(h);
    // simulate a user/tool removing the backup
    unlinkSync(h.backupPath);
    assert.throws(() => disableProbe(h), MissingBackupError);
  });

  it('throws a path-specific error for malformed settings JSON', () => {
    const h = harness();
    writeFileSync(h.settingsPath, '{ malformed settings');
    assert.throws(() => disableProbe(h), (error) => {
      assert.ok(error instanceof MalformedSettingsError);
      assert.equal(error.path, h.settingsPath);
      return true;
    });
  });

  it('tolerates a UTF-8 BOM in settings.json (review M6)', () => {
    const h = harness();
    const original = { type: 'command', command: 'foo', padding: 0 };
    // editor-added BOM in front of otherwise valid JSON
    writeFileSync(h.settingsPath, '﻿' + JSON.stringify({ statusLine: original }));
    enableProbe(h);
    // a BOM-prefixed file must not stop the probe from being disabled
    const { restored } = disableProbe(h);
    assert.deepEqual(restored, original);
  });
});

describe('probe concurrency', () => {
  it('does not overwrite a settings edit made during enable', async () => {
    const h = harness();
    const original = { type: 'command', command: 'before-edit', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    const interlock = join(h.settingsPath, '..', 'enable-edit-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-before-settings-write');

    await waitForPath(`${interlock}.ready`);
    const edited = { type: 'command', command: 'edited-by-user', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: edited }));
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /managed destination leaf changed concurrently/);
    assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine, edited);
    assert.ok(!existsSync(h.backupPath), 'failed enable must roll back its exact backup');
  });

  it('does not arm against a backup replaced before enable settings publication', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    const interlock = join(h.settingsPath, '..', 'enable-backup-replacement-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-before-settings-write');

    await waitForPath(`${interlock}.ready`);
    unlinkSync(h.backupPath);
    const successor = { previous: { type: 'command', command: 'foreign', padding: 0 } };
    writeFileSync(h.backupPath, JSON.stringify(successor));
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /probe backup changed concurrently/);
    assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine, original);
    assert.deepEqual(JSON.parse(readFileSync(h.backupPath, 'utf8')), successor,
      'foreign successor backup must be preserved');
  });

  it('fails fast while another probe transition owns the operation lease', async () => {
    const h = harness();
    const interlock = join(h.settingsPath, '..', 'enable-busy-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-after-read');

    await waitForPath(`${interlock}.ready`);
    assert.throws(() => enableProbe(h), ProbeBusyError);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await worker;
    assert.equal(result.ok, true);
  });

  it('does not remove a successor backup after stop reads the old one', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(h);

    const interlock = join(h.settingsPath, '..', 'stop-successor-interlock');
    const worker = runProbeWorker('disableProbe', h, interlock, 'disable-before-backup-remove');
    await waitForPath(`${interlock}.ready`);

    unlinkSync(h.backupPath);
    const successor = { previous: { type: 'command', command: 'new-start', padding: 0 } };
    writeFileSync(h.backupPath, JSON.stringify(successor));
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(h.backupPath, 'utf8')), successor);
    assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine, original);
  });

  it('does not restore settings from a backup replaced before stop restore', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(h);

    const interlock = join(h.settingsPath, '..', 'stop-backup-replacement-interlock');
    const worker = runProbeWorker('disableProbe', h, interlock, 'disable-before-settings-write');
    await waitForPath(`${interlock}.ready`);

    unlinkSync(h.backupPath);
    const successor = { previous: { type: 'command', command: 'foreign', padding: 0 } };
    writeFileSync(h.backupPath, JSON.stringify(successor));
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /probe backup changed concurrently/);
    assert.ok(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine['cah-sentinel']);
    assert.deepEqual(JSON.parse(readFileSync(h.backupPath, 'utf8')), successor,
      'foreign successor backup must be preserved');
  });

  it('rolls back the exact settings leaf when backup changes after enable publication', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));

    const interlock = join(h.settingsPath, '..', 'enable-post-settings-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-post-settings-rename');
    await waitForPath(`${interlock}.ready`);

    unlinkSync(h.backupPath);
    const successor = { previous: { type: 'command', command: 'foreign-successor', padding: 0 } };
    writeFileSync(h.backupPath, JSON.stringify(successor));
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /probe backup changed concurrently/);
    assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine, original,
      'failed enable must disarm its exact settings publication');
    assert.deepEqual(JSON.parse(readFileSync(h.backupPath, 'utf8')), successor,
      'enable must not remove a foreign backup successor');
  });

  it('rolls back the exact settings leaf when backup changes after stop publication', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(h);

    const interlock = join(h.settingsPath, '..', 'stop-post-settings-interlock');
    const worker = runProbeWorker('disableProbe', h, interlock, 'disable-post-settings-rename');
    await waitForPath(`${interlock}.ready`);

    unlinkSync(h.backupPath);
    const successor = { previous: { type: 'command', command: 'foreign-successor', padding: 0 } };
    writeFileSync(h.backupPath, JSON.stringify(successor));
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /probe backup changed concurrently/);
    assert.ok(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine['cah-sentinel'],
      'failed stop must retain the probe after restoring from stale data is refused');
    assert.deepEqual(JSON.parse(readFileSync(h.backupPath, 'utf8')), successor,
      'stop must preserve a foreign backup successor');
  });

  it('does not roll back a settings successor after enable postcheck failure', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));

    const interlock = join(h.settingsPath, '..', 'enable-settings-successor-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-post-settings-rename');
    await waitForPath(`${interlock}.ready`);

    const successor = readFileSync(h.settingsPath);
    unlinkSync(h.settingsPath);
    writeFileSync(h.settingsPath, successor);
    const successorIdentity = regularFileIdentity(h.settingsPath);
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /managed destination leaf changed concurrently/);
    assert.deepEqual(readFileSync(h.settingsPath), successor,
      'settings successor must never be overwritten during rollback');
    assert.equal(sameFileIdentity(regularFileIdentity(h.settingsPath), successorIdentity), true);
    assert.ok(!existsSync(h.backupPath), 'failed enable must roll back only its backup leaf');
  });

  it('does not roll back a byte-identical settings successor after stop postcheck failure', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(h);

    const interlock = join(h.settingsPath, '..', 'stop-settings-successor-interlock');
    const worker = runProbeWorker('disableProbe', h, interlock, 'disable-post-settings-rename');
    await waitForPath(`${interlock}.ready`);

    const successor = readFileSync(h.settingsPath);
    unlinkSync(h.settingsPath);
    writeFileSync(h.settingsPath, successor);
    const successorIdentity = regularFileIdentity(h.settingsPath);
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.match(result.message, /managed destination leaf changed concurrently/);
    assert.deepEqual(readFileSync(h.settingsPath), successor);
    assert.equal(sameFileIdentity(regularFileIdentity(h.settingsPath), successorIdentity), true);
    assert.ok(existsSync(h.backupPath), 'failed stop must retain its backup');
  });

  it('throws a path-specific error for malformed backup JSON', () => {
    const h = harness();
    enableProbe(h);
    writeFileSync(h.backupPath, '{ malformed backup');
    assert.throws(() => disableProbe(h), (error) => {
      assert.ok(error instanceof MalformedBackupError);
      assert.equal(error.path, h.backupPath);
      return true;
    });
  });
});

describe('probe command portability (review M10/L12)', () => {
  it('normalizes path separators and escapes quotes in the command', () => {
    const h = harness();
    enableProbe(h);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.ok(!s.statusLine.command.includes('\\'), 'no backslash separators');
    assert.match(s.statusLine.command, /^node "/);
  });

  it('preserves 4-space indentation of an existing settings.json (review L15)', () => {
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({ other: 'keep' }, null, 4));
    enableProbe(h);
    const text = readFileSync(h.settingsPath, 'utf8');
    assert.match(text, /\n {4}"other"/, 'indentation must stay 4-space');
  });
});

describe('readProbeLog', () => {
  it('returns [] for missing file', () => {
    const h = harness();
    assert.deepEqual(readProbeLog(h.logPath), []);
  });

  it('parses JSONL and skips malformed lines', () => {
    const h = harness();
    mkdirSync(join(h.logPath, '..'), { recursive: true });
    writeFileSync(h.logPath,
      '{"capturedAt":"t1","raw":"{}"}\n'
      + 'not json\n'
      + '{"capturedAt":"t2","raw":""}\n');
    const records = readProbeLog(h.logPath);
    assert.equal(records.length, 2);
    assert.equal(records[0].capturedAt, 't1');
    assert.equal(records[1].capturedAt, 't2');
  });
});

describe('probeStatus', () => {
  it('reports inactive when nothing is set', () => {
    const h = harness();
    const s = probeStatus(h);
    assert.equal(s.active, false);
    assert.equal(s.backupExists, false);
    assert.equal(s.logRecords, 0);
  });

  it('reports active after enable, with backup present', () => {
    const h = harness();
    enableProbe(h);
    const s = probeStatus(h);
    assert.equal(s.active, true);
    assert.equal(s.backupExists, true);
    assert.equal(s.logRecords, 0);
  });
});
