import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmdirSync, mkdtempSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { tmpDir, waitForPath, runSkillWorker } from './installer-test-helpers.js';
import { SentinelSkill } from '../lib/sentinel.js';
import { AllSkills } from '../lib/manifest.js';
import { Scope, SKILL_MANIFEST_LEAF } from '../lib/scope.js';
import { writeSkills, removeSkills } from '../lib/skills.js';
import { embeddedTemplates, diskTemplates } from '../lib/templates.js';

// ---------------------------------------------------------------------------
// WriteSkills
// ---------------------------------------------------------------------------

describe('writeSkills', { concurrency: false }, () => {
  it('canonicalizes a symlinked scope ancestor on first install', (t) => {
    const dir = tmpDir();
    const realScope = join(dir, 'real-scope');
    const linkedScope = join(dir, 'linked-scope');
    mkdirSync(realScope);
    try {
      symlinkSync(realScope, linkedScope, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const scope = new Scope({ cwd: linkedScope });
    writeSkills(embeddedTemplates(), scope, { subset: [AllSkills[0]] });
    assert.ok(existsSync(join(realScope, '.claude', 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
    assert.ok(existsSync(join(linkedScope, '.claude', 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
  });

  it('canonicalizes an existing symlinked .claude/skills root', (t) => {
    const dir = tmpDir();
    const realClaude = join(dir, 'real-claude');
    const linkedClaude = join(dir, '.claude');
    mkdirSync(realClaude);
    try {
      symlinkSync(realClaude, linkedClaude, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const scope = new Scope({ cwd: dir });
    writeSkills(embeddedTemplates(), scope, { subset: [AllSkills[0]] });
    assert.ok(existsSync(join(realClaude, 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
    assert.ok(existsSync(join(linkedClaude, 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
  });

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

  it('foreign selected skill with a user symlink safely skips write and removal', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    const link = join(destDir, 'user-link');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(destDir, SKILL_MANIFEST_LEAF), 'foreign manifest\n');
    writeFileSync(join(outside, 'data.txt'), 'outside data\n');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# managed template\n') },
      ],
    };

    assert.deepEqual(writeSkills(tpl, scope, { subset: [name] }).skipped, [name]);
    assert.deepEqual(removeSkills(tpl, scope, { subset: [name] }).skipped, [name]);
    assert.equal(readFileSync(join(destDir, SKILL_MANIFEST_LEAF), 'utf8'), 'foreign manifest\n');
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside data\n');
  });

  it('managed skill preserves a user-extra symlink across write and remove', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    const link = join(destDir, 'user-link');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(destDir, SKILL_MANIFEST_LEAF), `# old managed\n${SentinelSkill}\n`);
    writeFileSync(join(outside, 'data.txt'), 'outside data\n');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# current managed\n') },
      ],
    };

    const written = writeSkills(tpl, scope, { subset: [name] });
    assert.ok(written.preserved.includes(`${name}/user-link`));
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside data\n');

    const removed = removeSkills(tpl, scope, { subset: [name] });
    assert.deepEqual(removed.preserved, [name]);
    assert.ok(!existsSync(join(destDir, SKILL_MANIFEST_LEAF)));
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside data\n');
  });

  it('subset install ignores an unrelated foreign skill containing a symlink', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const [selected, unrelated] = AllSkills;
    const unrelatedDir = join(dir, '.claude', 'skills', unrelated);
    const outside = join(dir, 'outside');
    mkdirSync(unrelatedDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(unrelatedDir, SKILL_MANIFEST_LEAF), 'foreign manifest\n');
    try {
      symlinkSync(
        outside,
        join(unrelatedDir, 'user-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# selected\n') },
      ],
    };

    const result = writeSkills(tpl, scope, { subset: [selected] });
    assert.equal(result.written, 1);
    assert.ok(existsSync(join(dir, '.claude', 'skills', selected, SKILL_MANIFEST_LEAF)));
    assert.equal(readFileSync(join(unrelatedDir, SKILL_MANIFEST_LEAF), 'utf8'), 'foreign manifest\n');
  });

  it('prunes orphan skill directories whose names are no longer in the manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();

    const skillsDir = join(dir, '.claude', 'skills');
    const orphanMineDir = join(skillsDir, 'oldskill');
    mkdirSync(orphanMineDir, { recursive: true });
    writeFileSync(join(orphanMineDir, SKILL_MANIFEST_LEAF), `# old skill\n${SentinelSkill}\n`);

    const orphanForeignDir = join(skillsDir, 'foreignskill');
    mkdirSync(orphanForeignDir, { recursive: true });
    writeFileSync(join(orphanForeignDir, SKILL_MANIFEST_LEAF), 'not ours');

    const { written, skipped, pruned } = writeSkills(tpl, scope);
    assert.equal(written, AllSkills.length);
    assert.deepEqual(skipped, []);
    assert.equal(pruned, 1, 'mine orphan dir removed, foreign preserved');

    assert.throws(() => statSync(orphanMineDir), { code: 'ENOENT' });
    assert.equal(readFileSync(join(orphanForeignDir, SKILL_MANIFEST_LEAF), 'utf8'), 'not ours');
  });

  it('preserves legacy agent-tree skills for migration by the standalone package', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const legacySentinel = '<!-- cah-agent-tree:v1 -->';

    for (const name of ['agent', 'agent-new']) {
      const legacyDir = join(skillsDir, name);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, SKILL_MANIFEST_LEAF), `# ${name}\n${legacySentinel}\n`);
      writeFileSync(join(legacyDir, 'legacy-asset.txt'), `${name} data\n`);
    }

    const { pruned } = writeSkills(embeddedTemplates(), scope);
    assert.equal(pruned, 0, 'legacy agent-tree dirs belong to the standalone package');

    for (const name of ['agent', 'agent-new']) {
      const legacyDir = join(skillsDir, name);
      assert.equal(
        readFileSync(join(legacyDir, SKILL_MANIFEST_LEAF), 'utf8'),
        `# ${name}\n${legacySentinel}\n`,
      );
      assert.equal(readFileSync(join(legacyDir, 'legacy-asset.txt'), 'utf8'), `${name} data\n`);
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

  it('rejects duplicate relPaths before writing any skill files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# first\n') },
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# duplicate\n') },
      ],
    };

    assert.throws(
      () => writeSkills(tpl, scope, { subset: [name] }),
      /duplicate template relPath SKILL\.md/,
    );
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('rejects path escapes before the outside victim can change', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'must survive\n');

    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: '../../../victim.txt', bytes: Buffer.from('pwned\n') },
      ],
    };

    assert.throws(() => writeSkills(tpl, scope, { subset: [name] }), /invalid segment|escapes/i);
    assert.equal(readFileSync(victim, 'utf8'), 'must survive\n');
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('rejects absolute, device, mixed-separator, alias, and reserved paths', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const badPaths = [
      '/absolute.txt',
      'C:/absolute.txt',
      '//server/share/absolute.txt',
      '//?/C:/device.txt',
      'nested\\mixed/file.txt',
      'nested//empty.txt',
      './dot.txt',
      'nested/../escape.txt',
      'alias./file.txt',
      'alias /file.txt',
      'CON.txt',
      'nested/NUL',
      `nul\0byte.txt`,
    ];

    for (const relPath of badPaths) {
      const files = [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath, bytes: Buffer.from('bad\n') },
      ];
      assert.throws(
        () => writeSkills({ skillTree: () => files }, scope, { subset: [name] }),
        /relative|invalid segment|mixed separators|Windows separators|NUL|alias|device|escapes/i,
        relPath,
      );
    }
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('rejects malformed template bytes and validates all selected trees first', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const [first, second] = AllSkills;
    const trees = new Map([
      [first, [{ relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# first\n') }]],
      [second, [{ relPath: SKILL_MANIFEST_LEAF, bytes: 'not bytes' }]],
    ]);

    assert.throws(
      () => writeSkills({ skillTree: (name) => trees.get(name) }, scope, {
        subset: [first, second],
      }),
      /bytes must be Buffer or Uint8Array/,
    );
    assert.ok(!existsSync(join(dir, '.claude', 'skills', first, SKILL_MANIFEST_LEAF)));
  });

  it('rejects case-insensitive file and directory-prefix collisions', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const collisionTrees = [
      [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/readme.txt', bytes: Buffer.from('one\n') },
        { relPath: 'ASSETS/README.TXT', bytes: Buffer.from('two\n') },
      ],
      [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets', bytes: Buffer.from('file\n') },
        { relPath: 'assets/data.txt', bytes: Buffer.from('child\n') },
      ],
    ];
    for (const files of collisionTrees) {
      assert.throws(
        () => writeSkills({ skillTree: () => files }, scope, { subset: [name] }),
        /colliding template relPath/,
      );
    }
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('does not follow a symlink or junction directory outside the skill root', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);

    try {
      symlinkSync(outside, join(destDir, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/payload.txt', bytes: Buffer.from('must not escape\n') },
      ],
    };
    assert.throws(
      () => writeSkills(tpl, scope, { subset: [name] }),
      /symlink|junction|reparse|not a directory/i,
    );
    assert.ok(!existsSync(join(outside, 'payload.txt')));
  });

  it('accepts a valid multi-file skill tree with an exact root manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const tplRoot = tmpDir();
    const skillRoot = join(tplRoot, 'skills', name);
    mkdirSync(join(skillRoot, 'assets'), { recursive: true });
    writeFileSync(join(skillRoot, SKILL_MANIFEST_LEAF), '# multi-file skill\n');
    writeFileSync(join(skillRoot, 'assets', 'guide.txt'), 'companion data\n');

    const { written, skipped } = writeSkills(
      diskTemplates(tplRoot), scope, { subset: [name] },
    );
    assert.equal(written, 1);
    assert.deepEqual(skipped, []);
    assert.ok(readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8')
      .includes(SentinelSkill));
    assert.equal(
      readFileSync(join(dir, '.claude', 'skills', name, 'assets', 'guide.txt'), 'utf8'),
      'companion data\n',
    );
  });

  it('rejects lowercase or nested manifest paths even when they are the only manifests', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    for (const files of [
      [{ relPath: 'skill.md', bytes: Buffer.from('lowercase\n') }],
      [{ relPath: 'foo/SKILL.md', bytes: Buffer.from('nested\n') }],
    ]) {
      assert.throws(
        () => writeSkills({ skillTree: () => files }, scope, { subset: [name] }),
        /exactly one root SKILL\.md/,
      );
    }
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('fails closed when a managed skill ancestor is replaced before owned write', async (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside-write-victim');
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'write-ancestor-replacement-interlock');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(manifest, `${SentinelSkill}\n`);
    writeFileSync(join(outside, SKILL_MANIFEST_LEAF), 'outside must survive\n');

    try {
      const probe = join(dir, 'directory-link-probe');
      symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
      unlinkSync(probe);
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const running = runSkillWorker('write', dir, interlock, 'write-before-owned-write');
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    rmdirSync(destDir);
    symlinkSync(outside, destDir, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(`${interlock}.go`, 'go');

    await assert.rejects(
      running,
      /managed (skill parent|destination parent) changed concurrently|refusing operation/,
    );
    assert.equal(readFileSync(join(outside, SKILL_MANIFEST_LEAF), 'utf8'), 'outside must survive\n');
    assert.equal(readFileSync(manifest, 'utf8'), 'outside must survive\n');
  });

  it('fails closed when the manifest leaf is replaced before atomic publication', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'write-leaf-replacement-interlock');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(manifest, `${SentinelSkill}\n`);

    const running = runSkillWorker('write', dir, interlock, 'write-before-rename', [name]);
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    writeFileSync(manifest, 'foreign successor\n');
    writeFileSync(`${interlock}.go`, 'go');

    await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(manifest, 'utf8'), 'foreign successor\n');
    assert.deepEqual(
      readdirSync(destDir).filter((entry) => entry.includes('.cah-tmp-')),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// RemoveSkills
// ---------------------------------------------------------------------------


