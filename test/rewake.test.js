import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { MAX_ATTEMPTS, delayFor, reset, wait } from '../bin/cah-rewake.js';
import { RewakeSettingsError, readRewakeState, rewakeHooks, updateRewake } from '../lib/rewake.js';

const bin = fileURLToPath(new URL('../bin/cah-rewake.js', import.meta.url));
const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-rewake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function testEnv(home, delayMs = 20) {
  return { CAH_REWAKE_HOME: home, CAH_TEST_ONLY: '1', CAH_TEST_ONLY_REWAKE_DELAY_MS: String(delayMs) };
}

function payload(dir, extra = {}) {
  const transcript = join(dir, 'transcript.jsonl');
  if (!existsSync(transcript)) writeFileSync(transcript, '{}\n');
  return { session_id: 's-1', transcript_path: transcript, hook_event_name: 'StopFailure',
    error: 'unknown', error_details: 'Connection lost mid-response', ...extra };
}

function events(home) {
  const path = join(home, '.claude', 'cah-bin', 'cache', 'rewake.log');
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line).action);
}

describe('cah-rewake bin', () => {
  it('backs off 60 s, doubling up to 900 s', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(delayFor), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it('wakes with an attempt count, and a completed turn resets it', async (t) => {
    const dir = sandbox(t);
    const env = testEnv(dir);
    const first = await wait(payload(dir), env);
    assert.equal(first.code, 2);
    assert.match(first.message, /Connection lost mid-response\); attempt 1 of 6\. Continue the interrupted work/);
    assert.match((await wait(payload(dir), env)).message, /attempt 2 of 6/);
    reset({ session_id: 's-1' }, env);
    assert.match((await wait(payload(dir), env)).message, /attempt 1 of 6/);
  });

  it(`gives up after ${MAX_ATTEMPTS} tries in a row`, async (t) => {
    const dir = sandbox(t);
    const env = testEnv(dir, 0);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) assert.equal((await wait(payload(dir), env)).code, 2);
    assert.equal((await wait(payload(dir), env)).code, 0);
    assert.equal(events(dir).at(-1), 'give-up');
  });

  it('never wakes for errors a wake cannot fix', async (t) => {
    const dir = sandbox(t);
    for (const error of ['rate_limit', 'billing_error', 'authentication_failed', 'invalid_request']) {
      assert.equal((await wait(payload(dir, { error }), testEnv(dir))).code, 0, error);
    }
    assert.deepEqual(events(dir), ['skip', 'skip', 'skip', 'skip']);
  });

  it('stays quiet when the session moved on during the wait', async (t) => {
    const dir = sandbox(t);
    const input = payload(dir);
    const pending = wait(input, testEnv(dir, 400));
    setTimeout(() => appendFileSync(input.transcript_path, '{"type":"user"}\n'), 150);
    assert.equal((await pending).code, 0);
    assert.equal(events(dir).at(-1), 'moved-on');
  });

  it('exits 2 with the message on stderr as a hook process', (t) => {
    const dir = sandbox(t);
    const run = spawnSync(process.execPath, [bin, 'wait'], {
      input: JSON.stringify(payload(dir, { error: 'overloaded', error_details: '' })),
      env: { ...process.env, ...testEnv(dir) }, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
    });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /^cah-rewake: the previous turn was cut off by an API error \(overloaded\)/);
    const garbage = spawnSync(process.execPath, [bin, 'wait'], {
      input: 'not json', env: { ...process.env, ...testEnv(dir) }, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
    });
    assert.equal(garbage.status, 0, 'fail-silent on a malformed payload');
  });
});

describe('rewake settings wiring', () => {
  const BIN = 'C:/Users/me/.claude/cah-bin/bin/cah-rewake.js';

  it('adds both hooks, keeps foreign ones, and removes only its own', (t) => {
    const dir = sandbox(t);
    const path = join(dir, 'settings.json');
    const foreign = { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] };
    writeFileSync(path, JSON.stringify({ model: 'x', hooks: { Stop: [foreign] } }, null, 2) + '\n');

    assert.equal(updateRewake(path, 'enable', { binPath: BIN }), 'enabled');
    assert.equal(updateRewake(path, 'enable', { binPath: BIN }), 'already-enabled');
    assert.equal(readRewakeState(path, BIN), 'enabled');
    const on = JSON.parse(readFileSync(path, 'utf8'));
    const wanted = rewakeHooks(BIN);
    assert.deepEqual(on.hooks.Stop, [foreign, wanted.Stop]);
    assert.deepEqual(on.hooks.StopFailure, [wanted.StopFailure]);
    assert.equal(on.hooks.StopFailure[0].hooks[0].asyncRewake, true);
    assert.equal(on.hooks.StopFailure[0].hooks[0].command, `node "${BIN}" wait`);

    assert.equal(updateRewake(path, 'enable', { binPath: 'D:/other/cah-rewake.js' }), 'updated');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.StopFailure.length, 1);

    assert.equal(updateRewake(path, 'disable'), 'disabled');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'x', hooks: { Stop: [foreign] } });
    assert.equal(updateRewake(path, 'disable'), 'not-enabled');
    assert.equal(readRewakeState(path, BIN), 'disabled');
  });

  it('creates a missing file and refuses invalid JSON or an unsafe bin path', (t) => {
    const dir = sandbox(t);
    const fresh = join(dir, 'new', 'settings.json');
    assert.equal(updateRewake(fresh, 'disable'), 'not-enabled');
    assert.equal(existsSync(fresh), false);
    assert.equal(updateRewake(fresh, 'enable', { binPath: BIN }), 'enabled');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ nope');
    assert.throws(() => updateRewake(broken, 'enable', { binPath: BIN }), RewakeSettingsError);
    assert.equal(readFileSync(broken, 'utf8'), '{ nope');
    assert.throws(() => rewakeHooks('C:/Users/$me/cah-rewake.js'), RewakeSettingsError);
  });
});

describe('cah rewake', () => {
  function run(home, ccgp, ...args) {
    return spawnSync(process.execPath, [cli, 'rewake', ...args], {
      cwd: home, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
      env: { ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgp },
    });
  }

  it('global scope covers ~/.claude and every ccgp profile; --cwd only the project', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const ccgp = join(dir, 'ccgp');
    const profile = join(ccgp, 'claude', 'work');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, '.ccgp-mirror.ktav'), 'files: []\n');
    const project = join(dir, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });

    mkdirSync(home);
    const missing = run(home, ccgp, 'on');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cah install --only bins/);

    const binPath = join(home, '.claude', 'cah-bin', 'bin', 'cah-rewake.js');
    mkdirSync(join(binPath, '..'), { recursive: true });
    writeFileSync(binPath, '// placeholder\n');

    const on = run(home, ccgp, 'on');
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^global \(.*\): enabled$/m);
    assert.match(on.stdout, /^ccgp profile work \(.*\): enabled$/m);
    assert.equal(readRewakeState(join(home, '.claude', 'settings.json'), binPath), 'enabled');
    assert.equal(readRewakeState(join(profile, 'settings.json'), binPath), 'enabled');

    const local = run(home, ccgp, 'on', '--cwd', project);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /^project \(.*\): enabled$/m);
    assert.doesNotMatch(local.stdout, /ccgp profile/);

    const status = run(home, ccgp, 'status');
    assert.match(status.stdout, /: enabled\n[\s\S]*last events: none yet/);

    const off = run(home, ccgp, 'off');
    assert.equal(off.status, 0, off.stderr);
    assert.equal(readRewakeState(join(profile, 'settings.json'), binPath), 'disabled');
    assert.equal(readRewakeState(join(project, '.claude', 'settings.json'), binPath), 'enabled');

    assert.equal(run(home, ccgp, 'sideways').status, 2);
    assert.equal(run(home, ccgp, 'on', '--global', '--local').status, 2);
  });
});
