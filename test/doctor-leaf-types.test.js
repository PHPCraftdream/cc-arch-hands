import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { withHome } from '../test-support/env.js';
import { symlinkOrSkip } from '../test-support/symlink.js';
import { classifyPath, run } from '../lib/cli.js';
import { AllModelCommands } from '../lib/manifest.js';
import { SentinelModelAgent, SetForModelAgent } from '../lib/sentinel.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-doctor-leaf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const present of [false, true]) {
  it(`non-runtime classification refuses a ${present ? 'valid' : 'dangling'} symlink`, (t) => {
    const root = fixture(t);
    const target = join(root, 'target.md');
    const path = join(root, 'agent.md');
    if (present) writeFileSync(target, SentinelModelAgent);
    if (!symlinkOrSkip(t, target, path, 'file')) return;
    assert.equal(classifyPath(path, SetForModelAgent), 'foreign');
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(existsSync(target), present);
  });
}

it('doctor rejects an agent symlink that an actual install cannot replace', (t) => {
  const root = fixture(t);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    withHome(root, () => {
      assert.equal(run(['install']), 0);
      assert.equal(run(['doctor']), 0);
      const path = join(root, '.claude', 'agents', AllModelCommands[0].name + '.md');
      const target = join(root, 'agent-target.md');
      const original = readFileSync(path, 'utf8');
      writeFileSync(target, original);
      unlinkSync(path);
      if (!symlinkOrSkip(t, target, path, 'file')) return;
      assert.equal(run(['install', '--only', 'agents']), 1);
      assert.equal(run(['doctor']), 2);
      assert.ok(lstatSync(path).isSymbolicLink());
      assert.equal(readFileSync(target, 'utf8'), original);
    });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
});
