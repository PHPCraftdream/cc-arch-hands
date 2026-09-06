import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureRegularFileSnapshot, maintainRecoveryArtifacts, removeOwnedRegularFile,
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
