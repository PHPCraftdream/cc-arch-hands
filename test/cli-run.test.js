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
    name: 'run', arguments: { taskName: jobs[0]?.id, jobs, ...extraArgs }, _meta: { threadId: THREAD },
  });
  const acknowledgment = JSON.parse(toolText(reply));
  assert.deepEqual(Object.keys(acknowledgment), ['taskName', 'uid']);
  const started = {
    ...acknowledgment,
    runId: acknowledgment.uid,
    statusDir: join(env.CODEX_HOME, 'cli-run', 'runs', acknowledgment.uid),
  };
  return { mcp, started };
}

async function statusOf(mcp, query) {
  return JSON.parse(toolText(await mcp.request('tools/call', { name: 'status', arguments: { query } })));
}

async function logsOf(mcp, query, extraArgs = {}) {
  return JSON.parse(toolText(await mcp.request('tools/call', { name: 'logs', arguments: { query, ...extraArgs } })));
}

describe('cli-run worker', () => {
  it('queues one short task completion and serves full output through logs', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-tail-');
    const env = mcpEnv(dir);
    const outputLines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    const output = `${outputLines.join('\n')}\n`;
    const script = `process.stdout.write(${JSON.stringify(output)}); void "release: 0.12.1"`;
    const { mcp, started } = await runJobs(t, env, [
      { id: 'tail', argv: [process.execPath, '-e', script], cwd: dir },
    ], { showOutput: true });
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.equal(notification, `queue|${THREAD}|cli-run ${started.uid}: tail completed (1/1 succeeded)\n`);
    assert.equal(started.taskName, 'tail');
    assert.equal(started.uid, started.runId);
    const status = await statusOf(mcp, started.runId);
    assert.equal(status.taskName, 'tail');
    assert.equal(status.completionDelivery.ok, true);
    assert.equal(readFileSync(status.results[0].log, 'utf8'), output);
    const viewed = (await logsOf(mcp, 'tail')).logs[0];
    assert.equal(viewed.log, status.results[0].log);
    assert.equal(viewed.text, output);
    await mcp.close();
  });

  it('caps log tool output but preserves the full log', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-tail-long-');
    const env = mcpEnv(dir);
    const output = `${'x'.repeat(2500)}tail-marker\n`;
    const { mcp, started } = await runJobs(t, env, [{
      id: 'long-line', argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`], cwd: dir,
    }], { showOutput: true });
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.ok(!notification.includes('tail-marker'));
    const viewed = await logsOf(mcp, started.uid, { jobId: 'long-line', tailBytes: 128 });
    assert.equal(viewed.logs[0].text.length, 128);
    assert.equal(viewed.logs[0].truncated, true);
    assert.ok(viewed.logs[0].text.endsWith('tail-marker\n'));
    const status = await statusOf(mcp, started.runId);
    assert.equal(readFileSync(status.results[0].log, 'utf8'), output);
    await mcp.close();
  });

  it('reports spawn errors and completes the run', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-spawn-error-');
    const env = mcpEnv(dir);
    const { mcp, started } = await runJobs(t, env, [
      { id: 'missing', argv: [join(dir, 'missing-executable')], cwd: dir },
    ], { showOutput: true });
    await waitForPath(join(started.statusDir, 'finished.json'), 5000);

    const state = await statusOf(mcp, started.runId);
    assert.equal(state.completed, 1);
    assert.equal(state.delivered, 1);
    assert.equal(state.results[0].exitCode, null);
    assert.match(state.results[0].error, /ENOENT/);
    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.match(notification, /missing finished with 1\/1 failed/);
    assert.equal((await logsOf(mcp, started.uid)).logs[0].text, '');
    await mcp.close();
  });

  it('returns before parallel commands finish, then queues one aggregate result', async (t) => {
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
      "  fs.writeSync(1, 'job-running\\n');",
      "  fs.writeFileSync(ready, String(server.address().port));",
      '});',
    ].join('\n');
    const { mcp, started } = await runJobs(t, env, [
      { id: 'first', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: dir },
      { id: 'second', argv: [process.execPath, '-e', secondScript], cwd: dir },
    ], { taskName: 'parallel task', maxParallel: 2 });
    const { runId, statusDir } = started;
    assert.equal(runId.length, 36);
    assert.ok(!existsSync(join(statusDir, 'second.result.json')));
    await Promise.all([
      waitForPath(join(statusDir, 'first.result.json'), 30_000),
      waitForPath(secondReady, 30_000),
    ]);
    assert.ok(!existsSync(join(statusDir, 'completion.delivery.json')));
    assert.ok(!existsSync(join(statusDir, 'second.result.json')));
    const running = await statusOf(mcp, 'parallel task');
    assert.equal(running.uid, runId);
    assert.equal(running.completed, 1);
    assert.equal(running.finishedAt, null);
    assert.match((await logsOf(mcp, runId, { jobId: 'second' })).logs[0].text, /job-running/);
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
    assert.equal(result.delivered, 1);
    assert.equal(result.failedDeliveries, 0);
    assert.deepEqual(result.results.map((entry) => entry.exitCode).sort(), [0, 7]);
    const messages = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.equal(messages, `queue|${THREAD}|cli-run ${runId}: parallel task finished with 1/2 failed\n`);
    await mcp.close();
  });

  it('keeps job output out of the chat unless showOutput is set', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-hidden-');
    const env = mcpEnv(dir);
    const secret = 'SECRET-TOKEN-4f9c';
    // The secret appears only in the output, never in the command line itself.
    const { mcp, started } = await runJobs(t, env, [
      { id: 'secret', argv: [process.execPath, '-e', "console.log(['SECRET', 'TOKEN', '4f9c'].join('-'))"], cwd: dir },
    ]);
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const notification = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.match(notification, new RegExp(`cli-run ${started.uid}: secret completed`));
    assert.ok(!notification.includes(secret), notification);
    assert.ok(!notification.includes('command:'), notification);
    const status = await statusOf(mcp, started.runId);
    assert.ok(!JSON.stringify(status).includes(secret));
    assert.equal(readFileSync(status.results[0].log, 'utf8').trim(), secret);
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
    assert.equal(state.completionDelivery.ok, false);
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
  it('returns long-job output inline without a thread or queue delivery', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-inline-');
    const env = mcpEnv(dir, { CLI_RUN_TEST_QUEUE_FAIL: '1' });
    const mcp = startMcp(t, env);
    const output = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n') + '\n';
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: {
        taskName: 'native build',
        jobs: [{ id: 'build', argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)}); process.exitCode = 3`], cwd: dir }],
        delivery: 'inline', showOutput: true,
      },
    });
    const completed = JSON.parse(toolText(reply));
    assert.equal(completed.jobs, 1);
    assert.equal(completed.taskName, 'native build');
    assert.equal(completed.uid, completed.runId);
    assert.equal(completed.completed, 1);
    assert.ok(completed.finishedAt);
    assert.equal(completed.results[0].exitCode, 3);
    assert.deepEqual(completed.results[0].output, { text: output, truncated: false });
    assert.equal(readFileSync(completed.results[0].log, 'utf8'), output);
    assert.equal(existsSync(env.CLI_RUN_TEST_QUEUE_LOG), false);
    const status = await statusOf(mcp, completed.runId);
    assert.equal(status.deliveryMode, 'inline');
    assert.equal(status.failedDeliveries, 0);
    assert.equal(status.results[0].delivery, undefined);
    await mcp.close();
  });

  it('bounds inline output but preserves the full log', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-inline-cap-');
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: {
        taskName: 'big build',
        jobs: [{ id: 'build', argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(70000))"], cwd: dir }],
        delivery: 'inline', showOutput: true,
      },
    });
    const completed = JSON.parse(toolText(reply));
    assert.equal(completed.results[0].output.text.length, 64 * 1024);
    assert.equal(completed.results[0].output.truncated, true);
    assert.equal(readFileSync(completed.results[0].log, 'utf8').length, 70000);
    assert.equal(existsSync(env.CLI_RUN_TEST_QUEUE_LOG), false);
    await mcp.close();
  });

  it('hides inline output unless requested', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-inline-hidden-');
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: {
        taskName: 'private build',
        jobs: [{ id: 'build', argv: [process.execPath, '-e', "console.log(['private', 'output'].join('-'))"], cwd: dir }],
        delivery: 'inline',
      },
    });
    const completed = JSON.parse(toolText(reply));
    assert.equal(completed.results[0].output, undefined);
    assert.ok(!JSON.stringify(completed).includes('private-output'));
    assert.equal(readFileSync(completed.results[0].log, 'utf8').trim(), 'private-output');
    await mcp.close();
  });

  it('resolves repeated task names to the newest UID while older UIDs remain readable', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-names-');
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const launch = async (value) => {
      const reply = await mcp.request('tools/call', {
        name: 'run',
        arguments: {
          taskName: 'same task',
          jobs: [{ id: 'output', argv: [process.execPath, '-e', `console.log(${JSON.stringify(value)})`], cwd: dir }],
        },
        _meta: { threadId: THREAD },
      });
      const acknowledgment = JSON.parse(toolText(reply));
      assert.deepEqual(Object.keys(acknowledgment), ['taskName', 'uid']);
      const started = {
        ...acknowledgment,
        statusDir: join(env.CODEX_HOME, 'cli-run', 'runs', acknowledgment.uid),
      };
      await waitForPath(join(started.statusDir, 'finished.json'), 30_000);
      return started;
    };
    const first = await launch('first');
    const second = await launch('second');
    assert.notEqual(first.uid, second.uid);
    assert.equal((await statusOf(mcp, 'same task')).uid, second.uid);
    assert.equal((await statusOf(mcp, first.uid)).uid, first.uid);
    assert.equal((await logsOf(mcp, 'same task')).logs[0].text.trim(), 'second');
    assert.equal((await logsOf(mcp, first.uid)).logs[0].text.trim(), 'first');
    for (const args of [{ jobId: '../status.json' }, { tailBytes: 0 }, { jobId: 'missing' }]) {
      const reply = await mcp.request('tools/call', {
        name: 'logs', arguments: { query: second.uid, ...args },
      });
      assert.equal(reply.result.isError, true);
    }
    await mcp.close();
  });

  it('initializes and lists run, status, and logs tools', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-mcp-init-');
    const mcp = startMcp(t, mcpEnv(dir));
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    mcp.notify('notifications/initialized');
    const list = await mcp.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['run', 'status', 'logs']);
    assert.deepEqual(list.result.tools.map((tool) => tool.title),
      ['Запустить задачу', 'Статус задачи', 'Логи задачи']);
    assert.deepEqual(list.result.tools[0].inputSchema.required, ['taskName', 'jobs']);
    const unknownTool = await mcp.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    const unknownMethod = await mcp.request('resources/list', {});
    assert.equal(unknownMethod.error.code, -32601);
    const parseError = await mcp.raw('{not json');
    assert.equal(parseError.error.code, -32700);
    const missingRun = await mcp.request('tools/call', {
      name: 'status', arguments: { query: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(missingRun.result.isError, true);
    const missingLogs = await mcp.request('tools/call', {
      name: 'logs', arguments: { query: 'unknown task' },
    });
    assert.equal(missingLogs.result.isError, true);
    await mcp.close();
  });

  it('routes completion messages to the thread named in the call metadata', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-mcp-run-');
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: { taskName: 'repository check', jobs: [
        { id: 'ok', argv: [process.execPath, '-e', 'console.log(process.cwd())'] },
        { id: 'fails', argv: [process.execPath, '-e', 'process.exit(3)'], cwd: dir },
      ] },
      _meta: {
        threadId: 'thread-from-meta',
        'x-codex-turn-metadata': { thread_id: 'ignored', workspaces: { [dir]: {} } },
      },
    });
    const started = JSON.parse(toolText(reply));
    assert.deepEqual(Object.keys(started), ['taskName', 'uid']);
    await waitForPath(join(env.CODEX_HOME, 'cli-run', 'runs', started.uid, 'finished.json'), 30_000);

    const messages = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.equal(messages, `queue|thread-from-meta|cli-run ${started.uid}: repository check finished with 1/2 failed\n`);

    const status = await statusOf(mcp, started.uid);
    assert.equal(status.completed, 2);
    assert.equal(status.delivered, 1);
    assert.equal((await logsOf(mcp, started.uid, { jobId: 'ok' })).logs[0].text.trim(), dir);
    await mcp.close();
  });

  it('falls back to the turn metadata thread ID', async (t) => {
    const dir = sandbox(t, 'cah-cli-run-mcp-fallback-');
    const env = mcpEnv(dir);
    const mcp = startMcp(t, env);
    const reply = await mcp.request('tools/call', {
      name: 'run',
      arguments: { taskName: 'fallback', jobs: [{ id: 'ok', argv: [process.execPath, '-e', '0'], cwd: dir }] },
      _meta: { 'x-codex-turn-metadata': { thread_id: 'thread-from-turn' } },
    });
    const started = JSON.parse(toolText(reply));
    assert.deepEqual(Object.keys(started), ['taskName', 'uid']);
    await waitForPath(join(env.CODEX_HOME, 'cli-run', 'runs', started.uid, 'finished.json'), 30_000);
    assert.match(readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8'), /queue\|thread-from-turn\|cli-run .*fallback completed/);
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

    await refused({ taskName: 'test', jobs: [job] }, undefined, /thread ID/);
    await refused({ jobs: [job] }, meta, /taskName/);
    await refused({ taskName: '   ', jobs: [job] }, meta, /taskName/);
    await refused({ taskName: 'bad\nname', jobs: [job] }, meta, /taskName/);
    await refused({ taskName: 'test', jobs: [{ ...job, cwd: 'relative' }] }, meta, /absolute path/);
    await refused({ taskName: 'test', jobs: [{ id: 'ok', argv: [process.execPath, '-e', '0'] }] },
      { ...meta, 'x-codex-turn-metadata': { workspaces: { [dir]: {}, [tmpdir()]: {} } } }, /absolute path/);
    await refused({ taskName: 'test', jobs: [job], maxParallel: 99 }, meta, /max-parallel/);
    await refused({ taskName: 'test', jobs: [job], showOutput: 'yes' }, meta, /showOutput must be a boolean/);
    await refused({ taskName: 'test', jobs: [job], delivery: 'unknown' }, meta, /delivery must be queue or inline/);
    await refused({ taskName: 'test', jobs: [job, job] }, meta, /duplicate command id/);
    await refused({ taskName: 'test', jobs: [] }, meta, /1-64/);

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

  it('delivers quoted task names unchanged through the real codex launcher', async (t) => {
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

    const taskName = 'build "JARs" & native / a b';
    const line = '{"conclusion":"success","jobs":[{"name":"build JARs"}]}';
    const { mcp, started } = await runJobs(t, env, [
      { id: 'json-output', argv: [process.execPath, '-e', `console.log(${JSON.stringify(line)})`], cwd: dir },
    ], { taskName, showOutput: true });
    await waitForPath(join(started.statusDir, 'finished.json'), 30_000);

    const status = await statusOf(mcp, started.runId);
    assert.equal(status.completionDelivery.ok, true, JSON.stringify(status.completionDelivery));
    const delivered = readFileSync(env.CLI_RUN_TEST_QUEUE_LOG, 'utf8');
    assert.equal(delivered, `queue|${THREAD}|cli-run ${started.uid}: ${taskName} completed (1/1 succeeded)\n`);
    assert.equal((await logsOf(mcp, taskName)).logs[0].text.trim(), line);
    await mcp.close();
  });
});
