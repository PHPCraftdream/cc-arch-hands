import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeInterlock, STAGE_NAMES } from '../test-support/interlocks.js';

const fixtures = new Set();

const callStartRe = /testInterlock(?:\s*\?.\s*)?\(/g;
const literalRe = /^'([^']+)'$|^"([^"]+)"$/;

function skipQuoted(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === quote) return i;
    if (quote !== '`' && source[i] === '\n') return -1;
  }
  return -1;
}

// Balanced-paren argument extraction for the STAGE_NAMES scan. The previous
// `[^)]*` argument regex truncated any call whose arguments contain a ")" —
// e.g. testInterlock(phaseFor(config), 'brand-new-stage') — to a single wrong
// match whose start/parsed counters still agreed, so a stage literal
// introduced by such a call was silently missed. This walker tracks nested
// parentheses while skipping string literals and comments; a site it cannot
// close is reported as unparseable and fails the scan's self-check instead
// of silently agreeing with it.
function scanCallArguments(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const end = skipQuoted(source, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { args: source.slice(openParenIndex + 1, i), end: i };
    }
  }
  return null;
}

// Split a parsed argument list on top-level commas only, so a call like
// testInterlock(phaseFor(a, b), 'stage') still yields the stage as args[1].
function splitArguments(args) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const end = skipQuoted(args, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts;
}

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
    // The argument scan matches call sites that span lines (several do), and
    // it must never under-count silently: the raw call-start total is checked
    // against both the fully parsed total and EXPECTED_CALL_SITES, so a call
    // the balanced scan cannot close fails loudly instead of passing silently.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    // The parser (test-support/interlocks.js) consumes args[1] as a stage only
    // when it names a declared stage; otherwise it is the first alias of the
    // no-stage shape. probe.js uses that shape with quoted alias literals, so
    // its args[1] values are the only non-stage entries the scan may find.
    const knownAliasFirstArgs = new Set([
      'disable-after-backup-check', 'disable-after-settings-rename',
      'disable-before-settings-rename', 'enable-after-backup-check',
      'enable-after-settings-rename', 'enable-before-settings-rename',
    ]);
    // A drift detector, not a production rendezvous count: 57 real
    // production rendezvous points + 3 forwarding shims that pass only
    // identifiers (lib/lease-lock.js's options.testInterlock(phase, stage),
    // lib/fs-atomic-publication.js's options?.testInterlock?.(...phases),
    // and lib/fs-atomic.js's options?.testInterlock?.(...phases)),
    // excluding the single `function testInterlock(` definition itself.
    const EXPECTED_CALL_SITES = 60;
    const found = new Set();
    let callStarts = 0;
    let parsedCalls = 0;
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(callStartRe)) {
            if (/function\s+$/.test(source.slice(Math.max(0, match.index - 12), match.index))) continue;
            callStarts += 1;
            const parsed = scanCallArguments(source, match.index + match[0].length - 1);
            if (!parsed) continue;
            parsedCalls += 1;
            const parts = splitArguments(parsed.args);
            const literal = parts && parts.length > 1 ? literalRe.exec(parts[1].trim()) : null;
            if (literal) found.add(literal[1] ?? literal[2]);
          }
        }
      }
    };
    visit(join(root, 'lib'));
    visit(join(root, 'bin'));
    assert.equal(callStarts, parsedCalls,
      'every testInterlock call site must be parseable by the balanced-paren scan; '
      + 'a site whose parens/strings/comments never balance is unparseable');
    assert.equal(parsedCalls, EXPECTED_CALL_SITES,
      'the production testInterlock call-site count changed; re-run the scan, '
      + 'update EXPECTED_CALL_SITES, and update STAGE_NAMES if a stage was added or removed');
    assert.deepEqual(
      [...found].sort(),
      [...STAGE_NAMES, ...knownAliasFirstArgs].sort(),
      'the quoted args[1] literals in lib/ and bin/ must be exactly the declared '
      + 'stages plus the known alias-only first arguments',
    );
  });

  it('parses a call site whose arguments contain a nested ")"', () => {
    const source = 'const next = () => testInterlock(phaseFor(config), \'brand-new-stage\');\n';
    const match = new RegExp(callStartRe.source, callStartRe.flags).exec(source);
    assert.notEqual(match, null);
    const parsed = scanCallArguments(source, match.index + match[0].length - 1);
    assert.notEqual(parsed, null, 'the balanced scan must close a call with nested parens');
    const parts = splitArguments(parsed.args);
    assert.deepEqual(parts, ['phaseFor(config)', " 'brand-new-stage'"],
      'the argument text must survive a ")" inside the arguments');
    const literal = literalRe.exec(parts[1].trim());
    assert.notEqual(literal, null, 'the stage literal after a nested-paren argument must be found');
    assert.equal(literal[1] ?? literal[2], 'brand-new-stage');
  });
});
