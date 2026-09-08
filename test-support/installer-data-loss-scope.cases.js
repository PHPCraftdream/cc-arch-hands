import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, mkdirSync, openSync, writeSync, utimesSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmdirSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { tmpDir, waitForPath, runSkillWorker } from './installer-test-helpers.js';
import { runWorker } from './process-batches.js';
import { SentinelSkill } from '../lib/sentinel.js';
import { AllModelCommands, AllSkills } from '../lib/manifest.js';
import { Scope, StrictMissingRootError, SKILL_MANIFEST_LEAF } from '../lib/scope.js';
import { writeModelCommands } from '../lib/commands.js';
import { writeSkills, removeSkills } from '../lib/skills.js';
import { embeddedTemplates } from '../lib/templates.js';


// ---------------------------------------------------------------------------
// RemoveSkills
// ---------------------------------------------------------------------------

describe('removeSkills', { concurrency: false }, () => {
  it('mine removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const { removed, skipped } = removeSkills(tpl, scope);
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

      const { removed, skipped } = removeSkills(embeddedTemplates(), scope);
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

    const { removed, skipped } = removeSkills(embeddedTemplates(), scope);
    assert.equal(removed, 0);
    assert.deepEqual(skipped, []);
  });

  it('preserves the original ownership decision when the manifest is replaced before capture', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'remove-manifest-capture-interlock');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(manifest, `original A\n${SentinelSkill}\n`);

    const running = runSkillWorker(
      'remove',
      dir,
      interlock,
      'remove-before-owned-capture',
      [name],
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    writeFileSync(manifest, `successor B\n${SentinelSkill}\n`);
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.removed, 0);
    assert.deepEqual(result.preserved, [name]);
    assert.equal(readFileSync(manifest, 'utf8'), `successor B\n${SentinelSkill}\n`);
  });

  it('rejects an unvalidated relPath escape without deleting the victim', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const [first, second] = AllSkills;
    const firstManifest = join(dir, '.claude', 'skills', first, SKILL_MANIFEST_LEAF);
    const destDir = join(dir, '.claude', 'skills', second);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const victim = join(dir, 'victim.txt');
    mkdirSync(join(dir, '.claude', 'skills', first), { recursive: true });
    mkdirSync(destDir, { recursive: true });
    writeFileSync(firstManifest, `# first managed\n${SentinelSkill}\n`);
    writeFileSync(manifest, `# managed\n${SentinelSkill}\n`);
    writeFileSync(victim, 'must not be deleted\n');
    const tpl = {
      skillTree: (name) => name === first
        ? [{ relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# first\n') }]
        : [
          { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# second\n') },
          { relPath: '../../../victim.txt', bytes: Buffer.from('victim\n') },
        ],
    };

    assert.throws(
      () => removeSkills(tpl, scope, { subset: [first, second] }),
      /invalid segment|escapes/i,
    );
    assert.equal(readFileSync(victim, 'utf8'), 'must not be deleted\n');
    assert.ok(existsSync(firstManifest));
    assert.ok(existsSync(manifest));
  });

  it('rejects a symlink or junction traversal before removing anything', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    const outsideFile = join(outside, 'owned.txt');
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(manifest, `# managed\n${SentinelSkill}\n`);
    writeFileSync(outsideFile, 'outside stays\n');

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
        { relPath: 'assets/owned.txt', bytes: Buffer.from('owned\n') },
      ],
    };
    assert.throws(
      () => removeSkills(tpl, scope, { subset: [name] }),
      /symlink|junction|reparse|not a directory/i,
    );
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside stays\n');
    assert.ok(existsSync(manifest));
  });

  it('removes valid nested owned files while preserving user data', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const owned = join(destDir, 'assets', 'owned.txt');
    const userFile = join(destDir, 'notes.txt');
    mkdirSync(join(destDir, 'assets'), { recursive: true });
    writeFileSync(manifest, `# managed\n${SentinelSkill}\n`);
    writeFileSync(owned, 'owned\n');
    writeFileSync(userFile, 'keep\n');
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/owned.txt', bytes: new Uint8Array([1, 2, 3]) },
      ],
    };

    const result = removeSkills(tpl, scope, { subset: [name] });
    assert.equal(result.removed, 0);
    assert.deepEqual(result.preserved, [name]);
    assert.ok(!existsSync(manifest));
    assert.ok(!existsSync(owned));
    assert.equal(readFileSync(userFile, 'utf8'), 'keep\n');
  });
});

// ---------------------------------------------------------------------------
// Skill data-loss protection (review H1/H2/M5)
// ---------------------------------------------------------------------------

describe('skill data-loss protection', { concurrency: false }, () => {
  it('writeSkills preserves user files dropped into a managed skill dir', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const name = AllSkills[0];
    const userFile = join(dir, '.claude', 'skills', name, 'my-notes.md');
    writeFileSync(userFile, 'my private notes');

    const { preserved } = writeSkills(tpl, scope); // reinstall
    assert.equal(readFileSync(userFile, 'utf8'), 'my private notes');
    assert.ok(preserved.includes(`${name}/my-notes.md`));
    // the manifest is still rewritten (and stamped) alongside
    const manifest = readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8');
    assert.ok(manifest.includes(SentinelSkill));
  });

  it('removeSkills keeps user files, removing only our manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const name = AllSkills[0];
    const userFile = join(dir, '.claude', 'skills', name, 'keep.md');
    writeFileSync(userFile, 'keep me');

    const { removed, preserved } = removeSkills(tpl, scope);
    assert.ok(preserved.includes(name));
    // the skill with user data is reported under preserved, not removed
    assert.equal(removed, AllSkills.length - 1);
    assert.equal(readFileSync(userFile, 'utf8'), 'keep me');
    assert.throws(
      () => statSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)),
      { code: 'ENOENT' },
    );
  });

  it('reports recovery when the canonical SKILL.md is missing', () => {
    const name = AllSkills[0];
    const removeRoot = tmpDir();
    const removeDir = join(removeRoot, '.claude', 'skills', name);
    const removePayload = join(removeDir, `${SKILL_MANIFEST_LEAF}.cah-owned-remove`, 'payload');
    mkdirSync(join(removeDir, `${SKILL_MANIFEST_LEAF}.cah-owned-remove`), { recursive: true });
    writeFileSync(removePayload, 'recovery from remove\n');
    const removeResult = removeSkills(embeddedTemplates(), new Scope({ cwd: removeRoot }), {
      subset: [name],
    });
    const relativePayload = `${name}/${SKILL_MANIFEST_LEAF}.cah-owned-remove/payload`;
    assert.deepEqual(removeResult.recovery, [relativePayload]);
    assert.ok(!removeResult.preserved.includes(relativePayload));

    const writeRoot = tmpDir();
    const writeDir = join(writeRoot, '.claude', 'skills', name);
    const writeQuarantine = join(writeDir, `${SKILL_MANIFEST_LEAF}.cah-owned-remove`);
    mkdirSync(writeQuarantine, { recursive: true });
    writeFileSync(join(writeQuarantine, 'payload'), 'recovery from write\n');
    const writeResult = writeSkills(embeddedTemplates(), new Scope({ cwd: writeRoot }), {
      subset: [name],
    });
    assert.deepEqual(writeResult.recovery, [relativePayload]);
    assert.ok(!writeResult.preserved.includes(relativePayload));
  });

  // Probes, rather than assumes by platform, whether this filesystem lets a
  // sub-second mtime survive the exact round trip the test below performs
  // (read mtimeNs as a BigInt, convert through Number/1e9, write it back via
  // utimesSync). NTFS's coarser mtime resolution makes this round trip land
  // on the same value; a genuine nanosecond-resolution filesystem (ext4) can
  // lose a few hundred nanoseconds in the BigInt-to-Number conversion alone,
  // which the codebase's exact BigInt identity comparison then reports as a
  // changed file. Neither side is a bug — utimesSync's public API cannot
  // carry more than double precision, so this specific repro technique is
  // inherently unreliable wherever the filesystem actually stores what it
  // is given.
  function mtimeRoundTripIsExact() {
    const dir = tmpDir();
    const probe = join(dir, 'mtime-probe.txt');
    writeFileSync(probe, 'x');
    const fixedTime = 1700000000.123;
    utimesSync(probe, fixedTime, fixedTime);
    const before = statSync(probe, { bigint: true });
    utimesSync(probe, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
    const after = statSync(probe, { bigint: true });
    return before.mtimeNs === after.mtimeNs;
  }

  it('preserves a same-inode orphan mutation with restored metadata', async (t) => {
    if (!mtimeRoundTripIsExact()) {
      t.skip('nanosecond mtime restoration is not deterministic on this filesystem');
      return;
    }
    const dir = tmpDir();
    const orphan = join(dir, 'orphan-skill.md');
    const original = `${SentinelSkill}\nowned body\n`;
    const successor = `${SentinelSkill}\nalien body\n`;
    writeFileSync(orphan, original);
    const fixedTime = 1700000000.123;
    utimesSync(orphan, fixedTime, fixedTime);
    const before = statSync(orphan, { bigint: true });
    const interlock = join(dir, 'orphan-prune-interlock');
    const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
    const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        process.env.CAH_TEST_ONLY = '1';
        const { makeInterlock } = await import(workerData.hooksUrl);
        const testInterlock = makeInterlock({ ...process.env,
          CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
          CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'prune-before-remove',
        });
        const fsutil = await import(workerData.fsutilUrl);
        const { SetForSkill } = await import(workerData.sentinelUrl);
        const result = fsutil.pruneOrphans(workerData.dir, new Set(), SetForSkill, { testInterlock });
        parentPort.postMessage(result);
      })().catch((error) => { setImmediate(() => { throw error; }); });
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        dir, interlock, fsutilUrl,
        sentinelUrl: new URL('../lib/sentinel.js', import.meta.url).href, hooksUrl,
      },
    });
    const resultPromise = runWorker(worker, { label: 'orphan prune worker' });
    await waitForPath(`${interlock}.ready`);
    const fd = openSync(orphan, 'r+');
    writeSync(fd, Buffer.from(successor), 0, Buffer.byteLength(successor), 0);
    closeSync(fd);
    chmodSync(orphan, Number(before.mode & 0o7777n));
    utimesSync(orphan, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await resultPromise;
    const recovery = join(`${orphan}.cah-owned-remove`, 'payload');
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.recovery, [recovery]);
    assert.equal(existsSync(orphan), false);
    assert.equal(readFileSync(recovery, 'utf8'), successor);
  });

  it('pruneOrphanDirs spares a copied skill dir that holds extra user files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    // Simulate `cp -r ~/.claude/skills/<x> ~/.claude/skills/my-custom-copy`
    // followed by the user adding their own file.
    const copyDir = join(dir, '.claude', 'skills', 'my-custom-copy');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, SKILL_MANIFEST_LEAF), `# copy\n${SentinelSkill}\n`);
    writeFileSync(join(copyDir, 'extra.md'), 'user data');

    const { preserved, pruned } = writeSkills(tpl, scope);
    assert.equal(pruned, 0);
    assert.ok(preserved.some((p) => p.startsWith('my-custom-copy')));
    assert.equal(readFileSync(join(copyDir, 'extra.md'), 'utf8'), 'user data');
  });

  it('pruneOrphanDirs preserves an orphan with a user symlink without following it', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const orphanDir = join(skillsDir, 'orphan-with-link');
    const outside = join(dir, 'outside');
    const link = join(orphanDir, 'user-link');
    mkdirSync(orphanDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(orphanDir, SKILL_MANIFEST_LEAF), `# orphan\n${SentinelSkill}\n`);
    writeFileSync(join(outside, 'data.txt'), 'outside stays\n');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const result = writeSkills(embeddedTemplates(), scope);
    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('orphan-with-link')));
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside stays\n');
  });

  it('pruneOrphanDirs preserves an orphan containing an empty user directory', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const orphanDir = join(dir, '.claude', 'skills', 'orphan-with-empty-dir');
    const emptyDir = join(orphanDir, 'empty-user-dir');
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(orphanDir, SKILL_MANIFEST_LEAF), `# orphan\n${SentinelSkill}\n`);

    const result = writeSkills(embeddedTemplates(), scope);
    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('orphan-with-empty-dir')));
    assert.ok(statSync(emptyDir).isDirectory());
    assert.deepEqual(readdirSync(emptyDir), []);
  });

  it('pruneOrphanDirs preserves an entry appearing before final rmdir', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const orphanDir = join(skillsDir, 'race-orphan');
    const interlock = join(dir, 'prune-final-rmdir-interlock');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, SKILL_MANIFEST_LEAF), `# orphan\n${SentinelSkill}\n`);

    const running = runSkillWorker('write', dir, interlock, 'prune-before-rmdir');
    await waitForPath(`${interlock}.ready`);
    const userFile = join(orphanDir, 'user-created-during-prune.txt');
    writeFileSync(userFile, 'must survive\n');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('race-orphan')));
    assert.equal(readFileSync(userFile, 'utf8'), 'must survive\n');
  });

  it('pruneOrphanDirs preserves a manifest replaced by a symlink after validation', async (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const orphanDir = join(skillsDir, 'replacement-orphan');
    const manifest = join(orphanDir, SKILL_MANIFEST_LEAF);
    const outside = join(dir, 'outside-manifest.txt');
    const interlock = join(dir, 'prune-manifest-interlock');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(manifest, `# orphan\n${SentinelSkill}\n`);
    writeFileSync(outside, 'foreign target\n');

    try {
      const probe = join(dir, 'symlink-probe');
      symlinkSync(outside, probe, 'file');
      unlinkSync(probe);
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('file symlink creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const running = runSkillWorker('write', dir, interlock, 'prune-before-manifest-remove');
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    symlinkSync(outside, manifest, 'file');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('replacement-orphan')));
    assert.equal(readFileSync(outside, 'utf8'), 'foreign target\n');
    assert.equal(readFileSync(manifest, 'utf8'), 'foreign target\n');
  });

  it('removeSkills preserves an entry appearing before final rmdir', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);
    const first = AllSkills[0];
    const firstDir = join(dir, '.claude', 'skills', first);
    const interlock = join(dir, 'remove-final-rmdir-interlock');

    const running = runSkillWorker('remove', dir, interlock, 'remove-before-rmdir');
    await waitForPath(`${interlock}.ready`);
    const userFile = join(firstDir, 'user-created-during-remove.txt');
    writeFileSync(userFile, 'must survive\n');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.removed, AllSkills.length - 1);
    assert.deepEqual(result.preserved, [first]);
    assert.equal(readFileSync(userFile, 'utf8'), 'must survive\n');
  });

  it('preserves an outside victim and successor when an ancestor is replaced before owned removal', async (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside-remove-victim');
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'remove-ancestor-replacement-interlock');
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

    const running = runSkillWorker('remove', dir, interlock, 'remove-before-owned-delete');
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    rmdirSync(destDir);
    symlinkSync(outside, destDir, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.removed, 0);
    assert.deepEqual(result.preserved, [name]);
    assert.ok(lstatSync(destDir).isSymbolicLink(), 'replacement successor must remain');
    assert.equal(readFileSync(join(outside, SKILL_MANIFEST_LEAF), 'utf8'), 'outside must survive\n');
    assert.equal(readFileSync(manifest, 'utf8'), 'outside must survive\n');
  });
});

// ---------------------------------------------------------------------------
// Strict scope
// ---------------------------------------------------------------------------

describe('strict scope', { concurrency: false }, () => {
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
