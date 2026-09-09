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
  linkSync,
  lstatSync,
  openSync,
  writeSync,
  closeSync,
  utimesSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  enableProbe,
  disableProbe,
  readProbeLog,
  probeStatus,
  ProbeAlreadyActiveError,
  ProbeBusyError,
  ProbeNotActiveError,
  MissingBackupError,
  ProbePathUnsafeError,
  MalformedSettingsError,
  MalformedBackupError,
  PROBE_SENTINEL,
  PROBE_NAME,
} from '../lib/probe.js';
import { regularFileIdentity, sameFileIdentity } from '../lib/fsutil.js';
import { recoverPublicationFence } from '../lib/fs-atomic-publication.js';
import { runWorker } from '../test-support/process-batches.js';

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

function runProbeWorker(
  action,
  paths,
  interlock,
  phase,
  fsInterlock = null,
  fsPhase = null,
  { timeoutMs, graceMs, hang = false } = {},
) {
  const probeUrl = new URL('../lib/probe.js', import.meta.url).href;
  const hooksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      if (workerData.hang) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      process.env.CAH_TEST_ONLY_PROBE_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_PROBE_INTERLOCK_PHASE = workerData.phase;
      if (workerData.fsInterlock && workerData.fsPhase) {
        process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.fsInterlock;
        process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = workerData.fsPhase;
      }
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock(process.env);
      const probe = await import(workerData.probeUrl);
      try {
        const value = probe[workerData.action](workerData.paths, { testInterlock });
        parentPort.postMessage({ ok: true, value });
      } catch (error) {
        parentPort.postMessage({ ok: false, name: error.name, message: error.message });
      }
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      action, paths, interlock, phase, fsInterlock, fsPhase, probeUrl, hooksUrl, hang,
    },
  });
  return runWorker(worker, {
    label: 'probe worker',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(graceMs === undefined ? {} : { graceMs }),
  });
}

function mutateSettingsInPlace(path) {
  const before = lstatSync(path, { bigint: true });
  const original = readFileSync(path);
  const mutated = Buffer.from(original);
  // Callers pause at different post-rename points, so the file's content at
  // mutation time varies (a freshly committed probe entry vs. a just-restored
  // original) — but both always carry a `"command"` property. Flip a byte
  // strictly inside that quoted property name so the result stays valid,
  // parseable JSON (some callers re-parse it afterward) with a same-size,
  // same-inode, different-content leaf.
  const marker = Buffer.from('"command"');
  const offset = mutated.indexOf(marker);
  assert.ok(offset >= 0, 'a "command" property must be present in the settings content');
  const byteIndex = offset + 2;
  mutated[byteIndex] = mutated[byteIndex] === 0x6f ? 0x70 : 0x6f;
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, mutated, 0, mutated.length, 0);
  } finally {
    closeSync(fd);
  }
  // Restore the prior timestamps after the same-size in-place rewrite. The
  // exact snapshot check must still reject this because the bytes changed.
  utimesSync(path, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
  const after = lstatSync(path, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notDeepEqual(mutated, original);
  return mutated;
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

  it('fails before state mutation when the log path cannot be prepared', () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    const settingsBefore = JSON.stringify({ statusLine: original });
    writeFileSync(h.settingsPath, settingsBefore);
    mkdirSync(h.logPath, { recursive: true });

    assert.throws(() => enableProbe(h));
    assert.equal(readFileSync(h.settingsPath, 'utf8'), settingsBefore);
    assert.equal(existsSync(h.backupPath), false, 'failed preflight must not create backup');
  });

  it('rejects a log symlink without touching its victim or probe state', (t) => {
    const h = harness();
    const victimPath = join(h.logPath, '..', 'log-victim.txt');
    const victim = 'foreign log data\n';
    mkdirSync(join(h.logPath, '..'), { recursive: true });
    writeFileSync(victimPath, victim);
    if (!makeSymlinkOrSkip(t, h.logPath, victimPath)) return;
    const settingsBefore = JSON.stringify({ statusLine: { type: 'command', command: 'original' } });
    writeFileSync(h.settingsPath, settingsBefore);

    assert.throws(() => enableProbe(h), /probe log path is not a regular file/);
    assert.equal(readFileSync(victimPath, 'utf8'), victim);
    assert.equal(readFileSync(h.settingsPath, 'utf8'), settingsBefore);
    assert.equal(existsSync(h.backupPath), false);
    assert.equal(lstatSync(h.logPath, { bigint: true }).isSymbolicLink(), true);
  });

  it('rejects a hard-linked log without touching either link or probe state', () => {
    const h = harness();
    const victimPath = join(h.logPath, '..', 'log-hardlink-victim.txt');
    const victim = 'foreign hard-linked data\n';
    mkdirSync(join(h.logPath, '..'), { recursive: true });
    writeFileSync(victimPath, victim);
    linkSync(victimPath, h.logPath);
    const settingsBefore = JSON.stringify({ statusLine: { type: 'command', command: 'original' } });
    writeFileSync(h.settingsPath, settingsBefore);

    assert.throws(() => enableProbe(h), /probe log path has multiple links/);
    assert.equal(readFileSync(victimPath, 'utf8'), victim);
    assert.equal(readFileSync(h.logPath, 'utf8'), victim);
    assert.equal(readFileSync(h.settingsPath, 'utf8'), settingsBefore);
    assert.equal(existsSync(h.backupPath), false);
  });

  it('atomically publishes an empty log for a missing or safe existing leaf', () => {
    const missing = harness();
    enableProbe(missing);
    assert.equal(readFileSync(missing.logPath, 'utf8'), '');

    const existing = harness();
    mkdirSync(join(existing.logPath, '..'), { recursive: true });
    writeFileSync(existing.logPath, 'foreign existing log\n');
    const before = lstatSync(existing.logPath, { bigint: true });
    enableProbe(existing);
    const after = lstatSync(existing.logPath, { bigint: true });
    assert.equal(readFileSync(existing.logPath, 'utf8'), '');
    assert.notEqual(after.ino, before.ino, 'safe existing log must be atomically replaced');
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
  it('terminates a deterministically hung worker before rejecting', async () => {
    const h = harness();
    const started = Date.now();
    await assert.rejects(
      runProbeWorker('enableProbe', h, join(h.settingsPath, '..', 'hung-probe'), 'unused', null, null, {
        timeoutMs: 50,
        graceMs: 25,
        hang: true,
      }),
      (error) => error?.code === 'ETIMEDOUT',
    );
    assert.ok(Date.now() - started < 2_000, 'hung worker must be bounded');
  });

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
    assert.ok(existsSync(h.backupPath),
      'the successor kept the probe entry, so the backup is still its only recovery');
    const restored = disableProbe(h);
    assert.deepEqual(restored.restored, original, 'disable must restore the original entry');
    assert.equal(existsSync(h.backupPath), false, 'a successful disable consumes the backup');
  });

  it('keeps C during a probe rollback CAS race', async () => {
    const h = harness();
    const original = { type: 'command', command: 'original', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(h);

    const probeInterlock = join(h.settingsPath, '..', 'probe-rollback-cas-probe');
    const fsInterlock = join(h.settingsPath, '..', 'probe-rollback-cas-fs');
    const worker = runProbeWorker(
      'disableProbe',
      h,
      probeInterlock,
      'disable-post-settings-rename',
      fsInterlock,
      'probe-rollback-before-final',
    );
    await waitForPath(`${probeInterlock}.ready`);
    unlinkSync(h.backupPath);
    writeFileSync(h.backupPath, JSON.stringify({ previous: { owner: 'C' } }));
    writeFileSync(`${probeInterlock}.go`, 'go');
    await waitForPath(`${fsInterlock}.ready`);
    assert.equal(existsSync(h.settingsPath), true,
      'rollback preparation must keep the old settings leaf visible');
    assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine, original,
      'rollback preparation must leave the published settings intact until CAS');
    const successor = JSON.stringify({ owner: 'C-settings' }) + '\n';
    unlinkSync(h.settingsPath);
    writeFileSync(h.settingsPath, successor);
    const successorIdentity = regularFileIdentity(h.settingsPath);
    writeFileSync(`${fsInterlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.equal(readFileSync(h.settingsPath, 'utf8'), successor);
    assert.equal(sameFileIdentity(regularFileIdentity(h.settingsPath), successorIdentity), true);
    assert.equal(existsSync(`${h.settingsPath}.cah-owned-publish`), false,
      'a failed CAS must clean its private temp without creating a publication vacancy');
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

  it('preserves a same-inode, same-size mutated settings file during enable rollback', async (t) => {
    if (process.platform === 'win32') {
      t.skip('nanosecond mtime restoration is not deterministic on Windows');
      return;
    }
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'original', padding: 0 },
    }));

    const interlock = join(h.settingsPath, '..', 'enable-in-place-mutation-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-post-settings-rename');
    await waitForPath(`${interlock}.ready`);
    const mutated = mutateSettingsInPlace(h.settingsPath);
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.deepEqual(readFileSync(h.settingsPath), mutated,
      'enable rollback must preserve an in-place content successor');
    assert.ok(existsSync(h.backupPath),
      'the mutated leaf kept the probe entry, so the backup is still its only recovery');
    const restored = disableProbe(h);
    assert.deepEqual(restored.restored, { type: 'command', command: 'original', padding: 0 },
      'disable must restore the original entry through the mutated leaf');
    assert.equal(existsSync(h.backupPath), false, 'a successful disable consumes the backup');
  });

  it('preserves a same-inode, same-size mutated settings file during stop rollback', async (t) => {
    if (process.platform === 'win32') {
      t.skip('nanosecond mtime restoration is not deterministic on Windows');
      return;
    }
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'original', padding: 0 },
    }));
    enableProbe(h);

    const interlock = join(h.settingsPath, '..', 'stop-in-place-mutation-interlock');
    const worker = runProbeWorker('disableProbe', h, interlock, 'disable-post-settings-rename');
    await waitForPath(`${interlock}.ready`);
    const mutated = mutateSettingsInPlace(h.settingsPath);
    writeFileSync(`${interlock}.go`, 'go');

    const result = await worker;
    assert.equal(result.ok, false);
    assert.deepEqual(readFileSync(h.settingsPath), mutated,
      'stop rollback must preserve an in-place content successor');
    assert.ok(existsSync(h.backupPath), 'stop rollback must retain its backup');
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
  it('normalizes path separators and keeps shell-safe paths working', () => {
    const h = harness();
    enableProbe(h);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.ok(!s.statusLine.command.includes('\\'), 'no backslash separators');
    assert.match(s.statusLine.command, /^node "/);
  });

  const unsafeSegments = ['$(echo CAH_EXPANDED)', 'a`b', 'a"b', 'a&b', 'a%b',
    'a;b', 'a|b', 'a<b', 'a>b', 'a^b', 'a!b', 'a$b'];
  for (const segment of unsafeSegments) {
    it(`refuses a probe path containing ${JSON.stringify(segment)} at generation time`, () => {
      const h = harness();
      const original = { type: 'command', command: 'original-user-command', padding: 0 };
      writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
      const unsafePath = join(dirname(h.probeBinAbsPath), segment, 'cah-status-probe.js');
      let error = null;
      try {
        enableProbe({ ...h, probeBinAbsPath: unsafePath });
      } catch (caught) { error = caught; }
      assert.ok(error, 'generation must refuse the path');
      assert.ok(error instanceof ProbePathUnsafeError, `unexpected error: ${error}`);
      assert.match(error.message, /shell/);
      assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')), { statusLine: original },
        'settings must be untouched by a refused enable');
      assert.equal(existsSync(h.backupPath), false, 'no backup may be created');
      assert.equal(existsSync(h.logPath), false, 'no log may be created');
    });
  }

  it('runs the generated command identically through the platform shell for shell-safe paths', () => {
    const h = harness();
    const fixtureDir = join(dirname(h.settingsPath), 'probe shell dir (ok)');
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = join(fixtureDir, 'cah-status-probe.js');
    writeFileSync(fixture, "process.stdout.write('PROBE_SHELL_OK');");
    enableProbe({ ...h, probeBinAbsPath: fixture });
    const { command } = JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine;
    assert.equal(command, `node "${fixture.split('\\').join('/')}"`);
    const shell = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command],
        { encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(shell.status, 0, `shell run failed: ${shell.stderr}`);
    assert.equal(shell.stdout.trim(), 'PROBE_SHELL_OK',
      'the generated command must reach the same script through the shell');
    const direct = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
    assert.equal(direct.status, 0, `direct run failed: ${direct.stderr}`);
    assert.equal(direct.stdout.trim(), 'PROBE_SHELL_OK',
      'direct argv-array invocation must behave identically');
  });

  it('preserves 4-space indentation of an existing settings.json (review L15)', () => {
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({ other: 'keep' }, null, 4));
    enableProbe(h);
    const text = readFileSync(h.settingsPath, 'utf8');
    assert.match(text, /\n {4}"other"/, 'indentation must stay 4-space');
  });
});

describe('probe committed-publication rollback (review P1-2)', () => {
  function interlockThrowingAt(targetPhase, occurrence) {
    let seen = 0;
    return (phase) => {
      if (phase !== targetPhase) return;
      seen += 1;
      if (seen === occurrence) throw new Error(`injected failure at ${targetPhase}`);
    };
  }

  // enableProbe publishes three files (log, backup, settings) and each
  // writeFileAtomic fires these phases once, so the settings write is the
  // third occurrence; stop publishes only settings (the first).
  const postCommitPhases = [
    ['after rename, before sync', 'write-after-rename-before-sync', 3, 1],
    ['after parent sync and fence finish', 'write-after-rename', 3, 1],
    ['at destination inspection', 'write-before-destination-inspection', 3, 1],
  ];
  for (const [label, phase, enableAt, disableAt] of postCommitPhases) {
    it(`enable converges when its settings publication fails ${label}`, () => {
      const h = harness();
      const original = { type: 'command', command: 'original-user-command', padding: 0 };
      writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
      let error = null;
      try {
        enableProbe(h, { testInterlock: interlockThrowingAt(phase, enableAt) });
      } catch (caught) { error = caught; }
      assert.ok(error, 'the injected post-commit failure must propagate');
      assert.ok(error.committedPublication, 'the error must carry the committed publication');
      assert.equal(error.committedPublication.path, h.settingsPath);
      assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine, original,
        'the original settings must survive a failed enable');
      assert.equal(existsSync(h.backupPath), false,
        'the backup must not outlive a reverted enable');
      assert.equal(existsSync(`${h.settingsPath}.cah-owned-publish`), false,
        'the failed transition must not leave a publication fence');
    });

    it(`stop converges when its settings publication fails ${label}`, () => {
      const h = harness();
      const original = { type: 'command', command: 'original-user-command', padding: 0 };
      writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
      enableProbe(h);
      let error = null;
      try {
        disableProbe(h, { testInterlock: interlockThrowingAt(phase, disableAt) });
      } catch (caught) { error = caught; }
      assert.ok(error, 'the injected post-commit failure must propagate');
      assert.ok(error.committedPublication, 'the error must carry the committed publication');
      assert.equal(error.committedPublication.path, h.settingsPath);
      assert.ok(JSON.parse(readFileSync(h.settingsPath, 'utf8')).statusLine['cah-sentinel'],
        'a failed stop must leave the probe armed');
      const restored = disableProbe(h);
      assert.deepEqual(restored.restored, original, 'a retry must restore the original entry');
      assert.equal(existsSync(h.backupPath), false,
        'the successful retry must consume the backup');
    });
  }

  it('never rolls back over a settings successor that replaced a committed enable publication', () => {
    const h = harness();
    const original = { type: 'command', command: 'original-user-command', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));
    let seen = 0;
    const successorSwap = (phase) => {
      if (phase !== 'write-after-rename-before-sync') return;
      seen += 1;
      if (seen !== 3) return;
      const published = readFileSync(h.settingsPath);
      unlinkSync(h.settingsPath);
      writeFileSync(h.settingsPath, published);
      throw new Error('injected failure at write-after-rename-before-sync');
    };
    let error = null;
    try {
      enableProbe(h, { testInterlock: successorSwap });
    } catch (caught) { error = caught; }
    assert.ok(error, 'the injected post-commit failure must propagate');
    assert.equal(error.committedPublication.path, h.settingsPath);
    const settings = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(settings.statusLine['cah-sentinel'], PROBE_SENTINEL,
      'the successor leaf keeps the committed probe content');
    assert.equal(existsSync(h.backupPath), true,
      'an armed probe keeps its backup even when a successor replaced the leaf');
    // The successor swap left the failed enable's publication fence behind on
    // purpose: recovery state a successor verifies and completes. Do that
    // before disabling, exactly like any later writer would.
    assert.equal(recoverPublicationFence(h.settingsPath), true,
      'the successor must be able to complete the abandoned cleanup');
    const restored = disableProbe(h);
    assert.deepEqual(restored.restored, original,
      'disable must restore the original entry through the successor content');
    assert.equal(existsSync(h.backupPath), false, 'a successful disable consumes the backup');
  });
});

describe('probe backup vs ordinary settings edits (review round 2 P1-1)', () => {
  it('keeps the backup when an external editor re-saves settings with an unrelated key', () => {
    const h = harness();
    const original = { type: 'command', command: 'original-user-command', padding: 0 };
    writeFileSync(h.settingsPath, JSON.stringify({ statusLine: original }));

    const editorWrite = (phase) => {
      if (phase !== 'enable-post-settings-rename') return;
      // An ordinary settings editor: read the just-published settings (which
      // already carry the probe entry), add an unrelated key, re-save
      // atomically. The identity of the leaf changes; the armed probe does
      // not.
      const current = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
      assert.equal(current.statusLine['cah-name'], PROBE_NAME);
      current.editorSetting = 'preserve me';
      const temp = `${h.settingsPath}.editor-${process.pid}`;
      writeFileSync(temp, JSON.stringify(current, null, 2) + '\n');
      renameSync(temp, h.settingsPath);
      throw new Error('editor finished; enable still fails its post-rename check');
    };

    let error = null;
    try {
      enableProbe(h, { testInterlock: editorWrite });
    } catch (caught) { error = caught; }
    assert.ok(error, 'the injected post-rename failure must propagate');

    const settings = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(settings.statusLine['cah-sentinel'], PROBE_SENTINEL,
      'the probe entry must still be armed in the current settings content');
    assert.equal(settings.editorSetting, 'preserve me',
      'the unrelated editor change must not be rolled back');
    assert.equal(existsSync(h.backupPath), true,
      'the armed probe must keep its only recovery backup');
    const restored = disableProbe(h);
    assert.deepEqual(restored.restored, original,
      'disable must restore the original statusLine through the editor content');
    assert.equal(JSON.parse(readFileSync(h.settingsPath, 'utf8')).editorSetting, 'preserve me',
      'disable must preserve the unrelated editor key');
    assert.equal(existsSync(h.backupPath), false, 'a successful disable consumes the backup');
  });
});

describe('probe settings root validation (review round-5 P2-1)', () => {
  it('refuses a valid-JSON non-object settings root on enable, disable, and status without any side effects (round-5 P2-1)', async () => {
    for (const root of ['[]', '"just a string"', '42', 'true', 'null']) {
      const h = harness();
      writeFileSync(h.settingsPath, root + '\n');

      await assert.rejects(async () => enableProbe(h), (error) =>
        error instanceof MalformedSettingsError
        && /expected a JSON object at the document root/.test(error.message));
      // A refused enable must be side-effect free: no reformat, no cache dir,
      // no backup, no log.
      assert.equal(readFileSync(h.settingsPath, 'utf8'), root + '\n');
      assert.equal(existsSync(h.backupPath), false);
      assert.equal(existsSync(h.logPath), false);
      assert.equal(existsSync(dirname(h.backupPath)), false,
        'a refused enable must not create the cache directory');

      await assert.rejects(async () => disableProbe(h), MalformedSettingsError);
      assert.throws(() => probeStatus(h), MalformedSettingsError);
    }
  });

  it('still enables and disables normally for a plain object root (round-5 P2-1 regression guard)', () => {
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({ editorSetting: 'keep' }, null, 2) + '\n');

    enableProbe(h);
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(s.statusLine['cah-sentinel'], PROBE_SENTINEL);
    assert.equal(s.editorSetting, 'keep', 'unrelated keys must survive');
    assert.equal(JSON.parse(readFileSync(h.backupPath, 'utf8')).previous, null);

    const stop = disableProbe(h);
    assert.deepEqual(stop.restored, null);
    const after = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.ok(!('statusLine' in after));
    assert.equal(after.editorSetting, 'keep');
    assert.equal(existsSync(h.backupPath), false, 'a successful disable consumes the backup');
  });
});

describe('probe lease expiry vs successor backup (review round-5 P1-1)', () => {
  it('an enable that lost its lease must not overwrite the successor backup, settings, or log (round-5 P1-1)', async () => {
    const h = harness();
    writeFileSync(h.settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'original-before-edit', padding: 0 },
      editorSetting: 'keep',
    }, null, 2) + '\n');

    const interlock = join(h.settingsPath, '..', 'stale-enable-interlock');
    const worker = runProbeWorker('enableProbe', h, interlock, 'enable-after-read');
    await waitForPath(`${interlock}.ready`);

    // Backdate A's lease owner so the lease is exactly as reclaimable as a
    // real expiry, then play an external editor and let B take over.
    const ownerPath = join(h.settingsPath + '.lock', 'owner.json');
    assert.equal(existsSync(ownerPath), true, 'the paused enable must hold a lease owner file');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    owner.timestamp = Date.now() - 6 * 60 * 1000;
    writeFileSync(ownerPath, JSON.stringify(owner) + '\n');

    writeFileSync(h.settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'new-user-command', padding: 0 },
      editorSetting: 'keep',
    }));

    // B is a real separate process running the real enableProbe to completion.
    const probeUrl = pathToFileURL(join(__dirname, '..', 'lib', 'probe.js')).href;
    const childPath = join(h.settingsPath, '..', 'successor-enable.mjs');
    writeFileSync(childPath, [
      'const { enableProbe } = await import(process.argv[2]);',
      'const paths = JSON.parse(process.argv[3]);',
      'try {',
      '  enableProbe(paths);',
      "  console.log('B_OK');",
      '} catch (error) {',
      "  console.log('B_FAIL ' + error.name + ': ' + error.message);",
      '  process.exit(1);',
      '}',
    ].join('\n'));
    const b = spawnSync(process.execPath, [childPath, probeUrl,
      JSON.stringify({
        settingsPath: h.settingsPath,
        probeBinAbsPath: h.probeBinAbsPath,
        backupPath: h.backupPath,
        logPath: h.logPath,
      })], { encoding: 'utf8' });
    assert.equal(b.status, 0, `successor enable B failed: ${b.stdout} ${b.stderr}`);
    assert.ok(b.stdout.includes('B_OK'), `successor enable B did not succeed: ${b.stdout} ${b.stderr}`);
    assert.equal(JSON.parse(readFileSync(h.backupPath, 'utf8')).previous.command, 'new-user-command');

    writeFileSync(`${interlock}.go`, 'go');
    const result = await worker;
    // A must notice its lease was stolen, not proceed with its stale state.
    assert.equal(result.ok, false, `stale enable should fail, got ${JSON.stringify(result)}`);
    assert.equal(result.name, 'ProbeLeaseLostError',
      `expected ProbeLeaseLostError, got ${result.name}: ${result.message}`);
    assert.match(result.message, /lease was lost/);

    // B's published state must have survived A entirely.
    assert.equal(JSON.parse(readFileSync(h.backupPath, 'utf8')).previous.command, 'new-user-command',
      'the stale enable must not remove or overwrite the successor backup');
    const s = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.equal(s.statusLine['cah-sentinel'], PROBE_SENTINEL,
      'the stale enable must not overwrite the successor settings');
    assert.equal(s.editorSetting, 'keep');

    // Everything is still cleanly stoppable.
    const stop = disableProbe(h);
    assert.deepEqual(stop.restored, { type: 'command', command: 'new-user-command', padding: 0 });
    const after = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
    assert.deepEqual(after.statusLine, { type: 'command', command: 'new-user-command', padding: 0 });
    assert.equal(after.editorSetting, 'keep');
    assert.equal(existsSync(h.backupPath), false, 'a successful disable consumes the backup');
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

  it('accepts the Latin-1 mojibake BOM the mutating paths accept', () => {
    const h = harness();
    writeFileSync(h.settingsPath, 'ï»¿' + JSON.stringify({
      statusLine: {
        type: 'command',
        command: 'node probe.js',
        'cah-sentinel': 'cah-probe-statusline:v1',
        'cah-name': 'probe',
      },
    }));
    const s = probeStatus(h);
    assert.equal(s.active, true);
    assert.equal(s.backupExists, false);
    assert.equal(s.logRecords, 0);
  });

  it('throws MalformedSettingsError on malformed settings JSON like the mutating paths', () => {
    const h = harness();
    writeFileSync(h.settingsPath, '{ malformed settings');
    assert.throws(() => probeStatus(h), (error) => {
      assert.ok(error instanceof MalformedSettingsError);
      assert.match(error.message, new RegExp(h.settingsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  });
});
