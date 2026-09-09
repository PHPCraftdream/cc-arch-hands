import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';

const bin = fileURLToPath(new URL('../bin/cah-status-probe.js', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-probe-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, log: join(root, 'probe.log'), victim: join(root, 'user.json') };
}

function run(log, raw = '{"session_id":"probe-log-test"}', setup = null) {
  const args = setup ? ['--input-type=module', '-e',
    `${setup}\nawait import(${JSON.stringify(pathToFileURL(bin).href)});`] : [bin];
  const result = spawnSync(process.execPath, args, {
    input: raw, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CAH_PROBE_LOG: log },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cah probe/);
  return raw;
}

it('probe logger creates a regular log and appends complete records', (t) => {
  const { log } = fixture(t);
  const first = run(log);
  const second = run(log, '{"second":true}');
  const records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((entry) => entry.raw), [first, second]);
  assert.ok(records.every((entry) => Number.isFinite(Date.parse(entry.capturedAt))));
});

it('probe logger preserves a hard-linked user file', (t) => {
  const { log, victim } = fixture(t);
  const original = '{"userSetting":"keep"}\n';
  writeFileSync(victim, original);
  linkSync(victim, log);
  run(log);
  assert.equal(readFileSync(victim, 'utf8'), original);
  assert.equal(readFileSync(log, 'utf8'), original);
  assert.equal(lstatSync(log).nlink, 2);
});

for (const dangling of [false, true]) {
  it(`probe logger preserves a ${dangling ? 'dangling' : 'regular'} symlink`, (t) => {
    const { log, victim } = fixture(t);
    const original = '{"userSetting":"keep"}\n';
    if (!dangling) writeFileSync(victim, original);
    try { symlinkSync(victim, log, 'file'); } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('file symlinks unavailable');
        return;
      }
      throw error;
    }
    run(log);
    assert.ok(lstatSync(log).isSymbolicLink());
    if (dangling) assert.equal(existsSync(victim), false);
    else assert.equal(readFileSync(victim, 'utf8'), original);
  });
}

it('probe logger tolerates a directory without changing it', (t) => {
  const { log } = fixture(t);
  mkdirSync(log);
  run(log);
  assert.ok(lstatSync(log).isDirectory());
});

for (const present of [false, true]) {
  it(`probe logger refuses a link appearing at open (${present ? 'existing' : 'absent'} log)`, (t) => {
    const { log, victim } = fixture(t);
    const original = '{"userSetting":"keep"}\n';
    writeFileSync(victim, original);
    if (present) writeFileSync(log, '');
    run(log, '{}', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join, dirname } from 'node:path';
      const originalOpen = fs.openSync;
      const log = process.env.CAH_PROBE_LOG;
      fs.openSync = (path, ...args) => {
        if (path === log) {
          if (fs.existsSync(log)) fs.unlinkSync(log);
          fs.linkSync(join(dirname(log), 'user.json'), log);
        }
        return originalOpen(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    assert.equal(readFileSync(victim, 'utf8'), original);
    assert.equal(readFileSync(log, 'utf8'), original);
  });
}
