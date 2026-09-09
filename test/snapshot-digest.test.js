import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { captureRegularFileSnapshot } from '../lib/fs-atomic-identity.js';

for (const content of [null, '', 'snapshot bytes']) {
  it(`snapshot computes each available content digest once (${content === null ? 'missing' : content.length})`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cah-snapshot-digest-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'file');
    if (content !== null) writeFileSync(path, content);
    const nativeHash = crypto.createHash;
    const expected = content === null ? null : nativeHash('sha256').update(content).digest('hex');
    let calls = 0;
    try {
      crypto.createHash = (...args) => { calls++; return nativeHash(...args); };
      syncBuiltinESMExports();
      const snapshot = captureRegularFileSnapshot(path);
      assert.equal(snapshot.contentDigest, expected);
      assert.equal(snapshot.expectedDestination.contentDigest, expected);
      assert.equal(snapshot.contentBytes, content === null ? 0 : Buffer.byteLength(content));
      assert.equal(calls, content === null ? 0 : 1);
    } finally {
      crypto.createHash = nativeHash;
      syncBuiltinESMExports();
    }
  });
}
