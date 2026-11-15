import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOmpCommands, OmpCommandRuntimeFiles } from '../lib/omp-commands.js';
import { prepareOpencodeCommands } from '../lib/opencode-commands.js';
import { writeOpencodeSkills } from '../lib/opencode-skills.js';
import { OpenCodeScope } from '../lib/opencode-scope.js';
import { embeddedTemplates } from '../lib/templates.js';

// `$&`, `$$` and `` $` `` mean something to String.replace: a path holding them
// must still reach the installed command text unchanged.
const AWKWARD = 'a$&b$$c$`d';

function project(t) {
  const dir = join(mkdtempSync(join(tmpdir(), 'cah-helper-path-')), AWKWARD);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(join(dir, '..'), { recursive: true, force: true }));
  return dir;
}

describe('the commit helper path in installed command texts', () => {
  it('OMP commands keep a path with replacement patterns', (t) => {
    const dir = project(t);
    const agentRoot = join(dir, 'agent');
    const files = prepareOmpCommands(embeddedTemplates(), { agentRoot: () => agentRoot });
    const helper = JSON.stringify(join(agentRoot, OmpCommandRuntimeFiles[0]));
    const body = files.find((file) => file.rel === 'commands/ccheckpoint.md').body;
    assert.ok(body.includes(helper), 'the helper path is in the command');
    assert.ok(!body.includes('{{COMMIT_HELPER}}'));
  });

  it('OpenCode commands keep a path with replacement patterns', (t) => {
    const dir = project(t);
    const scope = new OpenCodeScope({ global: false, cwd: dir });
    const files = prepareOpencodeCommands(embeddedTemplates(), scope);
    const helper = JSON.stringify(join(dir, '.opencode', 'cah-opencode', 'commit-checkpoint.mjs').replaceAll('\\', '/'));
    const body = files.find((file) => file.rel === 'commands/ccheckpoint.md').body;
    assert.ok(body.includes(helper), 'the helper path is in the command');
    assert.ok(!body.includes('{{COMMIT_HELPER}}'));
  });

  it('OpenCode skills keep a path with replacement patterns', (t) => {
    const dir = project(t);
    const scope = new OpenCodeScope({ global: false, cwd: dir });
    writeOpencodeSkills(embeddedTemplates(), scope);
    const body = readFileSync(join(dir, '.opencode', 'skills', 'ccheckpoint', 'SKILL.md'), 'utf8');
    const helper = JSON.stringify(join(dir, '.opencode', 'cah-opencode', 'commit-checkpoint.mjs').replaceAll('\\', '/'));
    assert.ok(body.includes(helper), 'the helper path is in the skill');
    assert.ok(!body.includes('{{COMMIT_HELPER}}'));
  });
});
