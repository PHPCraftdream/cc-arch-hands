import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { run, resolveScope, parseOnly, resolveDeps } from '../lib/cli.js';
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
  it('empty returns all classes in order, no individual skills', () => {
    assert.deepEqual(parseOnly(''), { classes: ['commands', 'agents', 'skills', 'bins'], skills: [] });
    assert.deepEqual(parseOnly(undefined), { classes: ['commands', 'agents', 'skills', 'bins'], skills: [] });
  });

  it('single class', () => {
    assert.deepEqual(parseOnly('skills'), { classes: ['skills'], skills: [] });
  });

  it('comma-separated classes preserve canonical order', () => {
    assert.deepEqual(parseOnly('skills,commands'), { classes: ['commands', 'skills'], skills: [] });
  });

  it('deduplicates', () => {
    assert.deepEqual(parseOnly('agents,agents'), { classes: ['agents'], skills: [] });
  });

  it('individual skill name', () => {
    assert.deepEqual(parseOnly('clock'), { classes: [], skills: ['clock'] });
  });

  it('multiple skill names sorted', () => {
    assert.deepEqual(parseOnly('clock,babysit'), { classes: [], skills: ['babysit', 'clock'] });
  });

  it('mix of class and skill names', () => {
    assert.deepEqual(
      parseOnly('commands,clock,bins'),
      { classes: ['commands', 'bins'], skills: ['clock'] },
    );
  });

  it('unknown name throws and lists valid options', () => {
    assert.throws(() => parseOnly('foo'), /unknown name "foo"/);
    assert.throws(() => parseOnly('clock,foo'), /unknown name "foo"/);
  });

  it('all-blank resolves to no classes and throws', () => {
    assert.throws(() => parseOnly(' , , '), /no classes/);
  });
});

describe('resolveDeps', () => {
  it('passes through when no skill triggers a dep', () => {
    const r = resolveDeps({ classes: ['commands'], skills: [] });
    assert.deepEqual(r.classes, ['commands']);
    assert.deepEqual(r.skills, []);
    assert.deepEqual(r.notices, []);
  });

  it('auto-adds bins when clock is selected by name', () => {
    const r = resolveDeps({ classes: [], skills: ['clock'] });
    assert.ok(r.classes.includes('bins'));
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0], /auto-added 'bins'.*clock/);
  });

  it('auto-adds bins when checkpoint-watch is selected by name', () => {
    const r = resolveDeps({ classes: [], skills: ['checkpoint-watch'] });
    assert.ok(r.classes.includes('bins'));
    assert.match(r.notices[0], /checkpoint-watch/);
  });

  it('does not add bins when already present', () => {
    const r = resolveDeps({ classes: ['bins'], skills: ['clock'] });
    assert.deepEqual(r.notices, []);
  });

  it('triggers from whole "skills" class too — clock/checkpoint-watch are inside', () => {
    const r = resolveDeps({ classes: ['skills'], skills: [] });
    assert.ok(r.classes.includes('bins'));
    assert.match(r.notices[0], /clock/);
    assert.match(r.notices[0], /checkpoint-watch/);
  });

  it('classes returned in canonical order', () => {
    const r = resolveDeps({ classes: ['bins', 'commands'], skills: ['clock'] });
    assert.deepEqual(r.classes, ['commands', 'bins']);
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

// ---------------------------------------------------------------------------
// targeted install/uninstall/reinstall by skill name
// ---------------------------------------------------------------------------

describe('run install/uninstall --only <skill-name>', () => {
  it('installs ONLY the named skill, leaving other skill folders untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-subset-'));
    const skillsDir = join(dir, '.claude', 'skills');
    // First seed two skills with a full install.
    assert.equal(run(['install', '--only', 'skills', '--cwd', dir]), 0);
    assert.ok(existsSync(join(skillsDir, 'clock')));
    assert.ok(existsSync(join(skillsDir, 'babysit')));

    // Now uninstall only one — the other must survive.
    assert.equal(run(['uninstall', '--only', 'babysit', '--cwd', dir]), 0);
    assert.ok(existsSync(join(skillsDir, 'clock')), 'clock must survive targeted uninstall of babysit');
    assert.ok(!existsSync(join(skillsDir, 'babysit')), 'babysit must be gone');
    rmSync(dir, { recursive: true, force: true });
  });

  it('install --only clock writes the clock skill AND auto-pulls bins (with notice)', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const out = captureStdout(() => assert.equal(run(['install', '--only', 'clock']), 0));
        assert.match(out, /notice: auto-added 'bins' \(required by: clock\)/);
        assert.ok(existsSync(join(home, '.claude', 'skills', 'clock', 'SKILL.md')));
        assert.ok(existsSync(join(home, '.claude', 'cah-bin', 'bin', 'cah-status.js')),
          'bins must be auto-installed');
        // Other skills must NOT appear when only clock is requested.
        assert.ok(!existsSync(join(home, '.claude', 'skills', 'babysit')));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('uninstall does NOT auto-pull deps — removes ONLY what is named', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        // Seed both clock and bins.
        run(['install', '--only', 'clock']);
        assert.ok(existsSync(join(home, '.claude', 'cah-bin', 'bin', 'cah-status.js')));
        // Now remove only clock — bins must stay.
        const out = captureStdout(() => assert.equal(run(['uninstall', '--only', 'clock']), 0));
        assert.ok(!out.includes('auto-added'), 'uninstall must NOT auto-pull deps');
        assert.ok(!existsSync(join(home, '.claude', 'skills', 'clock')));
        assert.ok(existsSync(join(home, '.claude', 'cah-bin', 'bin', 'cah-status.js')),
          'bins must survive targeted uninstall of clock');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reinstall --only clock honours the subset (uninstall + install)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-subset-rein-'));
    // Seed everything first.
    run(['install', '--cwd', dir]);
    const before = readFileSync(join(dir, '.claude', 'skills', 'clock', 'SKILL.md'), 'utf8');
    // reinstall just clock; other skills must be unaffected.
    assert.equal(run(['reinstall', '--cwd', dir, '--only', 'clock']), 0);
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'babysit')),
      'other skills survive reinstall of single skill');
    const after = readFileSync(join(dir, '.claude', 'skills', 'clock', 'SKILL.md'), 'utf8');
    assert.equal(after, before, 'clock content matches embedded template (round-trip)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('unknown name in --only is rejected with exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-bogus-'));
    assert.equal(run(['install', '--only', 'not-a-real-skill', '--cwd', dir]), 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// doctor exit codes (review H3) + reinstall --templates (review H4/M8)
// ---------------------------------------------------------------------------

describe('doctor exit codes', () => {
  it('returns 1 when expected files are missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'cah-proj-'));
    try {
      withHome(home, () => {
        let rc;
        captureStdout(() => { rc = run(['doctor', '--cwd', proj]); });
        assert.equal(rc, 1);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('returns 0 when a full global install is healthy', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        captureStdout(() => run(['install']));
        let rc;
        captureStdout(() => { rc = run(['doctor']); });
        assert.equal(rc, 0);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('reinstall --templates', () => {
  it('does not abort in the uninstall phase (review H4/M8)', () => {
    const templates = fileURLToPath(new URL('../templates', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'cah-rein-tpl-'));
    try {
      let rc;
      captureStdout(() => {
        rc = run(['reinstall', '--cwd', dir, '--templates', templates, '--only', 'skills']);
      });
      assert.equal(rc, 0);
      assert.ok(existsSync(join(dir, '.claude', 'skills', 'clock', 'SKILL.md')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
