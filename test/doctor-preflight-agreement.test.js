import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  mkdirSync, writeFileSync, symlinkSync, linkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { run, classifyPath } from '../lib/cli.js';
import { BinFiles } from '../lib/binstall.js';
import { SentinelBin, SetForBin } from '../lib/sentinel.js';

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

const LeafRel = join('.claude', 'cah-bin', 'lib', 'lease-clock.js');

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'cah-doctor-agreement-'));
}

function leafPath(home) {
  return join(home, LeafRel);
}

function binTreeSnapshot(home) {
  const binDir = join(home, '.claude', 'cah-bin');
  const entries = [];
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      entries.push(relative(binDir, abs).split('\\').join('/'));
      if (dirent.isDirectory()) walk(abs);
    }
  };
  walk(binDir);
  entries.sort();
  const leaf = leafPath(home);
  const st = lstatSync(leaf);
  const leafKind = st.isSymbolicLink() ? 'symlink'
    : st.isDirectory() ? 'directory'
      : st.isFile() ? `file-nlink-${st.nlink}`
        : 'other';
  return {
    entries,
    leafBytes: st.isDirectory() ? 'directory' : readFileSync(leaf).toString('base64'),
    leafKind,
  };
}

function doctorAndListRows(home) {
  return withHome(home, () => {
    let doctorRc;
    const doctorOut = captureStdout(() => { doctorRc = run(['doctor']); });
    let listOut = '';
    listOut = captureStdout(() => { run(['list', '--json']); });
    const rows = listOut.split('\n').filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    return { doctorRc, doctorOut, rows };
  });
}

function assertReadOnlyAcrossDoctorAndList(home, before) {
  const { doctorRc, rows } = doctorAndListRows(home);
  assert.equal(doctorRc, 2, 'doctor must report the foreign leaf (exit 2)');
  const binRow = rows.find((r) => r.kind === 'bin' && r.name === 'lib/lease-clock.js');
  assert.ok(binRow, 'the lease-clock.js bin row must be present in list --json');
  assert.equal(binRow.state, 'foreign');
  const after = binTreeSnapshot(home);
  assert.deepEqual(after, before, 'doctor/list must be strictly read-only');
}

function assertInstallRejects(home, expected) {
  return withHome(home, () => {
    let installRc;
    const err = captureStderr(() => { installRc = run(['install', '--only', 'bins']); });
    assert.equal(installRc, 1, 'install must keep rejecting the structurally foreign leaf');
    assert.match(err, expected);
  });
}

describe('doctor/list and install preflight agree on runtime leaf structure', () => {
  const case_ = (name, fn) => {
    it(name, (t) => {
      const home = freshHome();
      try {
        withHome(home, () => {
          assert.equal(run(['install']), 0);
          let doctorRc;
          const doctorOut = captureStdout(() => { doctorRc = run(['doctor']); });
          assert.equal(doctorRc, 0, 'doctor must be healthy before mutation');
          assert.match(doctorOut, /foreign: 0/);
        });
        fn(home, t);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  };

  case_('an untouched owned leaf stays healthy for both doctor and install', (home) => {
    const leaf = leafPath(home);
    assert.equal(classifyPath(leaf, SetForBin, { structural: true }), 'mine');
    const rows = doctorAndListRows(home).rows;
    const binRow = rows.find((r) => r.kind === 'bin' && r.name === 'lib/lease-clock.js');
    assert.ok(binRow, 'the lease-clock.js bin row must be present in list --json');
    assert.equal(binRow.state, 'mine');
    const { doctorRc, doctorOut } = doctorAndListRows(home);
    assert.equal(doctorRc, 0);
    assert.match(doctorOut, /foreign: 0/);
    withHome(home, () => {
      let installRc;
      captureStderr(() => { installRc = run(['install', '--only', 'bins']); });
      assert.equal(installRc, 0);
    });
  });

  case_('a foreign-content payload is foreign for both', (home) => {
    const leaf = leafPath(home);
    writeFileSync(leaf, '#!/usr/bin/env node\n/* foreign payload */\n');
    assert.equal(classifyPath(leaf, SetForBin, { structural: true }), 'foreign');
    assertReadOnlyAcrossDoctorAndList(home, binTreeSnapshot(home));
    assertInstallRejects(home, /foreign managed runtime leaf.*lease-clock\.js/);
  });

  case_('a directory where the leaf belongs is foreign for both', (home) => {
    const leaf = leafPath(home);
    rmSync(leaf);
    mkdirSync(leaf);
    assert.equal(classifyPath(leaf, SetForBin, { structural: true }), 'foreign');
    assertReadOnlyAcrossDoctorAndList(home, binTreeSnapshot(home));
    assertInstallRejects(home, /foreign managed runtime leaf.*lease-clock\.js.*directory/);
  });

  case_('a symlink standing in for the leaf is foreign for both', (home, t) => {
    const leaf = leafPath(home);
    const original = readFileSync(leaf);
    const target = join(home, 'lease-clock-symlink-target.js');
    writeFileSync(target, original);
    rmSync(leaf);
    try {
      symlinkSync(target, leaf, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip('file symlinks are unavailable on this Windows runner');
        return;
      }
      throw error;
    }
    assert.equal(
      readFileSync(target, 'utf8').includes(SentinelBin),
      true,
      'the symlink target must carry the bin sentinel so the verdict is structural',
    );
    assert.equal(classifyPath(leaf, SetForBin, { structural: true }), 'foreign');
    assertReadOnlyAcrossDoctorAndList(home, binTreeSnapshot(home));
    assert.equal(lstatSync(leaf).isSymbolicLink(), true, 'the leaf must remain a symlink');
    assertInstallRejects(home, /foreign managed runtime leaf.*lease-clock\.js.*symbolic link/);
  });

  case_('a multi-hardlink leaf is foreign for both (the review repro)', (home) => {
    const leaf = leafPath(home);
    const witness = join(home, 'hardlink-witness.js');
    linkSync(leaf, witness);
    assert.equal(lstatSync(leaf, { bigint: true }).nlink, 2n);
    assert.equal(classifyPath(leaf, SetForBin, { structural: true }), 'foreign');
    assertReadOnlyAcrossDoctorAndList(home, binTreeSnapshot(home));
    assertInstallRejects(home, /foreign managed runtime leaf.*lease-clock\.js.*multi-hardlink regular file/);
    assert.equal(readFileSync(leaf).equals(readFileSync(witness)), true,
      'both hard links must survive with unchanged content');
  });
});
