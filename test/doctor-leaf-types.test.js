import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { classifyPath, run } from '../lib/cli.js';
import { AllModelCommands } from '../lib/manifest.js';
import { SentinelModelAgent, SetForModelAgent } from '../lib/sentinel.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-doctor-leaf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function link(t, target, path) {
  try { symlinkSync(target, path, 'file'); return true; } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('file symlinks unavailable');
      return false;
    }
    throw error;
  }
}

for (const present of [false, true]) {
  it(`non-runtime classification refuses a ${present ? 'valid' : 'dangling'} symlink`, (t) => {
    const root = fixture(t);
    const target = join(root, 'target.md');
    const path = join(root, 'agent.md');
    if (present) writeFileSync(target, SentinelModelAgent);
    if (!link(t, target, path)) return;
    assert.equal(classifyPath(path, SetForModelAgent), 'foreign');
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(existsSync(target), present);
  });
}

it('doctor rejects an agent symlink that an actual install cannot replace', (t) => {
  const root = fixture(t);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    assert.equal(run(['install']), 0);
    assert.equal(run(['doctor']), 0);
    const path = join(root, '.claude', 'agents', AllModelCommands[0].name + '.md');
    const target = join(root, 'agent-target.md');
    const original = readFileSync(path, 'utf8');
    writeFileSync(target, original);
    unlinkSync(path);
    if (!link(t, target, path)) return;
    assert.equal(run(['install', '--only', 'agents']), 1);
    assert.equal(run(['doctor']), 2);
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), original);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
