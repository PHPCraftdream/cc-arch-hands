import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, readdirSync, unlinkSync, rmdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-checkpoint-hint.js');

// Spawn the bin as a black box: feed `stdinJson` (already a string), point
// CAH_HINT_HOME at an isolated home, and capture stdout/exit code.
function runHint(stdin, home, extraEnv = {}) {
  const res = spawnSync(process.execPath, [BIN], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CAH_HINT_HOME: home, ...extraEnv },
  });
  return { stdout: res.stdout, status: res.status };
}

function runHintAsync(stdin, home, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CAH_HINT_HOME: home, ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (status) => resolve({ stdout, status }));
    child.stdin.end(stdin);
  });
}

function isolatedHome() {
  return mkdtempSync(join(tmpdir(), 'cah-hint-'));
}

function cacheDir(home) {
  return join(home, '.claude', 'cah-bin', 'cache');
}

async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${path}`);
}

// Write a JSONL transcript with one line carrying model + usage.input_tokens.
function writeTranscript(home, model, usedTokens) {
  const path = join(home, 'transcript.jsonl');
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

function markerExists(home, sessionId) {
  const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
  return existsSync(join(cacheDir(home), `cah-hint-shown-${hash}`));
}

function writeClaim(path, owner) {
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
}

function replaceClaim(path, owner) {
  unlinkSync(join(path, 'owner.json'));
  rmdirSync(path);
  writeClaim(path, owner);
}

function readClaim(path) {
  return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
}

const EXPECTED =
  '{"continue":true,"systemMessage":"[hint] Context at 90%. Run /checkpoint to save state before auto-compact."}\n';

describe('cah-checkpoint-hint bin', () => {
  it('stop_hook_active=true → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's1', stop_hook_active: true, transcript_path: 'x' }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('empty stdin → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint('', home);
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('malformed JSON stdin → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint('{not json', home);
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('marker already exists → silent, no duplicate hint', () => {
    const home = isolatedHome();
    const sessionId = 'dup-session';
    // Pre-create the marker.
    mkdirSync(join(home, '.claude'), { recursive: true });
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    writeFileSync(join(home, '.claude', `cah-hint-shown-${hash}`), '');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
    assert.equal(existsSync(join(home, '.claude', `cah-hint-shown-${hash}`)), false);
  });

  it('migrates a raw legacy hint marker for the current session into the hashed cache', () => {
    const home = isolatedHome();
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const legacyDir = join(home, '.claude');
    mkdirSync(legacyDir, { recursive: true });
    const legacy = join(legacyDir, `cah-hint-shown-${sessionId}`);
    writeFileSync(legacy, 'legacy');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(JSON.stringify({ session_id: sessionId, transcript_path: tp }), home);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(legacy), false);
    assert.equal(markerExists(home, sessionId), true);
  });

  it('ignores a legacy marker symlink during migration', (t) => {
    const home = isolatedHome();
    const sessionId = 'raw-symlink-session';
    const legacyDir = join(home, '.claude');
    mkdirSync(legacyDir, { recursive: true });
    const target = join(home, 'target-marker');
    const legacy = join(legacyDir, `cah-hint-shown-${sessionId}`);
    writeFileSync(target, 'target');
    try {
      symlinkSync(target, legacy, 'file');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip('file symlinks are unavailable on this host');
        return;
      }
      throw error;
    }
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(JSON.stringify({ session_id: sessionId, transcript_path: tp }), home);
    assert.equal(result.stdout, EXPECTED);
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(markerExists(home, sessionId), true);
  });

  it('sweeps stale raw legacy hint markers without reading nested paths', () => {
    const home = isolatedHome();
    const legacyDir = join(home, '.claude');
    mkdirSync(legacyDir, { recursive: true });
    const stale = join(legacyDir, 'cah-hint-shown-raw-uuid-not-a-64-hex-suffix');
    writeFileSync(stale, 'stale');
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(stale, old, old);
    const tp = writeTranscript(home, 'claude-opus-4-8', 10_000);
    const result = runHint(
      JSON.stringify({ session_id: `../escape/${'x'.repeat(400)}`, transcript_path: tp }),
      home,
    );
    assert.equal(result.stdout, '');
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(join(home, 'escape')), false);
  });

  it('prunes stale hint markers older than the TTL but keeps fresh ones', () => {
    const home = isolatedHome();
    const claudeDir = cacheDir(home);
    mkdirSync(claudeDir, { recursive: true });

    const stale = join(claudeDir, `cah-hint-shown-${'a'.repeat(64)}`);
    writeFileSync(stale, '');
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60; // ~30 days ago
    utimesSync(stale, old, old);

    const fresh = join(claudeDir, `cah-hint-shown-${'b'.repeat(64)}`);
    writeFileSync(fresh, '');

    const tp = writeTranscript(home, 'claude-opus-4-8', 10_000); // below threshold
    runHint(JSON.stringify({ session_id: 's-new', transcript_path: tp }), home);

    assert.equal(existsSync(stale), false, 'stale marker pruned');
    assert.equal(existsSync(fresh), true, 'fresh marker kept');
  });

  it('transcript missing/unreadable → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint(
      JSON.stringify({
        session_id: 's-missing',
        transcript_path: join(home, 'does-not-exist.jsonl'),
      }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-missing'), false);
  });

  it('usage 0.50 of limit → silent, no marker', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-opus-4-8', 500_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's-half', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-half'), false);
  });

  it('Opus at 0.95 (950k / 1M) → emits hint, creates marker', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's-opus', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, EXPECTED);
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-opus'), true);
  });

  it('Sonnet at 0.92 (184k / 200k) → emits hint, creates marker', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-sonnet-4-6', 184_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's-sonnet', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, EXPECTED);
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-sonnet'), true);
  });

  it('0.50 then 0.95 same session: first silent, second emits once', () => {
    const home = isolatedHome();
    const sessionId = 's-grow';

    const tpLow = writeTranscript(home, 'claude-opus-4-8', 500_000);
    const first = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tpLow }),
      home,
    );
    assert.equal(first.stdout, '');
    assert.equal(markerExists(home, sessionId), false);

    const tpHigh = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const second = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tpHigh }),
      home,
    );
    assert.equal(second.stdout, EXPECTED);
    assert.equal(markerExists(home, sessionId), true);

    // A third call must stay silent (marker dedupes).
    const third = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tpHigh }),
      home,
    );
    assert.equal(third.stdout, '');
  });

  it('unknown model falls back to 200K limit', () => {
    const home = isolatedHome();
    // 184k / 200k = 0.92 → should fire under fallback.
    const tp = writeTranscript(home, 'some-mystery-model', 184_000);
    const { stdout } = runHint(
      JSON.stringify({ session_id: 's-fallback', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, EXPECTED);
  });

  it('missing model does not use the 200K fallback without an explicit limit', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, null, 184_000);
    const result = runHint(
      JSON.stringify({ session_id: 's-missing-model', transcript_path: tp }),
      home,
    );
    assert.equal(result.stdout, '');
    assert.equal(markerExists(home, 's-missing-model'), false);
  });

  it('missing model emits when the hook envelope supplies a valid limit', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, null, 95_000);
    const result = runHint(
      JSON.stringify({
        session_id: 's-envelope-limit',
        transcript_path: tp,
        context_window: { context_window_size: 100_000 },
      }),
      home,
    );
    assert.equal(result.stdout, EXPECTED);
  });

  it('hashes traversal-shaped session IDs into a fixed marker filename', () => {
    const home = isolatedHome();
    const sessionId = `../escape/${'x'.repeat(400)}`;
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(JSON.stringify({ session_id: sessionId, transcript_path: tp }), home);
    assert.equal(result.stdout, EXPECTED);
    const names = readdirSync(cacheDir(home));
    assert.deepEqual(names.filter((name) => name.startsWith('cah-hint-shown-')), [
      `cah-hint-shown-${createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex')}`,
    ]);
    assert.equal(existsSync(join(home, 'escape')), false);
  });

  it('24 concurrent claims emit at most one hint', async () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const input = JSON.stringify({ session_id: 'parallel-hint', transcript_path: tp });
    const results = await Promise.all(Array.from({ length: 24 }, () =>
      runHintAsync(input, home, {
        CAH_RATE_LIMITS_CACHE: join(home, 'missing-rate-limits.json'),
      })));
    assert.equal(results.filter((result) => result.stdout === EXPECTED).length, 1);
    assert.ok(results.every((result) => result.status === 0));
  });

  it('24 concurrent claims recover one expired marker without double delivery', async () => {
    const home = isolatedHome();
    const sessionId = 'parallel-expired-hint';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const marker = join(cacheDir(home), `cah-hint-shown-${hash}`);
    mkdirSync(cacheDir(home), { recursive: true });
    writeFileSync(marker, 'old');
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(marker, old, old);
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const input = JSON.stringify({ session_id: sessionId, transcript_path: tp });
    const results = await Promise.all(Array.from({ length: 24 }, () => runHintAsync(input, home)));
    assert.equal(results.filter((result) => result.stdout === EXPECTED).length, 1);
    assert.ok(results.every((result) => result.status === 0));
  });

  it('recovers a claim left by a crashed process before delivery', () => {
    const home = isolatedHome();
    const sessionId = 'recovery-hint-session';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    mkdirSync(markerDir, { recursive: true });
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    writeClaim(claim, { pid: 99999999, nonce: 'dead-owner', claimedAt: Date.now() - 60_000 });
    const old = Date.now() / 1000 - 60;
    utimesSync(claim, old, old);
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(JSON.stringify({ session_id: sessionId, transcript_path: tp }), home);
    assert.equal(result.stdout, EXPECTED);
    assert.equal(markerExists(home, sessionId), true);
  });

  it('reclaims a live-PID claim after its absolute lease expires', () => {
    const home = isolatedHome();
    const sessionId = 'expired-live-claim';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    mkdirSync(markerDir, { recursive: true });
    writeClaim(claim, { pid: process.pid, nonce: 'reused-pid', claimedAt: Date.now() - 60_000 });
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
      { CAH_TEST_ONLY: '1', CAH_HINT_OWNER_MAX_LEASE_MS: '100' },
    );
    assert.equal(result.stdout, EXPECTED);
    assert.equal(markerExists(home, sessionId), true);
  });

  it('recovers a stale fence even when its PID is now live', () => {
    const home = isolatedHome();
    const sessionId = 'pid-reuse-fence';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    const fence = `${claim}.taken-${process.pid}-old-operation`;
    mkdirSync(markerDir, { recursive: true });
    writeClaim(fence, { pid: process.pid, nonce: 'old-fence', claimedAt: Date.now() - 60_000 });
    const old = Date.now() / 1000 - 60;
    utimesSync(fence, old, old);
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
      { CAH_TEST_ONLY: '1', CAH_HINT_OWNER_MAX_LEASE_MS: '100' },
    );
    assert.equal(result.stdout, EXPECTED);
    assert.equal(existsSync(fence), false);
  });

  it('ignores a lease-duration override without the explicit test-only guard', () => {
    const home = isolatedHome();
    const sessionId = 'unguarded-lease-duration';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    mkdirSync(markerDir, { recursive: true });
    writeClaim(claim, {
      pid: process.pid,
      nonce: 'live-owner',
      claimedAt: Date.now() - 60_000,
    });
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
      { CAH_TEST_ONLY: '0', CAH_HINT_OWNER_MAX_LEASE_MS: '1' },
    );
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(claim), {
      pid: process.pid,
      nonce: 'live-owner',
      claimedAt: JSON.parse(readFileSync(join(claim, 'owner.json'), 'utf8')).claimedAt,
    });
  });

  it('does not reclaim a successor claim installed after the dead-owner check', async () => {
    const home = isolatedHome();
    const sessionId = 'hint-reclaim-toctou';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    mkdirSync(markerDir, { recursive: true });
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    writeClaim(claim, { pid: 99999999, nonce: 'dead-owner' });
    const interlock = join(home, 'hint-reclaim-interlock');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const running = runHintAsync(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
      {
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-reclaim',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(join(claim, 'owner.json'));
    rmdirSync(claim);
    const successor = { pid: process.pid, nonce: 'live-successor' };
    writeClaim(claim, successor);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(claim), successor);
    assert.equal(markerExists(home, sessionId), false);
  });

  it('fences a three-party claim race while displaced owner B is restored', async () => {
    const home = isolatedHome();
    const sessionId = 'hint-three-party';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    mkdirSync(markerDir, { recursive: true });
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    writeClaim(claim, { pid: 99999999, nonce: 'stale-a' });
    const interlock = join(home, 'hint-three-party-interlock');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const input = JSON.stringify({ session_id: sessionId, transcript_path: tp });
    const reclaimer = runHintAsync(input, home, {
      CAH_TEST_ONLY: '1',
      CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-reclaim-three-party',
    });
    await waitForPath(`${interlock}.before.ready`);
    unlinkSync(join(claim, 'owner.json'));
    rmdirSync(claim);
    const ownerB = { pid: process.pid, nonce: 'live-b' };
    writeClaim(claim, ownerB);
    writeFileSync(`${interlock}.before.go`, 'go');
    await waitForPath(`${interlock}.vacancy.ready`);
    const contenderC = runHint(input, home);
    assert.equal(contenderC.stdout, '', 'C must not acquire while B is fenced in a tombstone');
    writeFileSync(`${interlock}.vacancy.go`, 'go');
    const result = await reclaimer;
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(claim), ownerB);
    assert.equal(markerExists(home, sessionId), false);
  });

  it('recovers an abandoned claim fence without losing its displaced owner', () => {
    const home = isolatedHome();
    const sessionId = 'hint-abandoned-fence';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    mkdirSync(markerDir, { recursive: true });
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    const fence = `${claim}.taken-99999999-dead-operation`;
    const ownerB = { pid: process.pid, nonce: 'restored-b' };
    writeClaim(fence, ownerB);
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = runHint(JSON.stringify({ session_id: sessionId, transcript_path: tp }), home);
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(claim), ownerB);
    assert.equal(existsSync(fence), false);
  });

  it('ignores the interlock environment without the explicit test-only guard', async () => {
    const home = isolatedHome();
    const interlock = join(home, 'unguarded-interlock');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const result = await runHintAsync(
      JSON.stringify({ session_id: 'unguarded-interlock', transcript_path: tp }),
      home,
      {
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-release',
      },
    );
    assert.equal(result.stdout, EXPECTED);
    assert.equal(existsSync(`${interlock}.ready`), false);
  });

  it('old claim release cannot unlink a successor owner', async () => {
    const home = isolatedHome();
    const sessionId = 'hint-release-toctou';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    const claim = join(markerDir, `.cah-marker-claim-cah-hint-shown-${hash}`);
    const interlock = join(home, 'hint-release-interlock');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const running = runHintAsync(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
      {
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-release',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(join(claim, 'owner.json'));
    rmdirSync(claim);
    const successor = { pid: process.pid, nonce: 'release-successor' };
    writeClaim(claim, successor);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.equal(result.stdout, EXPECTED);
    assert.deepEqual(readClaim(claim), successor);
    assert.equal(markerExists(home, sessionId), true);
  });

  it('stale-marker cleanup restores a freshly replaced delivered marker', async () => {
    const home = isolatedHome();
    const sessionId = 'hint-marker-toctou';
    const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
    const markerDir = cacheDir(home);
    mkdirSync(markerDir, { recursive: true });
    const marker = join(markerDir, `cah-hint-shown-${hash}`);
    writeFileSync(marker, 'stale');
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(marker, old, old);
    const interlock = join(home, 'hint-marker-interlock');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const running = runHintAsync(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
      {
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-remove',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(marker);
    writeFileSync(marker, 'fresh-successor');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(marker, 'utf8'), 'fresh-successor');
  });
});
