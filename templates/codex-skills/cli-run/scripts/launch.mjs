import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRun } from './store.mjs';

const entry = fileURLToPath(new URL('./cli-run.mjs', import.meta.url));

export async function startRun({ commands, thread, maxParallel = 4 }) {
  if (!thread) throw new Error('a Codex thread ID is required');
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) {
    throw new Error('max-parallel must be 1-16');
  }
  const runId = randomUUID();
  const dir = createRun(runId, { thread, commands, maxParallel });
  const child = spawn(process.execPath, [entry, 'worker', dir], {
    detached: true,
    windowsHide: true,
    cwd: tmpdir(),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker startup timed out')), 5000);
    child.on('message', (message) => {
      if (message?.type === 'ready') { clearTimeout(timeout); resolve(message); }
      if (message?.type === 'error') { clearTimeout(timeout); reject(new Error(message.error)); }
    });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`worker exited before ready: ${code}`)); });
  }).catch((error) => { child.kill(); throw error; });
  if (child.connected) child.disconnect();
  child.unref();
  return { runId, pid: ready.pid, statusDir: dir, commands: commands.length };
}
