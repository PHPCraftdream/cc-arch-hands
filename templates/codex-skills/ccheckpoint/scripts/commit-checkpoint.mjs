#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdtempSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function git(args, cwd, env = process.env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitExit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  return result.status;
}

function headIdentity(root) {
  const result = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return null;
  throw new Error('could not identify HEAD');
}

function result(status, detail) {
  console.log(JSON.stringify({ status, ...detail }));
}

function run(name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name || '')) {
    throw new Error('checkpoint name must be a safe slug or timestamp .md basename');
  }
  let root;
  try { root = realpathSync(git(['rev-parse', '--show-toplevel'], process.cwd())); }
  catch { return { status: 'skipped', reason: 'caller is outside a Git repository' }; }

  const directory = join(root, 'docs', 'checkpoints');
  const actualDirectory = realpathSync(directory);
  const expectedDirectory = resolve(directory);
  const sameDirectory = process.platform === 'win32'
    ? actualDirectory.toLowerCase() === expectedDirectory.toLowerCase()
    : actualDirectory === expectedDirectory;
  if (!sameDirectory) throw new Error('checkpoint directory is redirected');
  const path = join(directory, name);
  if (!lstatSync(path).isFile()) throw new Error('checkpoint is not a regular file');
  const rel = `docs/checkpoints/${name}`;
  const actualPath = realpathSync(path);
  const relativePath = relative(root, actualPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('checkpoint escapes the repository');
  }

  const indexName = git(['rev-parse', '--git-path', 'index'], root);
  const realIndex = isAbsolute(indexName) ? indexName : resolve(root, indexName);
  const lockPath = `${realIndex}.lock`;
  let lockFd;
  try { lockFd = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return { status: 'skipped', reason: 'Git index is locked' };
    throw error;
  }
  const lockIdentity = fstatSync(lockFd, { bigint: true });
  let lockOwned = true;
  let temp;
  let newCommit;
  try {
    const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
      'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG'];
    for (const operation of operations) {
      const stateName = git(['rev-parse', '--git-path', operation], root);
      if (existsSync(isAbsolute(stateName) ? stateName : resolve(root, stateName))) {
        return { status: 'skipped', reason: `Git ${operation} operation is active` };
      }
    }
    const oldHead = git(['rev-parse', '--verify', 'HEAD'], root);
    const oldRef = headIdentity(root);
    const staged = gitExit(['diff', '--cached', '--quiet', oldHead, '--', rel], root);
    if (staged === 1) return { status: 'skipped', reason: 'checkpoint path already has staged changes' };
    if (staged !== 0) throw new Error('staged-state preflight failed');

    temp = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-'));
    const privateIndex = join(temp, 'private-index');
    const privateEnv = { ...process.env, GIT_INDEX_FILE: privateIndex };
    git(['read-tree', oldHead], root, privateEnv);
    git(['add', '--', rel], root, privateEnv);
    const tree = git(['write-tree'], root, privateEnv);
    if (tree === git(['rev-parse', `${oldHead}^{tree}`], root)) {
      return { status: 'unchanged' };
    }
    const stem = name.slice(0, -3);
    newCommit = git(['commit-tree', tree, '-p', oldHead, '-m', `checkpoint: ${stem}`], root);
    if (headIdentity(root) !== oldRef || git(['rev-parse', 'HEAD'], root) !== oldHead) {
      return { status: 'skipped', reason: 'HEAD changed concurrently' };
    }
    if (gitExit(['update-ref', 'HEAD', newCommit, oldHead], root) !== 0) {
      return { status: 'skipped', reason: 'HEAD compare-and-swap failed' };
    }

    try {
      if (headIdentity(root) !== oldRef || git(['rev-parse', 'HEAD'], root) !== newCommit) {
        throw new Error('HEAD changed after commit');
      }
      const entry = git(['ls-tree', tree, '--', rel], root);
      const match = entry.match(/^([0-7]+) blob ([0-9a-f]+)\t/);
      if (!match) throw new Error('checkpoint tree entry is missing');
      const syncIndex = join(temp, 'sync-index');
      if (existsSync(realIndex)) writeFileSync(syncIndex, readFileSync(realIndex));
      else git(['read-tree', newCommit], root, { ...process.env, GIT_INDEX_FILE: syncIndex });
      git(['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${rel}`],
        root, { ...process.env, GIT_INDEX_FILE: syncIndex });
      writeFileSync(lockFd, readFileSync(syncIndex));
      fsyncSync(lockFd);
      closeSync(lockFd);
      lockFd = null;
      renameSync(lockPath, realIndex);
      lockOwned = false;
      return { status: 'committed', commit: newCommit };
    } catch (error) {
      return { status: 'committed', commit: newCommit, warning: `index synchronization skipped: ${error.message}` };
    }
  } finally {
    if (lockFd !== null) closeSync(lockFd);
    if (lockOwned && existsSync(lockPath)) {
      const current = statSync(lockPath, { bigint: true });
      if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) unlinkSync(lockPath);
    }
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

try {
  const [flag, name] = process.argv.slice(2);
  if (flag !== '--name' || process.argv.length !== 4) throw new Error('usage: commit-checkpoint.mjs --name <safe-basename.md>');
  const outcome = run(name);
  result(outcome.status, outcome);
} catch (error) {
  result('failed', { reason: error.message });
  process.exitCode = 1;
}
