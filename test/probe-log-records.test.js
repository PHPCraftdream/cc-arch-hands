import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { enableProbe, readProbeLog } from '../lib/probe.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-probe-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bins = join(root, '.claude', 'cah-bin');
  return { root, settingsPath: join(root, '.claude', 'settings.json'),
    backupPath: join(bins, 'cache', 'probe-backup.json'),
    logPath: join(bins, 'cache', 'envelope-probe.log'),
    probeBinAbsPath: join(bins, 'bin', 'cah-status-probe.js') };
}

const junk = 'null\nfalse\n42\n[]\n{}\n{"raw":false}\nnull\n';

it('probe log reader ignores JSON records with no string raw envelope', (t) => {
  const paths = fixture(t);
  mkdirSync(dirname(paths.logPath), { recursive: true });
  const valid = { capturedAt: 'test', raw: '{}' };
  writeFileSync(paths.logPath, junk + JSON.stringify(valid) + '\n' + junk);
  assert.deepEqual(readProbeLog(paths.logPath), [valid]);
});

for (const raw of [undefined, 'false', 'null']) {
  it(`probe stop tolerates damaged log records and displays ${raw ?? 'no'} envelope`, (t) => {
    const paths = fixture(t);
    mkdirSync(dirname(paths.settingsPath), { recursive: true });
    const original = { type: 'command', command: 'original' };
    writeFileSync(paths.settingsPath, JSON.stringify({ statusLine: original }));
    enableProbe(paths);
    writeFileSync(paths.logPath, junk + (raw === undefined ? '' : JSON.stringify({ raw }) + '\n'));
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../bin/cah.js', import.meta.url)), 'probe', 'statusline', 'stop',
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, HOME: paths.root, USERPROFILE: paths.root } });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).statusLine, original);
    assert.equal(existsSync(paths.backupPath), false);
    assert.match(child.stdout, new RegExp(`captured ${raw === undefined ? 0 : 1} envelope`));
    if (raw !== undefined) assert.match(child.stdout, new RegExp(`\\n${raw}\\r?\\n$`));
  });
}
