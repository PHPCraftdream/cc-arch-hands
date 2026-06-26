import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run, resolveScope, parseOnly } from '../lib/cli.js';
import { Scope } from '../lib/scope.js';
import { SentinelBin } from '../lib/sentinel.js';

// os.homedir() reads $HOME / %USERPROFILE% on each call, so we can sandbox the
// always-global bin directory to a temp dir for the duration of a test.
function withHome(home, fn) {
  const oh = process.env.HOME;
  const op = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    if (oh === undefined) delete process.env.HOME; else process.env.HOME = oh;
    if (op === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = op;
  }
}

function captureStdout(fn) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

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
    assert.deepEqual(parseOnly(''), ['commands', 'agents', 'skills', 'bins']);
    assert.deepEqual(parseOnly(undefined), ['commands', 'agents', 'skills', 'bins']);
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

  it('reinstall against a fresh --cwd is uninstall (no-op) then install', () => {
    // End-to-end sanity: dispatch is wired and the command exits cleanly.
    const dir = mkdtempSync(join(tmpdir(), 'cah-reinstall-'));
    assert.equal(run(['reinstall', '--cwd', dir, '--only', 'commands']), 0);
  });
});

// ---------------------------------------------------------------------------
// bins class through the CLI (integration: real PACKAGE_ROOT, real bin files)
// ---------------------------------------------------------------------------

describe('run install/uninstall --only bins', () => {
  const BIN_LEAVES = [
    'bin/cah-status.js',
    'bin/cah-stamp.js',
    'bin/cah-checkpoint-hint.js',
    'bin/cah-status-probe.js',
    'lib/transcript-stats.js',
  ];

  it('copies the real companion bins into <HOME>/.claude/cah-bin and removes them', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');

        assert.equal(run(['install', '--only', 'bins']), 0);
        for (const leaf of BIN_LEAVES) {
          const p = join(binDir, leaf);
          assert.ok(existsSync(p), `${leaf} should be installed`);
          assert.ok(
            readFileSync(p, 'utf8').includes(SentinelBin),
            `${leaf} should carry the bin sentinel`,
          );
        }
        // The copied entry point must still wire to its sibling lib via the
        // unchanged relative import — proves the bin/ + lib/ mirroring works.
        assert.ok(
          readFileSync(join(binDir, 'bin/cah-status.js'), 'utf8')
            .includes("'../lib/transcript-stats.js'"),
        );

        assert.equal(run(['uninstall', '--only', 'bins']), 0);
        for (const leaf of BIN_LEAVES) {
          assert.ok(!existsSync(join(binDir, leaf)), `${leaf} should be removed`);
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('list --json reports the bin files as mine once installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        run(['install', '--only', 'bins']);
        const out = captureStdout(() => run(['list', '--json']));
        const rows = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const binRows = rows.filter((r) => r.kind === 'bin');
        assert.equal(binRows.length, BIN_LEAVES.length);
        assert.ok(binRows.every((r) => r.state === 'mine'), 'all bin rows should be mine');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
