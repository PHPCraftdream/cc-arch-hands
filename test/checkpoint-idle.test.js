import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { resolveDeps } from '../lib/cli.js';
import { AllSkills, SkillSkillDeps } from '../lib/manifest.js';
import {
  IDLE_DEFAULT_MINUTES, IDLE_KEY, IDLE_MAX_MINUTES, IDLE_MIN_MINUTES, describeIdle, idleIn, readIdleState, updateIdle,
} from '../lib/checkpoint-idle.js';
import {
  IDLE_DEFAULT_MINUTES as ENGINE_DEFAULT, IDLE_KEY as ENGINE_KEY, IDLE_MAX_MINUTES as ENGINE_MAX,
  IDLE_MIN_MINUTES as ENGINE_MIN, idleOf,
} from '../templates/skills/checkpoint-watch/hooks/engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, '..', 'bin', 'cah.js');
const skillsDir = join(__dirname, '..', 'templates', 'skills');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-idle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('checkpoint-idle settings (lib/checkpoint-idle.js)', () => {
  it('enables, updates, mutes and disables the key, reporting each change', (t) => {
    const path = join(sandbox(t), '.claude', 'settings.local.json');
    assert.equal(updateIdle(path, 'enable', { mode: 'checkpoint', minutes: 30 }), 'enabled');
    assert.deepEqual(read(path), { [IDLE_KEY]: { mode: 'checkpoint', minutes: 30 } });
    assert.equal(updateIdle(path, 'enable', { mode: 'checkpoint', minutes: 30 }), 'already-enabled');
    assert.equal(updateIdle(path, 'enable', { mode: 'commit', minutes: 30 }), 'updated');
    assert.equal(updateIdle(path, 'enable', { mode: 'commit', minutes: 20 }), 'updated');
    assert.deepEqual(readIdleState(path), { mode: 'commit', minutes: 20 });
    assert.equal(updateIdle(path, 'mute'), 'muted');
    assert.deepEqual(read(path), { [IDLE_KEY]: { mode: 'off' } });
    assert.equal(readIdleState(path), null);
    assert.equal(updateIdle(path, 'mute'), 'already-muted');
    assert.equal(updateIdle(path, 'disable'), 'disabled');
    assert.deepEqual(read(path), {});
    assert.equal(readIdleState(path), undefined);
    assert.equal(updateIdle(path, 'disable'), 'not-set');
  });

  it('never creates a file to disable, and keeps other keys and the indent', (t) => {
    const dir = sandbox(t);
    const path = join(dir, '.claude', 'settings.json');
    assert.equal(updateIdle(path, 'disable'), 'not-set');
    assert.equal(existsSync(path), false);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{\n    "permissions": { "allow": ["Bash(ls)"] }\n}\n');
    updateIdle(path, 'enable', { mode: 'checkpoint', minutes: 30 });
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^\{\n {4}"permissions"/);
    assert.deepEqual(JSON.parse(text).permissions, { allow: ['Bash(ls)'] });
  });

  it('refuses a bad mode, bad minutes and invalid JSON, and writes nothing', (t) => {
    const path = join(sandbox(t), 'settings.json');
    assert.throws(() => updateIdle(path, 'enable', { mode: 'sometimes', minutes: 30 }), /unknown checkpoint-idle mode/);
    for (const minutes of [4, 51, 12.5, '30', NaN, undefined]) {
      assert.throws(() => updateIdle(path, 'enable', { mode: 'commit', minutes }), /minutes must be a whole number/);
    }
    assert.equal(existsSync(path), false);
    writeFileSync(path, '{ broken');
    assert.throws(() => updateIdle(path, 'enable', { mode: 'commit', minutes: 30 }), /invalid JSON/);
    assert.equal(readFileSync(path, 'utf8'), '{ broken');
  });

  it('reads the same as the mod\'s engine does', () => {
    assert.equal(IDLE_KEY, ENGINE_KEY);
    assert.equal(IDLE_DEFAULT_MINUTES, ENGINE_DEFAULT);
    assert.equal(IDLE_MIN_MINUTES, ENGINE_MIN);
    assert.equal(IDLE_MAX_MINUTES, ENGINE_MAX);
    const samples = [
      {}, null, { [IDLE_KEY]: 'yes' }, { [IDLE_KEY]: { mode: 'sometimes' } }, { [IDLE_KEY]: { mode: 'off', minutes: 9 } },
      { [IDLE_KEY]: { mode: 'commit' } }, { [IDLE_KEY]: { mode: 'commit', minutes: null } },
      { [IDLE_KEY]: { mode: 'checkpoint', minutes: 2 } }, { [IDLE_KEY]: { mode: 'checkpoint', minutes: 99 } },
      { [IDLE_KEY]: { mode: 'checkpoint', minutes: '25' } }, { [IDLE_KEY]: { mode: 'checkpoint', minutes: 'soon' } },
    ];
    for (const sample of samples) assert.deepEqual(idleIn(sample), idleOf(sample), JSON.stringify(sample));
    assert.equal(describeIdle(undefined), 'not set');
    assert.equal(describeIdle(null), 'off');
    assert.equal(describeIdle({ mode: 'commit', minutes: 20 }), 'on, mode commit, 20 min');
  });
});

describe('cah checkpoint-idle', () => {
  function setup(t) {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const ccgp = join(dir, 'ccgp');
    const profile = join(ccgp, 'claude', 'work');
    const project = join(dir, 'project');
    mkdirSync(home);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, '.ccgp-mirror.ktav'), 'files: []\n');
    assert.equal(spawnSync('git', ['init', '-q', project]).status, 0);
    const run = (...args) => spawnSync(process.execPath, [cli, 'checkpoint-idle', ...args], {
      cwd: home, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
      env: { ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgp },
    });
    return {
      run, home, project, profile,
      local: join(project, '.claude', 'settings.local.json'),
      user: join(home, '.claude', 'settings.json'),
      work: join(profile, 'settings.json'),
    };
  }

  it('turns the project cycle on, keeps the minutes, switches the mode, and turns it off', (t) => {
    const s = setup(t);
    const on = s.run('on', '--commit', '--minutes', '20', '--cwd', s.project);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^project \(.*\): enabled \(mode commit, 20 min\)$/m);
    assert.match(on.stdout, /the mod is missing; run `cah install --only checkpoint-watch`/);
    assert.deepEqual(read(s.local), { [IDLE_KEY]: { mode: 'commit', minutes: 20 } });

    const again = s.run('on', '--cwd', s.project);
    assert.match(again.stdout, /: updated \(mode checkpoint, 20 min\)/, 'the minutes stay, the mode follows the flags');

    const status = s.run('status', '--cwd', s.project);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^global \(.*\): not set$/m);
    assert.match(status.stdout, /^ccgp profile work \(.*\): not set$/m);
    assert.match(status.stdout, /^project \(.*\): on, mode checkpoint, 20 min$/m);
    assert.match(status.stdout, /^effective here: on, mode checkpoint, 20 min \(from project\)$/m);

    const off = s.run('off', '--cwd', s.project);
    assert.match(off.stdout, /: disabled$/m);
    assert.deepEqual(read(s.local), {});
    assert.match(s.run('status', '--cwd', s.project).stdout, /^effective here: off \(not set\)$/m);
  });

  it('--global writes ~/.claude and every ccgp profile, and a project off mutes it', (t) => {
    const s = setup(t);
    const on = s.run('on', '--global', '--minutes', '45');
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^global \(.*\): enabled \(mode checkpoint, 45 min\)$/m);
    assert.match(on.stdout, /^ccgp profile work \(.*\): enabled \(mode checkpoint, 45 min\)$/m);
    assert.deepEqual(read(s.user), { [IDLE_KEY]: { mode: 'checkpoint', minutes: 45 } });
    assert.deepEqual(read(s.work), { [IDLE_KEY]: { mode: 'checkpoint', minutes: 45 } });
    assert.equal(existsSync(s.local), false, 'a global switch never touches a project');

    const inherited = s.run('status', '--cwd', s.project);
    assert.match(inherited.stdout, /^effective here: on, mode checkpoint, 45 min \(from global\)$/m);

    const mute = s.run('off', '--cwd', s.project);
    assert.match(mute.stdout, /: muted$/m);
    assert.deepEqual(read(s.local), { [IDLE_KEY]: { mode: 'off' } });
    assert.match(s.run('status', '--cwd', s.project).stdout, /^effective here: off \(from project\)$/m);

    const local = s.run('on', '--commit', '--cwd', s.project);
    assert.match(local.stdout, /: updated \(mode commit, 30 min\)/);

    const globalOff = s.run('off', '--global');
    assert.equal(globalOff.status, 0, globalOff.stderr);
    assert.deepEqual(read(s.user), {});
    assert.deepEqual(read(s.work), {});
    assert.deepEqual(read(s.local), { [IDLE_KEY]: { mode: 'commit', minutes: 30 } }, 'the project keeps its own setting');
  });

  it('a project off with no global setting just drops the key', (t) => {
    const s = setup(t);
    s.run('on', '--cwd', s.project);
    const off = s.run('off', '--cwd', s.project);
    assert.match(off.stdout, /: disabled$/m);
    assert.deepEqual(read(s.local), {});
  });

  it('the project switch refuses a folder outside a Git repository; --global does not care', (t) => {
    const s = setup(t);
    const bare = join(dirname(s.project), 'bare');
    mkdirSync(bare);
    const refused = s.run('on', '--cwd', bare);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not inside a Git repository/);
    assert.equal(existsSync(join(bare, '.claude')), false);
    assert.equal(s.run('on', '--global').status, 0);
  });

  it('rejects bad arguments with exit 2 and writes nothing', (t) => {
    const s = setup(t);
    for (const args of [
      [], ['sideways'], ['on', '--minutes', '4'], ['on', '--minutes', '51'], ['on', '--minutes', '2.5'],
      ['on', '--minutes', 'soon'], ['off', '--minutes', '20'], ['off', '--commit'], ['status', '--commit'],
      ['on', '--global', '--local'], ['on', '--global', '--cwd', s.project],
    ]) {
      const r = s.run(...args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.equal(existsSync(join(s.home, '.claude')), false);
    assert.equal(existsSync(s.local), false);
    assert.equal(s.run('--help').status, 0);
  });
});

describe('/checkpoint-idle and /ccheckpoint-idle skills', () => {
  const skill = (name) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');

  it('are installable skills that bring the mod with them', () => {
    for (const name of ['checkpoint-idle', 'ccheckpoint-idle']) {
      assert.ok(AllSkills.includes(name), name);
      assert.deepEqual(SkillSkillDeps[name], ['checkpoint-watch']);
      const r = resolveDeps({ classes: [], skills: [name] });
      assert.deepEqual(r.skills, [name, 'checkpoint-watch']);
      assert.match(r.notices[0], new RegExp(`auto-added skill 'checkpoint-watch' \\(required by: ${name}\\)`));
      assert.match(skill(name), new RegExp(`^name: ${name}$`, 'm'));
    }
  });

  it('only run `cah checkpoint-idle`, never touch settings by hand, and pass --cwd except for --global', () => {
    for (const [name, commit] of [['checkpoint-idle', ''], ['ccheckpoint-idle', ' --commit']]) {
      const text = skill(name);
      assert.ok(text.includes(`cah checkpoint-idle on${commit} --cwd "<cwd>"`), name);
      assert.ok(text.includes(`cah checkpoint-idle on${commit} --minutes N --cwd "<cwd>"`), name);
      assert.ok(text.includes(`cah checkpoint-idle on${commit} --global`), name);
      assert.ok(text.includes('cah checkpoint-idle off --cwd "<cwd>"'), name);
      assert.ok(text.includes('cah checkpoint-idle off --global'), name);
      assert.ok(text.includes('cah checkpoint-idle status --cwd "<cwd>"'), name);
      assert.doesNotMatch(text, /cah checkpoint-idle [^\n]*--global[^\n]*--cwd/, `${name}: --global never takes --cwd`);
      assert.match(text, /Never edit the settings files by hand/);
    }
  });
});
