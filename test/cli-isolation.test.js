import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { SentinelBin } from '../lib/sentinel.js';

it('local CLI install tests leave the inherited home untouched', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cah-cli-outer-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, '.claude', 'cah-bin');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  const path = join(runtime, 'bin', 'cah-status.js');
  const original = `${SentinelBin}\n// inherited installation must survive\n`;
  writeFileSync(path, original);
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--test', '--test-name-pattern=installs ONLY the named skill|reinstall --only clock honours',
    fileURLToPath(new URL('./cli.test.js', import.meta.url)),
  ], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /installs ONLY the named skill/);
  assert.match(child.stdout, /reinstall --only clock honours/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(readdirSync(runtime), ['bin']);
  assert.deepEqual(readdirSync(join(runtime, 'bin')), ['cah-status.js']);
});
