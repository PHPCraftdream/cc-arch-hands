#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readCommands, option } from './spec.mjs';
import { createRun, readStatus, writeJson } from './store.mjs';
import { runWorker } from './runner.mjs';

async function launch(args) {
  const thread = option(args, '--thread', process.env.CODEX_THREAD_ID);
  const delivery = option(args, '--delivery', 'queue');
  if (!['queue', 'file'].includes(delivery)) throw new Error('delivery must be queue or file');
  if (delivery === 'queue' && !thread) throw new Error('CODEX_THREAD_ID or --thread is required');
  const maxParallel = Number(option(args, '--max-parallel', '4'));
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) {
    throw new Error('max-parallel must be 1-16');
  }
  const commands = await readCommands(option(args, '--spec'));
  const runId = randomUUID();
  const dir = createRun(runId, { thread, commands, maxParallel, delivery });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', dir], {
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
  console.log(JSON.stringify({ runId, pid: ready.pid, statusDir: dir, commands: commands.length }));
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'launch') return launch(args);
  if (action === 'worker') return runWorker(args[0]);
  if (action === 'status') {
    const runId = option(args, '--run');
    if (!runId) throw new Error('status requires --run <id>');
    console.log(JSON.stringify(readStatus(runId), null, 2));
    return;
  }
  throw new Error('usage: cli-run.mjs launch --spec <file|-> [--thread id] [--max-parallel N] | status --run <id>');
}

try {
  await main();
} catch (error) {
  if (process.connected) process.send({ type: 'error', error: error.message });
  else {
    if (process.argv[2] === 'worker' && process.argv[3]) {
      try {
        const path = join(process.argv[3], 'fatal.json');
        writeJson(path, { error: error.message, at: new Date().toISOString() });
      } catch {}
    }
    console.error(`cli-run: ${error.message}`);
  }
  process.exitCode = 1;
}
