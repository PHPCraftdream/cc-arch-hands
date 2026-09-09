import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOrphanDirs, pruneOrphans } from '../lib/fsutil.js';
import { SetForSkill } from '../lib/sentinel.js';

const CONTENT = '<!-- cah-skill:v1 -->\nmanaged\n';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-prune-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function atRead(path, armed, change, operation) {
  const nativeRead = fs.readFileSync;
  let reached = false;
  fs.readFileSync = (target, ...args) => {
    const value = nativeRead(target, ...args);
    if (target === path && !reached && armed()) {
      reached = true;
      change();
    }
    return value;
  };
  syncBuiltinESMExports();
  try {
    const result = operation();
    assert.equal(reached, true, 'the required snapshot boundary must execute');
    return result;
  } finally {
    fs.readFileSync = nativeRead;
    syncBuiltinESMExports();
  }
}

describe('pruneOrphanDirs', () => {
  it('handles a directory disappearing inside its initial snapshot', (t) => {
    const root = fixture(t);
    const orphan = join(root, 'zzz-orphan');
    mkdirSync(orphan);
    const manifest = join(orphan, 'SKILL.md');
    writeFileSync(manifest, CONTENT);
    const result = atRead(manifest, () => true,
      () => rmSync(orphan, { recursive: true }),
      () => pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill));
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.preserved, ['zzz-orphan']);
    assert.equal(existsSync(orphan), false);
  });
});

describe('pruneOrphanDirs concurrent manifest removal', () => {
  it('handles a manifest disappearing after reserving its removal slot', (t) => {
    const root = fixture(t);
    const orphan = join(root, 'zzz-orphan');
    mkdirSync(orphan);
    const manifest = join(orphan, 'SKILL.md');
    writeFileSync(manifest, CONTENT);
    const reservation = manifest + '.cah-owned-remove';
    const result = atRead(manifest, () => existsSync(reservation),
      () => fs.unlinkSync(manifest),
      () => pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill));
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.preserved, ['zzz-orphan']);
    assert.deepEqual(result.recovery, []);
    assert.equal(existsSync(orphan), true);
    assert.equal(existsSync(manifest), false);
    assert.equal(existsSync(reservation), false);
  });
});

describe('pruneOrphans concurrent orphan removal', () => {
  it('handles an orphan disappearing after reserving its removal slot', (t) => {
    const root = fixture(t);
    const orphan = join(root, 'zzz-retired-skill.md');
    writeFileSync(orphan, CONTENT);
    const reservation = orphan + '.cah-owned-remove';
    const result = atRead(orphan, () => existsSync(reservation),
      () => fs.unlinkSync(orphan),
      () => pruneOrphans(root, new Set(), SetForSkill));
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.preserved, []);
    assert.deepEqual(result.recovery, []);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(reservation), false);
  });
});

describe('prune final-unlink ENOENT', () => {
  it('pruneOrphanDirs treats an already-removed payload as success, not a raw ENOENT', () => {
    const root = mkdtempSync(join(tmpdir(), 'cah-prune-enoent-'));
    const orphanDir = join(root, 'zzz-orphan');
    mkdirSync(orphanDir);
    writeFileSync(join(orphanDir, 'SKILL.md'), '<!-- cah-skill:v1 -->\nmanaged\n');
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorInject = process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT = '1';
    try {
      const result = pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill);
      // The injected ENOENT is "already removed": the payload stays in the
      // deterministic quarantine slot, so the removal reports preserved
      // (payload kept) instead of throwing raw ENOENT.
      assert.equal(result.pruned, 0);
      assert.ok(result.preserved.includes('zzz-orphan'),
        `expected preserved, got ${JSON.stringify({ pruned: result.pruned, preserved: result.preserved })}`);
      assert.ok(existsSync(join(orphanDir, 'SKILL.md.cah-owned-remove', 'payload')),
        'the quarantined payload must be conserved, not dropped');
      assert.ok(result.recovery.includes('zzz-orphan/SKILL.md.cah-owned-remove/payload'),
        `expected the quarantined payload reported as the recovery slot, got ${JSON.stringify({ pruned: result.pruned, preserved: result.preserved, recovery: result.recovery })}`);
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorInject === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT;
      else process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT = priorInject;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pruneOrphans treats an already-removed payload as success, not a raw ENOENT', () => {
    const root = mkdtempSync(join(tmpdir(), 'cah-prune-enoent-file-'));
    const orphanPath = join(root, 'zzz-retired-skill.md');
    writeFileSync(orphanPath, '<!-- cah-skill:v1 -->\nmanaged\n');
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorInject = process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT = '1';
    try {
      const result = pruneOrphans(root, new Set(), SetForSkill);
      // Verified behavior: the orphan FILE is moved into the quarantine slot
      // before the injected final-unlink ENOENT, so the original path no
      // longer exists and the slot is reported under `recovery`, not
      // `preserved`. Either way the removal must not throw raw ENOENT and
      // the quarantined payload must be conserved.
      assert.equal(result.pruned, 0);
      assert.ok(
        result.recovery.some((p) => p.replaceAll('\\', '/').endsWith('.cah-owned-remove/payload')),
        `expected the quarantined payload reported as the recovery slot, got ${JSON.stringify({ pruned: result.pruned, preserved: result.preserved, recovery: result.recovery })}`);
      assert.ok(existsSync(join(`${orphanPath}.cah-owned-remove`, 'payload')),
        'the quarantined payload must be conserved, not dropped');
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorInject === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT;
      else process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT = priorInject;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
