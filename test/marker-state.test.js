import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  abortMarkerTransaction, compareFreshness, claimMarker, publishMarker,
  releaseMarkerClaim, sessionHash,
} from '../lib/marker-state.js';

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
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
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
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
    },
  });
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
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
    },
  });
}

function stagedTransaction(markerDir) {
  return JSON.stringify({
    version: 2,
    marker: join(markerDir, `marker-${sessionHash('staged-marker')}`),
    victim: join(markerDir, `marker-${sessionHash('staged-victim')}`),
    victimKey: 'victim-key', markerBeforeKey: 'absent', nonce: 'staged-nonce',
    markerClaimPath: join(markerDir, '.staged-marker-claim'),
    victimClaimPath: join(markerDir, '.staged-victim-claim'),
    capacityLeasePath: join(markerDir, '.cah-marker-capacity-marker-tests'),
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
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
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
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_TEST_ONLY: '1', CAH_TEST_MARKER_DIR: markerDir,
      CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
    },
  });
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
    const crashed = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForPath(`${env.CAH_TEST_ONLY_OWNER_INTERLOCK}.ready`);
    crashed.kill('SIGKILL');
    await new Promise((resolve) => crashed.on('close', resolve));
    const publicationFence = join(home, 'cache', '.markers-capacity-transaction',
      'transaction.json.cah-owned-publish');
    assert.equal(existsSync(join(publicationFence, 'publication.json'))
      || existsSync(join(publicationFence, 'publication.json.tmp')), true);
    unlinkSync(join(home, 'cache', '.markers-capacity-transaction', 'transaction.json'));
    if (existsSync(join(publicationFence, 'publication.json'))) {
      copyFileSync(join(publicationFence, 'publication.json'),
        join(publicationFence, 'publication.json.tmp'));
    }
    const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...env, CAH_TEST_RECOVER: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: undefined, CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: undefined },
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction')), false);
    assert.equal(existsSync(join(home, 'cache', '.markers-capacity-transaction',
      'transaction.json.cah-owned-publish')), false);
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
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env,
    });
    assert.notEqual(crashed.status, 0, crashed.stderr);
    const slot = join(home, 'cache', '.markers-capacity-transaction', 'victim');
    const recovering = spawn(process.execPath, ['--input-type=module', '-e', script], {
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
    const run = (crash) => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
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
      const successor = replaceWithSuccessorStage(home, markerDir, stagePath);
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
    const successor = replaceWithSuccessorFile(home, markerDir, fence, 'successor\n');
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
    const successor = replaceWithSuccessorFile(home, markerDir, fence, 'successor\n');
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
