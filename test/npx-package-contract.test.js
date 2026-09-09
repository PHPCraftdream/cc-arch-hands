import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { AllSkills } from '../lib/manifest.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

it('one-shot npx examples and update notices use the package name, not its bin alias', () => {
  const { name } = JSON.parse(read('package.json'));
  const readme = read('README.md');
  for (const match of readme.matchAll(/^\s*npx\s+(\S+)/gm)) assert.equal(match[1], name);
  for (const skill of [...AllSkills, 'bins', 'commands', 'codex-agents']) {
    assert.ok(readme.includes(`npx ${name} install --only ${skill}`), skill);
  }
  assert.ok(read('CLAUDE.md').includes(`npx ${name} install --only`));
  assert.ok(read('bin/cah-stamp.js').includes(`npx ${name} reinstall`));
  for (const path of ['README.md', 'CLAUDE.md', 'bin/cah-stamp.js']) {
    assert.doesNotMatch(read(path), /\bnpx\s+cah\b/, path);
  }
});
