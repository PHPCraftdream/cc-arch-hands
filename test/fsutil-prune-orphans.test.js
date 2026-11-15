import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOrphanDirs, pruneOrphans } from '../lib/fsutil.js';
import { SetForSkill } from '../lib/sentinel.js';
import { withEnv } from '../test-support/env.js';

const INJECT_UNLINK_ENOENT = { CAH_TEST_ONLY: '1', CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT: '1' };
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
    try {
      withEnv(INJECT_UNLINK_ENOENT, () => {
        const result = pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill);
        // The injected ENOENT is "already removed": the payload stays in the
        // deterministic quarantine slot, so the removal reports preserved
        // (payload kept) instead of throwing raw ENOENT.
        assert.equal(result.pruned, 0);
        assert.ok(result.preserved.includes('zzz-orphan'), JSON.stringify(result));
        assert.ok(existsSync(join(orphanDir, 'SKILL.md.cah-owned-remove', 'payload')),
          'the quarantined payload must be conserved, not dropped');
        assert.ok(result.recovery.includes('zzz-orphan/SKILL.md.cah-owned-remove/payload'),
          `expected the quarantined payload reported as the recovery slot, got ${JSON.stringify(result)}`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pruneOrphans treats an already-removed payload as success, not a raw ENOENT', () => {
    const root = mkdtempSync(join(tmpdir(), 'cah-prune-enoent-file-'));
    const orphanPath = join(root, 'zzz-retired-skill.md');
    writeFileSync(orphanPath, '<!-- cah-skill:v1 -->\nmanaged\n');
    try {
      withEnv(INJECT_UNLINK_ENOENT, () => {
        const result = pruneOrphans(root, new Set(), SetForSkill);
        // The orphan FILE is moved into the quarantine slot before the
        // injected final-unlink ENOENT, so the original path no longer exists
        // and the slot is reported under `recovery`, not `preserved`. Either
        // way the removal must not throw raw ENOENT and the payload must stay.
        assert.equal(result.pruned, 0);
        assert.ok(
          result.recovery.some((p) => p.replaceAll('\\', '/').endsWith('.cah-owned-remove/payload')),
          `expected the quarantined payload reported as the recovery slot, got ${JSON.stringify(result)}`);
        assert.ok(existsSync(join(`${orphanPath}.cah-owned-remove`, 'payload')),
          'the quarantined payload must be conserved, not dropped');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
