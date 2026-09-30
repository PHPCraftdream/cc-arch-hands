import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

async function delayedReader(t, args) {
  const home = mkdtempSync(join(tmpdir(), 'cah-cli-output-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pause();
  child.stderr.pause();
  const stdout = [];
  const stderr = [];
  const capture = (stream, chunks) => new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  const stdoutEnded = capture(child.stdout, stdout);
  const stderrEnded = capture(child.stderr, stderr);
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const resume = setTimeout(() => {
    child.stdout.resume();
    child.stderr.resume();
  }, 200);
  const deadline = setTimeout(() => child.kill('SIGTERM'), 10_000);
  try {
    const [result] = await Promise.all([completed, stdoutEnded, stderrEnded]);
    return { ...result, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8') };
  } finally {
    clearTimeout(resume);
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

describe('CLI pipe flushing', () => {
  it('delivers late JSON artifact rows to a reader that initially applies backpressure', async (t) => {
    const result = await delayedReader(t, ['list', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    const rows = result.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.find((row) => row.kind === 'omp-command' && row.name === 'checkpoint'),
      { name: 'checkpoint', kind: 'omp-command', state: 'missing' });
    assert.deepEqual(rows.find((row) => row.kind === 'bin' && row.name === 'lib/update-check.js'),
      { name: 'lib/update-check.js', kind: 'bin', state: 'missing' });
  });

  it('delivers the complete invalid selector diagnostic while preserving its failure exit code', async (t) => {
    const selector = `${'x'.repeat(20 * 1024)}-end`;
    const result = await delayedReader(t, ['install', '--only', selector]);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.ok(result.stderr.includes(selector), 'the diagnostic must retain the entire rejected selector');
  });
});
