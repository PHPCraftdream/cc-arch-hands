import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync as rawMkdtempSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, rmSync, utimesSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  abortMarkerTransaction, compareFreshness, claimMarker, publishMarker,
  inspectPath, identityKey, releaseMarkerClaim, sessionHash,
  migrateLegacyStateFiles, migrateMarkerState,
} from '../lib/marker-state.js';
import { acquireLease, releaseLease } from '../lib/lease-lock.js';
import { semanticFreshness } from '../lib/marker-capacity-ops.js';
import {
  recoverLegacyCapacityState, transactionRetirementPath, victimFencePath,
} from '../lib/marker-capacity-ops.js';
import {
  DEFAULT_CHILD_DEADLINE_MS, killChild, terminateChild,
} from '../test-support/process-batches.js';

const markerChildren = new Set();
const markerFixtures = new Set();

function mkdtempSync(...args) {
  const path = rawMkdtempSync(...args);
  markerFixtures.add(path);
  return path;
}

function spinUntil(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous settle */ }
}

// Windows refuses to rename a directory that a live child process holds as
// its CWD (EBUSY). Other platforms rename it freely, so the CWD-busy repro
// can only be built where this probe fails to rename.
async function renameBlockedWhileChildHoldsCwd() {
  const probe = mkdtempSync(join(tmpdir(), 'cah-cwd-probe-'));
  markerFixtures.add(`${probe}-moved`);
  const child = spawnMarker(process.execPath, ['-e', 'setTimeout(() => {}, 120)'], {
    cwd: probe, stdio: 'ignore',
  });
  spinUntil(60);
  let blocked = false;
  try {
    renameSync(probe, `${probe}-moved`);
    renameSync(`${probe}-moved`, probe);
  } catch {
    blocked = true;
  }
  await new Promise((resolve) => child.once('exit', resolve));
  return blocked;
}

// Bounded rename-probe loop: rename `dir` aside and immediately back, until
// the rename FAILS — which on Windows (EPERM/EBUSY/ENOTEMPTY) proves the
// child process provably holds the directory (via an open handle / CWD).
// Returns true only
// when the block was actually observed before the ~5s deadline.
function probeUntilRenameBlocked(dir) {
  const probePath = `${dir}.probe`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      renameSync(dir, probePath);
      renameSync(probePath, dir); // rename succeeded: child hasn't taken its CWD yet
      spinUntil(5);
    } catch (err) {
      assert.ok(
        ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code),
        `probe rename failed with unexpected code ${err.code} (dir must not have vanished)`,
      );
      return true;
    }
  }
  return false;
}

function spawnMarker(...args) {
  const child = spawn(...args);
  markerChildren.add(child);
  child.once('close', () => markerChildren.delete(child));
  return child;
}

function spawnMarkerSync(file, args, options = {}) {
  return spawnSync(file, args, {
    ...options,
    timeout: options.timeout ?? DEFAULT_CHILD_DEADLINE_MS,
    killSignal: options.killSignal ?? 'SIGKILL',
  });
}

afterEach(async () => {
  await Promise.all([...markerChildren].map((child) => terminateChild(child)));
  for (const fixture of markerFixtures) rmSync(fixture, { recursive: true, force: true });
  markerFixtures.clear();
});

describe('marker state freshness ordering', () => {
  it('orders BigInt nanosecond mtimes exactly beyond Number safe range', () => {
    const older = 2n ** 53n + 100n;
    const newer = older + 1n;
    const base = { delivered: 0, time: -1 };
    assert.equal(compareFreshness({ ...base, mtime: newer }, { ...base, mtime: older }), 1);
    assert.equal(compareFreshness({ ...base, mtime: older }, { ...base, mtime: newer }), -1);
  });
});

function markerConfig(markerDir, overrides = {}) {
  return {
    markerDir,
    namespace: 'marker-tests',
    prefix: 'marker-',
    ttlMs: 24 * 60 * 60 * 1000,
    maxSessions: 1,
    scanCap: 128,
    claimTtlMs: 30_000,
    markerNameRe: /^marker-[a-f0-9]{64}$/,
    ...overrides,
  };
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function runPausedReconciler(home, markerDir) {
  const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
  const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  const script = `
    import { claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
    import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
    const cfg = {
      markerDir: process.env.CAH_TEST_MARKER_DIR,
      namespace: 'marker-tests', prefix: 'marker-', ttlMs: 86400000,
      maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
      ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS',
      markerNameRe: /^marker-[a-f0-9]{64}$/,
      testInterlock: makeInterlock(),
    };
    const claim = claimMarker({ ...cfg, sessionId: 'paused-reconciler', nowMs: Date.now() });
    if (claim) releaseMarkerClaim(claim);
  `;
  return spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'stage-reconcile-interlock'),
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-stage',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function retrySuccessor(run) {
  let result;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = run();
    if (result.status !== 2) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return result;
}

function replaceWithSuccessorStage(home, markerDir, stagePath) {
  const leaseUrl = new URL('../lib/lease-lock.js', import.meta.url).href;
  const script = `
    import { acquireLease, releaseLease } from ${JSON.stringify(leaseUrl)};
    import { mkdirSync, rmdirSync } from 'node:fs';
    import { join } from 'node:path';
    const markerDir = process.env.CAH_TEST_MARKER_DIR;
    const stage = ${JSON.stringify(stagePath)};
    const lease = acquireLease(join(markerDir, '.cah-marker-capacity-marker-tests'), {
      testLeaseEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', staleAfterMs: 100,
    });
    if (!lease) process.exit(2);
    try { rmdirSync(stage); mkdirSync(stage); } finally { releaseLease(lease); }
  `;
  return retrySuccessor(() => spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
    },
  }));
}

function replaceWithSuccessorChild(home, markerDir, stagePath, content = 'successor\n') {
  const leaseUrl = new URL('../lib/lease-lock.js', import.meta.url).href;
  const script = `
    import { acquireLease, releaseLease } from ${JSON.stringify(leaseUrl)};
    import { unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const markerDir = process.env.CAH_TEST_MARKER_DIR;
    const stage = ${JSON.stringify(stagePath)};
    const lease = acquireLease(join(markerDir, '.cah-marker-capacity-marker-tests'), {
      testLeaseEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', staleAfterMs: 100,
    });
    if (!lease) process.exit(2);
    try {
      unlinkSync(join(stage, 'transaction.json'));
      writeFileSync(join(stage, 'transaction.json'), ${JSON.stringify(content)});
    } finally { releaseLease(lease); }
  `;
  return spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
    },
  });
}

function stagedTransaction(markerDir) {
  const marker = join(markerDir, `marker-${sessionHash('staged-marker')}`);
  const victim = join(markerDir, `marker-${sessionHash('staged-victim')}`);
  return JSON.stringify({
    version: 2,
    marker, victim,
    victimKey: 'victim-key', markerBeforeKey: 'absent', nonce: 'staged-nonce',
    markerClaimPath: join(markerDir, `.cah-marker-claim-${basename(marker)}`),
    victimClaimPath: join(markerDir, `.cah-marker-claim-${basename(victim)}`),
    capacityLeasePath: join(markerDir, '.cah-marker-capacity-marker-tests'),
    markerClaimToken: 'staged-marker-token', sessionLeaseToken: 'staged-marker-token',
    victimLeaseToken: 'staged-victim-token', capacityLeaseToken: 'staged-capacity-token',
    capacityLeaseGeneration: 'staged-capacity-generation',
    victimFenceGeneration: 'staged-capacity-generation',
    sessionLeaseGeneration: 'staged-session-generation',
    victimLeaseGeneration: 'staged-victim-generation',
  }) + '\n';
}

function runPausedFenceReconciler(home, markerDir) {
  const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
  const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  const script = `
    import { pruneMarkers } from ${JSON.stringify(markerUrl)};
    import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
    const cfg = {
      markerDir: process.env.CAH_TEST_MARKER_DIR,
      namespace: 'marker-tests', prefix: 'marker-', ttlMs: 86400000,
      maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
      ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS',
      markerNameRe: /^marker-[a-f0-9]{64}$/,
      testInterlock: makeInterlock(),
    };
    pruneMarkers({ ...cfg, nowMs: Date.now() });
  `;
  return spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'fence-reconcile-interlock'),
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-fence',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function replaceWithSuccessorFile(home, markerDir, path, content) {
  const leaseUrl = new URL('../lib/lease-lock.js', import.meta.url).href;
  const script = `
    import { acquireLease, releaseLease } from ${JSON.stringify(leaseUrl)};
    import { unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const markerDir = process.env.CAH_TEST_MARKER_DIR;
    const path = ${JSON.stringify(path)};
    const lease = acquireLease(join(markerDir, '.cah-marker-capacity-marker-tests'), {
      testLeaseEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', staleAfterMs: 100,
    });
    if (!lease) process.exit(2);
    try { unlinkSync(path); writeFileSync(path, ${JSON.stringify(content)}); }
    finally { releaseLease(lease); }
  `;
  return retrySuccessor(() => spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
    },
  }));
}

describe('marker capacity staging', () => {
  it('recovers a crash-left current transaction publication proof before cleanup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-publication-crash-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `marker-${sessionHash('old')}`), 'old\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const script = `
      import { abortMarkerTransaction, claimMarker, publishMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = {
        markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests', prefix: 'marker-',
        ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
        testInterlock: makeInterlock(),
      };
      if (process.env.CAH_TEST_RECOVER === '1') {
        const claim = claimMarker({ ...cfg, sessionId: 'proof-recovery', nowMs: Date.now() });
        if (!claim || !abortMarkerTransaction(claim)) process.exit(3);
        releaseMarkerClaim(claim);
      } else {
        const claim = claimMarker({ ...cfg, sessionId: 'proof-crash', nowMs: Date.now() });
        if (!claim || !publishMarker(claim, Buffer.from('new-marker\\n'), cfg)) process.exit(4);
      }
    `;
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'publication-proof-interlock'),
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'write-after-proof-before-final-operation',
    };
    const crashed = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(`${env.CAH_TEST_ONLY_OWNER_INTERLOCK}.ready`);
    await killChild(crashed);
    const publicationFence = join(home, 'cache', '.markers-capacity-transaction',
      'transaction.json.cah-owned-publish');
    assert.equal(existsSync(join(publicationFence, 'publication.json'))
      || existsSync(join(publicationFence, 'publication.json.tmp')), true);
    unlinkSync(join(home, 'cache', '.markers-capacity-transaction', 'transaction.json'));
    const statePath = join(home, 'cache', '.markers-capacity-transaction', 'transaction.json');
    const rejected = recoverLegacyCapacityState(
      markerDir, statePath, publicationFence, () => false,
      {
        inspectPath,
        capacitySlotPath: (dir) => join(dir, '..', '.markers-capacity-transaction', 'victim'),
        parseTransactionState: (content) => JSON.parse(content.toString('utf8')),
        identityKey, present: 'present', indeterminate: 'indeterminate',
      },
    );
    assert.deepEqual(rejected, { recognized: true, state: null });
    assert.equal(existsSync(statePath), false);
    assert.equal(existsSync(join(publicationFence, 'publication.json'))
      || existsSync(join(publicationFence, 'publication.json.tmp')), true,
    'ownership loss preserves the legacy rollback artifact');
    if (existsSync(join(publicationFence, 'publication.json'))) {
      copyFileSync(join(publicationFence, 'publication.json'),
        join(publicationFence, 'publication.json.tmp'));
    }
    const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_RECOVER: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: undefined, CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: undefined },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), false);
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction',
      'transaction.json.cah-owned-publish')), false);
  });

  it('preserves and reports a successor moved by a late victim race', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-late-successor-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('late-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const script = `
      import { claimMarker } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = {
        markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests', prefix: 'marker-',
        ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS',
        markerNameRe: /^marker-[a-f0-9]{64}$/, testInterlock: makeInterlock(),
      };
      const maintenance = {};
      const claim = claimMarker({ ...cfg, sessionId: 'late-successor', nowMs: Date.now(), maintenance });
      if (claim) process.exit(3);
      process.exit(maintenance.preserved?.some((path) => path.includes('.cah-tmp-victim-')) ? 0 : 4);
    `;
    const interlock = join(home, 'victim-fence-interlock');
    const child = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
        CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-victim-rename' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(`${interlock}.ready`);
    unlinkSync(victim);
    writeFileSync(victim, 'successor\n');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await new Promise((resolve) => child.on('close', (status) => resolve(status)));
    assert.equal(result, 0);
    const fenceName = readdirSync(markerDir).find((name) =>
      name.startsWith(`.cah-tmp-victim-${victim.slice(markerDir.length + 1)}`));
    assert.ok(fenceName, 'generation-scoped successor fence is preserved');
    assert.equal(readFileSync(join(markerDir, fenceName, 'payload'), 'utf8'), 'successor\n');
  });

  it('recovers a crash after victim quarantine without losing the victim', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-quarantine-crash-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('quarantine-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const script = `
      import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      if (process.env.CAH_TEST_RECOVER === '1') {
        const claim = claimMarker({ ...cfg, sessionId: 'recover-quarantine', nowMs: Date.now() });
        if (!claim || !abortMarkerTransaction(claim)) process.exit(3);
        releaseMarkerClaim(claim);
      } else if (claimMarker({ ...cfg, sessionId: 'crash-quarantine', nowMs: Date.now() })) process.exit(4);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-victim-quarantine' };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], { env });
    assert.notEqual(crashed.status, 0);
    const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_RECOVER: '1', CAH_TEST_ONLY_CAPACITY_CRASH: undefined },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
  });

  it('recovers a retired transaction when the canonical state is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-retirement-crash-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('retirement-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const script = `
      import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      const claim = claimMarker({ ...cfg, sessionId: process.env.CAH_TEST_RECOVER ? 'retire-recover' : 'retire-crash', nowMs: Date.now() });
      if (!claim || !abortMarkerTransaction(claim)) process.exit(3);
      releaseMarkerClaim(claim);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-transaction-retirement' };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], { env });
    assert.notEqual(crashed.status, 0);
    const txDir = join(home, 'cache', '.markers-capacity-transaction');
    assert.ok(readdirSync(txDir).some((name) => name.startsWith('.cah-retired-')));
    unlinkSync(join(txDir, 'transaction.json'));
    const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_RECOVER: '1', CAH_TEST_ONLY_CAPACITY_CRASH: undefined },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), false);
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
  });

  it('retires multiple expired records around a valid canonical successor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-populated-retirements-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('populated-retirement-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const crashScript = `
      import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 100,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      const claim = claimMarker({ ...cfg, sessionId: 'populated-retirement-crash', nowMs: Date.now() });
      if (!claim || abortMarkerTransaction(claim)) process.exit(3);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-transaction-retirement' };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', crashScript], {
      encoding: 'utf8', env,
    });
    assert.notEqual(crashed.status, 0, crashed.stderr);
    const txDir = join(home, 'cache', '.markers-capacity-transaction');
    const txPath = join(txDir, 'transaction.json');
    const expired = JSON.parse(readFileSync(txPath, 'utf8'));
    const secondGeneration = 'expired-second-generation';
    const secondRetirement = transactionRetirementPath(txDir, secondGeneration);
    mkdirSync(secondRetirement);
    writeFileSync(join(secondRetirement, 'transaction.json'), JSON.stringify({
      ...expired, capacityLeaseGeneration: secondGeneration,
    }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const recoveryScript = `
      import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 100,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
        testInterlock: makeInterlock() };
      const claim = claimMarker({ ...cfg, sessionId: 'populated-retirement-recovery', nowMs: Date.now() });
      if (!claim) process.exit(2);
      if (!abortMarkerTransaction(claim)) process.exit(3);
      releaseMarkerClaim(claim);
    `;
    const recovery = spawnMarker(process.execPath, ['--input-type=module', '-e', recoveryScript], {
      env: { ...env, CAH_TEST_ONLY_CAPACITY_CRASH: undefined,
        CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'successor-interlock'),
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-before-transaction-reconcile' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(join(home, 'successor-interlock.ready'));
    const ownerPath = join(expired.capacityLeasePath, 'owner.json');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    unlinkSync(txPath);
    writeFileSync(txPath, JSON.stringify({ ...expired, nonce: 'successor-nonce',
      capacityLeaseToken: owner.token, capacityLeaseGeneration: owner.generation,
      victimFenceGeneration: owner.generation }) + '\n');
    writeFileSync(join(home, 'successor-interlock.go'), 'go');
    const result = await new Promise((resolve) => {
      let stderr = '';
      recovery.stderr.on('data', (chunk) => { stderr += chunk; });
      recovery.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(txDir), false);
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
  });

  it('removes multiple empty stale retirement reservations without poisoning live state', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-empty-retirements-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('empty-retirement-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const script = `
      import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 100,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      const claim = claimMarker({ ...cfg, sessionId: 'empty-retirement-recovery', nowMs: Date.now() });
      if (!claim || !abortMarkerTransaction(claim)) process.exit(3);
      releaseMarkerClaim(claim);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-victim-rename' };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', `
      import { claimMarker } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      claimMarker({ ...cfg, sessionId: 'empty-retirement-crash', nowMs: Date.now() });
    `], { env });
    assert.notEqual(crashed.status, 0, crashed.stderr);
    const txDir = join(home, 'cache', '.markers-capacity-transaction');
    const staleA = transactionRetirementPath(txDir, 'stale-a');
    const staleB = transactionRetirementPath(txDir, 'stale-b');
    mkdirSync(staleA);
    mkdirSync(staleB);
    const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_ONLY_CAPACITY_CRASH: undefined },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), false);
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
    assert.equal(existsSync(staleA), false);
    assert.equal(existsSync(staleB), false);
  });

  it('recovers a real crash after the transaction temp and before its publication proof', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-pre-proof-crash-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('pre-proof-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const script = `
      import { abortMarkerTransaction, claimMarker, publishMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 100,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
        testInterlock: makeInterlock() };
      if (process.env.CAH_TEST_RECOVER === '1') {
        const claim = claimMarker({ ...cfg, sessionId: 'pre-proof-recovery', nowMs: Date.now() });
        if (!claim || !abortMarkerTransaction(claim)) process.exit(3);
        releaseMarkerClaim(claim);
        process.exit(0);
      }
      const claim = claimMarker({ ...cfg, sessionId: 'pre-proof-crash', nowMs: Date.now() });
      if (!claim || !publishMarker(claim, Buffer.from('new-marker\\n'), cfg)) process.exit(4);
      releaseMarkerClaim(claim);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'pre-proof-interlock'),
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'write-before-final-publication' };
    const crashed = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(join(home, 'pre-proof-interlock.ready'));
    await killChild(crashed);
    const txDir = join(home, 'cache', '.markers-capacity-transaction');
    assert.ok(readdirSync(txDir).some((name) => name.startsWith('.cah-tmp-')));
    const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_ONLY_OWNER_INTERLOCK: undefined,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: undefined, CAH_TEST_RECOVER: '1' },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(txDir), false);
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
  });

  it('removes an empty or partial transaction temp after a real child crash', async () => {
    for (const crashPhase of ['write-after-temp-create', 'write-after-temp-partial']) {
      const home = mkdtempSync(join(tmpdir(), `cah-marker-${crashPhase}-`));
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const victim = join(markerDir, `marker-${sessionHash(`${crashPhase}-victim`)}`);
      writeFileSync(victim, 'victim\n');
      const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
      const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
      const script = `
        import { abortMarkerTransaction, claimMarker, publishMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
        import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
        const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
          prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 100,
          ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
          testInterlock: makeInterlock() };
        if (process.env.CAH_TEST_RECOVER === '1') {
          const claim = claimMarker({ ...cfg, sessionId: 'temp-recovery', nowMs: Date.now() });
          if (!claim || !abortMarkerTransaction(claim)) process.exit(3);
          releaseMarkerClaim(claim);
        } else {
          const claim = claimMarker({ ...cfg, sessionId: 'temp-crash', nowMs: Date.now() });
          if (!claim || !publishMarker(claim, Buffer.from('new-marker\\n'), cfg)) process.exit(4);
        }
      `;
      const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
        CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
        CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'temp-interlock'),
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: crashPhase,
        ...(crashPhase === 'write-after-temp-partial'
          ? { CAH_TEST_ONLY_ATOMIC_PARTIAL_WRITE: '1' } : {}) };
      const child = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
        env, stdio: ['ignore', 'ignore', 'pipe'],
      });
      await waitForPath(join(home, 'temp-interlock.ready'));
      await killChild(child);
      const txDir = join(home, 'cache', '.markers-capacity-transaction');
      assert.ok(readdirSync(txDir).some((name) => name.startsWith('.cah-tmp-')));
      const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...env, CAH_TEST_RECOVER: '1', CAH_TEST_ONLY_OWNER_INTERLOCK: undefined,
          CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: undefined, CAH_TEST_ONLY_ATOMIC_PARTIAL_WRITE: undefined },
      });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(existsSync(txDir), false);
      assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
    }
  });

  it('preserves a successor transaction when the retiring owner loses its lease', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-retirement-successor-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `marker-${sessionHash('retirement-successor-victim')}`), 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const leaseUrl = new URL('../lib/lease-lock.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const script = `
      import { abortMarkerTransaction, claimMarker } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 100,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      const claim = claimMarker({ ...cfg, sessionId: 'retirement-pause', nowMs: Date.now(),
        testInterlock: makeInterlock() });
      if (!claim) process.exit(3);
      if (abortMarkerTransaction(claim)) process.exit(0);
      process.exit(7);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'retirement-interlock'),
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-transaction-retire-before-unlink' };
    const paused = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(join(home, 'retirement-interlock.ready'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const txPath = join(home, 'cache', '.markers-capacity-transaction', 'transaction.json');
    const successor = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireLease, releaseLease } from ${JSON.stringify(leaseUrl)};
      import { unlinkSync, writeFileSync } from 'node:fs';
      const path = ${JSON.stringify(join(markerDir, '.cah-marker-capacity-marker-tests'))};
      const tx = ${JSON.stringify(txPath)};
      const lease = acquireLease(path, { staleAfterMs: 100, testLeaseEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS' });
      if (!lease) process.exit(2);
      try { unlinkSync(tx); writeFileSync(tx, 'successor-transaction\\n'); } finally { releaseLease(lease); }
    `], { encoding: 'utf8', env });
    assert.equal(successor.status, 0, successor.stderr);
    writeFileSync(join(home, 'retirement-interlock.go'), 'go');
    const status = await new Promise((resolve) => paused.on('close', resolve));
    assert.notEqual(status, 0);
    assert.equal(readFileSync(txPath, 'utf8'), 'successor-transaction\n');
  });

  it('aborts a crash-left eviction without removing a newer canonical successor', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-abort-successor-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('abort-successor-victim')}`);
    writeFileSync(victim, 'old\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const script = `
      import { claimMarker, abortMarkerTransaction, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      const claim = claimMarker({ ...cfg, marker: process.env.CAH_TEST_VICTIM,
        sessionId: 'abort-successor-recovery', nowMs: Date.now() });
      if (process.env.CAH_TEST_RECOVER === '1') {
        if (claim) process.exit(3);
        process.exit(0);
      }
      if (claim) process.exit(4);
      process.exit(5);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_VICTIM: victim,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-victim-rename' };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], { env });
    assert.notEqual(crashed.status, 0, crashed.stderr);
    writeFileSync(victim, 'new-canonical\n');
    const recovered = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_RECOVER: '1', CAH_TEST_ONLY_CAPACITY_CRASH: undefined },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(victim, 'utf8'), 'new-canonical\n');
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), false);
  });

  it('keeps generation-scoped fences disjoint across lease reuse', () => {
    const source = join(mkdtempSync(join(tmpdir(), 'cah-marker-generation-')), 'victim');
    const first = victimFencePath(source, { victimFenceGeneration: 'generation-a' });
    const second = victimFencePath(source, { victimFenceGeneration: 'generation-b' });
    assert.notEqual(first, second);
    assert.match(first, /\.cah-tmp-victim-victim-[a-f0-9]{32}$/);
    assert.match(second, /\.cah-tmp-victim-victim-[a-f0-9]{32}$/);
  });

  it('preserves a successor payload when the fence owner lease is reused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-lease-reuse-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const victim = join(markerDir, `marker-${sessionHash('lease-reuse-victim')}`);
    writeFileSync(victim, 'victim\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const script = `
      import { readFileSync } from 'node:fs';
      import { claimMarker } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
        testInterlock: makeInterlock() };
      const maintenance = {};
      const claim = claimMarker({ ...cfg, sessionId: 'lease-reuse-recovery', nowMs: Date.now(), maintenance });
      process.exit(claim ? 3 : maintenance.preserved?.length ? 0 : 4);
    `;
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-victim-quarantine' };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', `
      import { claimMarker } from ${JSON.stringify(markerUrl)};
      const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests',
        prefix: 'marker-', ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/ };
      claimMarker({ ...cfg, sessionId: 'lease-reuse-crash', nowMs: Date.now() });
    `], { env });
    assert.notEqual(crashed.status, 0, crashed.stderr);
    const fenceName = readdirSync(markerDir).find((name) =>
      name.startsWith(`.cah-tmp-victim-${victim.slice(markerDir.length + 1)}`));
    assert.ok(fenceName);
    const fencePayload = join(markerDir, fenceName, 'payload');
    const txDir = join(home, 'cache', '.markers-capacity-transaction');
    const tx = JSON.parse(readFileSync(join(txDir, 'transaction.json'), 'utf8'));
    const ownerPath = join(tx.capacityLeasePath, 'owner.json');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const recovering = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, CAH_TEST_ONLY_CAPACITY_CRASH: undefined,
        CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'lease-reuse-interlock'),
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-victim-unlink' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(join(home, 'lease-reuse-interlock.ready'));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, token: 'successor-token',
      generation: 'successor-generation' }) + '\n');
    unlinkSync(fencePayload);
    writeFileSync(fencePayload, 'successor-payload\n');
    writeFileSync(join(home, 'lease-reuse-interlock.go'), 'go');
    const result = await new Promise((resolve) => recovering.on('close', (status) => resolve(status)));
    assert.equal(result, 0);
    assert.equal(readFileSync(fencePayload, 'utf8'), 'successor-payload\n');
    assert.equal(existsSync(join(txDir, 'transaction.json')), true);
  });

  it('preserves and reports a successor replacing the victim slot after the final fence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-slot-successor-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `marker-${sessionHash('old')}`), 'old\n');
    const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
    const script = `
      import { claimMarker } from ${JSON.stringify(markerUrl)};
      import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
      const cfg = {
        markerDir: process.env.CAH_TEST_MARKER_DIR, namespace: 'marker-tests', prefix: 'marker-',
        ttlMs: 86400000, maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
        testInterlock: makeInterlock(),
      };
      const maintenance = {};
      const claim = claimMarker({ ...cfg, sessionId: 'slot-successor', nowMs: Date.now(), maintenance });
      if (process.env.CAH_TEST_RECOVER === '1') {
        const slot = ${JSON.stringify(join(home, 'cache', '.markers-capacity-transaction', 'victim'))};
        process.exit(claim ? 2 : maintenance.preserved?.includes(slot) ? 0 : 4);
      }
      if (!claim) process.exit(3);
    `;
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
      CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
      CAH_TEST_ONLY_CAPACITY_CRASH: 'after-victim-rename',
    };
    const crashed = spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env,
    });
    assert.notEqual(crashed.status, 0, crashed.stderr);
    const slot = join(home, 'cache', '.markers-capacity-transaction', 'victim');
    const recovering = spawnMarker(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, CAH_TEST_ONLY_CAPACITY_CRASH: undefined,
        CAH_TEST_RECOVER: '1', CAH_TEST_ONLY_OWNER_INTERLOCK: join(home, 'slot-interlock'),
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity-slot' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(join(home, 'slot-interlock.ready'));
    unlinkSync(slot);
    writeFileSync(slot, 'successor-slot\n');
    writeFileSync(join(home, 'slot-interlock.go'), 'go');
    const result = await new Promise((resolve) => {
      let stderr = '';
      recovering.stderr.on('data', (chunk) => { stderr += chunk; });
      recovering.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(slot, 'utf8'), 'successor-slot\n');
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), true);
  });

  it('reconciles its deterministic stage despite a truncated shared-parent scan', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-stage-'));
    const cache = join(home, 'cache');
    const markerDir = join(cache, 'markers');
    mkdirSync(markerDir, { recursive: true });
    for (let i = 0; i < 300; i += 1) writeFileSync(join(cache, `foreign-${i}`), 'foreign');
    const stage = join(markerDir, '.capacity-transaction-stage');
    mkdirSync(stage);

    const claim = claimMarker({ ...markerConfig(markerDir), sessionId: 'truncated-stage' });
    assert.ok(claim);
    releaseMarkerClaim(claim);
    assert.equal(existsSync(stage), false);
  });

  it('reuses one stage slot across repeated crashes and reconciles it on restart', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-crash-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `marker-${sessionHash('old')}`),
      JSON.stringify({ deliveredAt: Date.now() }) + '\n');
    const moduleUrl = new URL('../lib/marker-state.js', import.meta.url).href;
    const script = `
      import {
        claimMarker, abortMarkerTransaction, releaseMarkerClaim,
      } from ${JSON.stringify(moduleUrl)};
      const cfg = {
        markerDir: process.env.CAH_TEST_MARKER_DIR,
        namespace: 'marker-tests', prefix: 'marker-', ttlMs: 86400000,
        maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
        markerNameRe: /^marker-[a-f0-9]{64}$/,
      };
      const claim = claimMarker({ ...cfg, sessionId: 'new', nowMs: Date.now() });
      if (!claim) process.exit(3);
      if (!abortMarkerTransaction(claim)) process.exit(4);
      releaseMarkerClaim(claim);
    `;
    const run = (crash) => spawnMarkerSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        CAH_TEST_MARKER_DIR: markerDir,
        CAH_TEST_ONLY: crash ? '1' : undefined,
        CAH_TEST_ONLY_CAPACITY_CRASH_AFTER_STAGE_WRITE: crash ? '1' : undefined,
      },
    });

    for (let i = 0; i < 3; i += 1) {
      assert.notEqual(run(true).status, 0);
      assert.equal(readdirSync(markerDir)
        .filter((name) => name === '.capacity-transaction-stage').length, 1);
    }
    const recovered = run(false);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(join(markerDir, '.capacity-transaction-stage')), false);
    assert.equal(readdirSync(markerDir).filter((name) => name.startsWith('marker-')).length, 1);
  });

  for (const legacy of [false, true]) {
    it(`does not remove an expired owner's ${legacy ? 'legacy' : 'current'} successor stage`, async () => {
      const home = mkdtempSync(join(tmpdir(), `cah-marker-${legacy ? 'legacy' : 'current'}-fence-`));
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const stagePath = legacy
        ? join(home, 'cache', '.markers-capacity-transaction-stage-successor')
        : join(markerDir, '.capacity-transaction-stage');
      mkdirSync(stagePath);

      const paused = runPausedReconciler(home, markerDir);
      const interlock = join(home, 'stage-reconcile-interlock');
      await waitForPath(`${interlock}.ready`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const successor = await replaceWithSuccessorStage(home, markerDir, stagePath);
      assert.equal(successor.status, 0, successor.stderr);
      writeFileSync(`${interlock}.go`, 'go');
      const result = await new Promise((resolve) => {
        let stderr = '';
        paused.stderr.on('data', (chunk) => { stderr += chunk; });
        paused.on('close', (status) => resolve({ status, stderr }));
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(stagePath), true);
    });

    it(`preserves a replaced transaction child in the ${legacy ? 'legacy' : 'current'} promotion branch`, async () => {
      const home = mkdtempSync(join(tmpdir(), `cah-marker-${legacy ? 'legacy' : 'current'}-child-`));
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const stagePath = legacy
        ? join(home, 'cache', '.markers-capacity-transaction-stage-successor')
        : join(markerDir, '.capacity-transaction-stage');
      mkdirSync(stagePath);
      writeFileSync(join(stagePath, 'transaction.json'), stagedTransaction(markerDir));

      const paused = runPausedReconciler(home, markerDir);
      const interlock = join(home, 'stage-reconcile-interlock');
      await waitForPath(`${interlock}.ready`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const successor = replaceWithSuccessorChild(home, markerDir, stagePath, 'successor\n');
      assert.equal(successor.status, 0, successor.stderr);
      writeFileSync(`${interlock}.go`, 'go');
      const result = await new Promise((resolve) => {
        let stderr = '';
        paused.stderr.on('data', (chunk) => { stderr += chunk; });
        paused.on('close', (status) => resolve({ status, stderr }));
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(stagePath, 'transaction.json'), 'utf8'), 'successor\n');
      assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), false);
    });
  }

  it('does not rename a replaced legacy capacity fence into an empty marker slot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-fence-rename-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const marker = join(markerDir, `marker-${sessionHash('fence-rename')}`);
    const fence = `${marker}.cah-capacity-fence`;
    writeFileSync(fence, JSON.stringify({ deliveredAt: 1 }) + '\n');
    const paused = runPausedFenceReconciler(home, markerDir);
    const interlock = join(home, 'fence-reconcile-interlock');
    await waitForPath(`${interlock}.ready`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const successor = await replaceWithSuccessorFile(home, markerDir, fence, 'successor\n');
    assert.equal(successor.status, 0, successor.stderr);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await new Promise((resolve) => {
      let stderr = '';
      paused.stderr.on('data', (chunk) => { stderr += chunk; });
      paused.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(fence, 'utf8'), 'successor\n');
  });

  it('does not remove a replaced legacy capacity fence over a newer marker', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-fence-remove-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const marker = join(markerDir, `marker-${sessionHash('fence-remove')}`);
    const fence = `${marker}.cah-capacity-fence`;
    writeFileSync(fence, JSON.stringify({ deliveredAt: 1 }) + '\n');
    writeFileSync(marker, JSON.stringify({ deliveredAt: 2 }) + '\n');
    const paused = runPausedFenceReconciler(home, markerDir);
    const interlock = join(home, 'fence-reconcile-interlock');
    await waitForPath(`${interlock}.ready`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const successor = await replaceWithSuccessorFile(home, markerDir, fence, 'successor\n');
    assert.equal(successor.status, 0, successor.stderr);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await new Promise((resolve) => {
      let stderr = '';
      paused.stderr.on('data', (chunk) => { stderr += chunk; });
      paused.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), JSON.stringify({ deliveredAt: 2 }) + '\n');
    assert.equal(readFileSync(fence, 'utf8'), 'successor\n');
  });
});

describe('legacy claim migration lease release', () => {
  function writeClaimOwner(dir, timestamp) {
    const token = randomUUID();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'),
      JSON.stringify({ pid: 99999999, token, nonce: token, timestamp, startedAt: timestamp }) + '\n');
  }

  function assertSourceWins(sourcePath, targetPath) {
    const source = semanticFreshness(sourcePath, inspectPath(join(sourcePath, 'owner.json'), { content: true }));
    const target = semanticFreshness(targetPath, inspectPath(join(targetPath, 'owner.json'), { content: true }));
    assert.equal(compareFreshness(source, target) > 0, true);
  }

  it('releases the migrated stamp lock so the next acquire succeeds', () => {
    const home = mkdtempSync(join(tmpdir(), 'marker-state-stamp-'));
    const stateDir = join(home, 'stamp-state');
    const sessionId = 'stamp-migration-claim-test';
    const hash = sessionHash(sessionId);
    const stateName = `last-stamp.json.session-${hash}.json`;
    const lockName = `${stateName}.lock`;
    const sourceLock = join(home, lockName);
    const targetLock = join(stateDir, lockName);
    writeClaimOwner(targetLock, Date.now() - 60_000);
    writeClaimOwner(sourceLock, Date.now());
    assertSourceWins(sourceLock, targetLock);
    const result = migrateLegacyStateFiles({
      prefix: 'last-stamp.json.session-', namespace: 'stamp-state', namespaceDir: stateDir,
      home, sessionId, stateName, lockName, roots: [home],
      ttlMs: 24 * 60 * 60 * 1000, claimTtlMs: 30_000, maxSessions: 64, scanCap: 200,
      ownerTestEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
    });
    assert.equal(result?.blocked, false);
    const token = randomUUID();
    const nowMs = Date.now();
    const lock = acquireLease(targetLock, {
      nowMs, owner: { pid: process.pid, token, nonce: token, timestamp: nowMs, startedAt: nowMs },
      staleAfterMs: 30_000, fenceSuffix: '.taken-',
      interlockPhase: 'lock-reclaim', releaseInterlockPhase: 'lock-release',
      testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
    });
    assert.notEqual(lock, null);
    if (lock) releaseLease(lock);
  });

  it('retries a transiently stuck target-claim release so the next acquire succeeds', async function () {
    if (!(await renameBlockedWhileChildHoldsCwd())) {
      return this.skip('platform does not block rename of a directory held as a child process CWD');
    }
    const home = mkdtempSync(join(tmpdir(), 'marker-state-stall-'));
    const stateDir = join(home, 'stamp-state');
    const sessionId = 'stamp-migration-release-stall';
    const hash = sessionHash(sessionId);
    const stateName = `last-stamp.json.session-${hash}.json`;
    const lockName = `${stateName}.lock`;
    const sourceLock = join(home, lockName);
    const targetLock = join(stateDir, lockName);
    writeClaimOwner(targetLock, Date.now() - 60_000);
    writeClaimOwner(sourceLock, Date.now());
    assertSourceWins(sourceLock, targetLock);

    // The target claim's release runs under the 'legacy-claim-reclaim-release'
    // interlock phase. Hold the target lock directory by having a live child
    // hold an open handle on a file inside it (spawned with the dir as CWD):
    // the release fence rename fails with EPERM/EBUSY until the handle
    // closes, so the release only succeeds when it is retried.
    let child = null;
    let blockedOnce = false;
    const result = migrateLegacyStateFiles({
      prefix: 'last-stamp.json.session-', namespace: 'stamp-state', namespaceDir: stateDir,
      home, sessionId, stateName, lockName, roots: [home],
      ttlMs: 24 * 60 * 60 * 1000, claimTtlMs: 30_000, maxSessions: 64, scanCap: 200,
      ownerTestEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
      testInterlock: (phase) => {
        if (phase === 'legacy-claim-reclaim-release' && child === null) {
          child = spawnMarker(process.execPath, ['-e', "const p=require('path'),f=require('fs');const q=p.join(process.cwd(),'held');const h=f.openSync(q,'w');setTimeout(() => { try { f.unlinkSync(q); } finally { f.closeSync(h); } }, 200)"], {
            cwd: targetLock,
          });
          blockedOnce = probeUntilRenameBlocked(targetLock);
        }
      },
    });

    assert.notEqual(child, null, 'target claim release must have been reached');
    assert.equal(blockedOnce, true, 'probe must prove the first release attempt was blocked by the child\'s open handle (retry is exercised only then)');
    assert.equal(result?.blocked, false, 'migration must recover once the transient contention clears');
    const token = randomUUID();
    const nowMs = Date.now();
    const lock = acquireLease(targetLock, {
      nowMs, owner: { pid: process.pid, token, nonce: token, timestamp: nowMs, startedAt: nowMs },
      staleAfterMs: 30_000, fenceSuffix: '.taken-',
      interlockPhase: 'lock-reclaim', releaseInterlockPhase: 'lock-release',
      testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
    });
    assert.notEqual(lock, null, 'the re-acquire after migration must not see a stranded live-owner lease');
    if (lock) releaseLease(lock);
  });

  it('releases the migrated marker claim so claimMarker succeeds', () => {
    const home = mkdtempSync(join(tmpdir(), 'marker-state-claim-'));
    const markerDir = join(home, 'cache', 'marker-tests');
    const cfg = markerConfig(markerDir);
    const sessionId = 'migration-claim-test';
    const hash = sessionHash(sessionId);
    const marker = join(markerDir, `marker-${hash}`);
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(marker, JSON.stringify({ claimedAt: Date.now() - 25 * 3_600_000 }) + '\n');
    utimesSync(marker, Date.now() / 1000 - 25 * 3600, Date.now() / 1000 - 25 * 3600);
    const claimName = `.cah-marker-claim-marker-${hash}`;
    const sourceClaim = join(home, '.claude', 'cah-bin', 'cache', claimName);
    const targetClaim = join(markerDir, claimName);
    writeClaimOwner(targetClaim, Date.now() - 60_000);
    writeClaimOwner(sourceClaim, Date.now());
    assertSourceWins(sourceClaim, targetClaim);
    const result = migrateMarkerState({ ...cfg, home, sessionId });
    assert.equal(result?.blocked, false);
    const claim = claimMarker({ ...cfg, sessionId, nowMs: Date.now() });
    assert.notEqual(claim, null);
    if (claim) releaseMarkerClaim(claim);
  });
});

describe('claimMarker capacity lease lifecycle', () => {
  it('releases the capacity lease when capacity eviction is not prepared', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-lease-leak-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const cfg = markerConfig(markerDir);
    const stale = Date.now() / 1000 - 25 * 3600;
    const sessionId = 'lease-leak-test';
    const target = join(markerDir, `marker-${sessionHash(sessionId)}`);
    const otherHash = sessionHash('lease-leak-other');
    const other = join(markerDir, `marker-${otherHash}`);
    writeFileSync(target, 'target\n');
    writeFileSync(other, 'other\n');
    utimesSync(target, stale, stale);
    const token = randomUUID();
    const now = Date.now();
    mkdirSync(join(markerDir, `.cah-marker-claim-marker-${otherHash}`), { recursive: true });
    writeFileSync(join(markerDir, `.cah-marker-claim-marker-${otherHash}`, 'owner.json'),
      JSON.stringify({ pid: process.pid, token, nonce: token, timestamp: now, startedAt: now }) + '\n');
    const claim = claimMarker({ ...cfg, sessionId, nowMs: Date.now() });
    assert.equal(claim, null);
    const capacityLease = acquireLease(join(markerDir, '.cah-marker-capacity-marker-tests'), {
      nowMs: Date.now(),
      owner: { pid: process.pid, token: randomUUID(), nonce: randomUUID(),
        timestamp: Date.now(), startedAt: Date.now() },
      staleAfterMs: 30_000, fenceSuffix: '.taken-',
      interlockPhase: 'marker-capacity-lease-reclaim',
      releaseInterlockPhase: 'marker-capacity-lease-reclaim-release',
    });
    assert.notEqual(capacityLease, null,
      'capacity lease should have been released after failed eviction preparation');
    if (capacityLease) releaseLease(capacityLease);
  });

  it('bounds capacity eviction retries so the claim still succeeds', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-retry-bound-'));
    const markerDir = join(home, 'cache', 'markers');
    mkdirSync(markerDir, { recursive: true });
    const cfg = markerConfig(markerDir);
    const txDir = join(dirname(markerDir), `.${basename(markerDir)}-capacity-transaction`);
    const stale = Date.now() / 1000 - 25 * 3600;
    const fresh = Date.now() / 1000;
    const target = join(markerDir, `marker-${sessionHash('retry-bound')}`);
    writeFileSync(target, 'target\n');
    utimesSync(target, stale, stale);
    // Fresh (non-stale) markers fill the capacity slot; eviction retries target
    // the oldest of them until the exclusion set empties the candidate pool.
    ['retry-bound-a', 'retry-bound-b'].map((id, index) => {
      const path = join(markerDir, `marker-${sessionHash(id)}`);
      writeFileSync(path, `${id}\n`);
      utimesSync(path, fresh - 7200 + index * 1800, fresh - 7200 + index * 1800);
      return path;
    });
    let slotFires = 0;
    const testInterlock = (phase) => {
      if (phase !== 'marker-capacity-slot') return;
      slotFires += 1;
      // Replace the chosen victim right before the CAS move so the move fails
      // deterministically on every attempt, driving the retry path.
      const state = JSON.parse(readFileSync(join(txDir, 'transaction.json'), 'utf8'));
      writeFileSync(state.victim, `successor-${slotFires}\n`);
    };
    const claim = claimMarker({ ...cfg, sessionId: 'retry-bound', nowMs: Date.now(), testInterlock });
    assert.notEqual(claim, null, 'claim should succeed once candidates are exhausted');
    assert.ok(slotFires > 1, `expected the eviction retry loop to cycle, fired ${slotFires} times`);
    assert.ok(slotFires <= 6, `retry loop must be bounded, fired ${slotFires} times`);
    if (claim) releaseMarkerClaim(claim);
  });
});
