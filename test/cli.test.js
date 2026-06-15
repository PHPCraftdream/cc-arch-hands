import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { run, resolveScope, parseOnly } from '../lib/cli.js';
import { Scope } from '../lib/scope.js';

// ---------------------------------------------------------------------------
// resolveScope
// ---------------------------------------------------------------------------

describe('resolveScope', () => {
  it('default (no flags) is global', () => {
    const scope = resolveScope({ global: false, local: false, cwd: '' });
    assert.equal(scope.global, true);
  });

  it('--global explicit is global', () => {
    const scope = resolveScope({ global: true, local: false, cwd: '' });
    assert.equal(scope.global, true);
  });

  it('--local is strict local', () => {
    const scope = resolveScope({ global: false, local: true, cwd: '' });
    assert.equal(scope.global, false);
    assert.equal(scope.strict, true);
  });

  it('--cwd implies local non-strict', () => {
    const scope = resolveScope({ global: false, local: false, cwd: '/tmp/x' });
    assert.equal(scope.global, false);
    assert.equal(scope.strict, false);
    assert.equal(scope.cwd, '/tmp/x');
  });

  it('--local --cwd is strict at cwd', () => {
    const scope = resolveScope({ global: false, local: true, cwd: '/tmp/x' });
    assert.equal(scope.global, false);
    assert.equal(scope.strict, true);
    assert.equal(scope.cwd, '/tmp/x');
  });

  it('--global --local throws', () => {
    assert.throws(
      () => resolveScope({ global: true, local: true, cwd: '' }),
      /mutually exclusive/,
    );
  });

  it('--global --cwd throws', () => {
    assert.throws(
      () => resolveScope({ global: true, local: false, cwd: '/tmp' }),
      /mutually exclusive/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseOnly
// ---------------------------------------------------------------------------

describe('parseOnly', () => {
  it('empty returns all classes in order', () => {
    assert.deepEqual(parseOnly(''), ['commands', 'agents', 'skills']);
    assert.deepEqual(parseOnly(undefined), ['commands', 'agents', 'skills']);
  });

  it('single class', () => {
    assert.deepEqual(parseOnly('skills'), ['skills']);
  });

  it('comma-separated preserves canonical order', () => {
    assert.deepEqual(parseOnly('skills,commands'), ['commands', 'skills']);
  });

  it('deduplicates', () => {
    assert.deepEqual(parseOnly('agents,agents'), ['agents']);
  });

  it('unknown class throws', () => {
    assert.throws(() => parseOnly('foo'), /unknown class/);
  });

  it('all-blank resolves to no classes and throws', () => {
    assert.throws(() => parseOnly(' , , '), /no classes/);
  });
});

// ---------------------------------------------------------------------------
// run (dispatch smoke)
// ---------------------------------------------------------------------------

describe('run', () => {
  it('no args returns 0', () => {
    assert.equal(run([]), 0);
  });

  it('help returns 0', () => {
    assert.equal(run(['help']), 0);
    assert.equal(run(['--help']), 0);
    assert.equal(run(['-h']), 0);
  });

  it('unknown subcommand returns 2', () => {
    assert.equal(run(['bogus']), 2);
  });

  it('version returns 0', () => {
    assert.equal(run(['version']), 0);
  });
});
