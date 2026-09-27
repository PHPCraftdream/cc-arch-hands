import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
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

  it('launch --wait keeps the launcher alive until the worker finishes', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-wait-'));
    const queueLog = join(dir, 'queue.log');
    const server = createServer();
    let workerSocket;
    let launcher;
    let launcherClosed;
    t.after(async () => {
      if (workerSocket && !workerSocket.destroyed) workerSocket.end('release');
      if (server.listening) server.close();
      if (launcher && launcherClosed && launcher.exitCode === null && launcher.signalCode === null) {
        const killTimer = setTimeout(() => launcher.kill(), 5000);
        await launcherClosed;
        clearTimeout(killTimer);
      }
      rmSync(dir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    let resolveWorkerReady;
    const workerReady = new Promise((resolve) => { resolveWorkerReady = resolve; });
    server.once('connection', (socket) => {
      workerSocket = socket;
      let message = '';
      socket.on('data', (chunk) => {
        message += chunk.toString();
        if (message.includes('ready')) resolveWorkerReady(socket);
      });
    });

    const script = [
      "const net = require('node:net');",
      'let released = false;',
      `const socket = net.createConnection(${port}, '127.0.0.1');`,
      "socket.once('connect', () => socket.write('ready'));",
      "socket.on('data', () => { released = true; socket.end(); });",
      "socket.once('close', () => { if (!released) process.exitCode = 1; });",
      "socket.once('error', () => { process.exitCode = 1; });",
    ].join('\n');
    const env = {
      ...process.env,
      CODEX_HOME: join(dir, 'codex-home'),
      CODEX_THREAD_ID: 'thread-test',
      CLI_RUN_TEST_QUEUE_LOG: queueLog,
      CLI_RUN_CODEX_CLI: fakeCli,
    };
    launcher = spawn(process.execPath, [cli, 'launch', '--spec', '-', '--wait'], {
      cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ackSettled = false;
    const launchAck = new Promise((resolve, reject) => {
      launcher.stdout.setEncoding('utf8');
      launcher.stderr.setEncoding('utf8');
      launcher.stdout.on('data', (chunk) => {
        stdout += chunk;
        const lineEnd = stdout.indexOf('\n');
        if (lineEnd < 0 || ackSettled) return;
        ackSettled = true;
        try { resolve(JSON.parse(stdout.slice(0, lineEnd))); } catch (error) { reject(error); }
      });
      launcher.stderr.on('data', (chunk) => { stderr += chunk; });
      launcher.once('error', reject);
      launcher.once('close', (code, signal) => {
        if (!ackSettled) reject(new Error(stderr || `launcher exited ${code ?? signal}`));
      });
    });
    launcherClosed = new Promise((resolve) => {
      launcher.once('close', (code, signal) => resolve({ code, signal }));
    });
    launcher.stdin.end(JSON.stringify([{
      id: 'waited', argv: [process.execPath, '-e', script],
    }]));

    const [started, socket] = await Promise.all([launchAck, workerReady]);
    const finishedPath = join(started.statusDir, 'finished.json');
    assert.equal(started.commands, 1);
    assert.ok(!existsSync(finishedPath));
    assert.equal(launcher.exitCode, null);
    socket.end('release');

    const { code } = await launcherClosed;
    assert.equal(code, 0, stderr);
    assert.ok(existsSync(finishedPath));
    assert.equal(JSON.parse(readFileSync(join(started.statusDir, 'waited.result.json'), 'utf8')).exitCode, 0);
    assert.equal(JSON.parse(readFileSync(join(started.statusDir, 'waited.delivery.json'), 'utf8')).ok, true);
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

const mcpServer = join(root, 'templates', 'codex-skills', 'cli-run', 'scripts', 'mcp-server.mjs');

function startMcp(t, env) {
  const child = spawn(process.execPath, [mcpServer], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const pending = new Map();
  const received = [];
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      received.push(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    received,
    request(method, params) {
      const id = nextId++;
      const reply = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return reply;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async close() {
      child.stdin.end();
      const code = await exited;
      assert.equal(code, 0, stderr);
    },
  };
}

function mcpEnv(dir, extra = {}) {
  const env = {
    ...process.env,
    CODEX_HOME: join(dir, 'codex-home'),
    CLI_RUN_TEST_QUEUE_LOG: join(dir, 'queue.log'),
    CLI_RUN_CODEX_CLI: fakeCli,
    ...extra,
  };
  delete env.CODEX_THREAD_ID;
  return env;
}

function toolText(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.notEqual(reply.result.isError, true, reply.result.content?.[0]?.text);
  return reply.result.content[0].text;
}

describe('cli-run MCP server', () => {
  it('initializes and lists only the run and status tools', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-mcp-init-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mcp = startMcp(t, mcpEnv(dir));
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    mcp.notify('notifications/initialized');
    const list = await mcp.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['run', 'status']);
    assert.deepEqual(list.result.tools[0].inputSchema.required, ['jobs']);
    const unknownTool = await mcp.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    const unknownMethod = await mcp.request('resources/list', {});
    assert.equal(unknownMethod.error.code, -32601);
    await mcp.close();
  });

  it('routes completion messages to the thread named in the call metadata', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-mcp-run-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: { jobs: [
        { id: 'ok', argv: [process.execPath, '-e', 'console.log(process.cwd())'] },
        { id: 'fails', argv: [process.execPath, '-e', 'process.exit(3)'], cwd: dir },
      ] },
      _meta: {
        threadId: 'thread-from-meta',
        'x-codex-turn-metadata': { thread_id: 'ignored', workspaces: { [dir]: {} } },
      },
    });
    const started = JSON.parse(toolText(reply));
    assert.equal(started.jobs, 2);
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const messages = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.match(messages, new RegExp(`queue\|thread-from-meta\|cli-run ${started.runId}: ok exited 0`));
    assert.match(messages, new RegExp(`queue\|thread-from-meta\|cli-run ${started.runId}: fails exited 3`));
    assert.ok(messages.includes(dir), 'job without cwd runs in the single workspace root');

    const status = JSON.parse(toolText(await mcp.request('tools/call', {
      name: 'status', arguments: { runId: started.runId },
    })));
    assert.equal(status.completed, 2);
    assert.equal(status.delivered, 2);
    await mcp.close();
  });

  it('falls back to the turn metadata thread ID', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-mcp-fallback-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: { jobs: [{ id: 'ok', argv: [process.execPath, '-e', '0'], cwd: dir }] },
      _meta: { 'x-codex-turn-metadata': { thread_id: 'thread-from-turn' } },
    });
    const { statusDir } = JSON.parse(toolText(reply));
    await waitForPath(join(statusDir, 'finished.json'), 30_000);
    assert.match(readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8'), /queue\|thread-from-turn\|cli-run /);
    await mcp.close();
  });

  it('refuses runs it cannot route or place without starting a worker', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-mcp-refuse-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const job = { id: 'ok', argv: [process.execPath, '-e', '0'], cwd: dir };

    const noThread = await mcp.request('tools/call', { name: 'run', arguments: { jobs: [job] } });
    assert.equal(noThread.result.isError, true);
    assert.match(noThread.result.content[0].text, /thread ID/);

    const meta = { threadId: 'thread-test' };
    const relative = await mcp.request('tools/call', {
      name: 'run', arguments: { jobs: [{ ...job, cwd: 'relative' }] }, _meta: meta,
    });
    assert.equal(relative.result.isError, true);
    assert.match(relative.result.content[0].text, /absolute path/);

    const twoRoots = await mcp.request('tools/call', {
      name: 'run',
      arguments: { jobs: [{ id: 'ok', argv: [process.execPath, '-e', '0'] }] },
      _meta: { ...meta, 'x-codex-turn-metadata': { workspaces: { [dir]: {}, [tmpdir()]: {} } } },
    });
    assert.equal(twoRoots.result.isError, true);

    const badParallel = await mcp.request('tools/call', {
      name: 'run', arguments: { jobs: [job], maxParallel: 99 }, _meta: meta,
    });
    assert.equal(badParallel.result.isError, true);
    assert.match(badParallel.result.content[0].text, /max-parallel/);

    assert.ok(!existsSync(join(env.CODEX_HOME, 'cli-run', 'runs')));
    await mcp.close();
  });
});
