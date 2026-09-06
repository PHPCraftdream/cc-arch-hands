import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionHash } from '../lib/marker-state.js';
import { transactionRetirementPath } from '../lib/marker-capacity-ops.js';
import { DEFAULT_CHILD_DEADLINE_MS } from '../test-support/process-batches.js';

function runMarkerSync(file, args, options = {}) {
  return spawnSync(file, args, {
    ...options,
    timeout: options.timeout ?? DEFAULT_CHILD_DEADLINE_MS,
    killSignal: options.killSignal ?? 'SIGKILL',
  });
}

describe('round54 marker capacity recovery', () => {
  it('reconciles two unrelated populated retirements around an expired canonical', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-marker-round54-'));
    try {
      const markerDir = join(home, 'cache', 'markers');
      mkdirSync(markerDir, { recursive: true });
      const victim = join(markerDir, `marker-${sessionHash('round54-victim')}`);
      writeFileSync(victim, 'victim\n');
      const markerUrl = new URL('../lib/marker-state.js', import.meta.url).href;
      const cfg = `const cfg = { markerDir: process.env.CAH_TEST_MARKER_DIR,
        namespace: 'marker-tests', prefix: 'marker-', ttlMs: 86400000, maxSessions: 1,
        scanCap: 128, claimTtlMs: 100,
        ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS',
        markerNameRe: /^marker-[a-f0-9]{64}$/ };`;
      const crashScript = `
        import { abortMarkerTransaction, claimMarker } from ${JSON.stringify(markerUrl)};
        ${cfg}
        const claim = claimMarker({ ...cfg, sessionId: 'round54-crash', nowMs: Date.now() });
        if (!claim || abortMarkerTransaction(claim)) process.exit(3);
      `;
      const env = { ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
        CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
        CAH_TEST_ONLY_CAPACITY_CRASH: 'after-transaction-retirement' };
      const crashed = runMarkerSync(process.execPath, ['--input-type=module', '-e', crashScript], {
        encoding: 'utf8', env,
      });
      assert.notEqual(crashed.status, 0, crashed.error || crashed.stderr);

      const txDir = join(home, 'cache', '.markers-capacity-transaction');
      const txPath = join(txDir, 'transaction.json');
      const canonical = JSON.parse(readFileSync(txPath, 'utf8'));
      for (const generation of ['round54-unrelated-a', 'round54-unrelated-b']) {
        const retirement = transactionRetirementPath(txDir, generation);
        mkdirSync(retirement);
        writeFileSync(join(retirement, 'transaction.json'), JSON.stringify({
          ...canonical, capacityLeaseGeneration: generation,
        }) + '\n');
      }

      const recoveryScript = `
        import { abortMarkerTransaction, claimMarker, releaseMarkerClaim } from ${JSON.stringify(markerUrl)};
        ${cfg}
        const claim = claimMarker({ ...cfg, sessionId: 'round54-independent-claim', nowMs: Date.now() });
        if (!claim || !abortMarkerTransaction(claim)) process.exit(2);
        releaseMarkerClaim(claim);
      `;
      const recoveryEnv = { ...env };
      delete recoveryEnv.CAH_TEST_ONLY_CAPACITY_CRASH;
      const recovered = runMarkerSync(process.execPath, ['--input-type=module', '-e', recoveryScript], {
        encoding: 'utf8', env: recoveryEnv,
      });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(existsSync(txDir), false);
      assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
