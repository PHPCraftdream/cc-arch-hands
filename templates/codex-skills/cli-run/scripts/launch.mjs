import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRun, readStatus } from './store.mjs';

const entry = fileURLToPath(new URL('./cli-run.mjs', import.meta.url));

export async function startRun({ taskName, commands, thread, maxParallel = 4, showOutput = false, delivery = 'queue' }) {
  if (typeof taskName !== 'string' || !taskName.trim() || taskName.trim().length > 120
      || /[\u0000-\u001f\u007f\u2028\u2029]/.test(taskName)) {
    throw new Error('taskName must be 1-120 printable characters');
  }
  const name = taskName.trim();
  if (!['queue', 'inline'].includes(delivery)) throw new Error('delivery must be queue or inline');
  if (delivery === 'queue' && !thread) throw new Error('a Codex thread ID is required');
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) {
    throw new Error('max-parallel must be 1-16');
  }
  if (typeof showOutput !== 'boolean') throw new Error('showOutput must be a boolean');
  const runId = randomUUID();
  const dir = createRun(runId, { taskName: name, thread, commands, maxParallel, showOutput, delivery });
  const child = spawn(process.execPath, [entry, 'worker', dir], {
    detached: true,
    windowsHide: true,
    cwd: tmpdir(),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ error: error.message }));
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
  const launched = { uid: runId, runId, taskName: name, pid: ready.pid, statusDir: dir, commands: commands.length };
  if (delivery === 'inline') {
    const exit = await exited;
    const status = readStatus(runId);
    if ((exit.error || exit.code !== 0) && !status.fatal) {
      status.fatal = { error: exit.error ?? `worker exited ${exit.code ?? exit.signal ?? 'unknown'}` };
    }
    return { ...launched, status };
  }
  child.unref();
  return launched;
}
