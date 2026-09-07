import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync, unlinkSync, rmdirSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  armChildDeadline, timeoutError, DEFAULT_CHILD_DEADLINE_MS, TERMINATION_GRACE_MS,
} from './process-batches.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, 'run-companion.js');
const stampFixtures = new Set();

afterEach(() => {
  for (const fixture of stampFixtures) rmSync(fixture, { recursive: true, force: true });
  stampFixtures.clear();
});

export function stampInvocationEnv(env = {}) {
  const hintHome = env.CAH_STAMP_HINT_HOME
    || mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
  if (!env.CAH_STAMP_HINT_HOME) stampFixtures.add(hintHome);
  const cacheOverride = env.CAH_RATE_LIMITS_CACHE
    || join(hintHome, 'missing-rate-limits.json');
  const throttleOverride = env.CAH_STAMP_THROTTLE_PATH
    || join(hintHome, 'last-stamp.json');
  let updateCacheOverride = env.CAH_UPDATE_CHECK_CACHE;
  if (!updateCacheOverride) {
    updateCacheOverride = join(hintHome, 'update-check.json');
    writeFileSync(updateCacheOverride, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
  }
  return {
    hintHome,
    cacheOverride,
    throttleOverride,
    updateCacheOverride,
    env: {
      ...process.env,
      CAH_TEST_ONLY: '0',
      ...env,
      HOME: hintHome,
      USERPROFILE: hintHome,
      CAH_STAMP_HINT_HOME: hintHome,
      CAH_RATE_LIMITS_CACHE: cacheOverride,
      CAH_STAMP_THROTTLE_PATH: throttleOverride,
      CAH_UPDATE_CHECK_CACHE: updateCacheOverride,
    },
  };
}

export function runStamp(stdinData, env) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const invocation = stampInvocationEnv(env);
  const res = spawnSync(process.execPath, [RUNNER, 'stamp'], {
    input,
    encoding: 'utf8',
    env: invocation.env,
    timeout: DEFAULT_CHILD_DEADLINE_MS,
    killSignal: 'SIGKILL',
  });
  return {
    stdout: res.stdout,
    status: res.status,
    hintHome: invocation.hintHome,
    cachePath: invocation.cacheOverride,
    throttlePath: invocation.throttleOverride,
    updateCachePath: invocation.updateCacheOverride,
  };
}

export async function runStampAsync(
  stdinData,
  env = {},
  { timeoutMs = DEFAULT_CHILD_DEADLINE_MS, graceMs = TERMINATION_GRACE_MS, signal } = {},
) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const invocation = stampInvocationEnv(env);
  const ownsHintHome = !env.CAH_STAMP_HINT_HOME;
  let child = null;
  let closed = false;
  let deadline = null;
  let terminationError = null;
  let stdout = '';
  let closePromise = null;
  const result = { stdout: '', status: null, error: null };
  const onSignalAbort = () => {
    terminationError = timeoutError('stamp child');
    void deadline?.terminate();
  };
  try {
    child = spawn(process.execPath, [RUNNER, 'stamp'], {
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdout.on('error', (error) => { if (!terminationError) terminationError = error; });
    child.stdin.on('error', () => { /* close reports the child result */ });
    child.on('error', (error) => { if (!terminationError) terminationError = error; });
    closePromise = new Promise((resolve) => child.once('close', (status) => {
      closed = true;
      resolve(status);
    }));
    deadline = armChildDeadline(child, {
      timeoutMs,
      graceMs,
      onTimeout: () => { terminationError = timeoutError('stamp child'); },
    });
    if (signal) {
      if (signal.aborted) onSignalAbort();
      else signal.addEventListener('abort', onSignalAbort, { once: true });
    }
    child.stdin.end(input);
    result.status = await closePromise;
    result.stdout = stdout;
    result.error = terminationError;
  } catch (error) {
    result.error = terminationError || error;
  } finally {
    if (signal) signal.removeEventListener('abort', onSignalAbort);
    if (child && !closed) {
      void deadline?.terminate();
    }
    if (closePromise) await closePromise;
    deadline?.clear();
    if (child) {
      child.stdout.removeAllListeners();
      child.stdin.removeAllListeners();
      child.stdout.destroy();
      child.stdin.destroy();
    }
    if (ownsHintHome) rmSync(invocation.hintHome, { recursive: true, force: true });
  }
  return {
    ...result,
    hintHome: invocation.hintHome,
    cachePath: invocation.cacheOverride,
    throttlePath: invocation.throttleOverride,
    updateCachePath: invocation.updateCacheOverride,
  };
}

export function isolatedDir() {
  const path = mkdtempSync(join(tmpdir(), 'cah-stamp-'));
  stampFixtures.add(path);
  return path;
}

export function updateMarkerDir(home) {
  return join(home, '.claude', 'cah-bin', 'cache', 'update-markers');
}

export async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${path}`);
}

export function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

export function stampSidecarPath(base, sessionId) {
  const parent = dirname(base);
  const stateDir = basename(parent) === 'stamp-state' ? parent : join(parent, 'stamp-state');
  mkdirSync(stateDir, { recursive: true });
  return join(stateDir, `${basename(base)}.session-${sessionHash(sessionId)}.json`);
}

export function stampSidecars(base) {
  const prefix = basename(base) + '.session-';
  const parent = dirname(base);
  const stateDir = basename(parent) === 'stamp-state' ? parent : join(parent, 'stamp-state');
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => join(stateDir, name));
}

export function writeClaim(path, owner) {
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
}

export function replaceClaim(path, owner) {
  unlinkSync(join(path, 'owner.json'));
  rmdirSync(path);
  writeClaim(path, owner);
}

export function readClaim(path) {
  return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
}

export function writeTranscript(dir, model, usedTokens) {
  const path = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: { input_tokens: usedTokens, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

export const TIME_RE = /^\d{2}:\d{2}/;
