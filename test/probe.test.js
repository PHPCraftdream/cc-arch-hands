import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enableProbe,
  disableProbe,
  readProbeLog,
  probeStatus,
  ProbeAlreadyActiveError,
  ProbeNotActiveError,
  MissingBackupError,
  PROBE_SENTINEL,
  PROBE_NAME,
} from '../lib/probe.js';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cah-probe-'));
  return {
    settingsPath: join(root, 'settings.json'),
    backupPath: join(root, 'cache', 'probe-backup.json'),
    logPath: join(root, 'cache', 'envelope-probe.log'),
    probeBinAbsPath: join(root, 'bin', 'cah-status-probe.js'),
  };
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
