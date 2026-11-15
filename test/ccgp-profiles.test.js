import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { discoverCcgpProfiles, discoverClaudeDirs } from '../lib/ccgp-profiles.js';

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
  // The developer's own config dirs must not leak into what these runs discover.
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgpHome,
    CLAUDE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', OPENCODE_CONFIG_DIR: '',
  };
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

  it('adds a CLAUDE_CONFIG_DIR under the home dir that no other entry covers', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const ccgpHome = join(dir, 'ccgp');
    const work = profile(ccgpHome, 'work');
    const custom = join(home, 'claude-alt');
    mkdirSync(custom, { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    const labels = (env) => discoverClaudeDirs({ env: { CCGP_HOME: ccgpHome, ...env }, home, cwd: dir, platform: 'linux' })
      .map((entry) => entry.label);
    assert.deepEqual(labels({ CLAUDE_CONFIG_DIR: custom }), ['ccgp profile work', 'CLAUDE_CONFIG_DIR']);
    assert.deepEqual(labels({}), ['ccgp profile work']);
    assert.deepEqual(labels({ CLAUDE_CONFIG_DIR: join(home, '.claude') }), ['ccgp profile work'], '~/.claude itself');
    assert.deepEqual(labels({ CLAUDE_CONFIG_DIR: work }), ['ccgp profile work'], 'a ccgp profile session');
    assert.deepEqual(labels({ CLAUDE_CONFIG_DIR: join(home, 'missing') }), ['ccgp profile work']);
    const outside = join(dir, 'real-config');
    mkdirSync(outside);
    assert.deepEqual(labels({ CLAUDE_CONFIG_DIR: outside }), ['ccgp profile work'], 'never outside the home dir');
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

  it('doctor checks every profile too, and a skill with a missing owned file is not healthy', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    mkdirSync(home);
    const ccgpHome = join(dir, 'ccgp');
    const work = profile(ccgpHome, 'work');
    assert.equal(callCli(home, ccgpHome, dir, 'install').status, 0);
    const healthy = callCli(home, ccgpHome, dir, 'doctor');
    assert.equal(healthy.status, 0, healthy.stdout);

    rmSync(join(work, 'commands', 'oh.md'));
    const profileGap = callCli(home, ccgpHome, dir, 'doctor');
    assert.equal(profileGap.status, 1, 'a file missing in a profile');
    assert.match(profileGap.stdout, /missing: 1 \(out of/, 'exactly the one deleted file is counted');
    assert.equal(callCli(home, ccgpHome, dir, 'install').status, 0);

    rmSync(join(home, '.claude', 'skills', 'checkpoint-watch', 'hooks', 'engine.mjs'));
    const incomplete = callCli(home, ccgpHome, dir, 'doctor');
    assert.equal(incomplete.status, 1, 'the mod lost its engine');
    assert.match(incomplete.stdout, /missing: 1 \(out of/, 'the incomplete skill is counted once');
    const list = callCli(home, ccgpHome, dir, 'list', '--json');
    const row = list.stdout.trim().split('\n').map((line) => JSON.parse(line))
      .find((r) => r.kind === 'skill' && r.name === 'checkpoint-watch');
    assert.equal(row.state, 'incomplete');
    const rows = list.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.some((r) => r.name === 'ccgp profile work/oh' && r.kind === 'command'),
      'list shows the profile rows doctor counts');
    assert.ok(rows.some((r) => r.name === 'ccgp profile work/checkpoint-watch' && r.kind === 'skill'));
  });

  it('a global install, uninstall and rewake also reach a CLAUDE_CONFIG_DIR under the home dir', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const alt = join(home, 'claude-alt');
    mkdirSync(alt, { recursive: true });
    const ccgpHome = join(dir, 'ccgp');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: dir, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
      env: { ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgpHome, CLAUDE_CONFIG_DIR: alt },
    });
    const install = run('install', '--only', 'rewake');
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /^CLAUDE_CONFIG_DIR \(/m);
    assert.ok(existsSync(join(alt, 'skills', 'rewake', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.claude', 'skills', 'rewake', 'SKILL.md')));

    const on = run('rewake', 'on');
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^CLAUDE_CONFIG_DIR \(.*\): enabled$/m);
    assert.ok(readFileSync(join(alt, 'settings.json'), 'utf8').includes('cah-rewake'));

    const uninstall = run('uninstall', '--only', 'rewake');
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(existsSync(join(alt, 'skills', 'rewake')), false);

    const sameAsHome = spawnSync(process.execPath, [cli, 'rewake', 'status'], {
      cwd: dir, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
      env: { ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgpHome, CLAUDE_CONFIG_DIR: join(home, '.claude') },
    });
    assert.doesNotMatch(sameAsHome.stdout, /CLAUDE_CONFIG_DIR/, '~/.claude itself is not listed twice');
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
