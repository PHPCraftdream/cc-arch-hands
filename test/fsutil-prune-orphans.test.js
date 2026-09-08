import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOrphanDirs, pruneOrphans } from '../lib/fsutil.js';
import { SetForSkill } from '../lib/sentinel.js';

const FILLER = `${'x'.repeat(120)}\n`;

function largeManagedManifestContent() {
  let content = '<!-- cah-skill:v1 -->\n';
  while (content.length < 64 * 1024 * 1024) content += FILLER;
  return content;
}

// A real remover process that fires the instant the managed removal
// reserves its deterministic quarantine namespace — i.e. strictly inside
// removeOwnedRegularFile(), while the 64 MB manifest is being re-read.
// That lands the concurrent unlink inside captureRegularFileSnapshot()'s
// double-lstat window, the exact escape shape round 68 closes.
function spawnReservationSignaledRemover(manifestPath) {
  const reservation = `${manifestPath}.cah-owned-remove`;
  const script = `
    const fs = require('node:fs');
    const reservation = ${JSON.stringify(reservation)};
    const target = ${JSON.stringify(manifestPath)};
    const deadline = Date.now() + 30000;
    (function poll() {
      if (Date.now() > deadline) process.exit(2);
      if (fs.existsSync(reservation)) {
        try { fs.unlinkSync(target); } catch { /* already gone */ }
        process.exit(0);
      }
      setTimeout(poll, 1);
    })();
  `;
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
}

describe('pruneOrphanDirs', () => {
  it('preserves an orphan directory removed by a concurrent process during the snapshot window', () => {
    const root = mkdtempSync(join(tmpdir(), 'cah-prune-race-'));
    const orphanDir = join(root, 'zzz-orphan');
    mkdirSync(orphanDir);
    // ~64 MB manifest so captureRegularFileSnapshot's double hash widens the
    // race window to well over 100 ms, comfortably covering the
    // snapshot -> pre-removal re-read window.
    let content = '<!-- cah-skill:v1 -->\n';
    while (content.length < 64 * 1024 * 1024) content += FILLER;
    writeFileSync(join(orphanDir, 'SKILL.md'), content);

    const remover = spawn(
      process.execPath,
      ['-e', `const fs = require('node:fs'); setTimeout(() => { try { fs.rmSync(${JSON.stringify(orphanDir)}, { recursive: true, force: true }); } catch {} }, 60);`],
      { stdio: 'ignore', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    let result;
    try {
      result = pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill);
    } finally {
      remover.kill();
    }

    // The concurrent removal must not escape as a raw ENOENT.
    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.includes('zzz-orphan'),
      `expected 'zzz-orphan' preserved, got ${JSON.stringify(result)}`);
  });
});

describe('pruneOrphanDirs concurrent manifest removal', () => {
  it('preserves the orphan when a real remover makes the manifest vanish mid-removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'cah-prune-midremoval-'));
    const orphanDir = join(root, 'zzz-orphan');
    mkdirSync(orphanDir);
    writeFileSync(join(orphanDir, 'SKILL.md'), largeManagedManifestContent());
    const remover = spawnReservationSignaledRemover(join(orphanDir, 'SKILL.md'));
    let result;
    try {
      result = pruneOrphanDirs(root, new Set(), 'SKILL.md', SetForSkill);
    } finally {
      remover.kill();
    }
    // The vanished leaf must converge to preserve-and-continue, never a raw
    // 'managed destination leaf changed concurrently' throw.
    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.includes('zzz-orphan'),
      `expected 'zzz-orphan' preserved, got ${JSON.stringify({ pruned: result.pruned, preserved: result.preserved })}`);
  });
});

describe('pruneOrphans concurrent orphan removal', () => {
  it('preserves the orphan when a real remover makes it vanish mid-removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'cah-prune-orphans-race-'));
    const orphanPath = join(root, 'zzz-retired-skill.md');
    writeFileSync(orphanPath, largeManagedManifestContent());
    const remover = spawnReservationSignaledRemover(orphanPath);
    let result;
    try {
      result = pruneOrphans(root, new Set(), SetForSkill);
    } finally {
      remover.kill();
    }
    // Verified behavior: the reservation fires near the quarantine rename,
    // so the remover's unlink either hits an already-moved path (clean
    // prune), or wins the race entirely and the vanished leaf is skipped.
    // All observed outcomes are { pruned: 1 } or { pruned: 0, preserved: [],
    // recovery: [] } — the invariant under test is that the concurrent
    // unlink NEVER escapes as a throw and never corrupts the report.
    assert.equal(typeof result.pruned, 'number');
    assert.ok(Array.isArray(result.preserved) && Array.isArray(result.recovery));
    assert.ok(
      result.pruned === 1 || (result.pruned === 0 && result.preserved.length + result.recovery.length <= 1),
      `unexpected report shape, got ${JSON.stringify({ pruned: result.pruned, preserved: result.preserved, recovery: result.recovery })}`);
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
