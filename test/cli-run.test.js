import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'templates', 'codex-skills', 'cli-run', 'scripts', 'cli-run.mjs');
const fakeCli = join(root, 'test-support', 'cli-run-fake-codex.mjs');

function waitFor(path, ready, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const observer = watch(dirname(path), () => check());
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${path}`)), timeoutMs);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      observer.once('close', () => {
        if (error) reject(error); else resolve();
      });
      observer.close();
    }
    observer.on('error', finish);
    function check() {
      try { if (ready()) finish(); } catch (error) { finish(error); }
    }
    check();
  });
}

describe('cli-run worker', () => {
  it('returns before parallel commands finish, then queues each result', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-cli-run-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const queueLog = join(dir, 'queue.log');
    const spec = [
      { id: 'first', argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'] },
      { id: 'second', argv: [process.execPath, '-e', 'setTimeout(() => process.exit(7), 700)'] },
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
    await waitFor(join(statusDir, 'first.delivery.json'), () => {
      if (!existsSync(join(statusDir, 'first.delivery.json'))) return false;
      return JSON.parse(readFileSync(join(statusDir, 'first.delivery.json'), 'utf8')).ok;
    });
    assert.ok(!existsSync(join(statusDir, 'second.result.json')));
    await waitFor(join(statusDir, 'finished.json'), () => existsSync(join(statusDir, 'finished.json')))
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
    await waitFor(join(statusDir, 'finished.json'), () => existsSync(join(statusDir, 'finished.json')));
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
