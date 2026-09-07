import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeInterlock, STAGE_NAMES } from '../test-support/interlocks.js';

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

  it('keeps STAGE_NAMES in lockstep with the production stage literals', () => {
    // An undeclared stage silently becomes a phase-agnostic rendezvous
    // candidate that fires at every unrelated call site using the same stage,
    // so the declared set must track the literals production actually passes.
    // Every current call site is single-line, so a bounded same-line argument
    // scan is exact today; if a call site ever spans lines this test fails on
    // the resulting set mismatch and the scan must be extended with it.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const callSiteRe = /testInterlock(?:\s*\?.\s*)?\(([^)\n]*)\)/g;
    const literalRe = /^'([^']+)'$|^"([^"]+)"$/;
    const found = new Set();
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          for (const match of readFileSync(path, 'utf8').matchAll(callSiteRe)) {
            const args = match[1].split(',');
            const literal = args.length > 1 ? literalRe.exec(args[1].trim()) : null;
            if (literal) found.add(literal[1] ?? literal[2]);
          }
        }
      }
    };
    visit(join(root, 'lib'));
    visit(join(root, 'bin'));
    assert.deepEqual(
      [...found].sort(),
      [...STAGE_NAMES].sort(),
      'STAGE_NAMES must exactly match the testInterlock() stage literals in lib/ and bin/',
    );
  });
});
