#!/usr/bin/env node
// cah-rewake — wakes a Claude Code session whose turn an API error cut off.
//
//   wait   StopFailure hook (async + asyncRewake). Backs off, then exits 2:
//          Claude Code wakes the idle session with the stderr text.
//   reset  Stop hook (async). A completed turn clears the session's attempts.
//
// Fail-silent: any unexpected state ends with exit 0 (no wake).

import {
  appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_ATTEMPTS = 6;
export const BASE_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 900_000;
// The transcript baseline is taken after this settle time, once Claude Code has
// written the error turn itself.
const SETTLE_MS = 5_000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_SCAN_CAP = 256;
const LOG_MAX_BYTES = 256 * 1024;
const DETAILS_MAX = 300;

// Errors a wake cannot fix, plus rate_limit: Claude Code resumes usage limits itself.
export const SKIPPED_ERRORS = Object.freeze(new Set([
  'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
  'invalid_request', 'model_not_found', 'cloud_credential_error', 'max_output_tokens', 'rate_limit',
]));

// 60 s, 120 s, 240 s, 480 s, then 900 s.
export function delayFor(attempt) {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

function cacheDir(env) {
  return join(env.CAH_REWAKE_HOME || homedir(), '.claude', 'cah-bin', 'cache');
}

function sessionKey(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex');
}

function statePath(env, sessionId) {
  return join(cacheDir(env), 'rewake', `${sessionKey(sessionId)}.json`);
}

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(state?.attempts) && state.attempts > 0 ? state : null;
  } catch { return null; }
}

function writeState(path, state) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(state) + '\n');
  renameSync(tmp, path);
}

function pruneStates(dir, nowMs) {
  let names;
  try { names = readdirSync(dir).slice(0, STATE_SCAN_CAP); } catch { return; }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(dir, name);
    try { if (nowMs - statSync(path).mtimeMs > STATE_TTL_MS) rmSync(path, { force: true }); } catch { /* raced */ }
  }
}

function log(env, record) {
  try {
    const dir = cacheDir(env);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'rewake.log');
    try { if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`); } catch { /* no log yet */ }
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch { /* logging is best effort */ }
}

function transcriptSize(path) {
  try { return statSync(path).size; } catch { return null; }
}

function testDelayMs(env) {
  if (env.CAH_TEST_ONLY !== '1') return null;
  const value = Number(env.CAH_TEST_ONLY_REWAKE_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function wakeMessage(error, details, attempt) {
  const why = details ? `${error}: ${details}` : error;
  return `cah-rewake: the previous turn was cut off by an API error (${why}); attempt ${attempt} of ${MAX_ATTEMPTS}. `
    + 'Continue the interrupted work from where it stopped. If the last action may have been applied in part, '
    + 'check its result before repeating it. If nothing was in progress, reply in one short line.';
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Returns { code, message }: code 2 wakes the session with message.
export async function wait(payload, env = process.env) {
  const sessionId = payload?.session_id;
  if (!sessionId) return { code: 0 };
  const error = typeof payload.error === 'string' && payload.error ? payload.error : 'unknown';
  const details = typeof payload.error_details === 'string' ? payload.error_details.slice(0, DETAILS_MAX) : '';
  const session = sessionKey(sessionId).slice(0, 12);
  const path = statePath(env, sessionId);
  pruneStates(join(path, '..'), Date.now());
  if (SKIPPED_ERRORS.has(error)) {
    log(env, { session, error, details, action: 'skip' });
    return { code: 0 };
  }
  const attempt = (readState(path)?.attempts || 0) + 1;
  if (attempt > MAX_ATTEMPTS) {
    log(env, { session, error, details, action: 'give-up' });
    return { code: 0 };
  }
  writeState(path, { attempts: attempt, at: Date.now() });
  const testDelay = testDelayMs(env);
  const delay = testDelay ?? delayFor(attempt);
  const settle = Math.min(testDelay === null ? SETTLE_MS : 0, delay);
  log(env, { session, error, details, action: 'wait', attempt, delayMs: delay });
  await sleep(settle);
  const baseline = transcriptSize(payload.transcript_path);
  await sleep(delay - settle);
  // The user (or anything else) moved the session on, or a turn completed.
  if (transcriptSize(payload.transcript_path) !== baseline || !readState(path)) {
    log(env, { session, error, action: 'moved-on', attempt });
    return { code: 0 };
  }
  log(env, { session, error, action: 'wake', attempt });
  return { code: 2, message: wakeMessage(error, details, attempt) };
}

export function reset(payload, env = process.env) {
  if (!payload?.session_id) return;
  rmSync(statePath(env, payload.session_id), { force: true });
}

async function run() {
  const mode = process.argv[2];
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return 0; }
  if (mode === 'reset') {
    reset(payload);
    return 0;
  }
  if (mode !== 'wait') return 0;
  const outcome = await wait(payload);
  if (outcome.code === 2) process.stderr.write(outcome.message + '\n');
  return outcome.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then((code) => process.exit(code), () => process.exit(0));
}
