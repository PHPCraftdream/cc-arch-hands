// Windows refuses to rename a directory that a live child process holds (as
// its CWD or through an open handle): EPERM/EBUSY. Other platforms rename it
// freely, so a test that needs that contention first asks whether it can be
// built here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleepSyncWait } from '../lib/lease-clock.js';
import { DEFAULT_CHILD_DEADLINE_MS } from './process-batches.js';

// True when a directory held as a child's CWD cannot be renamed.
export async function renameBlockedWhileChildHoldsCwd() {
  const probe = mkdtempSync(join(tmpdir(), 'cah-cwd-probe-'));
  const moved = `${probe}-moved`;
  try {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120)'], {
      cwd: probe, stdio: 'ignore',
    });
    sleepSyncWait(60);
    let blocked = false;
    try {
      renameSync(probe, moved);
      renameSync(moved, probe);
    } catch {
      blocked = true;
    }
    await new Promise((resolve) => child.once('exit', resolve));
    return blocked;
  } finally {
    rmSync(probe, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
}

// Renames `dir` aside and back until a rename FAILS, which proves a child
// process holds the directory. True only when the block was seen before the
// 5 s deadline.
export function probeUntilRenameBlocked(dir) {
  const probePath = `${dir}.probe`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      renameSync(dir, probePath);
      renameSync(probePath, dir); // the child has not taken its handle yet
      sleepSyncWait(5);
    } catch (err) {
      assert.ok(
        ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code),
        `probe rename failed with unexpected code ${err.code} (dir must not have vanished)`,
      );
      return true;
    }
  }
  return false;
}

// Blocks until `path` exists; for callbacks that cannot await.
export function waitForPathSync(path, deadlineMs = DEFAULT_CHILD_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    sleepSyncWait(5);
  }
}
