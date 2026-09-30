import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpCommands, OmpCommandRuntimeFiles, SetForOmpCommand } from '../lib/omp-commands.js';

const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));
function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-omp-commands-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function call(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 30_000,
  });
}
function ok(home, ...args) {
  const result = call(home, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function list(home, ...args) {
  return ok(home, 'list', '--json', ...args).stdout.trim().split('\n').map(JSON.parse);
}
function missing(home) {
  return Number(call(home, 'doctor').stdout.match(/missing: (\d+)/)[1]);
}
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe('OMP command installer', () => {
  it('refreshes owned commands and prunes orphans, preserving foreign files and agents', (t) => {
    const home = sandbox(t);
    const root = join(home, '.omp', 'agent');
    const dir = join(root, 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'triage.md'), 'personal triage');
    ok(home, 'install', '--only', 'omp-agents,omp-commands');
    const checkpoint = join(dir, 'checkpoint.md');
    writeFileSync(checkpoint, `${SetForOmpCommand.current}\nold command`);
    writeFileSync(join(dir, 'obsolete.md'), `${SetForOmpCommand.current}\nobsolete`);
    writeFileSync(join(dir, 'custom.md'), 'personal command');
    ok(home, 'install', '--omp-commands');
    assert.equal(existsSync(join(dir, 'obsolete.md')), false);
    assert.equal(list(home).find((r) => r.kind === 'omp-command' && r.name === 'checkpoint').state, 'mine');
    ok(home, 'reinstall', '--omp-commands');
    assert.equal(readFileSync(join(dir, 'triage.md'), 'utf8'), 'personal triage');
    assert.equal(readFileSync(join(dir, 'custom.md'), 'utf8'), 'personal command');
    assert.equal(existsSync(join(dir, 'resume.md')), false);
    assert.equal(existsSync(join(dir, 'checkpoint-resume.md')), true);
    ok(home, 'uninstall', '--omp-commands');
    for (const name of OmpCommands.filter((name) => name !== 'triage')) assert.equal(existsSync(join(dir, `${name}.md`)), false);
    for (const rel of OmpCommandRuntimeFiles) assert.equal(existsSync(join(root, rel)), false);
    assert.equal(readFileSync(join(dir, 'triage.md'), 'utf8'), 'personal triage');
    assert.equal(readFileSync(join(dir, 'custom.md'), 'utf8'), 'personal command');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), true);
  });

  it('rejects foreign runtime and missing custom templates before reinstall removes commands', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--omp-commands');
    const root = join(home, '.omp', 'agent');
    const path = join(root, 'commands', 'checkpoint.md');
    const installed = readFileSync(path);
    const extension = join(root, 'extensions', 'cah-babysit.js');
    writeFileSync(extension, 'personal extension');
    assert.equal(call(home, 'reinstall', '--omp-commands').status, 1);
    assert.deepEqual(readFileSync(path), installed);
    assert.equal(readFileSync(extension, 'utf8'), 'personal extension');
    const templates = join(home, 'empty-templates');
    mkdirSync(templates);
    assert.equal(call(home, 'reinstall', '--omp-commands', '--templates', templates).status, 1);
    assert.deepEqual(readFileSync(path), installed);
  });

  it('installs only the selected named profile and exposes dependency health in doctor', (t) => {
    const home = sandbox(t);
    const baseline = missing(home);
    const project = join(home, 'project');
    mkdirSync(project);
    ok(home, 'install', '--omp-commands', '--omp-profile', 'work', '--cwd', project);
    const root = join(home, '.omp', 'profiles', 'work', 'agent');
    assert.equal(existsSync(join(home, '.omp', 'agent')), false);
    assert.equal(existsSync(join(project, '.omp')), false);
    assert.equal(list(home, '--omp-profile', 'work').find((r) => r.kind === 'omp-command' && r.name === 'babysit').state, 'mine');
    assert.equal(missing(home), baseline);
    rmSync(join(root, 'extensions', 'cah-babysit.js'));
    const doctor = call(home, 'doctor', '--omp-profile', 'work');
    assert.equal(doctor.status, 1);
    assert.equal(Number(doctor.stdout.match(/missing: (\d+)/)[1]), baseline + 1);
    ok(home, 'uninstall', '--omp-commands', '--omp-profile', 'work');
  });

  it('commits only a checkpoint through the installed helper, preserving staged user changes', (t) => {
    const home = sandbox(t);
    const repo = join(home, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--quiet');
    writeFileSync(join(repo, 'user.txt'), 'original\n');
    git(repo, 'add', 'user.txt');
    git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'initial');
    writeFileSync(join(repo, 'user.txt'), 'staged user change\n');
    git(repo, 'add', 'user.txt');
    const staged = git(repo, 'diff', '--cached', '--', 'user.txt');
    mkdirSync(join(repo, 'docs', 'checkpoints'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'checkpoints', 'snapshot.md'), '# Checkpoint\nSaved context\n');
    ok(home, 'install', '--omp-commands');
    const helper = join(home, '.omp', 'agent', 'cah', 'commit-checkpoint.mjs');
    const result = spawnSync(process.execPath, [helper, '--name', 'snapshot.md'], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'committed');
    assert.equal(git(repo, 'diff', '--cached', '--', 'user.txt'), staged);
    assert.equal(git(repo, 'show', '--format=', '--name-only', 'HEAD').trim(), 'docs/checkpoints/snapshot.md');
    assert.equal(git(repo, 'show', 'HEAD:user.txt'), 'original\n');
  });
});
