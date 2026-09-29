import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { queueCompletion } from './queue.mjs';
import { writeJson } from './store.mjs';

function displayArgument(value) {
  return `[${value
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('"', '\\u0022')
    .replaceAll("'", '\\u0027')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}]`;
}

function displayCommand(command) {
  return command.argv
    ? `argv ${command.argv.map(displayArgument).join(' ')}`
    : `shell ${displayArgument(command.command)}`;
}

function execute(command, dir) {
  const started = Date.now();
  const log = join(dir, `${command.id}.log`);
  const commandLine = command.command ?? JSON.stringify(command.argv);
  const commandDisplay = displayCommand(command);
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
      seconds: 0, log, error: error.message, commandLine, commandDisplay });
  }
  closeSync(fd);
  return new Promise((resolve) => {
    let spawnError = null;
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        id: command.id, exitCode, signal,
        seconds: Math.round((Date.now() - started) / 1000), log, error: spawnError,
        commandLine, commandDisplay,
      });
    };
    child.once('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.once('exit', finish);
  });
}

function completionMessage(uid, taskName, results) {
  const failed = results.filter((result) => result.error || result.signal || result.exitCode !== 0).length;
  const outcome = failed ? `finished with ${failed}/${results.length} failed` : `completed (${results.length}/${results.length} succeeded)`;
  return `cli-run ${uid}: ${taskName} ${outcome}`;
}

export async function runWorker(dir) {
  const specPath = join(dir, 'spec.json');
  const { taskName, thread, commands, maxParallel, delivery = 'queue' } = JSON.parse(readFileSync(specPath, 'utf8'));
  unlinkSync(specPath);
  writeJson(join(dir, 'status.json'), {
    startedAt: new Date().toISOString(), taskName, total: commands.length, deliveryMode: delivery,
  });
  let cursor = 0;
  const results = [];
  process.send?.({ type: 'ready', pid: process.pid });

  async function pump() {
    while (cursor < commands.length) {
      const command = commands[cursor++];
      const result = await execute(command, dir);
      const resultPath = join(dir, `${command.id}.result.json`);
      writeJson(resultPath, result);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxParallel, commands.length) }, pump));
  if (delivery === 'queue') {
    const outcome = await queueCompletion(thread, completionMessage(basename(dir), taskName, results));
    writeJson(join(dir, 'completion.delivery.json'), outcome);
  }
  writeJson(join(dir, 'finished.json'), { finishedAt: new Date().toISOString() });
}
