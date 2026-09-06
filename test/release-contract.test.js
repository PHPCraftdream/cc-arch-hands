import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url);

function read(name) {
  return readFileSync(new URL(name, ROOT), 'utf8');
}

const CHECKPOINT_SKILL = read('templates/skills/ccheckpoint/SKILL.md');
const RESUME_SKILL = read('templates/skills/resume/SKILL.md');
const CHECKPOINT_BLOCK = CHECKPOINT_SKILL.match(/```bash\n([\s\S]*?)```/)[1];
const SAFE_CHECKPOINT_BASENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const BASH = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
    .find((candidate) => existsSync(candidate)) ?? 'bash'
  : 'bash';

function runGit(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function makeCheckpointRepo(prefix = 'cah-ccheckpoint-') {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(repo, 'docs', 'checkpoints'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'initial\n');
  writeFileSync(join(repo, 'unrelated.txt'), 'initial\n');
  runGit(repo, ['init', '-q']);
  runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Checkpoint Test']);
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-qm', 'initial']);
  return repo;
}

function renderCheckpointCommand(basename) {
  assert.match(basename, SAFE_CHECKPOINT_BASENAME);
  const command = CHECKPOINT_BLOCK.replace("'SAFE_BASENAME'", `'${basename}'`);
  assert.doesNotMatch(command, /SAFE_BASENAME/);
  return command;
}

function runCheckpointCommit(repo, basename = 'state.md', env = {}) {
  const childEnv = { ...process.env, ...env };
  return spawnSync(BASH, ['-s'], {
    cwd: repo,
    input: renderCheckpointCommand(basename),
    encoding: 'utf8',
    env: childEnv,
  });
}

function toBashPath(path) {
  if (process.platform !== 'win32') return path;
  return execFileSync(BASH, ['-c', 'cygpath -u -- "$1"', 'ccheckpoint-path', path], {
    encoding: 'utf8',
  }).trim();
}

function gitPath(repo, path) {
  return runGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', path]);
}

function indexEntry(repo, path) {
  return runGit(repo, ['ls-files', '--stage', '--', path]);
}

function stagedNames(repo) {
  const output = runGit(repo, ['diff', '--cached', '--name-only']);
  return output ? output.split(/\r?\n/) : [];
}

describe('release and generated-doc contracts', () => {
  it('publish workflow requires tag, package, and CURRENT_VERSION to match', () => {
    const workflow = read('.github/workflows/publish.yml');
    assert.match(workflow, /PACKAGE_VERSION=.*package\.json/);
    assert.match(workflow, /CURRENT_VERSION=.*update-check\.js/);
    assert.match(workflow, /tag=\$VERSION package=\$PACKAGE_VERSION CURRENT_VERSION=\$CURRENT_VERSION/);
    assert.match(workflow, /npm publish .*--tag next/);
  });

  it('prerelease publication is never sent to latest', () => {
    const workflow = read('.github/workflows/publish.yml');
    assert.match(workflow, /if \[\[ "\$VERSION" == \*-\* \]\]/);
    assert.doesNotMatch(workflow, /npm publish[^\n]*--tag latest/);
  });

  it('ccheckpoint commits only the checkpoint and preserves unrelated staged changes', () => {
    assert.equal((CHECKPOINT_BLOCK.match(/\bSAFE_BASENAME\b/g) ?? []).length, 1);
    assert.doesNotMatch(CHECKPOINT_BLOCK, /<[^>\n]+>|reported_(?:checkpoint_)?path|\$[1-9#@*]/);
    const assignedVariables = new Set(
      [...CHECKPOINT_BLOCK.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)=/gm)].map((match) => match[1]),
    );
    const referencedVariables = new Set(
      [...CHECKPOINT_BLOCK.matchAll(/\$(?:\{([a-zA-Z_][a-zA-Z0-9_]*)[^}]*\}|([a-zA-Z_][a-zA-Z0-9_]*))/g)]
        .map((match) => match[1] ?? match[2]),
    );
    assert.deepEqual(
      [...referencedVariables].filter((name) => !assignedVariables.has(name)),
      [],
      'published block must not depend on unresolved shell variables',
    );

    const repo = makeCheckpointRepo();
    try {
      const checkpoint = join(repo, 'docs', 'checkpoints', 'state.md');
      writeFileSync(checkpoint, 'updated\n');
      writeFileSync(join(repo, 'unrelated.txt'), 'staged update\n');
      runGit(repo, ['add', '--', 'unrelated.txt']);
      const result = runCheckpointCommit(repo);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.deepEqual(stagedNames(repo), ['unrelated.txt'], result.stdout + result.stderr);
      assert.equal(runGit(repo, ['status', '--porcelain']), 'M  unrelated.txt');
      assert.deepEqual(
        runGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD^', 'HEAD']).split(/\r?\n/),
        ['docs/checkpoints/state.md'],
      );
      assert.equal(runGit(repo, ['show', 'HEAD:docs/checkpoints/state.md']), 'updated');
      assert.equal(existsSync(join(repo, '.git', 'index.lock')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint commits from detached HEAD and synchronizes its real index', () => {
    const repo = makeCheckpointRepo();
    try {
      runGit(repo, ['switch', '--detach', 'HEAD']);
      const checkpoint = join(repo, 'docs', 'checkpoints', 'state.md');
      writeFileSync(checkpoint, 'detached update\n');
      writeFileSync(join(repo, 'unrelated.txt'), 'staged alongside detached checkpoint\n');
      runGit(repo, ['add', '--', 'unrelated.txt']);

      const result = runCheckpointCommit(repo);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.equal(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
      assert.deepEqual(stagedNames(repo), ['unrelated.txt'], result.stdout + result.stderr);
      assert.equal(runGit(repo, ['show', ':unrelated.txt']), 'staged alongside detached checkpoint');
      assert.equal(runGit(repo, ['diff', '--name-only', '--', 'docs/checkpoints/state.md']), '');
      assert.equal(runGit(repo, ['diff', '--cached', '--name-only', '--', 'docs/checkpoints/state.md']), '');
      assert.equal(
        indexEntry(repo, 'docs/checkpoints/state.md').split(' ').slice(0, 2).join(' '),
        runGit(repo, ['ls-tree', '--format=%(objectmode) %(objectname)', 'HEAD', '--', 'docs/checkpoints/state.md']),
      );
      assert.equal(runGit(repo, ['show', 'HEAD:docs/checkpoints/state.md']), 'detached update');
      assert.equal(existsSync(`${gitPath(repo, 'index')}.lock`), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint skips a checkpoint that is already staged', () => {
    const repo = makeCheckpointRepo();
    try {
      const checkpoint = join(repo, 'docs', 'checkpoints', 'state.md');
      writeFileSync(checkpoint, 'staged checkpoint\n');
      runGit(repo, ['add', '--', 'docs/checkpoints/state.md']);
      const beforeHead = runGit(repo, ['rev-parse', 'HEAD']);
      const beforeIndex = readFileSync(join(repo, '.git', 'index'));
      const result = runCheckpointCommit(repo);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /already has staged changes/);
      assert.equal(runGit(repo, ['rev-parse', 'HEAD']), beforeHead);
      assert.deepEqual(readFileSync(join(repo, '.git', 'index')), beforeIndex);
      assert.deepEqual(stagedNames(repo), ['docs/checkpoints/state.md']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint retries a CAS race without rolling back the parallel commit', () => {
    const repo = makeCheckpointRepo();
    const wrapperDir = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-git-wrapper-'));
    try {
      const checkpoint = join(repo, 'docs', 'checkpoints', 'state.md');
      writeFileSync(checkpoint, 'updated around race\n');
      const realGit = process.platform === 'win32'
        ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]
        : execFileSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).trim();
      const bashEnv = join(wrapperDir, 'ccheckpoint-race-env.sh');
      writeFileSync(bashEnv, `git() {
  if [ "$1" = update-ref ] && [ "$2" = HEAD ] && [ ! -e .cah-race-triggered ]; then
    : > .cah-race-triggered
    printf 'parallel\n' > parallel.txt
    parallel_index=$(mktemp)
    GIT_INDEX_FILE="$parallel_index" "$CCHECKPOINT_REAL_GIT" read-tree "$4"
    GIT_INDEX_FILE="$parallel_index" "$CCHECKPOINT_REAL_GIT" add -- parallel.txt
    parallel_tree=$(GIT_INDEX_FILE="$parallel_index" "$CCHECKPOINT_REAL_GIT" write-tree)
    parallel_commit=$(printf 'parallel\n' | "$CCHECKPOINT_REAL_GIT" commit-tree "$parallel_tree" -p "$4")
    "$CCHECKPOINT_REAL_GIT" update-ref HEAD "$parallel_commit" "$4"
    rm -f -- "$parallel_index"
  fi
  "$CCHECKPOINT_REAL_GIT" "$@"
}
`);
      const result = runCheckpointCommit(repo, 'state.md', {
        BASH_ENV: toBashPath(bashEnv),
        CCHECKPOINT_REAL_GIT: realGit,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.equal(runGit(repo, ['show', '-s', '--format=%s', 'HEAD']), 'checkpoint: state');
      assert.equal(runGit(repo, ['show', '-s', '--format=%s', 'HEAD^']), 'parallel');
      assert.deepEqual(
        runGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD^', 'HEAD']).split(/\r?\n/),
        ['docs/checkpoints/state.md'],
      );
      assert.equal(readFileSync(join(repo, 'parallel.txt'), 'utf8'), 'parallel\n');
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint keeps a same-OID branch switch from retargeting the CAS', () => {
    const repo = makeCheckpointRepo();
    const wrapperDir = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-switch-wrapper-'));
    try {
      const capturedRef = runGit(repo, ['symbolic-ref', 'HEAD']);
      const capturedOid = runGit(repo, ['rev-parse', capturedRef]);
      runGit(repo, ['branch', 'same-oid']);
      writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'switch race\n');
      const bashEnv = join(wrapperDir, 'ccheckpoint-switch-env.sh');
      writeFileSync(bashEnv, `git() {
  if [ "$1" = update-ref ] && [ "$2" = HEAD ] && [ ! -e .cah-switch-triggered ]; then
    : > .cah-switch-triggered
    "$CCHECKPOINT_REAL_GIT" symbolic-ref HEAD refs/heads/same-oid
  fi
  "$CCHECKPOINT_REAL_GIT" "$@"
}
`);
      const result = runCheckpointCommit(repo, 'state.md', {
        BASH_ENV: toBashPath(bashEnv),
        CCHECKPOINT_REAL_GIT: process.platform === 'win32'
          ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]
          : execFileSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).trim(),
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.match(result.stdout, /real index synchronization skipped: HEAD changed concurrently/);
      assert.equal(runGit(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/same-oid');
      assert.equal(runGit(repo, ['rev-parse', capturedRef]), capturedOid);
      assert.notEqual(runGit(repo, ['rev-parse', 'refs/heads/same-oid']), capturedOid);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint does not retry after a different-OID HEAD switch', () => {
    const repo = makeCheckpointRepo();
    const wrapperDir = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-switch-wrapper-'));
    try {
      const capturedRef = runGit(repo, ['symbolic-ref', 'HEAD']);
      runGit(repo, ['switch', '-c', 'different-oid']);
      writeFileSync(join(repo, 'unrelated.txt'), 'different branch\n');
      runGit(repo, ['add', '--', 'unrelated.txt']);
      runGit(repo, ['commit', '-qm', 'different branch']);
      const differentHead = runGit(repo, ['rev-parse', 'HEAD']);
      runGit(repo, ['switch', capturedRef.replace('refs/heads/', '')]);
      const capturedOid = runGit(repo, ['rev-parse', capturedRef]);
      writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'different switch race\n');
      const bashEnv = join(wrapperDir, 'ccheckpoint-switch-env.sh');
      writeFileSync(bashEnv, `git() {
  if [ "$1" = update-ref ] && [ "$2" = HEAD ] && [ ! -e .cah-switch-triggered ]; then
    : > .cah-switch-triggered
    "$CCHECKPOINT_REAL_GIT" symbolic-ref HEAD refs/heads/different-oid
  fi
  "$CCHECKPOINT_REAL_GIT" "$@"
}
`);
      const result = runCheckpointCommit(repo, 'state.md', {
        BASH_ENV: toBashPath(bashEnv),
        CCHECKPOINT_REAL_GIT: process.platform === 'win32'
          ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]
          : execFileSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).trim(),
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit skipped: HEAD switched concurrently; real index preserved/);
      assert.doesNotMatch(result.stdout, /retry limit reached/);
      assert.equal(runGit(repo, ['rev-parse', 'HEAD']), differentHead);
      assert.equal(runGit(repo, ['rev-parse', capturedRef]), capturedOid);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint skips merge and rebase states', () => {
    for (const [state, isDirectory] of [['MERGE_HEAD', false], ['rebase-merge', true]]) {
      const repo = makeCheckpointRepo();
      try {
        const statePath = runGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', state]);
        if (isDirectory) mkdirSync(statePath, { recursive: true });
        else writeFileSync(statePath, `${runGit(repo, ['rev-parse', 'HEAD'])}\n`);
        writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), `${state} update\n`);
        const beforeHead = runGit(repo, ['rev-parse', 'HEAD']);
        const result = runCheckpointCommit(repo);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Git operation is in progress/);
        assert.equal(runGit(repo, ['rev-parse', 'HEAD']), beforeHead);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('ccheckpoint skips before commit when the existing index.lock is present', () => {
    const repo = makeCheckpointRepo();
    try {
      const indexPath = runGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      writeFileSync(`${indexPath}.lock`, 'held\n');
      writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'locked update\n');
      const beforeHead = runGit(repo, ['rev-parse', 'HEAD']);
      const result = runCheckpointCommit(repo);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /real index is locked/);
      assert.equal(runGit(repo, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(existsSync(`${indexPath}.lock`), true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('checkpoint, ccheckpoint, and resume resolve a linked worktree as the caller repo', () => {
    assert.match(CHECKPOINT_SKILL, /git rev-parse --show-toplevel/);
    assert.match(CHECKPOINT_SKILL, /linked worktree's `.git` file/);
    assert.match(RESUME_SKILL, /git rev-parse --show-toplevel/);
    assert.match(RESUME_SKILL, /linked worktree's `.git` file/);
    assert.doesNotMatch(RESUME_SKILL, /if a `.git` directory exists in the current working directory or any parent/);
    assert.match(RESUME_SKILL, /otherwise \(only when the command fails or returns an empty path/);
    assert.match(RESUME_SKILL, /Exact filename match \(with or without `\.md`\): take it/);
    assert.match(RESUME_SKILL, /sort every `\.md` in the directory by filesystem mtime descending/);

    const parentRepo = makeCheckpointRepo('cah-ccheckpoint-linked-parent-');
    const worktree = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-linked-worktree-'));
    rmSync(worktree, { recursive: true, force: true });
    try {
      runGit(parentRepo, ['worktree', 'add', '-q', '-b', 'linked-contract', worktree, 'HEAD']);
      assert.equal(readFileSync(join(worktree, '.git'), 'utf8').startsWith('gitdir: '), true);
      assert.equal(
        runGit(worktree, ['rev-parse', '--show-toplevel']).replaceAll('\\', '/'),
        worktree.replaceAll('\\', '/'),
      );

      writeFileSync(join(parentRepo, 'docs', 'checkpoints', 'state.md'), 'parent must stay untouched\n');
      writeFileSync(join(worktree, 'docs', 'checkpoints', 'state.md'), 'linked worktree update\n');
      writeFileSync(join(worktree, 'unrelated.txt'), 'linked staged update\n');
      runGit(worktree, ['add', '--', 'unrelated.txt']);
      const parentHead = runGit(parentRepo, ['rev-parse', 'HEAD']);

      const result = runCheckpointCommit(worktree);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.equal(runGit(parentRepo, ['rev-parse', 'HEAD']), parentHead);
      assert.equal(readFileSync(join(parentRepo, 'docs', 'checkpoints', 'state.md'), 'utf8'), 'parent must stay untouched\n');
      assert.equal(runGit(worktree, ['show', 'HEAD:docs/checkpoints/state.md']), 'linked worktree update');
      assert.deepEqual(stagedNames(worktree), ['unrelated.txt'], result.stdout + result.stderr);
      assert.equal(runGit(worktree, ['diff', '--name-only', '--', 'docs/checkpoints/state.md']), '');
      assert.equal(runGit(worktree, ['diff', '--cached', '--name-only', '--', 'docs/checkpoints/state.md']), '');
      assert.equal(existsSync(`${gitPath(worktree, 'index')}.lock`), false);

      const resumeRepoRoot = runGit(worktree, ['rev-parse', '--show-toplevel']);
      const resumeCheckpoint = join(resumeRepoRoot, 'docs', 'checkpoints', 'state.md');
      assert.equal(resumeRepoRoot.replaceAll('\\', '/'), worktree.replaceAll('\\', '/'));
      assert.equal(readFileSync(resumeCheckpoint, 'utf8'), 'linked worktree update\n');
      assert.equal(readFileSync(join(parentRepo, 'docs', 'checkpoints', 'state.md'), 'utf8'), 'parent must stay untouched\n');
    } finally {
      try {
        runGit(parentRepo, ['worktree', 'remove', '--force', worktree]);
      } catch {
        // The worktree may not have been registered if setup failed.
      }
      rmSync(worktree, { recursive: true, force: true });
      rmSync(parentRepo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint keeps malicious repo paths out of shell source and rejects unsafe basenames', () => {
    const repo = makeCheckpointRepo('cah-ccheckpoint-$(touch pwned)-`echo pwned`-');
    try {
      const maliciousName = 'bad$(touch pwned)-`echo pwned`.md';
      assert.throws(() => renderCheckpointCommand(maliciousName));
      writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'safe update\n');
      const result = runCheckpointCommit(repo);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.equal(runGit(repo, ['show', '-s', '--format=%s', 'HEAD']), 'checkpoint: state');
      assert.equal(existsSync(join(repo, 'pwned')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint preserves the real index on commit and index-publication failures', () => {
    const repo = makeCheckpointRepo();
    const publicationRepo = makeCheckpointRepo();
    const bashEnvDir = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-mv-failure-'));
    try {
      const checkpoint = join(repo, 'docs', 'checkpoints', 'state.md');
      writeFileSync(checkpoint, 'will not commit\n');
      writeFileSync(join(repo, 'unrelated.txt'), 'staged update\n');
      runGit(repo, ['add', '--', 'unrelated.txt']);
      const beforeHead = runGit(repo, ['rev-parse', 'HEAD']);
      const beforeIndex = readFileSync(join(repo, '.git', 'index'));
      const result = runCheckpointCommit(repo, 'state.md', { GIT_COMMITTER_NAME: '' });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /real index preserved/);
      assert.equal(runGit(repo, ['rev-parse', 'HEAD']), beforeHead);
      assert.deepEqual(readFileSync(join(repo, '.git', 'index')), beforeIndex);
      assert.deepEqual(stagedNames(repo), ['unrelated.txt']);
      assert.equal(existsSync(join(repo, '.git', 'index.lock')), false);

      const publicationCheckpoint = join(publicationRepo, 'docs', 'checkpoints', 'state.md');
      writeFileSync(publicationCheckpoint, 'commit despite index publication failure\n');
      writeFileSync(join(publicationRepo, 'unrelated.txt'), 'staged update\n');
      runGit(publicationRepo, ['add', '--', 'unrelated.txt']);
      const publicationHead = runGit(publicationRepo, ['rev-parse', 'HEAD']);
      const publicationIndex = readFileSync(join(publicationRepo, '.git', 'index'));
      const bashEnv = join(bashEnvDir, 'ccheckpoint-fail-mv-env.sh');
      writeFileSync(bashEnv, 'mv() { return 73; }\n');
      const publicationResult = runCheckpointCommit(publicationRepo, 'state.md', {
        BASH_ENV: toBashPath(bashEnv),
      });

      assert.equal(publicationResult.status, 0, publicationResult.stderr);
      assert.match(publicationResult.stdout, /commit succeeded: [0-9a-f]{7}; real index synchronization skipped/);
      assert.notEqual(runGit(publicationRepo, ['rev-parse', 'HEAD']), publicationHead);
      assert.deepEqual(readFileSync(join(publicationRepo, '.git', 'index')), publicationIndex);
      assert.equal(existsSync(join(publicationRepo, '.git', 'index.lock')), false);
      assert.deepEqual(stagedNames(publicationRepo), ['docs/checkpoints/state.md', 'unrelated.txt']);
    } finally {
      rmSync(bashEnvDir, { recursive: true, force: true });
      rmSync(publicationRepo, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint does not remove a successor lock after publication is interrupted', () => {
    const repo = makeCheckpointRepo();
    const bashEnvDir = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-signal-window-'));
    try {
      writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'signal-window update\n');
      const bashEnv = join(bashEnvDir, 'ccheckpoint-signal-window-env.sh');
      const realMv = process.platform === 'win32'
        ? execFileSync(BASH, ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()
        : execFileSync('command', ['-v', 'mv'], { encoding: 'utf8', shell: true }).trim();
      writeFileSync(bashEnv, `mv() {
  "$CCHECKPOINT_REAL_MV" "$@"
  mv_status=$?
  if [ "$mv_status" -eq 0 ]; then
    : > "$2"
    kill -TERM "$$"
  fi
  return "$mv_status"
}
`);
      const result = runCheckpointCommit(repo, 'state.md', {
        BASH_ENV: toBashPath(bashEnv),
        CCHECKPOINT_REAL_MV: toBashPath(realMv),
      });

      const indexPath = gitPath(repo, 'index');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /commit succeeded: [0-9a-f]{7}/);
      assert.equal(existsSync(`${indexPath}.lock`), true);
      assert.equal(readFileSync(`${indexPath}.lock`, 'utf8'), '');
    } finally {
      rmSync(bashEnvDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('README describes no-effort Haiku and shared-bin uninstall explicitly', () => {
    const readme = read('README.md');
    assert.match(readme, /\/h\s+Haiku \(top\), no effort control/);
    assert.match(readme, /`\/h45`/);
    assert.match(readme, /uninstall --only bins.*shared bins globally/);
    assert.doesNotMatch(readme, /`\/hl`.*low effort/);
  });
});
