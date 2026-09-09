import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { rateLimitsContextPath, readRateLimitsCache } from '../lib/transcript-stats.js';

const stamp = 1_700_000_000;
const record = (size, capturedAt) => JSON.stringify({ version: 1, contextWindowSize: size, capturedAt });

function rewrite(path, content) {
  const before = fs.lstatSync(path, { bigint: true });
  fs.writeFileSync(path, content);
  fs.utimesSync(path, stamp, stamp);
  const after = fs.lstatSync(path, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs']) assert.equal(after[key], before[key], key);
}

for (const boundary of ['target publication', 'source cleanup']) {
  it(`context migration preserves same-metadata successor during ${boundary}`, (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'cah-context-cas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cache = join(root, 'rate-limits.json');
    const session = 'cas-session';
    const hash = createHash('sha256').update(`string:${session}`).digest('hex');
    const source = `${cache}.context-${hash}.json`;
    const target = rateLimitsContextPath(cache, session);
    fs.mkdirSync(dirname(target));
    fs.writeFileSync(source, record(300000, 200));
    fs.utimesSync(source, stamp, stamp);
    if (boundary === 'target publication') {
      fs.writeFileSync(target, record(200000, 100));
      fs.utimesSync(target, stamp, stamp);
    }
    const nativeRead = fs.readFileSync;
    const nativeRename = fs.renameSync;
    let changed = false;
    try {
      fs.readFileSync = (path, ...args) => {
        const value = nativeRead(path, ...args);
        if (boundary === 'target publication' && path === target && !changed) {
          changed = true;
          rewrite(target, record(400000, 300));
        }
        return value;
      };
      fs.renameSync = (from, to) => {
        const value = nativeRename(from, to);
        if (boundary === 'source cleanup' && to === target && !changed) {
          changed = true;
          rewrite(source, record(400000, 300));
        }
        return value;
      };
      syncBuiltinESMExports();
      const result = readRateLimitsCache(cache, 400, session);
      assert.equal(changed, true);
      assert.equal(result?.contextWindowSize, 400000);
      assert.equal(nativeRead(boundary === 'target publication' ? target : source, 'utf8'), record(400000, 300));
    } finally {
      fs.readFileSync = nativeRead;
      fs.renameSync = nativeRename;
      syncBuiltinESMExports();
    }
  });
}
