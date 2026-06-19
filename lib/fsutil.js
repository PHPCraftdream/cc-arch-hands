import { readFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';

export function readFileMaybe(path) {
  try {
    return [true, readFileSync(path)];
  } catch (e) {
    if (e.code === 'ENOENT') return [false, null];
    throw e;
  }
}

export function pruneOrphans(dir, knownNames, sentinelSet) {
  let pruned = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (knownNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const [present, content] = readFileMaybe(path);
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      unlinkSync(path);
      pruned++;
    }
  }
  return pruned;
}

export function pruneOrphanDirs(root, knownNames, manifestLeaf, sentinelSet) {
  let pruned = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (knownNames.has(entry.name)) continue;
    const manifestPath = join(root, entry.name, manifestLeaf);
    const [present, content] = readFileMaybe(manifestPath);
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
      pruned++;
    }
  }
  return pruned;
}
