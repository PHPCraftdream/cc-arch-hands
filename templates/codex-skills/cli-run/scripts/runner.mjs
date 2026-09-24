import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { queueCompletion } from './queue.mjs';
import { writeJson } from './store.mjs';

function execute(command, dir) {
  const started = Date.now();
  const log = join(dir, `${command.id}.log`);
  const fd = openSync(log, 'wx', 0o600);
  let child;
  try {
    child = command.argv
      ? spawn(command.argv[0], command.argv.slice(1), {
        cwd: command.cwd, windowsHide: true, stdio: ['ignore', fd, fd],
      })
      : spawn(command.command, {
        cwd: command.cwd, shell: true, windowsHide: true, stdio: ['ignore', fd, fd],
      });
  } catch (error) {
    closeSync(fd);
    return Promise.resolve({ id: command.id, exitCode: null, signal: null,
      seconds: 0, log, error: error.message });
  }
  closeSync(fd);
  return new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (error) => { spawnError = error.message; });
    child.on('exit', (exitCode, signal) => resolve({
      id: command.id, exitCode, signal,
      seconds: Math.round((Date.now() - started) / 1000), log, error: spawnError,
    }));
  });
}

function completionMessage(runId, result) {
  const status = result.error ? `failed to start (${result.error})`
    : result.signal ? `stopped by ${result.signal}` : `exited ${result.exitCode}`;
  return `cli-run ${runId}: ${result.id} ${status}; log: ${result.log}`;
}

export async function runWorker(dir) {
  const specPath = join(dir, 'spec.json');
  const { thread, commands, maxParallel, delivery } = JSON.parse(readFileSync(specPath, 'utf8'));
  unlinkSync(specPath);
  writeJson(join(dir, 'status.json'), {
    startedAt: new Date().toISOString(), total: commands.length, deliveryMode: delivery,
  });
  let cursor = 0;
  const deliveries = [];
  process.send?.({ type: 'ready', pid: process.pid });

  async function pump() {
    while (cursor < commands.length) {
      const command = commands[cursor++];
      const result = await execute(command, dir);
      const resultPath = join(dir, `${command.id}.result.json`);
      writeJson(resultPath, result);

      const sent = delivery === 'file'
        ? Promise.resolve({ ok: true, mode: 'file' })
        : queueCompletion(thread, completionMessage(basename(dir), result));
      deliveries.push(sent.then((outcome) => {
        writeJson(join(dir, `${command.id}.delivery.json`), outcome);
      }));
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxParallel, commands.length) }, pump));
  await Promise.all(deliveries);
  writeJson(join(dir, 'finished.json'), { finishedAt: new Date().toISOString() });
}
