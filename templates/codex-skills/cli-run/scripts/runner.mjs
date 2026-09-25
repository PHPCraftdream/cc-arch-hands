import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { queueCompletion } from './queue.mjs';
import { writeJson } from './store.mjs';

const OUTPUT_TAIL_LINES = 10;
const OUTPUT_TAIL_MAX_BYTES = 256 * 1024;
const OUTPUT_TAIL_MAX_LINE_CHARS = 1000;

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

function completionMessage(runId, result) {
  const status = result.error ? `failed to start (${result.error})`
    : result.signal ? `stopped by ${result.signal}` : `exited ${result.exitCode}`;
  const { lines, truncated } = readOutputTail(result.log);
  const tailLabel = `Last ${lines.length} output lines${truncated ? ' (long lines truncated)' : ''}`;
  return `cli-run ${runId}: ${result.id} ${status}; command: ${result.commandDisplay}; log: ${result.log}\n\n${tailLabel}:\n${lines.length ? lines.join('\n') : '(no output)'}`;
}

function readOutputTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, OUTPUT_TAIL_MAX_BYTES);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(fd, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      readSync(fd, previousByte, 0, 1, start - 1);
      if (previousByte[0] !== 0x0a && previousByte[0] !== 0x0d) {
        const firstBreak = text.match(/\r\n|\r|\n/);
        text = firstBreak
          ? text.slice(firstBreak.index + firstBreak[0].length)
          : text.replace(/^\uFFFD/, '');
      }
    }

    const allLines = text.split(/\r\n|\r|\n/);
    if (allLines.at(-1) === '') allLines.pop();
    let truncated = false;
    const lines = allLines.slice(-OUTPUT_TAIL_LINES).map((line) => {
      const characters = Array.from(line);
      if (characters.length <= OUTPUT_TAIL_MAX_LINE_CHARS) return line;
      truncated = true;
      const marker = '...[line truncated] ';
      return marker + characters.slice(-(OUTPUT_TAIL_MAX_LINE_CHARS - marker.length)).join('');
    });
    return { lines, truncated };
  } finally {
    closeSync(fd);
  }
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
