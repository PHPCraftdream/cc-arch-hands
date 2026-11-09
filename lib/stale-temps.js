import { lstatSync, opendirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isOlderThan, sameStatInteger } from './fs-atomic-identity.js';
import {
  AtomicOwnershipLostError, PUBLICATION_FENCE_SUFFIX, readPublicationProof,
} from './fs-atomic-publication.js';

const STALE_TEMP_NAME = /^\.cah-tmp-\d+-[0-9a-f]{32}$/;
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_SWEEP_LIMIT = 5000;

function sameStat(left, right) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs'].every((key) => sameStatInteger(left[key], right[key]));
}

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, fallback) : fallback;
}

function assertOwnership(options) {
  if (options.assertOwnership?.() === false) throw new AtomicOwnershipLostError();
}

function isOwnershipLoss(error) {
  return Boolean(error?.leaseLost || error?.code === 'ERR_ATOMIC_OWNERSHIP_LOST'
    || error instanceof AtomicOwnershipLostError);
}

// Remove writeFileAtomic temps stranded by a writer killed before rename.
// Direct entries of `root` only; a temp qualifies only when its name is the exact
// pid+random form, it is a regular file older than the age floor, and no
// publication proof in `root` still names it. The caller must own `root`.
export function sweepStaleAtomicTemps(root, options = {}) {
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs >= 0
    ? options.maxAgeMs : STALE_TEMP_MAX_AGE_MS;
  const limit = boundedLimit(options.limit, STALE_TEMP_SWEEP_LIMIT);
  const report = { swept: [], failures: [], incomplete: false, truncated: false };
  let handle;
  try { handle = opendirSync(root); } catch (error) {
    if (error.code !== 'ENOENT') report.failures.push({ path: resolve(root), code: error.code || 'UNKNOWN' });
    return report;
  }
  const candidates = [];
  const referenced = new Set();
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (STALE_TEMP_NAME.test(entry.name)) {
        if (candidates.length < limit) candidates.push(entry.name); else report.truncated = true;
      } else if (entry.name.endsWith(PUBLICATION_FENCE_SUFFIX)) {
        const proof = readPublicationProof(join(root, entry.name));
        if (proof?.tempPath) referenced.add(resolve(proof.tempPath));
        else report.incomplete = true;
      }
    }
  } catch (error) {
    report.failures.push({ path: resolve(root), code: error.code || 'UNKNOWN' });
    report.incomplete = true;
    return report;
  } finally {
    try { handle.closeSync(); } catch { /* best effort */ }
  }
  // An unreadable fence may name any temp: sweep nothing rather than guess.
  if (report.incomplete) return report;
  const now = Date.now();
  for (const name of candidates) {
    const path = join(root, name);
    if (referenced.has(resolve(path))) continue;
    assertOwnership(options);
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || !isOlderThan(stat, now, maxAgeMs)) continue;
      if (!sameStat(stat, lstatSync(path, { bigint: true }))) continue;
      unlinkSync(path);
      report.swept.push(path);
    } catch (error) {
      if (isOwnershipLoss(error)) throw error;
      if (error.code !== 'ENOENT') report.failures.push({ path, code: error.code || 'UNKNOWN' });
    }
  }
  return report;
}
