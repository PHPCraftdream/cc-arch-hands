import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimMarker, sessionHash,
} from '../lib/marker-state.js';
import { captureRegularFileSnapshot, writeFileAtomic } from '../lib/fsutil.js';
import { transactionRetirementPath } from '../lib/marker-capacity-ops.js';

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
});
