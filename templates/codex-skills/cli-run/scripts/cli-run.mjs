#!/usr/bin/env node
import { join } from 'node:path';
import { readCommands, option } from './spec.mjs';
import { readStatus, writeJson } from './store.mjs';
import { runWorker } from './runner.mjs';
import { checkMaxParallel, startRun } from './launch.mjs';

async function launch(args) {
  const thread = option(args, '--thread', process.env.CODEX_THREAD_ID);
  const delivery = option(args, '--delivery', 'queue');
  if (delivery === 'queue' && !thread) throw new Error('CODEX_THREAD_ID or --thread is required');
  const maxParallel = checkMaxParallel(Number(option(args, '--max-parallel', '4')));
  const commands = await readCommands(option(args, '--spec'));
  const run = await startRun({ commands, thread, maxParallel, delivery });
  console.log(JSON.stringify({ runId: run.runId, pid: run.pid, statusDir: run.statusDir, commands: run.commands }));
  if (args.includes('--wait')) {
    const { code, signal } = await run.exited;
    if (code !== 0) throw new Error(`worker exited ${code ?? signal ?? 'unknown'}`);
  } else {
    run.child.unref();
  }
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
  throw new Error('usage: cli-run.mjs launch --spec <file|-> [--thread id] [--max-parallel N] [--wait] | status --run <id>');
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
