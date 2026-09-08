import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOrphanDirs } from '../lib/fsutil.js';
import { SetForSkill } from '../lib/sentinel.js';

const FILLER = `${'x'.repeat(120)}\n`;

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
