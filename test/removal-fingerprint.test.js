import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { captureRegularFileSnapshot, removeOwnedRegularFile } from '../lib/fsutil.js';

for (const shape of ['identity', 'digest', 'length', 'wrong-length', 'digest-wrong-length']) {
  it(`removal honors a ${shape} expectation without discarding caller constraints`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cah-removal-fingerprint-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'owned.txt');
    writeFileSync(path, 'original');
    const snapshot = captureRegularFileSnapshot(path);
    const expected = { exists: true, identity: snapshot.expectedDestination.identity };
    if (shape.includes('digest')) expected.contentDigest = snapshot.contentDigest;
    if (shape.includes('length')) expected.contentBytes = shape.includes('wrong') ? 99 : snapshot.contentBytes;
    const removed = removeOwnedRegularFile(path, expected);
    if (shape.includes('wrong')) {
      assert.equal(removed, false);
      assert.equal(readFileSync(path, 'utf8'), 'original');
    } else {
      assert.equal(removed, true);
      assert.equal(existsSync(path), false);
    }
    assert.equal(existsSync(path + '.cah-owned-remove'), false);
  });
}
