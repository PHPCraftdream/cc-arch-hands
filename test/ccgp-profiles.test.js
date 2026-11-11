import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { discoverCcgpProfiles } from '../lib/ccgp-profiles.js';

const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-ccgp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A profile dir as ccgp leaves it: <home>/claude/<name> with its copy manifest.
function profile(ccgpHome, name, manifest = '.ccgp-mirror.ktav') {
  const dir = join(ccgpHome, 'claude', name);
  mkdirSync(dir, { recursive: true });
  if (manifest) writeFileSync(join(dir, manifest), 'files: []\n');
  return dir;
}

function callCli(home, ccgpHome, cwd, ...args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgpHome };
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS });
}

const CLOCK = join('skills', 'clock', 'SKILL.md');

describe('ccgp profile discovery', () => {
  it('finds managed profiles in CCGP_HOME, ./.ccgp and the default home, each once', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const cwd = join(dir, 'project');
    const custom = join(dir, 'custom');
    profile(custom, 'work');
    profile(custom, 'legacy', '.ccgp-mirror.json');
    profile(custom, 'unmanaged', null);
    profile(join(cwd, '.ccgp'), 'local');
    profile(join(home, '.config', 'cc-go-proxy'), 'codex');
    const found = discoverCcgpProfiles({
      env: { CCGP_HOME: custom }, home, cwd, platform: 'linux',
    });
    assert.deepEqual(found.map((p) => p.name), ['legacy', 'work', 'local', 'codex']);
    const twice = discoverCcgpProfiles({ env: { CCGP_HOME: join(home, '.config', 'cc-go-proxy') }, home, cwd, platform: 'linux' });
    assert.deepEqual(twice.map((p) => p.name), ['codex', 'local'], 'one dir reached twice is listed once');
  });

  it('ignores a default config dir outside the home dir', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const appData = join(dir, 'real-appdata');
    profile(join(appData, 'cc-go-proxy'), 'codex');
    const found = discoverCcgpProfiles({ env: { APPDATA: appData }, home, cwd: dir, platform: 'win32' });
    assert.deepEqual(found, [], 'a sandboxed home never reaches the real profiles');
    const inside = join(home, 'AppData', 'Roaming');
    profile(join(inside, 'cc-go-proxy'), 'zai');
    assert.deepEqual(discoverCcgpProfiles({ env: { APPDATA: inside }, home, cwd: dir, platform: 'win32' })
      .map((p) => p.name), ['zai']);
  });
});

describe('ccgp profile install', () => {
  it('a global install and uninstall update every ccgp profile at once', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    mkdirSync(home);
    const ccgpHome = join(dir, 'ccgp');
    const work = profile(ccgpHome, 'work');
    const unmanaged = profile(ccgpHome, 'unmanaged', null);
    mkdirSync(join(work, 'skills', 'mine'), { recursive: true });
    writeFileSync(join(work, 'skills', 'mine', 'SKILL.md'), 'user skill\n');

    const install = callCli(home, ccgpHome, dir, 'install', '--only', 'clock');
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /ccgp profile work \(/);
    assert.equal(readFileSync(join(work, CLOCK), 'utf8'), readFileSync(join(home, '.claude', CLOCK), 'utf8'));
    assert.equal(existsSync(join(unmanaged, 'skills')), false, 'a dir without a ccgp manifest is not a profile');
    assert.equal(existsSync(join(work, 'cah-bin')), false, 'bins stay in the shared global copy');

    const uninstall = callCli(home, ccgpHome, dir, 'uninstall', '--only', 'clock');
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(existsSync(join(work, CLOCK)), false);
    assert.equal(existsSync(join(home, '.claude', CLOCK)), false);
    assert.equal(readFileSync(join(work, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'user skill\n', 'foreign files survive');
  });

  it('a project-local install leaves ccgp profiles alone', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    mkdirSync(home);
    const project = join(dir, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const work = profile(join(dir, 'ccgp'), 'work');
    const install = callCli(home, join(dir, 'ccgp'), dir, 'install', '--only', 'clock', '--cwd', project);
    assert.equal(install.status, 0, install.stderr);
    assert.ok(existsSync(join(project, '.claude', CLOCK)));
    assert.equal(existsSync(join(work, 'skills')), false);
  });
});
