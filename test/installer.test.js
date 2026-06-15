import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SentinelModelCommand, SentinelModelAgent, SentinelSkill,
  LegacyModelCommand, LegacyModelAgent,
  SetForModelCommand, SetForModelAgent, SetForSkill,
  Ownership, classifyContent,
} from '../lib/sentinel.js';
import { AllModelCommands, AllSkills } from '../lib/manifest.js';
import { Scope, StrictMissingRootError, SKILL_MANIFEST_LEAF } from '../lib/scope.js';
import { writeModelCommands, removeModelCommands } from '../lib/commands.js';
import { writeModelAgents, removeModelAgents } from '../lib/agents.js';
import { writeSkills, removeSkills } from '../lib/skills.js';
import { embeddedTemplates, diskTemplates } from '../lib/templates.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cah-test-'));
}

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

describe('classifyContent', () => {
  it('missing', () => {
    assert.equal(classifyContent(false, null, SetForModelCommand), Ownership.missing);
  });

  it('empty content present is foreign', () => {
    assert.equal(classifyContent(true, '', SetForModelCommand), Ownership.foreign);
  });

  it('new sentinel only is mine', () => {
    const body = `hello\n${SentinelModelCommand}\n`;
    assert.equal(classifyContent(true, body, SetForModelCommand), Ownership.mine);
  });

  it('legacy sentinel only is legacy', () => {
    const body = `hello\n${LegacyModelCommand}\n`;
    assert.equal(classifyContent(true, body, SetForModelCommand), Ownership.legacy);
  });

  it('both new and legacy yields legacy', () => {
    const body = `${SentinelModelCommand}\n${LegacyModelCommand}\n`;
    assert.equal(classifyContent(true, body, SetForModelCommand), Ownership.legacy);
  });

  it('empty-New set legacy match is legacy', () => {
    const set = { current: '', legacy: [LegacyModelCommand] };
    const body = `preamble\n${LegacyModelCommand}\n`;
    assert.equal(classifyContent(true, body, set), Ownership.legacy);
  });

  it('empty-New set no legacy match is foreign', () => {
    const set = { current: '', legacy: [LegacyModelCommand] };
    assert.equal(classifyContent(true, 'no marker', set), Ownership.foreign);
  });
});

// ---------------------------------------------------------------------------
// WriteModelCommands
// ---------------------------------------------------------------------------

describe('writeModelCommands', () => {
  it('empty dir installs all', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const { written, skipped } = writeModelCommands(null, scope);

    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const cmdDir = join(dir, '.claude', 'commands');
    const entries = readdirSync(cmdDir).filter((f) => f.endsWith('.md'));
    assert.equal(entries.length, AllModelCommands.length);

    for (const name of ['o47h', 'fh']) {
      const data = readFileSync(join(cmdDir, `${name}.md`), 'utf8');
      assert.ok(data.endsWith(`${SentinelModelCommand}\n`), `${name} must end with sentinel`);
      const mc = AllModelCommands.find((c) => c.name === name);
      assert.ok(data.includes(`description: ${mc.model} effort=${mc.effort}`));
    }
  });

  it('re-run is idempotent', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);
    const { written, skipped } = writeModelCommands(null, scope);

    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const cmdDir = join(dir, '.claude', 'commands');
    const entries = readdirSync(cmdDir).filter((f) => f.endsWith('.md'));
    assert.equal(entries.length, AllModelCommands.length);
  });

  it('foreign file is preserved and skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const foreignPath = join(cmdDir, 'o47x.md');
    const foreignBody = 'someone else owns this';
    writeFileSync(foreignPath, foreignBody);

    const { written, skipped } = writeModelCommands(null, scope);
    assert.equal(written, AllModelCommands.length - 1);
    assert.deepEqual(skipped, [foreignPath]);

    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
    statSync(join(cmdDir, 'o47h.md'));
  });

  it('legacy file is migrated', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const legacyPath = join(cmdDir, 'o47h.md');
    writeFileSync(legacyPath, `---\ndescription: stale\n---\n\nold body\n${LegacyModelCommand}\n`);

    const { skipped } = writeModelCommands(null, scope);
    assert.deepEqual(skipped, []);

    const data = readFileSync(legacyPath, 'utf8');
    assert.ok(data.includes(SentinelModelCommand), 'must be stamped with new sentinel');
    assert.ok(!data.includes(LegacyModelCommand), 'legacy sentinel must be gone');
  });
});

// ---------------------------------------------------------------------------
// RemoveModelCommands
// ---------------------------------------------------------------------------

describe('removeModelCommands', () => {
  it('all mine are removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);

    const { removed, skipped } = removeModelCommands(scope);
    assert.equal(removed, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const cmdDir = join(dir, '.claude', 'commands');
    assert.equal(readdirSync(cmdDir).length, 0);
  });

  it('mixed mine legacy foreign missing', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const minePath = join(cmdDir, 'o47h.md');
    writeFileSync(minePath, `x\n${SentinelModelCommand}\n`);
    const legacyPath = join(cmdDir, 'o47m.md');
    writeFileSync(legacyPath, `y\n${LegacyModelCommand}\n`);
    const foreignPath = join(cmdDir, 'o47l.md');
    const foreignBody = 'not yours';
    writeFileSync(foreignPath, foreignBody);

    const { removed, skipped } = removeModelCommands(scope);
    assert.equal(removed, 2);
    assert.deepEqual(skipped, [foreignPath]);

    assert.throws(() => statSync(minePath), { code: 'ENOENT' });
    assert.throws(() => statSync(legacyPath), { code: 'ENOENT' });
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });
});

// ---------------------------------------------------------------------------
// WriteModelAgents
// ---------------------------------------------------------------------------

describe('writeModelAgents', () => {
  it('empty dir installs all', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const { written, skipped } = writeModelAgents(null, scope);

    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const agentsDir = join(dir, '.claude', 'agents');
    for (const mc of AllModelCommands) {
      const data = readFileSync(join(agentsDir, `a${mc.name}.md`), 'utf8');
      assert.ok(data.includes(`name: a${mc.name}`));
      assert.ok(data.includes(`model: ${mc.model}`));
      assert.ok(data.includes('Git safety'));
      assert.ok(data.includes('Test scope'));
      assert.ok(data.endsWith(`${SentinelModelAgent}\n`), `agent ${mc.name} must end with sentinel`);
    }
  });

  it('legacy is migrated', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const legacyPath = join(agentsDir, 'ao47h.md');
    writeFileSync(legacyPath, `old\n${LegacyModelAgent}\n`);

    const { skipped } = writeModelAgents(null, scope);
    assert.deepEqual(skipped, []);

    const data = readFileSync(legacyPath, 'utf8');
    assert.ok(data.includes(SentinelModelAgent));
    assert.ok(!data.includes(LegacyModelAgent));
  });

  it('foreign is preserved and skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const foreignPath = join(agentsDir, 'ao47h.md');
    const foreignBody = "someone else's agent";
    writeFileSync(foreignPath, foreignBody);

    const { written, skipped } = writeModelAgents(null, scope);
    assert.equal(written, AllModelCommands.length - 1);
    assert.deepEqual(skipped, [foreignPath]);
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });
});

// ---------------------------------------------------------------------------
// RemoveModelAgents
// ---------------------------------------------------------------------------

describe('removeModelAgents', () => {
  it('all mine are removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelAgents(null, scope);

    const { removed, skipped } = removeModelAgents(scope);
    assert.equal(removed, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const agentsDir = join(dir, '.claude', 'agents');
    assert.equal(readdirSync(agentsDir).length, 0);
  });

  it('mixed mine legacy foreign missing', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const minePath = join(agentsDir, 'ao47h.md');
    writeFileSync(minePath, `x\n${SentinelModelAgent}\n`);
    const legacyPath = join(agentsDir, 'ao47m.md');
    writeFileSync(legacyPath, `y\n${LegacyModelAgent}\n`);
    const foreignPath = join(agentsDir, 'ao47l.md');
    const foreignBody = 'not yours';
    writeFileSync(foreignPath, foreignBody);

    const { removed, skipped } = removeModelAgents(scope);
    assert.equal(removed, 2);
    assert.deepEqual(skipped, [foreignPath]);
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });
});

// ---------------------------------------------------------------------------
// WriteSkills
// ---------------------------------------------------------------------------

describe('writeSkills', () => {
  it('embedded smoke install', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();

    const { written, skipped } = writeSkills(tpl, scope);
    assert.equal(written, AllSkills.length);
    assert.deepEqual(skipped, []);

    for (const name of AllSkills) {
      const data = readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8');
      assert.ok(data.includes(SentinelSkill));
    }
  });

  it('re-run is idempotent and does not double-stamp', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();

    writeSkills(tpl, scope);
    const { written, skipped } = writeSkills(tpl, scope);
    assert.equal(written, AllSkills.length);
    assert.deepEqual(skipped, []);

    for (const name of AllSkills) {
      const data = readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8');
      const count = data.split(SentinelSkill).length - 1;
      assert.equal(count, 1, `sentinel must appear exactly once, got ${count}`);
    }
  });

  it('foreign skill is skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const tplRoot = tmpDir();
    const skillDir = join(tplRoot, 'skills', 'mytestskill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# my skill\n');
    const tpl = diskTemplates(tplRoot);

    const origSkills = [...AllSkills];
    AllSkills.length = 0;
    AllSkills.push('mytestskill');

    try {
      const destSkill = join(dir, '.claude', 'skills', 'mytestskill');
      mkdirSync(destSkill, { recursive: true });
      const foreignBody = 'someone else owns this skill';
      writeFileSync(join(destSkill, SKILL_MANIFEST_LEAF), foreignBody);

      const { written, skipped } = writeSkills(tpl, scope);
      assert.equal(written, 0);
      assert.deepEqual(skipped, ['mytestskill']);
      assert.equal(readFileSync(join(destSkill, SKILL_MANIFEST_LEAF), 'utf8'), foreignBody);
    } finally {
      AllSkills.length = 0;
      AllSkills.push(...origSkills);
    }
  });

  it('source SKILL.md already stamped is copied verbatim', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const tplRoot = tmpDir();
    const skillDir = join(tplRoot, 'skills', 'prestamped');
    mkdirSync(skillDir, { recursive: true });
    const stamped = `# pre-stamped skill\n\nbody\n\n${SentinelSkill}\n`;
    writeFileSync(join(skillDir, 'SKILL.md'), stamped);
    const tpl = diskTemplates(tplRoot);

    const origSkills = [...AllSkills];
    AllSkills.length = 0;
    AllSkills.push('prestamped');

    try {
      const { written, skipped } = writeSkills(tpl, scope);
      assert.equal(written, 1);
      assert.deepEqual(skipped, []);

      const got = readFileSync(join(dir, '.claude', 'skills', 'prestamped', SKILL_MANIFEST_LEAF), 'utf8');
      assert.equal(got, stamped);
    } finally {
      AllSkills.length = 0;
      AllSkills.push(...origSkills);
    }
  });
});

// ---------------------------------------------------------------------------
// RemoveSkills
// ---------------------------------------------------------------------------

describe('removeSkills', () => {
  it('mine removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const { removed, skipped } = removeSkills(scope);
    assert.equal(removed, AllSkills.length);
    assert.deepEqual(skipped, []);

    for (const name of AllSkills) {
      assert.throws(() => statSync(join(dir, '.claude', 'skills', name)), { code: 'ENOENT' });
    }
  });

  it('foreign kept and recorded', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const origSkills = [...AllSkills];
    AllSkills.length = 0;
    AllSkills.push('foreignskill');

    try {
      const destDir = join(dir, '.claude', 'skills', 'foreignskill');
      mkdirSync(destDir, { recursive: true });
      const foreignBody = 'not ours';
      writeFileSync(join(destDir, SKILL_MANIFEST_LEAF), foreignBody);

      const { removed, skipped } = removeSkills(scope);
      assert.equal(removed, 0);
      assert.deepEqual(skipped, ['foreignskill']);
      assert.equal(readFileSync(join(destDir, SKILL_MANIFEST_LEAF), 'utf8'), foreignBody);
    } finally {
      AllSkills.length = 0;
      AllSkills.push(...origSkills);
    }
  });

  it('missing is no-op', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const { removed, skipped } = removeSkills(scope);
    assert.equal(removed, 0);
    assert.deepEqual(skipped, []);
  });
});

// ---------------------------------------------------------------------------
// Strict scope
// ---------------------------------------------------------------------------

describe('strict scope', () => {
  it('missing .claude with strict throws StrictMissingRootError', () => {
    const dir = tmpDir();
    const scope = new Scope({ strict: true, cwd: dir });

    assert.throws(() => scope.resolveCommandsDir(), (e) => e instanceof StrictMissingRootError);
    assert.throws(() => scope.resolveAgentsDir(), (e) => e instanceof StrictMissingRootError);
    assert.throws(() => scope.resolveSkillsDir(), (e) => e instanceof StrictMissingRootError);
  });

  it('existing .claude with strict resolves cleanly', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.claude'));
    const scope = new Scope({ strict: true, cwd: dir });

    assert.equal(scope.resolveCommandsDir(), join(dir, '.claude', 'commands'));
  });

  it('.claude exists as a file, not a dir — strict refuses', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.claude'), 'not a dir');
    const scope = new Scope({ strict: true, cwd: dir });

    assert.throws(() => scope.resolveCommandsDir(), (e) => e instanceof StrictMissingRootError);
  });

  it('non-strict default ignores missing .claude', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    assert.equal(scope.resolveCommandsDir(), join(dir, '.claude', 'commands'));
  });

  it('writeModelCommands under strict refuses when .claude missing', () => {
    const dir = tmpDir();
    const scope = new Scope({ strict: true, cwd: dir });

    assert.throws(() => writeModelCommands(null, scope), (e) => e instanceof StrictMissingRootError);
  });

  it('writeModelCommands under strict succeeds when .claude exists', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.claude'));
    const scope = new Scope({ strict: true, cwd: dir });

    const { written, skipped } = writeModelCommands(null, scope);
    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);
  });

  it('describe reflects strict mode', () => {
    const desc = new Scope({ strict: true, cwd: '/tmp/x' }).describe();
    assert.ok(desc.includes('local-strict'));
    assert.ok(desc.includes('/tmp/x'));
  });
});
