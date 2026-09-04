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
  return spawnSync(BASH, ['-c', renderCheckpointCommand(basename)], {
    cwd: repo,
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
    (
      unset GIT_INDEX_FILE
      "$CCHECKPOINT_REAL_GIT" add -- parallel.txt
      "$CCHECKPOINT_REAL_GIT" commit -qm parallel
    )
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

  it('README describes no-effort Haiku and shared-bin uninstall explicitly', () => {
    const readme = read('README.md');
    assert.match(readme, /\/h\s+Haiku \(top\), no effort control/);
    assert.match(readme, /`\/h45`/);
    assert.match(readme, /uninstall --only bins.*shared bins globally/);
    assert.doesNotMatch(readme, /`\/hl`.*low effort/);
  });
});
