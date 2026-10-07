import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { OpencodeSkills } from '../lib/opencode-skills.js';
import { OpencodeCommands, OpencodeCommandRuntimeFiles } from '../lib/opencode-commands.js';
import { embeddedTemplates } from '../lib/templates.js';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const cli = join(worktree, 'bin', 'cah.js');

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-opencode-skills-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function call(home, ...rest) {
  const env = rest.length > 0 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])
    ? rest.shift() : {};
  return spawnSync(process.execPath, [cli, ...rest], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
  });
}

function ok(home, ...args) {
  const result = call(home, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

// Materialize a COMPLETE fixture tree: the nine opencode-skills plus every
// dependency tree the opencode-commands class needs (command templates and
// runtime leaves), since resolveDeps auto-adds opencode-commands.
function fixtureTemplates(home, transform = null) {
  const templates = embeddedTemplates();
  const root = join(home, 'fixtures-templates');
  const write = (kind, name, leaf, bytes) => {
    const dest = join(root, kind, name, leaf);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, bytes);
  };
  for (const name of OpencodeSkills) {
    for (const file of templates.skillTree(name, 'opencode-skills')) {
      write('opencode-skills', name, file.relPath, file.bytes);
    }
  }
  for (const name of OpencodeCommands) {
    for (const file of templates.skillTree(name, 'opencode-commands')) {
      write('opencode-commands', name, file.relPath, file.bytes);
    }
  }
  for (const file of templates.skillTree('scheduler', 'opencode-runtime')) {
    write('opencode-runtime', 'scheduler', file.relPath, file.bytes);
  }
  for (const file of templates.skillTree('plugin', 'opencode-runtime')) {
    write('opencode-runtime', 'plugin', file.relPath, file.bytes);
  }
  for (const file of templates.skillTree('ccheckpoint', 'codex-skills')) {
    write('codex-skills', 'ccheckpoint', file.relPath, file.bytes);
  }
  if (transform) transform(root);
  return root;
}

describe('OpenCode skill installer', () => {
  it('installs all nine skills with name+description frontmatter', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-skills');
    const root = join(home, '.config', 'opencode', 'skills');
    assert.deepEqual(readdirSync(root).sort(), [...OpencodeSkills].sort());
    for (const name of OpencodeSkills) {
      const body = readFileSync(join(root, name, 'SKILL.md'), 'utf8');
      assert.match(body, new RegExp(`^name: ${name}$`, 'm'));
      assert.match(body, /^description: "/m);
    }
  });

  it('preserves user extra files inside managed skills', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-skills');
    const dir = join(home, '.config', 'opencode', 'skills', 'checkpoint');
    writeFileSync(join(dir, 'my-notes.md'), 'user notes');
    ok(home, 'reinstall', '--opencode-skills');
    assert.equal(readFileSync(join(dir, 'my-notes.md'), 'utf8'), 'user notes');
    ok(home, 'uninstall', '--opencode-skills');
    assert.equal(readFileSync(join(dir, 'my-notes.md'), 'utf8'), 'user notes');
    assert.equal(existsSync(join(dir, 'SKILL.md')), false);
  });

  it('coexists with same-named commands: both artefacts installed', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode');
    for (const name of OpencodeSkills) {
      assert.equal(existsSync(join(home, '.config', 'opencode', 'skills', name, 'SKILL.md')), true, name);
      assert.equal(existsSync(join(home, '.config', 'opencode', 'commands', `${name}.md`)), true, name);
    }
  });

  it('standalone-class --templates install works with a complete fixture tree', (t) => {
    const home = sandbox(t);
    const templates = fixtureTemplates(home, (root) => {
      // prove the fixture (not the embedded tree) is what got installed
      const path = join(root, 'opencode-skills', 'triage', 'SKILL.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace('Inspect pending',
        'Inspect fixture pending'));
    });
    ok(home, 'install', '--opencode-skills', '--templates', templates);
    assert.match(readFileSync(join(home, '.config', 'opencode', 'skills', 'triage', 'SKILL.md'), 'utf8'),
      /Inspect fixture pending/);
    const rows = ok(home, 'list', '--json', '--opencode').stdout.trim()
      .split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(rows.filter((r) => r.kind === 'opencode-skill' && r.state === 'mine').length,
      OpencodeSkills.length);
  });

  it('a skills-only partial tree fails preflight without deleting anything', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-skills');
    const installed = readFileSync(
      join(home, '.config', 'opencode', 'skills', 'triage', 'SKILL.md'));
    const partial = join(home, 'partial-templates');
    mkdirSync(join(partial, 'opencode-skills', 'triage'), { recursive: true });
    writeFileSync(join(partial, 'opencode-skills', 'triage', 'SKILL.md'),
      '---\nname: triage\ndescription: "x"\n---\n\nbody\n');
    // opencode-skills auto-adds opencode-commands; its trees are missing here,
    // so the preflight must fail BEFORE the uninstall phase of reinstall.
    assert.equal(call(home, 'reinstall', '--opencode-skills', '--templates', partial).status, 1);
    assert.deepEqual(readFileSync(
      join(home, '.config', 'opencode', 'skills', 'triage', 'SKILL.md')), installed);
  });

  it('a foreign managed skill blocks nothing but is skipped; foreign runtime blocks install', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-skills');
    const skillPath = join(home, '.config', 'opencode', 'skills', 'triage', 'SKILL.md');
    writeFileSync(skillPath, 'foreign triage');
    // install still succeeds; the foreign skill is skipped, runtime untouched
    ok(home, 'install', '--opencode-skills');
    assert.equal(readFileSync(skillPath, 'utf8'), 'foreign triage');
    const scheduler = join(home, '.config', 'opencode', 'cah-opencode', 'cah-babysit-scheduler.js');
    const saved = readFileSync(scheduler);
    writeFileSync(scheduler, 'foreign scheduler');
    assert.equal(call(home, 'reinstall', '--opencode-skills').status, 1,
      'foreign runtime must block the auto-added opencode-commands class');
    assert.equal(readFileSync(scheduler, 'utf8'), 'foreign scheduler');
    writeFileSync(scheduler, saved);
  });

  it('installed skills carry no unresolved {{COMMIT_HELPER}} placeholders', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode');
    const skillRoot = join(home, '.config', 'opencode', 'skills');
    for (const name of OpencodeSkills) {
      const body = readFileSync(join(skillRoot, name, 'SKILL.md'), 'utf8');
      assert.ok(!body.includes('{{'), `${name} has an unresolved placeholder`);
    }
    const ccheckpoint = readFileSync(join(skillRoot, 'ccheckpoint', 'SKILL.md'), 'utf8');
    const helper = JSON.parse(ccheckpoint.match(/helper ("(?:\\.|[^"\\])*")/)[1]);
    assert.equal(helper, join(home, '.config', 'opencode', 'cah-opencode', 'commit-checkpoint.mjs').replaceAll('\\', '/'));
    const commandRoot = join(home, '.config', 'opencode', 'commands');
    for (const name of OpencodeCommands) {
      assert.ok(!readFileSync(join(commandRoot, `${name}.md`), 'utf8').includes('{{'));
    }
  });
});
