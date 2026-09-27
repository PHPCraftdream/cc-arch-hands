import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForPath } from '../test-support/installer-test-helpers.js';
import { codexCommand } from '../templates/codex-skills/cli-run/scripts/queue.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scripts = join(root, 'templates', 'codex-skills', 'cli-run', 'scripts');
const mcpServer = join(scripts, 'mcp-server.mjs');
const workerEntry = join(scripts, 'cli-run.mjs');
const fakeCli = join(root, 'test-support', 'cli-run-fake-codex.mjs');
const THREAD = 'thread-test';

function sandbox(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function startMcp(t, env) {
  const child = spawn(process.execPath, [mcpServer], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const pending = new Map();
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
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    request(method, params) {
      const id = nextId++;
      const reply = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return reply;
    },
    raw(line) {
      const reply = new Promise((resolve) => pending.set(null, resolve));
      child.stdin.write(`${line}\n`);
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

async function runJobs(t, env, jobs, extraArgs = {}) {
  const mcp = startMcp(t, env);
  const reply = await mcp.request('tools/call', {
    name: 'run', arguments: { jobs, ...extraArgs }, _meta: { threadId: THREAD },
  });
  return { mcp, started: JSON.parse(toolText(reply)) };
}

async function statusOf(mcp, runId) {
  return JSON.parse(toolText(await mcp.request('tools/call', { name: 'status', arguments: { runId } })));
}

describe('cli-run worker', () => {
  it('queues only the last ten output lines while preserving the full log', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-tail-');
    const env = mcpEnv(dir);
    const outputLines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    const output = `${outputLines.join('\n')}\n`;
    const script = `process.stdout.write(${JSON.stringify(output)}); void "release: 0.12.1"`;
    const { mcp, started } = await runJobs(t, env, [
      { id: 'tail', argv: [process.execPath, '-e', script], cwd: dir },
    ]);
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    const tail = notification.split('Last 10 output lines:\n')[1];
    assert.ok(tail, notification);
    assert.ok(notification.includes('command: argv ['), notification);
    assert.ok(notification.includes('release: 0.12.1\\u0022]'), notification);
    assert.deepEqual(tail.trimEnd().split(/\r?\n/), outputLines.slice(-10));
    const status = await statusOf(mcp, started.runId);
    assert.equal(readFileSync(status.results[0].log, 'utf8'), output);
    await mcp.close();
  });

  it('caps long output lines in notifications but preserves them in the log', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-tail-long-');
    const env = mcpEnv(dir);
    const output = `${'x'.repeat(2500)}tail-marker\n`;
    const { mcp, started } = await runJobs(t, env, [{
      id: 'long-line', argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`], cwd: dir,
    }]);
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    const tail = notification.split('Last 1 output lines (long lines truncated):\n')[1]?.trimEnd();
    assert.ok(tail, notification);
    assert.equal(tail.length, 1000);
    assert.ok(tail.endsWith('tail-marker'));
    const status = await statusOf(mcp, started.runId);
    assert.equal(readFileSync(status.results[0].log, 'utf8'), output);
    await mcp.close();
  });

  it('reports spawn errors and completes the run', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-spawn-error-');
    const env = mcpEnv(dir);
    const { mcp, started } = await runJobs(t, env, [
      { id: 'missing', argv: [join(dir, 'missing-executable')], cwd: dir },
    ]);
    await waitForPath(join(started.statusDir, 'finished.json'), 5000);

    const state = await statusOf(mcp, started.runId);
    assert.equal(state.completed, 1);
    assert.equal(state.delivered, 1);
    assert.equal(state.results[0].exitCode, null);
    assert.match(state.results[0].error, /ENOENT/);
    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.match(notification, /failed to start/);
    assert.match(notification, /Last 0 output lines:\n\(no output\)/);
    await mcp.close();
  });

  it('returns before parallel commands finish, then queues each result', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-');
    const env = mcpEnv(dir);
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
    const { mcp, started } = await runJobs(t, env, [
      { id: 'first', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: dir },
      { id: 'second', argv: [process.execPath, '-e', secondScript], cwd: dir },
    ], { maxParallel: 2 });
    const { runId, statusDir } = started;
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
    await waitForPath(join(statusDir, 'finished.json'), 30_000);

    const result = await statusOf(mcp, runId);
    assert.equal(result.completed, 2);
    assert.equal(result.delivered, 2);
    assert.equal(result.failedDeliveries, 0);
    assert.deepEqual(result.results.map((entry) => entry.exitCode).sort(), [0, 7]);
    const messages = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.match(messages, /queue\|thread-test\|cli-run .*first exited 0/);
    assert.match(messages, /queue\|thread-test\|cli-run .*second exited 7/);
    await mcp.close();
  });

  it('records failed queue delivery without claiming a notification', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-queue-fail-');
    const env = mcpEnv(dir, { CLI_RUN_TEST_QUEUE_FAIL: '1' });
    const { mcp, started } = await runJobs(t, env, [
      { id: 'done', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: dir },
    ]);
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);
    const state = await statusOf(mcp, started.runId);
    assert.equal(state.delivered, 0);
    assert.equal(state.failedDeliveries, 1);
    assert.equal(state.results[0].delivery.ok, false);
    await mcp.close();
  });

  it('is not a user-facing launcher', () => {
    const result = spawnSync(process.execPath, [workerEntry, 'launch', '--spec', '-'], {
      input: '[]', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /internal worker entry; use the cli-run MCP tools/);
  });
});

describe('cli-run MCP server', () => {
  it('initializes and lists only the run and status tools', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-mcp-init-');
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
    const parseError = await mcp.raw('{not json');
    assert.equal(parseError.error.code, -32700);
    const missingRun = await mcp.request('tools/call', {
      name: 'status', arguments: { runId: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(missingRun.result.isError, true);
    await mcp.close();
  });

  it('routes completion messages to the thread named in the call metadata', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-mcp-run-');
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
    assert.match(messages, new RegExp(`queue\\|thread-from-meta\\|cli-run ${started.runId}: ok exited 0`));
    assert.match(messages, new RegExp(`queue\\|thread-from-meta\\|cli-run ${started.runId}: fails exited 3`));
    assert.ok(messages.includes(dir), 'job without cwd runs in the single workspace root');

    const status = await statusOf(mcp, started.runId);
    assert.equal(status.completed, 2);
    assert.equal(status.delivered, 2);
    await mcp.close();
  });

  it('falls back to the turn metadata thread ID', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-mcp-fallback-');
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
    const dir = sandbox(t, 'cah-cli-run-mcp-refuse-');
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const job = { id: 'ok', argv: [process.execPath, '-e', '0'], cwd: dir };
    const meta = { threadId: THREAD };
    const refused = async (args, _meta, pattern) => {
      const reply = await mcp.request('tools/call', { name: 'run', arguments: args, _meta });
      assert.equal(reply.result.isError, true);
      if (pattern) assert.match(reply.result.content[0].text, pattern);
    };

    await refused({ jobs: [job] }, undefined, /thread ID/);
    await refused({ jobs: [{ ...job, cwd: 'relative' }] }, meta, /absolute path/);
    await refused({ jobs: [{ id: 'ok', argv: [process.execPath, '-e', '0'] }] },
      { ...meta, 'x-codex-turn-metadata': { workspaces: { [dir]: {}, [tmpdir()]: {} } } }, /absolute path/);
    await refused({ jobs: [job], maxParallel: 99 }, meta, /max-parallel/);
    await refused({ jobs: [job, job] }, meta, /duplicate command id/);
    await refused({ jobs: [] }, meta, /1-64/);

    assert.ok(!existsSync(join(env.CODEX_HOME, 'cli-run', 'runs')));
    await mcp.close();
  });
});

const FAKE_CODEX_CJS = [
  "const { appendFileSync } = require('node:fs');",
  'const [action, , thread, , message] = process.argv.slice(2);',
  'appendFileSync(process.env.CLI_RUN_TEST_QUEUE_LOG, `${action}|${thread}|${message}\\n`);',
].join('\n');

// Mirrors npm's generated codex.ps1: PowerShell 5.1 re-splits arguments that contain quotes.
const NPM_PS1_SHIM = '& node "$PSScriptRoot/node_modules/@openai/codex/bin/codex.js" $args\nexit $LASTEXITCODE\n';

function installFakeCodex(binDir) {
  const packageBin = join(binDir, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(packageBin, { recursive: true });
  writeFileSync(join(packageBin, 'codex.js'), FAKE_CODEX_CJS);
  writeFileSync(join(binDir, 'codex.ps1'), NPM_PS1_SHIM);
  const shim = join(binDir, 'codex');
  writeFileSync(shim, `#!/usr/bin/env node\n${FAKE_CODEX_CJS}\n`);
  chmodSync(shim, 0o755);
  return join(packageBin, 'codex.js');
}

describe('codex queue delivery', () => {
  it('resolves the npm package launcher on Windows instead of the PowerShell or cmd shim', (t) => {
    const dir = sandbox(t, 'cah-cli-run-resolve-');
    const npmDir = join(dir, 'npm');
    const exeDir = join(dir, 'exe');
    mkdirSync(exeDir);
    const codexJs = installFakeCodex(npmDir);
    writeFileSync(join(exeDir, 'codex.exe'), '');

    assert.deepEqual(codexCommand({ PATH: npmDir }, 'win32'), [process.execPath, codexJs]);
    assert.deepEqual(codexCommand({ Path: `${exeDir};${npmDir}` }, 'win32'), [join(exeDir, 'codex.exe')]);
    assert.deepEqual(codexCommand({ PATH: npmDir }, 'linux'), ['codex']);

    const shimOnly = join(dir, 'shim-only');
    mkdirSync(shimOnly);
    writeFileSync(join(shimOnly, 'codex.ps1'), NPM_PS1_SHIM);
    writeFileSync(join(shimOnly, 'codex.cmd'), '@echo off\r\n');
    assert.throws(() => codexCommand({ PATH: shimOnly }, 'win32'), /codex not found on PATH/);
  });

  it('delivers output with quotes, JSON, and spaces unchanged through the real codex launcher', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-quotes-');
    const binDir = join(dir, 'bin');
    installFakeCodex(binDir);
    const env = mcpEnv(dir);
    delete env.CLI_RUN_CODEX_CLI;
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    // Keep the real system dirs so the npm PowerShell shim stays reachable, as on a real machine.
    const system = process.platform === 'win32' && process.env.SystemRoot
      ? [join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
      : [];
    env.PATH = [binDir, dirname(process.execPath), ...system].join(delimiter);

    const line = '{"conclusion":"success","jobs":[{"name":"build JARs"},{"name":"native / a b"}]} it\'s "done" & | < > ^ %PATH%';
    const { mcp, started } = await runJobs(t, env, [
      { id: 'json-output', argv: [process.execPath, '-e', `console.log(${JSON.stringify(line)})`], cwd: dir },
    ]);
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const status = await statusOf(mcp, started.runId);
    assert.equal(status.results[0].delivery.ok, true, JSON.stringify(status.results[0].delivery));
    const delivered = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.ok(delivered.startsWith(`queue|${THREAD}|cli-run ${started.runId}: json-output exited 0;`), delivered);
    assert.ok(delivered.includes(`Last 1 output lines:\n${line}\n`), delivered);
    await mcp.close();
  });
});
