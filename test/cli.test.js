import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run, resolveScope, parseOnly, resolveDeps, classifyPath } from '../lib/cli.js';
import { BinFiles, binLifecycleLockPath } from '../lib/binstall.js';
import { LEASE_MAX_MS } from '../lib/lease-lock.js';
import { AllCodexAgents } from '../lib/manifest.js';
import { SentinelBin, SentinelCodexAgent, SetForModelCommand } from '../lib/sentinel.js';
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
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (s) => { out += s; return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
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
    assert.deepEqual(parseOnly(''), { classes: ['agents', 'skills', 'bins'], skills: [] });
    assert.deepEqual(parseOnly(undefined), { classes: ['agents', 'skills', 'bins'], skills: [] });
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
  it('rejects the extracted agent-tree selector', () => {
    assert.throws(() => parseOnly('agent-tree'), /unknown name "agent-tree"/);
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

  it('install and reinstall return 2 for any strict parseArgs error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-parse-positional-'));
    try {
      assert.equal(run(['install', '--cwd', dir, 'unexpected']), 2);
      assert.equal(run(['reinstall', '--cwd', dir, 'unexpected']), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('version returns 0', () => {
    assert.equal(run(['version']), 0);
  });

  it('rejects --agent-tree and exposes no extracted feature in version/list', () => {
    const error = captureStderr(() => assert.equal(run(['install', '--agent-tree']), 2));
    assert.match(error, /Unknown option .*agent-tree/);

    const home = mkdtempSync(join(tmpdir(), 'cah-extraction-'));
    try {
      withHome(home, () => {
        const version = captureStdout(() => run(['version']));
        const listing = captureStdout(() => run(['list', '--json']));
        assert.doesNotMatch(version, /agent-tree/);
        assert.doesNotMatch(listing, /agent-tree/);
        const rows = listing.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        assert.ok(rows.every((row) => !JSON.stringify(row).includes('agent-tree')));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reinstall against a fresh --cwd is uninstall (no-op) then install', () => {
    // End-to-end sanity: dispatch is wired and the command exits cleanly.
    const dir = mkdtempSync(join(tmpdir(), 'cah-reinstall-'));
    assert.equal(run(['reinstall', '--cwd', dir, '--only', 'commands']), 0);
  });
});

describe('Windows wrappers', () => {
  const wrappers = [
    ['install.bat', 'install'],
    ['reinstall.bat', 'reinstall'],
    ['uninstall.bat', 'uninstall'],
  ];

  it('use the package entry point without changing caller cwd and preserve %errorlevel%', () => {
    for (const [file, subcommand] of wrappers) {
      const body = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
      assert.doesNotMatch(body, /^\s*cd(?:\s|\/)/im, `${file} must not change cwd`);
      assert.ok(body.includes(`node "%~dp0bin\\cah.js" ${subcommand} %*`), `${file} must use absolute entry point`);
      assert.match(body, /exit \/b %errorlevel%/i, `${file} must preserve exit code`);
    }
  });

  it('executes install in the caller cwd on Windows', { skip: process.platform !== 'win32' }, () => {
    const caller = mkdtempSync(join(tmpdir(), 'cah-wrapper-cwd-'));
    try {
      mkdirSync(join(caller, '.claude'));
      const wrapper = fileURLToPath(new URL('../install.bat', import.meta.url));
      const result = spawnSync(wrapper, ['--local', '--only', 'commands'], {
        cwd: caller,
        encoding: 'utf8',
        shell: true,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(caller, '.claude', 'commands', 'oh.md')),
        'wrapper must install into caller .claude');

      const failed = spawnSync(wrapper, ['--not-a-real-option'], {
        cwd: caller,
        encoding: 'utf8',
        shell: true,
      });
      assert.equal(failed.status, 2, failed.stderr);
    } finally {
      rmSync(caller, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// bins class through the CLI (integration: real PACKAGE_ROOT, real bin files)
// ---------------------------------------------------------------------------

describe('run install/uninstall --only bins', () => {
  const BIN_LEAVES = BinFiles.map(({ dest }) => dest);

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

  it('reports a live lifecycle lease as busy and recovers an expired one', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');
        const lockPath = binLifecycleLockPath(binDir);
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
          kind: 'cc-arch-hands-bin-lifecycle',
          pid: process.pid,
          token: 'live-cli-operation',
          timestamp: Date.now(),
        }) + '\n');

        let busyRc;
        const busy = captureStderr(() => { busyRc = run(['install', '--only', 'bins']); });
        assert.equal(busyRc, 1);
        assert.match(busy, /companion bins are busy/);
        assert.ok(!existsSync(join(binDir, 'package.json')), 'busy install must not publish leaves');

        writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
          kind: 'cc-arch-hands-bin-lifecycle',
          pid: process.pid,
          token: 'expired-cli-operation',
          timestamp: Date.now() - LEASE_MAX_MS - 60 * 1000,
        }) + '\n');
        assert.equal(run(['install', '--only', 'bins']), 0);
        assert.ok(existsSync(join(binDir, 'package.json')));
        assert.ok(!existsSync(lockPath), 'CLI must release the recovered sibling lease');
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
        assert.equal(binRows.length, BinFiles.length);
        assert.ok(binRows.every((r) => r.state === 'mine'), 'all bin rows should be mine');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('silently preserves the root cache while reporting unknown entries with normalized paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');
        mkdirSync(join(binDir, 'cache'), { recursive: true });
        mkdirSync(join(binDir, 'unknown-root-dir'), { recursive: true });

        const out = captureStdout(() => {
          assert.equal(run(['install', '--global', '--only', 'bins']), 0);
        });
        assert.ok(existsSync(join(binDir, 'cache')));
        assert.ok(existsSync(join(binDir, 'unknown-root-dir')));
        assert.doesNotMatch(out, /skipped: cache\b/);
        assert.match(out, /skipped: unknown-root-dir\b/);
        assert.doesNotMatch(out, /skipped: .*cah-bin[\\/]unknown-root-dir/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('reports unproved cache crash temps through install and uninstall maintenance', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');
        const cache = join(binDir, 'cache');
        const crashTemp = join(cache, '.cah-tmp-crashed-cli');
        mkdirSync(cache, { recursive: true });
        writeFileSync(crashTemp, 'unproved crash leftover\n');

        const installed = captureStdout(() => {
          assert.equal(run(['install', '--only', 'bins']), 0);
        });
        assert.match(installed, /recovery: cache[\\/]\.cah-tmp-crashed-cli/);
        assert.ok(existsSync(crashTemp), 'unproved cache temp must be preserved');
        assert.doesNotMatch(installed, /skipped: cache\b/);

        const removed = captureStdout(() => {
          assert.equal(run(['uninstall', '--only', 'bins']), 0);
        });
        assert.match(removed, /recovery: cache[\\/]\.cah-tmp-crashed-cli/);
        assert.ok(existsSync(crashTemp), 'unproved cache temp must survive removal');
        assert.doesNotMatch(removed, /skipped: cache\b/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('warns but does not fail when cache maintenance cannot enumerate', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    try {
      withHome(home, () => {
        mkdirSync(join(home, '.claude', 'cah-bin', 'cache'), { recursive: true });
        process.env.CAH_TEST_ONLY = '1';
        process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'opendir';
        const installed = captureStdout(() => assert.equal(run(['install', '--only', 'bins']), 0));
        assert.match(installed, /warning: cache maintenance incomplete/);
        const removed = captureStdout(() => assert.equal(run(['uninstall', '--only', 'bins']), 0));
        assert.match(removed, /warning: cache maintenance incomplete/);
      });
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('reports combined root and cache maintenance failures once on install and uninstall', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');
        const cache = join(binDir, 'cache');
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(binDir, '.cah-tmp-root-cli'), 'root recovery\n');
        writeFileSync(join(cache, '.cah-tmp-cache-cli'), 'cache recovery\n');
        process.env.CAH_TEST_ONLY = '1';
        process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'opendir';

        const installed = captureStdout(() => assert.equal(run(['install', '--only', 'bins']), 0));
        const installCacheFailures = installed.split(/\r?\n/)
          .filter((line) => line === '    maintenance failure: EACCES cache');
        assert.equal(installCacheFailures.length, 1);

        const removed = captureStdout(() => assert.equal(run(['uninstall', '--only', 'bins']), 0));
        const uninstallCacheFailures = removed.split(/\r?\n/)
          .filter((line) => line === '    maintenance failure: EACCES cache');
        assert.equal(uninstallCacheFailures.length, 1);
      });
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('propagates generic command maintenance failures to the CLI report', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    try {
      withHome(home, () => {
        process.env.CAH_TEST_ONLY = '1';
        process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'opendir';
        const output = captureStdout(() => {
          assert.equal(run(['install', '--only', 'commands']), 0);
        });
        assert.match(output, /commands:[\s\S]*warning: cache maintenance incomplete/);
      });
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bare uninstall preserves shared bins; explicit bins removal warns', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        run(['install', '--only', 'bins']);
        assert.equal(run(['uninstall']), 0);
        assert.ok(existsSync(join(home, '.claude', 'cah-bin', 'bin', 'cah-status.js')));
        const out = captureStdout(() => assert.equal(run(['uninstall', '--only', 'bins']), 0));
        assert.match(out, /warning: removing shared companion bins/);
        assert.ok(!existsSync(join(home, '.claude', 'cah-bin', 'bin', 'cah-status.js')));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a foreign ESM package boundary before CLI bin mutation', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');
        const foreignPackage = JSON.stringify({ type: 'module', owner: 'user' }) + '\n';
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, 'package.json'), foreignPackage);

        let rc;
        const error = captureStderr(() => { rc = run(['install', '--only', 'bins']); });
        assert.equal(rc, 1);
        assert.match(error, /foreign package boundary/);
        assert.equal(readFileSync(join(binDir, 'package.json'), 'utf8'), foreignPackage);
        assert.ok(!existsSync(join(binDir, 'bin', 'cah-status.js')),
          'CLI failure must not publish companion leaves');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a foreign companion executable before CLI bin mutation', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        const binDir = join(home, '.claude', 'cah-bin');
        const foreign = join(binDir, 'bin', 'cah-status.js');
        const foreignBody = '#!/usr/bin/env node\nforeign\n';
        mkdirSync(join(binDir, 'bin'), { recursive: true });
        writeFileSync(foreign, foreignBody);

        let rc;
        const error = captureStderr(() => { rc = run(['install', '--only', 'bins']); });
        assert.equal(rc, 1);
        assert.match(error, /foreign managed runtime leaf.*cah-status\.js/);
        assert.equal(readFileSync(foreign, 'utf8'), foreignBody);
        assert.ok(!existsSync(join(binDir, 'package.json')),
          'foreign executable rejection must not publish the package boundary');
        assert.ok(!existsSync(join(binDir, 'lib', 'fsutil.js')),
          'foreign executable rejection must not publish dependencies');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});


describe('run install/uninstall --codex-agents', () => {
  it('default install does not write Codex agents', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        assert.equal(run(['install', '--only', 'commands']), 0);
        assert.ok(!existsSync(join(home, '.codex', 'agents', 'h55.toml')));
        // codex-agents is an opt-in selector — valid via --only but excluded from
        // the default (empty --only) install set.
        assert.deepEqual(parseOnly('codex-agents'), { classes: ['codex-agents'], skills: [] });
        assert.deepEqual(parseOnly(''), { classes: ['agents', 'skills', 'bins'], skills: [] });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes Codex agents under <HOME>/.codex/agents and removes them', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        assert.equal(run(['install', '--codex-agents']), 0);
        assert.ok(existsSync(join(home, '.codex', 'agents', 'ha.toml')));
        assert.ok(readFileSync(join(home, '.codex', 'agents', 'ha.toml'), 'utf8').includes('model = "gpt-6-astra"'));
        assert.ok(readFileSync(join(home, '.codex', 'agents', 'xxt.toml'), 'utf8').includes('model = "gpt-5.6-terra"'));
        assert.ok(readFileSync(join(home, '.codex', 'agents', 'xxt.toml'), 'utf8').includes('model_reasoning_effort = "max"'));
        assert.ok(readFileSync(join(home, '.codex', 'agents', 'ul.toml'), 'utf8').includes('model = "gpt-5.6-luna"'));
        assert.ok(readFileSync(join(home, '.codex', 'agents', 'us.toml'), 'utf8').includes('model = "gpt-5.6-sol"'));
        assert.ok(readFileSync(join(home, '.codex', 'agents', 'us.toml'), 'utf8').includes('model_reasoning_effort = "ultra"'));

        const out = captureStdout(() => run(['list', '--json']));
        const rows = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const codexRows = rows.filter((r) => r.kind === 'codex-agent');
        assert.equal(codexRows.length, AllCodexAgents.length);
        assert.ok(codexRows.every((r) => r.state === 'mine'));

        assert.equal(run(['uninstall', '--codex-agents']), 0);
        assert.ok(!existsSync(join(home, '.codex', 'agents', 'ha.toml')));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('selects Codex agents via --only codex-agents (no flag needed)', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        assert.equal(run(['install', '--only', 'codex-agents']), 0);
        assert.ok(existsSync(join(home, '.codex', 'agents', 'ha.toml')));
        // claude-side must NOT be touched by a codex-only selection
        assert.ok(!existsSync(join(home, '.claude', 'commands')));

        assert.equal(run(['uninstall', '--only', 'codex-agents']), 0);
        assert.ok(!existsSync(join(home, '.codex', 'agents', 'ha.toml')));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('install and reinstall prune legacy and unsupported sentinel-owned Codex TOML and preserve foreign files', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    const legacyNames = [
      'l55', 'm55', 'h55', 'x55', 'l54', 'm54', 'h54', 'x54',
      'l54m', 'm54m', 'h54m', 'x54m',
      'ua',
    ];
    const agentsDir = join(home, '.codex', 'agents');
    const foreignPath = join(agentsDir, 'foreign-legacy.toml');
    try {
      withHome(home, () => {
        mkdirSync(agentsDir, { recursive: true });
        for (const name of legacyNames) {
          writeFileSync(join(agentsDir, `${name}.toml`), `${SentinelCodexAgent}\nlegacy\n`);
        }
        const foreignBody = 'foreign user-owned Codex agent\n';
        writeFileSync(foreignPath, foreignBody);

        assert.equal(run(['install', '--codex-agents']), 0);
        for (const name of legacyNames) {
          assert.ok(!existsSync(join(agentsDir, `${name}.toml`)), `${name}.toml must be pruned on install`);
        }
        assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);

        for (const name of legacyNames) {
          writeFileSync(join(agentsDir, `${name}.toml`), `${SentinelCodexAgent}\nlegacy again\n`);
        }
        assert.equal(run(['reinstall', '--codex-agents']), 0);
        for (const name of legacyNames) {
          assert.ok(!existsSync(join(agentsDir, `${name}.toml`)), `${name}.toml must be pruned on reinstall`);
        }
        assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves and reports a foreign removed Codex alias through install and reinstall', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    const agentsDir = join(home, '.codex', 'agents');
    const removedAlias = join(agentsDir, 'h55.toml');
    try {
      withHome(home, () => {
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(removedAlias, 'foreign user-owned legacy alias\n');

        const first = captureStdout(() => assert.equal(run(['install', '--codex-agents']), 0));
        assert.match(first, /h55\.toml/);
        assert.equal(readFileSync(removedAlias, 'utf8'), 'foreign user-owned legacy alias\n');

        const reinstall = captureStdout(() => assert.equal(run(['reinstall', '--codex-agents']), 0));
        assert.equal((reinstall.match(/^    skipped: h55\.toml$/gm) || []).length, 2);
        assert.equal(readFileSync(removedAlias, 'utf8'), 'foreign user-owned legacy alias\n');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('run install/uninstall --commands', () => {
  it('default install does not write the per-model slash-commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        assert.equal(run(['install']), 0);
        assert.ok(!existsSync(join(home, '.claude', 'commands')));
        // Sub-agents (same registry, other half) still install by default —
        // only the frontmatter-reliant slash-command half is opt-in.
        assert.ok(existsSync(join(home, '.claude', 'agents')));
        // commands is an opt-in selector — valid via --only but excluded from
        // the default (empty --only) install set.
        assert.deepEqual(parseOnly('commands'), { classes: ['commands'], skills: [] });
        assert.deepEqual(parseOnly(''), { classes: ['agents', 'skills', 'bins'], skills: [] });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes the per-model slash-commands under <HOME>/.claude/commands and removes them', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        assert.equal(run(['install', '--commands']), 0);
        assert.ok(existsSync(join(home, '.claude', 'commands', 'oh.md')));

        const out = captureStdout(() => run(['list', '--json']));
        const rows = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const commandRows = rows.filter((r) => r.kind === 'command');
        assert.equal(commandRows.length, 44);
        assert.ok(commandRows.every((r) => r.state === 'mine'));

        assert.equal(run(['uninstall', '--commands']), 0);
        assert.ok(!existsSync(join(home, '.claude', 'commands', 'oh.md')));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('selects commands via --only commands (no flag needed)', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-home-'));
    try {
      withHome(home, () => {
        assert.equal(run(['install', '--only', 'commands']), 0);
        assert.ok(existsSync(join(home, '.claude', 'commands', 'oh.md')));
        // rest of the default set must NOT be pulled in by a commands-only selection
        assert.ok(!existsSync(join(home, '.claude', 'agents')));

        assert.equal(run(['uninstall', '--only', 'commands']), 0);
        assert.ok(!existsSync(join(home, '.claude', 'commands', 'oh.md')));
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

  it('direct uninstall stays strict and still rejects --templates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-uninst-tpl-'));
    try {
      let rc;
      captureStdout(() => {
        rc = run(['uninstall', '--cwd', dir, '--templates', '/bad', '--only', 'commands']);
      });
      assert.equal(rc, 2, 'uninstall must not silently accept the install-only --templates flag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preflights a missing template path before uninstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-rein-preflight-'));
    try {
      assert.equal(run(['install', '--cwd', dir, '--only', 'skills']), 0);
      const existing = join(dir, '.claude', 'skills', 'clock', 'SKILL.md');
      assert.ok(existsSync(existing));
      assert.equal(run(['reinstall', '--cwd', dir, '--only', 'skills', '--templates', join(dir, 'missing')]), 1);
      assert.ok(existsSync(existing), 'failed template preflight must not uninstall existing files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preflights a missing --templates value before uninstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-rein-value-'));
    try {
      assert.equal(run(['install', '--cwd', dir, '--only', 'skills']), 0);
      const existing = join(dir, '.claude', 'skills', 'clock', 'SKILL.md');
      assert.equal(run(['reinstall', '--cwd', dir, '--only', 'skills', '--templates']), 2);
      assert.ok(existsSync(existing), 'argument parse failure must not uninstall existing files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preflights missing selected template trees before uninstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-rein-tree-'));
    const templates = mkdtempSync(join(tmpdir(), 'cah-empty-templates-'));
    try {
      assert.equal(run(['install', '--cwd', dir, '--only', 'clock']), 0);
      const existing = join(dir, '.claude', 'skills', 'clock', 'SKILL.md');
      assert.equal(run(['reinstall', '--cwd', dir, '--only', 'clock', '--templates', templates]), 1);
      assert.ok(existsSync(existing), 'missing template tree must not uninstall existing files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(templates, { recursive: true, force: true });
    }
  });

  it('install rejects a custom tree without an exact root SKILL.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-custom-install-'));
    const templates = mkdtempSync(join(tmpdir(), 'cah-malformed-install-'));
    try {
      assert.equal(run(['install', '--cwd', dir, '--only', 'babysit']), 0);
      const existing = join(dir, '.claude', 'skills', 'babysit', 'SKILL.md');
      const before = readFileSync(existing, 'utf8');

      const skillRoot = join(templates, 'skills', 'babysit');
      mkdirSync(join(skillRoot, 'foo'), { recursive: true });
      writeFileSync(join(skillRoot, 'skill.md'), '# lowercase only\n');
      writeFileSync(join(skillRoot, 'foo', 'SKILL.md'), '# nested only\n');

      let rc;
      const error = captureStderr(() => { rc = run([
        'install', '--cwd', dir, '--only', 'babysit', '--templates', templates,
      ]); });
      assert.equal(rc, 1);
      assert.match(error, /exactly one root SKILL\.md/);
      assert.equal(readFileSync(existing, 'utf8'), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(templates, { recursive: true, force: true });
    }
  });

  it('reinstall rejects a malformed custom tree before uninstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-custom-reinstall-'));
    const templates = mkdtempSync(join(tmpdir(), 'cah-malformed-reinstall-'));
    try {
      assert.equal(run(['install', '--cwd', dir, '--only', 'babysit']), 0);
      const existing = join(dir, '.claude', 'skills', 'babysit', 'SKILL.md');
      const before = readFileSync(existing, 'utf8');

      const skillRoot = join(templates, 'skills', 'babysit');
      mkdirSync(join(skillRoot, 'foo'), { recursive: true });
      writeFileSync(join(skillRoot, 'skill.md'), '# lowercase only\n');
      writeFileSync(join(skillRoot, 'foo', 'SKILL.md'), '# nested only\n');

      let rc;
      const error = captureStderr(() => { rc = run([
        'reinstall', '--cwd', dir, '--only', 'babysit', '--templates', templates,
      ]); });
      assert.equal(rc, 1);
      assert.match(error, /exactly one root SKILL\.md/);
      assert.equal(readFileSync(existing, 'utf8'), before,
        'malformed reinstall must leave managed content installed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(templates, { recursive: true, force: true });
    }
  });
});

describe('strict local and path conflicts', () => {
  it('Codex-only --local still requires an existing .claude directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-strict-codex-'));
    try {
      assert.equal(run(['install', '--local', '--cwd', dir, '--only', 'codex-agents']), 1);
      assert.ok(!existsSync(join(dir, '.codex')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies a directory at a file path as foreign, not missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-path-conflict-'));
    const path = join(dir, 'conflict');
    try {
      mkdirSync(path);
      assert.equal(classifyPath(path, SetForModelCommand), 'foreign');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('doctor exits 2 for a directory conflict at an expected file path', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-doctor-conflict-'));
    try {
      withHome(home, () => {
        mkdirSync(join(home, '.claude', 'agents', 'oh.md'), { recursive: true });
        let rc;
        captureStdout(() => { rc = run(['doctor']); });
        assert.equal(rc, 2);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('probe recovery guidance', () => {
  it('identifies malformed backup JSON and never recommends restoring from it', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-probe-cli-malformed-'));
    const claude = join(home, '.claude');
    const cache = join(claude, 'cah-bin', 'cache');
    const settingsPath = join(claude, 'settings.json');
    const backupPath = join(cache, 'probe-backup.json');
    try {
      mkdirSync(cache, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node probe.js',
          'cah-sentinel': 'cah-probe-statusline:v1',
          'cah-name': 'probe',
        },
      }));
      writeFileSync(backupPath, '{ malformed backup');

      let rc;
      const error = withHome(home, () => captureStderr(() => {
        rc = run(['probe', 'statusline', 'stop']);
      }));
      assert.equal(rc, 1);
      assert.match(error, /could not parse probe backup/);
      assert.match(error, new RegExp(`fix the JSON in ${backupPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(error, /restore from .*probe-backup\.json/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('status reports malformed settings JSON with the same recovery guidance as stop', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-probe-cli-status-malformed-'));
    const claude = join(home, '.claude');
    const settingsPath = join(claude, 'settings.json');
    try {
      mkdirSync(claude, { recursive: true });
      writeFileSync(settingsPath, '{ malformed settings');

      let rc;
      const error = withHome(home, () => captureStderr(() => {
        rc = run(['probe', 'statusline', 'status']);
      }));
      assert.equal(rc, 1);
      assert.match(error, /cah probe status:/);
      assert.match(error, new RegExp(`fix the JSON in ${settingsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(error, /unexpected error/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('start reports malformed settings JSON with a recovery hint like stop and status', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-probe-cli-start-malformed-'));
    const claude = join(home, '.claude');
    const settingsPath = join(claude, 'settings.json');
    try {
      mkdirSync(claude, { recursive: true });
      mkdirSync(join(claude, 'cah-bin', 'bin'), { recursive: true });
      writeFileSync(join(claude, 'cah-bin', 'bin', 'cah-status-probe.js'), 'probe bin placeholder');
      writeFileSync(settingsPath, '{ malformed settings');

      let rc;
      const error = withHome(home, () => captureStderr(() => {
        rc = run(['probe', 'statusline', 'start']);
      }));
      assert.equal(rc, 1);
      assert.match(error, /cah probe start:/);
      assert.match(error, new RegExp(`fix the JSON in ${settingsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(error, /unexpected error/);
      assert.match(error, /then retry start[.]/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
