import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimMarker, sessionHash,
} from '../lib/marker-state.js';
import { captureRegularFileSnapshot, writeFileAtomic } from '../lib/fsutil.js';
import { transactionRetirementPath } from '../lib/marker-capacity-ops.js';
import {
  clearDirectoryScanStats, readDirectoryScanStats, resetDirectoryScanStats,
} from '../lib/lease-lock.js';

const markerConfig = (markerDir) => ({
  markerDir, namespace: 'marker-tests', prefix: 'marker-', ttlMs: 86400000,
  maxSessions: 1, scanCap: 128, claimTtlMs: 100,
  ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS',
  markerNameRe: /^marker-[a-f0-9]{64}$/,
});

function runMarker(script, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env,
  });
}

describe('round55 marker recovery', () => {
  it('rejects a canonical transaction whose victim and claim escape the namespace', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-round55-path-'));
    try {
      const markerDir = join(home, 'cache', 'markers');
      const outside = join(home, 'outside');
      mkdirSync(markerDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      const marker = join(markerDir, `marker-${sessionHash('corrupt-outside')}`);
      const transactionDir = join(dirname(markerDir), `.${basename(markerDir)}-capacity-transaction`);
      const outsideVictim = join(outside, 'victim');
      const outsideClaim = join(outside, 'claim');
      mkdirSync(transactionDir, { recursive: true });
      writeFileSync(outsideVictim, 'must-survive\n');
      writeFileSync(join(transactionDir, 'transaction.json'), JSON.stringify({
        version: 2, marker, victim: outsideVictim, victimKey: 'foreign',
        markerBeforeKey: 'absent', nonce: 'corrupt-outside',
        markerClaimPath: join(markerDir, `.cah-marker-claim-${basename(marker)}`),
        victimClaimPath: outsideClaim,
        capacityLeasePath: join(markerDir, '.cah-marker-capacity-marker-tests'),
        capacityLeaseGeneration: 'foreign-generation', victimFenceGeneration: 'foreign-generation',
        sessionLeaseGeneration: 'foreign-session', victimLeaseGeneration: 'foreign-victim',
      }) + '\n', { flag: 'wx' });

      assert.equal(claimMarker({ ...markerConfig(markerDir), sessionId: 'recovery' }), null);
      assert.equal(readFileSync(outsideVictim, 'utf8'), 'must-survive\n');
      assert.equal(existsSync(outsideClaim), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a fully same-dir transaction whose marker leaves are foreign names', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-round56-foreign-leaf-'));
    try {
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const marker = join(markerDir, 'foreign-marker');
      const victim = join(markerDir, 'foreign-victim');
      const markerClaim = join(markerDir, `.cah-marker-claim-${basename(marker)}`);
      const victimClaim = join(markerDir, `.cah-marker-claim-${basename(victim)}`);
      const capacityLease = join(markerDir, '.cah-marker-capacity-marker-tests');
      const transactionDir = join(dirname(markerDir), `.${basename(markerDir)}-capacity-transaction`);
      writeFileSync(marker, 'foreign marker\n');
      writeFileSync(victim, 'foreign victim\n');
      mkdirSync(transactionDir, { recursive: true });
      writeFileSync(join(transactionDir, 'transaction.json'), JSON.stringify({
        version: 2, marker, victim, victimKey: 'foreign-victim-key',
        markerBeforeKey: 'foreign-marker-before', nonce: 'foreign-same-dir',
        markerClaimPath: markerClaim, markerClaimToken: 'foreign-marker-claim',
        sessionLeaseToken: 'foreign-session', victimClaimPath: victimClaim,
        victimLeaseToken: 'foreign-victim-claim', capacityLeasePath: capacityLease,
        capacityLeaseToken: 'foreign-capacity', capacityLeaseGeneration: 'foreign-generation',
        victimFenceGeneration: 'foreign-generation', sessionLeaseGeneration: 'foreign-session-generation',
        victimLeaseGeneration: 'foreign-victim-generation',
      }) + '\n');

      assert.equal(claimMarker({ ...markerConfig(markerDir), sessionId: 'same-dir-recovery' }), null);
      assert.equal(readFileSync(marker, 'utf8'), 'foreign marker\n');
      assert.equal(readFileSync(victim, 'utf8'), 'foreign victim\n');
      assert.equal(existsSync(markerClaim), false);
      assert.equal(existsSync(victimClaim), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets a verified multi-lease successor recover a fresh live-PID publication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-marker-round55-live-'));
    try {
      const destination = join(dir, 'marker');
      const leases = ['capacity', 'session'].map((name) => {
        const path = join(dir, name);
        mkdirSync(path);
        writeFileSync(join(path, 'owner.json'), JSON.stringify({
          pid: process.pid, token: `old-${name}`, generation: `old-generation-${name}`,
        }));
        return { path, token: `old-${name}`, generation: `old-generation-${name}` };
      });
      assert.throws(() => writeFileAtomic(destination, 'old\n', {
        lifecycleLeases: leases,
        testInterlock: (phase) => {
          if (phase === 'write-after-final-rename') throw new Error('live owner paused');
        },
      }), /live owner paused/);

      const successorLeases = leases.map((lease) => {
        const successor = { ...lease, token: `new-${basename(lease.path)}`,
          generation: `new-generation-${basename(lease.path)}` };
        writeFileSync(join(lease.path, 'owner.json'), JSON.stringify({
          pid: process.pid, token: successor.token, generation: successor.generation,
        }));
        return successor;
      });
      const before = captureRegularFileSnapshot(destination);
      writeFileAtomic(destination, 'successor\n', {
        expectedDestination: before.expectedDestination,
        lifecycleLeases: successorLeases,
      });
      assert.equal(readFileSync(destination, 'utf8'), 'successor\n');
      assert.equal(existsSync(`${destination}.cah-owned-publish`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues populated-retirement reconciliation in bounded deterministic batches', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-round55-bounded-'));
    try {
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const victim = join(markerDir, `marker-${sessionHash('bounded-victim')}`);
      writeFileSync(victim, 'victim\n');
      const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
      const cfg = markerConfig(markerDir);
      const childCfg = { ...cfg, markerNameRe: undefined };
      const crashScript = `
        import { abortMarkerTransaction, claimMarker } from ${JSON.stringify(markerUrl)};
        const cfg = ${JSON.stringify(childCfg)};
        const claim = claimMarker({ ...cfg, sessionId: 'bounded-crash', nowMs: Date.now() });
        if (!claim || abortMarkerTransaction(claim)) process.exit(3);
      `;
      const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
        CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
        CAH_TEST_ONLY_CAPACITY_CRASH: 'after-transaction-retirement' };
      const crashed = runMarker(crashScript, env);
      assert.notEqual(crashed.status, 0, crashed.stderr);

      const transactionDir = join(home, 'cache', '.markers-capacity-transaction');
      const transactionPath = join(transactionDir, 'transaction.json');
      const canonical = JSON.parse(readFileSync(transactionPath, 'utf8'));
      for (let index = 0; index < 20; index += 1) {
        const generation = `round55-populated-${index.toString().padStart(2, '0')}`;
        const retired = transactionRetirementPath(transactionDir, generation);
        mkdirSync(retired);
        writeFileSync(join(retired, 'transaction.json'), JSON.stringify({
          ...canonical, capacityLeaseGeneration: generation,
        }) + '\n');
      }
      const recoveryScript = `
        import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
        const cfg = ${JSON.stringify(childCfg)};
        const claim = claimMarker({ ...cfg, sessionId: 'bounded-recovery', nowMs: Date.now() });
        if (!claim) process.exit(2);
        if (!abortMarkerTransaction(claim)) process.exit(2);
        releaseMarkerClaim(claim);
      `;
      const first = runMarker(recoveryScript, { ...env, CAH_TEST_ONLY_CAPACITY_CRASH: undefined });
      assert.equal(first.status, 2, first.stderr);
      assert.equal(existsSync(transactionDir), true);
      let result = first;
      for (let attempt = 0; attempt < 4 && result.status !== 0; attempt += 1) {
        result = runMarker(recoveryScript, { ...env, CAH_TEST_ONLY_CAPACITY_CRASH: undefined });
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(transactionDir), false);
      assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bounds retirement visits and inspections while preserving evidence and progress', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-round56-bounded-scan-'));
    try {
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const victim = join(markerDir, `marker-${sessionHash('bounded-scan-victim')}`);
      writeFileSync(victim, 'victim\n');
      const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
      const cfg = markerConfig(markerDir);
      const childCfg = { ...cfg, markerNameRe: undefined, retirementBatchCap: 4 };
      const crashScript = `
        import { abortMarkerTransaction, claimMarker } from ${JSON.stringify(markerUrl)};
        const cfg = ${JSON.stringify(childCfg)};
        const claim = claimMarker({ ...cfg, sessionId: 'bounded-scan-crash', nowMs: Date.now() });
        if (!claim || abortMarkerTransaction(claim)) process.exit(3);
      `;
      const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
        CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
        CAH_TEST_ONLY_CAPACITY_CRASH: 'after-transaction-retirement' };
      const crashed = runMarker(crashScript, env);
      assert.notEqual(crashed.status, 0, crashed.stderr);

      const transactionDir = join(home, 'cache', '.markers-capacity-transaction');
      const transactionPath = join(transactionDir, 'transaction.json');
      const canonical = JSON.parse(readFileSync(transactionPath, 'utf8'));
      for (let index = 0; index < 80; index += 1) {
        const generation = `round56-backlog-${index.toString().padStart(3, '0')}`;
        const retired = transactionRetirementPath(transactionDir, generation);
        mkdirSync(retired);
        writeFileSync(join(retired, 'transaction.json'), JSON.stringify({
          ...canonical, capacityLeaseGeneration: generation,
        }) + '\n');
      }
      const countRetirements = () => readdirSync(transactionDir)
        .filter((name) => name.startsWith('.cah-retired-')).length;
      const before = countRetirements();
      assert.equal(before, 81);

      resetDirectoryScanStats();
      const first = claimMarker({ ...childCfg, sessionId: 'bounded-scan-first', nowMs: Date.now() });
      const firstStats = readDirectoryScanStats();
      clearDirectoryScanStats();
      assert.equal(first, null);
      const afterFirst = countRetirements();
      assert.ok(afterFirst < before, 'first bounded recovery call must make safe progress');
      assert.ok(firstStats.visited < before * 2,
        `retirement directory visits must stay bounded: ${JSON.stringify(firstStats)}`);
      assert.ok(firstStats.lookaheadCalls <= childCfg.retirementBatchCap * 20,
        'retirement lookahead calls must stay bounded');
      assert.ok(firstStats.inspections <= childCfg.retirementBatchCap * 12,
        'retirement record inspection must stay within bounded recovery work');
      assert.equal(existsSync(transactionPath), true, 'canonical recovery evidence remains');
      assert.equal(existsSync(transactionDir), true, 'transaction evidence remains for continuation');

      resetDirectoryScanStats();
      const second = claimMarker({ ...childCfg, sessionId: 'bounded-scan-second', nowMs: Date.now() });
      const secondStats = readDirectoryScanStats();
      clearDirectoryScanStats();
      assert.equal(second, null);
      const afterSecond = countRetirements();
      assert.ok(afterSecond < afterFirst, 'next call must continue from the remaining backlog');
      assert.ok(secondStats.visited < before * 2, 'continuation must remain bounded');
      assert.equal(existsSync(transactionPath), true, 'evidence remains until recovery completes');
    } finally {
      clearDirectoryScanStats();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
