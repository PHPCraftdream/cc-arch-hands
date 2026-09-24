import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../templates/codex-skills/ccheckpoint/scripts/commit-checkpoint.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-codex-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, 'unrelated.txt'), 'base\n');
  git(dir, 'add', '--', 'unrelated.txt');
  git(dir, 'commit', '-qm', 'base');
  mkdirSync(join(dir, 'docs', 'checkpoints'), { recursive: true });
  return dir;
}

function commit(cwd, name) {
  const call = spawnSync(process.execPath, [helper, '--name', name], { cwd, encoding: 'utf8' });
  return { exit: call.status, data: JSON.parse(call.stdout), stderr: call.stderr };
}

describe('Codex ccheckpoint commit helper', () => {
  it('commits only a new checkpoint and keeps unrelated staged changes', (t) => {
    const dir = repo(t);
    writeFileSync(join(dir, 'unrelated.txt'), 'staged\n');
    git(dir, 'add', '--', 'unrelated.txt');
    writeFileSync(join(dir, 'docs', 'checkpoints', 'session.md'), '# Checkpoint\n');
    const result = commit(dir, 'session.md');
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.data.status, 'committed');
    assert.deepEqual(git(dir, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean),
      ['docs/checkpoints/session.md']);
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'unrelated.txt');
    assert.equal(git(dir, 'status', '--porcelain', '--', 'docs/checkpoints/session.md'), '');
    assert.equal(commit(dir, 'session.md').data.status, 'unchanged');
  });

  it('skips a checkpoint path that already has staged changes', (t) => {
    const dir = repo(t);
    const path = join(dir, 'docs', 'checkpoints', 'session.md');
    writeFileSync(path, '# staged\n');
    git(dir, 'add', '--', 'docs/checkpoints/session.md');
    const head = git(dir, 'rev-parse', 'HEAD');
    const result = commit(dir, 'session.md');
    assert.equal(result.exit, 0);
    assert.equal(result.data.status, 'skipped');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(path, 'utf8'), '# staged\n');
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'docs/checkpoints/session.md');
  });

  it('rejects unsafe names and refuses outside a repository', (t) => {
    const dir = repo(t);
    assert.equal(commit(dir, '../escape.md').data.status, 'failed');
    const outside = mkdtempSync(join(tmpdir(), 'cah-codex-checkpoint-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    assert.equal(commit(outside, 'session.md').data.status, 'skipped');
  });

  it('commits from a linked worktree and keeps its index clean', (t) => {
    const dir = repo(t);
    const linked = join(dir, 'linked worktree');
    git(dir, 'worktree', 'add', '--detach', linked);
    mkdirSync(join(linked, 'docs', 'checkpoints'), { recursive: true });
    writeFileSync(join(linked, 'docs', 'checkpoints', 'linked.md'), '# linked\n');
    const result = commit(linked, 'linked.md');
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.data.status, 'committed');
    assert.equal(git(linked, 'status', '--porcelain', '--', 'docs/checkpoints/linked.md'), '');
  });

  it('does not touch a pre-existing Git index lock', (t) => {
    const dir = repo(t);
    writeFileSync(join(dir, 'docs', 'checkpoints', 'locked.md'), '# locked\n');
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir');
    const lock = join(gitDir, 'index.lock');
    writeFileSync(lock, 'other process\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    const result = commit(dir, 'locked.md');
    assert.equal(result.data.status, 'skipped');
    assert.equal(readFileSync(lock, 'utf8'), 'other process\n');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.ok(existsSync(join(dir, 'docs', 'checkpoints', 'locked.md')));
  });
});
