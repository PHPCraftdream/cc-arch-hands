import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeInterlock } from '../test-support/interlocks.js';

const fixtures = new Set();

afterEach(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
  fixtures.clear();
});

// Drives one interlock call against a fresh rendezvous base with a pre-armed
// `.go` file: when the configured phase/alias is among the call's candidates,
// wait() writes `${base}.ready` and returns immediately.
function rendezvousFires(phase, callArgs) {
  const base = join(mkdtempSync(join(tmpdir(), 'cah-interlock-')), 'rendezvous');
  fixtures.add(base);
  const interlock = makeInterlock({
    CAH_TEST_ONLY: '1',
    CAH_TEST_ONLY_FSUTIL_INTERLOCK: base,
    CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: phase,
  });
  writeFileSync(`${base}.go`, 'go');
  let threw = null;
  try { interlock(...callArgs); } catch (error) { threw = error; }
  return { fired: existsSync(`${base}.ready`), threw };
}

describe('interlock argument parser', () => {
  it('keeps the first alias of every no-stage call shape reachable', () => {
    // (phase, ...aliases) shape — one representative per production file:
    const cases = [
      // lib/fs-atomic.js:110
      ['write-after-transaction-temp-create', ['write-after-temp-create', 'write-after-transaction-temp-create']],
      // lib/fs-atomic.js:144
      ['write-post-rename', ['write-after-rename', 'write-post-rename']],
      // lib/fs-atomic-publication.js:813
      ['write-after-final-operation', ['write-after-final-rename', 'write-after-final-operation']],
      // lib/probe.js:400 (middle alias)
      ['enable-after-backup-check', ['enable-post-backup-check', 'enable-after-backup-check', 'post-backup-check']],
      // lib/probe.js:403 (middle alias)
      ['enable-before-settings-rename', ['enable-pre-settings-rename', 'enable-before-settings-rename', 'pre-settings-rename']],
      // lib/binstall/runtime.js:245 (alias + numeric tail)
      ['lib/lease-lock.js', ['binstall-before-source-capture', 'lib/lease-lock.js', 0]],
      // single-argument shape is unaffected
      ['prune-before-remove', ['prune-before-remove']],
    ];
    for (const [phase, callArgs] of cases) {
      const { fired, threw } = rendezvousFires(phase, callArgs);
      assert.equal(threw, null, `${phase}: unexpected interlock error`);
      assert.equal(fired, true, `${phase} (alias of ${callArgs[0]}) must be a rendezvous candidate`);
    }
  });

  it('still resolves aliases when a declared stage is present', () => {
    const { fired, threw } = rendezvousFires('marker-capacity', [
      'marker-capacity-transaction-retire', 'before', 'marker-capacity',
    ]);
    assert.equal(threw, null);
    assert.equal(fired, true, 'the alias after a declared stage must stay a rendezvous candidate');
  });

  it('does not fire for a phase outside the call candidates', () => {
    const { fired, threw } = rendezvousFires('no-such-phase', [
      'write-after-rename', 'write-post-rename',
    ]);
    assert.equal(threw, null, 'a non-matching configured phase must return without waiting or throwing');
    assert.equal(fired, false);
  });

  it('does not treat a declared stage as a rendezvous candidate', () => {
    const { fired, threw } = rendezvousFires('before', ['lease-reclaim', 'before']);
    assert.equal(threw, null);
    assert.equal(fired, false, "a declared stage must be consumed as the stage, not leak into candidates");
  });
});
