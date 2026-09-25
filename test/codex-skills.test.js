import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOnly } from '../lib/cli.js';
import { Scope } from '../lib/scope.js';
import { writeCodexSkills, removeCodexSkills } from '../lib/codex-skills.js';
import { embeddedTemplates } from '../lib/templates.js';
import { SentinelSkill } from '../lib/sentinel.js';
import { AllCodexSkills } from '../lib/manifest.js';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-codex-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skillDir(dir, name = 'cli-run') {
  return join(dir, '.codex', 'skills', name);
}

function isolatedHome(dir) {
  const home = join(dir, 'home');
  mkdirSync(home);
  return home;
}

const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

function callCli(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 30_000,
  });
}

function missingCount(home) {
  const doctor = callCli(home, 'doctor');
  assert.equal(doctor.status, 1, doctor.stderr);
  const match = doctor.stdout.match(/missing: (\d+)/);
  assert.ok(match, doctor.stdout);
  return Number(match[1]);
}

describe('Codex skill lifecycle', () => {
  it('is opt-in and supports install, reinstall and uninstall', (t) => {
    const dir = sandbox(t);
    const home = isolatedHome(dir);
    assert.ok(!parseOnly('').classes.includes('codex-skills'));
    assert.deepEqual(parseOnly('codex-skills'), { classes: ['codex-skills'], skills: [] });
    assert.equal(callCli(home, 'install', '--codex-skills', '--cwd', dir).status, 0);
    for (const name of AllCodexSkills) {
      assert.ok(readFileSync(join(skillDir(dir, name), 'SKILL.md'), 'utf8').includes(SentinelSkill));
    }
    assert.ok(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes('<!-- cah-cli-run:start -->'));
    assert.ok(existsSync(join(skillDir(dir), 'scripts', 'cli-run.mjs')));
    assert.ok(existsSync(join(skillDir(dir, 'ccheckpoint'), 'scripts', 'commit-checkpoint.mjs')));
    assert.ok(!existsSync(join(dir, '.claude', 'skills')));

    assert.equal(callCli(home, 'reinstall', '--codex-skills', '--cwd', dir).status, 0);
    for (const name of AllCodexSkills) {
      assert.ok(existsSync(join(skillDir(dir, name), 'SKILL.md')));
    }
    assert.ok(existsSync(join(skillDir(dir), 'scripts', 'runner.mjs')));
    assert.equal(callCli(home, 'uninstall', '--codex-skills', '--cwd', dir).status, 0);
    for (const name of AllCodexSkills) assert.ok(!existsSync(skillDir(dir, name)));
    assert.ok(!readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes('<!-- cah-cli-run:start -->'));
  });

  it('reinstall publishes the current cli-run instructions from the bundled template', (t) => {
    const dir = sandbox(t);
    const home = isolatedHome(dir);
    const installed = join(skillDir(dir), 'SKILL.md');
    const template = readFileSync(
      fileURLToPath(new URL('../templates/codex-skills/cli-run/SKILL.md', import.meta.url)),
      'utf8',
    );
    const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
    const installedTemplate = `${normalizeEol(template).trimEnd()}\n\n${SentinelSkill}\n`;

    assert.equal(callCli(home, 'install', '--codex-skills', '--cwd', dir).status, 0);
    assert.equal(normalizeEol(readFileSync(installed, 'utf8')), installedTemplate);

    writeFileSync(installed, `stale installed instructions\n${SentinelSkill}\n`);
    assert.equal(callCli(home, 'reinstall', '--codex-skills', '--cwd', dir).status, 0);
    assert.equal(normalizeEol(readFileSync(installed, 'utf8')), installedTemplate);
  });

  it('preserves foreign skills and user files beside managed files', (t) => {
    const dir = sandbox(t);
    const home = isolatedHome(dir);
    const target = skillDir(dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'foreign personal skill\n');
    assert.deepEqual(writeCodexSkills(embeddedTemplates(), new Scope({ cwd: dir })).skipped, ['cli-run']);
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'foreign personal skill\n');
    assert.deepEqual(removeCodexSkills(embeddedTemplates(), new Scope({ cwd: dir })).skipped, ['cli-run']);

    rmSync(target, { recursive: true });
    assert.equal(callCli(home, 'install', '--only', 'codex-skills', '--cwd', dir).status, 0);
    writeFileSync(join(target, 'my-notes.txt'), 'keep me\n');
    assert.equal(callCli(home, 'reinstall', '--only', 'codex-skills', '--cwd', dir).status, 0);
    assert.equal(readFileSync(join(target, 'my-notes.txt'), 'utf8'), 'keep me\n');
    assert.equal(callCli(home, 'uninstall', '--only', 'codex-skills', '--cwd', dir).status, 0);
    assert.equal(readFileSync(join(target, 'my-notes.txt'), 'utf8'), 'keep me\n');
    assert.ok(!existsSync(join(target, 'SKILL.md')));
    assert.ok(!existsSync(join(target, 'scripts', 'cli-run.mjs')));
  });

  it('refuses a missing Codex template before reinstall removes the installed skill', (t) => {
    const dir = sandbox(t);
    const home = isolatedHome(dir);
    const templates = join(dir, 'templates');
    mkdirSync(templates);
    assert.equal(callCli(home, 'install', '--codex-skills', '--cwd', dir).status, 0);
    assert.equal(callCli(home, 'reinstall', '--codex-skills', '--cwd', dir, '--templates', templates).status, 1);
    assert.ok(existsSync(join(skillDir(dir), 'SKILL.md')));
  });

  it('honors the strict local scope guard for Codex-only installs', (t) => {
    const dir = sandbox(t);
    const home = isolatedHome(dir);
    assert.equal(callCli(home, 'install', '--codex-skills', '--local', '--cwd', dir).status, 1);
    assert.ok(!existsSync(skillDir(dir)));
    mkdirSync(join(dir, '.claude'));
    assert.equal(callCli(home, 'install', '--codex-skills', '--local', '--cwd', dir).status, 0);
    assert.ok(existsSync(join(skillDir(dir), 'SKILL.md')));
  });

  it('lists the skill and gates doctor only when the opt-in class is installed', (t) => {
    const home = sandbox(t);
    const baselineMissing = missingCount(home);
    assert.equal(callCli(home, 'install', '--codex-skills').status, 0);
    const list = callCli(home, 'list', '--json');
    assert.equal(list.status, 0);
    const row = list.stdout.trim().split('\n').map((line) => JSON.parse(line))
      .find((entry) => entry.kind === 'codex-skill' && entry.name === 'cli-run');
    assert.equal(row.state, 'mine');
    assert.equal(missingCount(home), baselineMissing);
    assert.equal(callCli(home, 'uninstall', '--codex-skills').status, 0);
    assert.equal(missingCount(home), baselineMissing);
  });
});
