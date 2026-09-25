import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForPath } from '../test-support/installer-test-helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'templates', 'codex-skills', 'cli-run', 'scripts', 'cli-run.mjs');
const fakeCli = join(root, 'test-support', 'cli-run-fake-codex.mjs');

describe('cli-run worker', () => {
  it('queues only the last ten output lines while preserving the full log', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-tail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const queueLog = join(dir, 'queue.log');
    const outputLines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    const output = `${outputLines.join('\n')}\n`;
    const script = `process.stdout.write(${JSON.stringify(output)}); void "release: 0.12.1"`;
    const spec = [{
      id: 'tail',
      argv: [process.execPath, '-e', script],
    }];
    const env = {
      ...process.env,
      CODEX_HOME: join(dir, 'codex-home'),
      CODEX_THREAD_ID: 'thread-test',
      CLI_RUN_TEST_QUEUE_LOG: queueLog,
      CLI_RUN_CODEX_CLI: fakeCli,
    };
    const launch = spawnSync(process.execPath, [cli, 'launch', '--spec', '-'], {
      cwd: dir, env, input: JSON.stringify(spec), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(launch.status, 0, launch.stderr);
    const { runId, statusDir } = JSON.parse(launch.stdout);
    await waitForPath(join(statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(queueLog, 'utf8');
    const heading = 'Last 10 output lines:\n';
    const tail = notification.split(heading)[1];
    assert.ok(tail, notification);
    assert.ok(notification.includes('command: argv ['), notification);
    assert.ok(notification.includes('release: 0.12.1\\u0022]'), notification);
    assert.ok(!notification.includes('"'), notification);
    assert.deepEqual(tail.trimEnd().split(/\r?\n/), outputLines.slice(-10));
    const status = spawnSync(process.execPath, [cli, 'status', '--run', runId], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(readFileSync(JSON.parse(status.stdout).results[0].log, 'utf8'), output);
  });

  it('caps long output lines in notifications but preserves them in the log', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-tail-long-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const queueLog = join(dir, 'queue.log');
    const output = `${'x'.repeat(2500)}tail-marker\n`;
    const env = {
      ...process.env,
      CODEX_HOME: join(dir, 'codex-home'),
      CODEX_THREAD_ID: 'thread-test',
      CLI_RUN_TEST_QUEUE_LOG: queueLog,
      CLI_RUN_CODEX_CLI: fakeCli,
    };
    const launch = spawnSync(process.execPath, [cli, 'launch', '--spec', '-'], {
      cwd: dir,
      env,
      input: JSON.stringify([{
        id: 'long-line',
        argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`],
      }]),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(launch.status, 0, launch.stderr);
    const { runId, statusDir } = JSON.parse(launch.stdout);
    await waitForPath(join(statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(queueLog, 'utf8');
    const heading = 'Last 1 output lines (long lines truncated):\n';
    const tail = notification.split(heading)[1]?.trimEnd();
    assert.ok(tail, notification);
    assert.equal(tail.length, 1000);
    assert.ok(tail.endsWith('tail-marker'));
    const status = spawnSync(process.execPath, [cli, 'status', '--run', runId], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(readFileSync(JSON.parse(status.stdout).results[0].log, 'utf8'), output);
  });

  it('reports spawn errors and completes the run', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-spawn-error-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = {
      ...process.env,
      CODEX_HOME: join(dir, 'codex-home'),
      CODEX_THREAD_ID: 'thread-test',
      CLI_RUN_TEST_QUEUE_LOG: join(dir, 'queue.log'),
      CLI_RUN_CODEX_CLI: fakeCli,
    };
    const missingCommand = join(dir, 'missing-executable');
    const launch = spawnSync(process.execPath, [cli, 'launch', '--spec', '-'], {
      cwd: dir, env, input: JSON.stringify([{ id: 'missing', argv: [missingCommand] }]),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(launch.status, 0, launch.stderr);
    const { runId, statusDir } = JSON.parse(launch.stdout);
    await waitForPath(join(statusDir, 'finished.json'), 5000);

    const status = spawnSync(process.execPath, [cli, 'status', '--run', runId], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.completed, 1);
    assert.equal(state.delivered, 1);
    assert.equal(state.results[0].exitCode, null);
    assert.match(state.results[0].error, /ENOENT/);
    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.match(notification, /failed to start/);
    assert.match(notification, /Last 0 output lines:\n\(no output\)/);
  });

  it('returns before parallel commands finish, then queues each result', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const queueLog = join(dir, 'queue.log');
    const secondReady = join(dir, 'second-ready');
    const secondScript = [
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      `const ready = ${JSON.stringify(secondReady)};`,
      'const server = net.createServer((socket) => {',
      '  socket.end();',
      '  server.close(() => { process.exitCode = 7; });',
      '});',
      "server.listen(0, '127.0.0.1', () => {",
      "  fs.writeFileSync(ready, String(server.address().port));",
      '});',
    ].join('\n');
    const spec = [
      { id: 'first', argv: [process.execPath, '-e', 'process.exit(0)'] },
      { id: 'second', argv: [process.execPath, '-e', secondScript] },
    ];
    const env = {
      ...process.env,
      CODEX_HOME: join(dir, 'codex-home'),
      CODEX_THREAD_ID: 'thread-test',
      CLI_RUN_TEST_QUEUE_LOG: queueLog,
      CLI_RUN_CODEX_CLI: fakeCli,
    };
    const launch = spawnSync(process.execPath, [cli, 'launch', '--spec', '-', '--max-parallel', '2'], {
      cwd: dir, env, input: JSON.stringify(spec), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(launch.status, 0, launch.stderr);
    const { runId, statusDir } = JSON.parse(launch.stdout);
    assert.equal(runId.length, 36);
    assert.ok(!existsSync(join(statusDir, 'second.result.json')));
    await Promise.all([
      waitForPath(join(statusDir, 'first.delivery.json'), 30_000),
      waitForPath(secondReady, 30_000),
    ]);
    assert.equal(JSON.parse(readFileSync(join(statusDir, 'first.delivery.json'), 'utf8')).ok, true);
    assert.ok(!existsSync(join(statusDir, 'second.result.json')));
    const port = Number(readFileSync(secondReady, 'utf8'));
    await new Promise((resolve, reject) => {
      const socket = createConnection(port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
    });
    await waitForPath(join(statusDir, 'finished.json'), 30_000)
      .catch((error) => {
        const files = readFileSync(join(statusDir, 'status.json'), 'utf8');
        throw new Error(`${error.message}; initial=${files}`);
      });

    const status = spawnSync(process.execPath, [cli, 'status', '--run', runId], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    const result = JSON.parse(status.stdout);
    assert.equal(result.completed, 2);
    assert.equal(result.delivered, 2);
    assert.equal(result.failedDeliveries, 0);
    assert.deepEqual(result.results.map((entry) => entry.exitCode).sort(), [0, 7]);
    const messages = readFileSync(queueLog, 'utf8');
    assert.match(messages, /queue\|thread-test\|cli-run .*first exited 0/);
    assert.match(messages, /queue\|thread-test\|cli-run .*second exited 7/);
  });

  it('rejects malformed specs before launching a worker', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-invalid-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { ...process.env, CODEX_HOME: join(dir, 'codex-home') };
    const result = spawnSync(process.execPath, [cli, 'launch', '--spec', '-', '--delivery', 'file'], {
      cwd: dir, env, input: '[{"id":"same","argv":["node"]},{"id":"same","argv":["node"]}]',
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate command id/);
    assert.ok(!existsSync(join(env.CODEX_HOME, 'cli-run', 'runs')));
  });

  it('records failed queue delivery without claiming a notification', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-queue-fail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = {
      ...process.env,
      CODEX_HOME: join(dir, 'codex-home'),
      CODEX_THREAD_ID: 'thread-test',
      CLI_RUN_CODEX_CLI: fakeCli,
      CLI_RUN_TEST_QUEUE_FAIL: '1',
    };
    const spec = [{ id: 'done', argv: [process.execPath, '-e', 'process.exit(0)'] }];
    const launch = spawnSync(process.execPath, [cli, 'launch', '--spec', '-'], {
      cwd: dir, env, input: JSON.stringify(spec), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(launch.status, 0, launch.stderr);
    const { statusDir } = JSON.parse(launch.stdout);
    await waitForPath(join(statusDir, 'finished.json'), 30_000);
    const status = spawnSync(process.execPath, [cli, 'status', '--run', JSON.parse(launch.stdout).runId], {
      env, encoding: 'utf8',
    });
    assert.equal(status.status, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    const result = state.results[0];
    assert.equal(state.delivered, 0);
    assert.equal(state.failedDeliveries, 1);
    assert.equal(result.delivery.ok, false);
  });
});
