import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureRegularFileSnapshot, enumerateRecoveryArtifacts, isQuarantineName, isQuarantinePath,
  maintainRecoveryArtifacts, removeOwnedRegularFile,
} from '../lib/fs-atomic.js';

describe('empty atomic-removal reservations', () => {
  it('reclaims an identity-stable empty reservation before removing its leaf', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-empty-quarantine-'));
    const dest = join(dir, 'leaf');
    const reservation = `${dest}.cah-owned-remove`;
    writeFileSync(dest, 'owned\n');
    const snapshot = captureRegularFileSnapshot(dest);
    mkdirSync(reservation);

    assert.equal(removeOwnedRegularFile(dest, snapshot.expectedDestination), true);
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(reservation), false);
  });

  it('maintenance reclaims only an empty reservation and preserves successors and payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-empty-quarantine-'));
    const emptyLeaf = join(dir, 'empty');
    const successor = join(dir, 'successor');
    const emptyReservation = `${emptyLeaf}.cah-owned-remove`;
    writeFileSync(successor, 'successor\n');
    mkdirSync(emptyReservation);

    const swept = maintainRecoveryArtifacts(dir);
    assert.ok(swept.swept.includes(emptyReservation));
    assert.equal(readFileSync(successor, 'utf8'), 'successor\n');

    const occupied = join(dir, 'occupied.cah-owned-remove');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'foreign'), 'keep\n');
    const second = maintainRecoveryArtifacts(dir);
    assert.equal(second.swept.includes(occupied), false);
    assert.equal(readFileSync(join(occupied, 'foreign'), 'utf8'), 'keep\n');
  });
});

describe('lease-quarantine recovery artifacts', () => {
  it('classifies lease-quarantine roots as displaced, empty, or regular-file', () => {
    const base = mkdtempSync(join(tmpdir(), 'cah-lease-quarantine-'));
    const displaced = join(base, 'displaced', '.cah-lease-quarantine');
    mkdirSync(join(displaced, 'claim.taken-1-a'), { recursive: true });
    writeFileSync(join(displaced, 'claim.taken-1-a', 'stray'), 'stray');
    mkdirSync(join(base, 'empty', '.cah-lease-quarantine'), { recursive: true });
    mkdirSync(join(base, 'plain'), { recursive: true });
    writeFileSync(join(base, 'plain', '.cah-lease-quarantine'), 'not a directory');

    const expected = new Map([
      ['displaced', true],
      ['empty', false],
      ['plain', false],
    ]);
    for (const [name, expectDisplaced] of expected) {
      const artifacts = enumerateRecoveryArtifacts(join(base, name));
      const found = artifacts.filter((artifact) => artifact.kind === 'lease-quarantine');
      assert.equal(found.length, 1, `${name}: exactly one lease-quarantine artifact expected`);
      assert.equal(found[0].path, join(base, name, '.cah-lease-quarantine'));
      assert.equal(found[0].displacedData, expectDisplaced, `${name}: unexpected displacedData`);
      assert.equal(found[0].inspectionIncomplete, false, `${name}: must be fully inspected`);
    }

    const report = maintainRecoveryArtifacts(join(base, 'displaced'));
    assert.deepEqual(report.swept, [], 'a lease-quarantine namespace is never swept');
    assert.ok(report.recovery.includes(displaced), 'a displaced quarantine root must be reported as recovery');
    assert.equal(report.incomplete, false);
  });

  it('reports an uninspectable quarantine root as inspection-incomplete instead of dropping it', () => {
    const base = mkdtempSync(join(tmpdir(), 'cah-lease-quarantine-eacces-'));
    const root = join(base, '.cah-lease-quarantine');
    mkdirSync(root);
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'empty';
    try {
      const artifacts = enumerateRecoveryArtifacts(base);
      const found = artifacts.filter((artifact) => artifact.kind === 'lease-quarantine');
      assert.equal(found.length, 1, 'the artifact must be reported, not dropped');
      assert.equal(found[0].inspectionIncomplete, true);
      assert.equal(found[0].displacedData, false);
      assert.equal(artifacts.incomplete, true);
      assert.ok(artifacts.failures.some((failure) => failure.path === root));

      const report = maintainRecoveryArtifacts(base);
      assert.ok(report.recovery.includes(root), 'an inspection-incomplete root stays in the recovery report');
      assert.equal(report.incomplete, true);
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
    }
  });

  it('recognizes the lease-quarantine namespace as a recovery marker', () => {
    // The predicates and describeRecoveryArtifact() must agree about what
    // the string means, or orphan sweeps treat a recovery namespace as user
    // data.
    assert.equal(isQuarantineName('.cah-lease-quarantine'), true);
    assert.equal(isQuarantinePath(join('x', '.cah-lease-quarantine', 'claim.taken-1-a')), true);
    assert.equal(isQuarantineName('plain-name'), false);
  });
});
