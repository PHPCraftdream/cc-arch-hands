import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url);

function read(name) {
  // Normalize CRLF -> LF: a Windows checkout (core.autocrlf) converts the
  // checked-in LF line endings to CRLF, and CHECKPOINT_BLOCK's regex below
  // (and other line-anchored patterns in this file) require a literal \n.
  return readFileSync(new URL(name, ROOT), 'utf8').replaceAll('\r\n', '\n');
}


const CHECKPOINT_SKILL = read('templates/skills/ccheckpoint/SKILL.md');
const RESUME_SKILL = read('templates/skills/resume/SKILL.md');
// The published commit commands, one per line, with NAME as the stem placeholder.
const CHECKPOINT_COMMANDS = CHECKPOINT_SKILL.match(/```bash\n([\s\S]*?)```/)[1]
  .split('\n').map((line) => line.trim()).filter(Boolean);
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
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'initial\n');
  writeFileSync(join(repo, 'unrelated.txt'), 'initial\n');
  runGit(repo, ['init', '-q']);
  runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Checkpoint Test']);
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-qm', 'initial']);
  return repo;
}

// Runs the published commands as separate calls, as the skill instructs, and
// stops at the first failure. Returns one spawnSync result per command run.
function runCheckpointCommands(cwd, stem = 'state', commands = CHECKPOINT_COMMANDS) {
  const results = [];
  for (const command of commands) {
    const result = spawnSync(BASH, ['-c', command.replaceAll('NAME', stem)], { cwd, encoding: 'utf8' });
    results.push(result);
    if (result.status !== 0) break;
  }
  return results;
}

function output(results) {
  return results.map((r) => r.stdout + r.stderr).join('');
}

// dev+ino identifies one filesystem entry however its path is spelled
// (macOS /private/var, Windows 8.3 short names).
function samePath(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

function stagedNames(repo) {
  const out = runGit(repo, ['diff', '--cached', '--name-only']);
  return out ? out.split(/\r?\n/) : [];
}

function committedNames(repo) {
  return runGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD^', 'HEAD']).split(/\r?\n/);
}

describe('release and generated-doc contracts', () => {
  it('ignores /wrush task worktrees and nothing else agent-tree-shaped', () => {
    // /wrush now legitimately creates worktrees/ under this repo (unrelated
    // to the agent-tree extraction this test used to guard against), so the
    // ignore entry is expected -- assert its exact, intentional shape
    // instead of a blanket absence.
    const gitignore = read('.gitignore');
    assert.match(gitignore, /^\/worktrees\/$/m);
    assert.doesNotMatch(gitignore, /agent-tree/i);
  });

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

  it('ccheckpoint publishes only ordinary Git commands', () => {
    assert.deepEqual(CHECKPOINT_COMMANDS, [
      "git status --porcelain -- ':(top)docs/checkpoints/NAME.md'",
      "git add -- ':(top)docs/checkpoints/NAME.md'",
      "git commit --only -m 'checkpoint: NAME' -- ':(top)docs/checkpoints/NAME.md'",
      'git rev-parse --short HEAD',
    ]);
    assert.match(CHECKPOINT_SKILL, /\^\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\*\\\.md\$/,
      'the basename rule keeps NAME a plain slug inside single quotes');
    assert.match(CHECKPOINT_SKILL, /Do not use `git commit-tree`, `git update-ref`, a custom `GIT_INDEX_FILE`/);
    assert.match(CHECKPOINT_SKILL, /Never use `git add -f`/);
    assert.match(CHECKPOINT_SKILL, /never bypass hooks \(`--no-verify`\)/);
    assert.match(CHECKPOINT_SKILL, /is yours to fix: correct the command and run it again/);
    assert.match(CHECKPOINT_SKILL, /Never push/);
  });

  it('ccheckpoint commits only the checkpoint from a subdirectory and keeps unrelated staged changes', () => {
    const repo = makeCheckpointRepo();
    try {
      writeFileSync(join(repo, 'docs', 'checkpoints', 'state.md'), 'updated\n');
      writeFileSync(join(repo, 'unrelated.txt'), 'staged update\n');
      runGit(repo, ['add', '--', 'unrelated.txt']);
      const results = runCheckpointCommands(join(repo, 'sub'));

      assert.equal(results.length, CHECKPOINT_COMMANDS.length, output(results));
      assert.ok(results.every((r) => r.status === 0), output(results));
      assert.equal(results.at(-1).stdout.trim(), runGit(repo, ['rev-parse', '--short', 'HEAD']));
      assert.deepEqual(committedNames(repo), ['docs/checkpoints/state.md']);
      assert.equal(runGit(repo, ['show', '-s', '--format=%s', 'HEAD']), 'checkpoint: state');
      assert.equal(runGit(repo, ['show', 'HEAD:docs/checkpoints/state.md']), 'updated');
      assert.deepEqual(stagedNames(repo), ['unrelated.txt']);
      assert.equal(runGit(repo, ['status', '--porcelain']), 'M  unrelated.txt');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint commits a new untracked checkpoint and works on a detached HEAD', () => {
    const repo = makeCheckpointRepo();
    try {
      runGit(repo, ['switch', '--detach', '-q', 'HEAD']);
      writeFileSync(join(repo, 'docs', 'checkpoints', '2026-10-26-1226.md'), 'fresh\n');
      const results = runCheckpointCommands(repo, '2026-10-26-1226');

      assert.ok(results.every((r) => r.status === 0), output(results));
      assert.deepEqual(committedNames(repo), ['docs/checkpoints/2026-10-26-1226.md']);
      assert.equal(runGit(repo, ['status', '--porcelain']), '');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint sees an unchanged checkpoint as empty status output', () => {
    const repo = makeCheckpointRepo();
    try {
      const head = runGit(repo, ['rev-parse', 'HEAD']);
      const [status] = runCheckpointCommands(repo, 'state', CHECKPOINT_COMMANDS.slice(0, 1));
      assert.equal(status.status, 0, status.stderr);
      assert.equal(status.stdout, '');
      assert.equal(runGit(repo, ['rev-parse', 'HEAD']), head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint leaves an ignored checkpoint directory uncommitted', () => {
    const repo = makeCheckpointRepo();
    try {
      writeFileSync(join(repo, '.gitignore'), 'docs/checkpoints/\n');
      runGit(repo, ['add', '.gitignore']);
      runGit(repo, ['commit', '-qm', 'ignore checkpoints']);
      writeFileSync(join(repo, 'docs', 'checkpoints', 'ignored.md'), 'local only\n');
      const head = runGit(repo, ['rev-parse', 'HEAD']);
      const results = runCheckpointCommands(repo, 'ignored');

      assert.notEqual(results.at(-1).status, 0);
      assert.match(output(results), /ignored by one of your \.gitignore files/);
      assert.equal(runGit(repo, ['rev-parse', 'HEAD']), head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint surfaces real blockers without touching them', () => {
    const merging = makeCheckpointRepo();
    const locked = makeCheckpointRepo();
    try {
      const branch = runGit(merging, ['branch', '--show-current']);
      runGit(merging, ['switch', '-q', '-c', 'side']);
      writeFileSync(join(merging, 'unrelated.txt'), 'side\n');
      runGit(merging, ['commit', '-qam', 'side']);
      runGit(merging, ['switch', '-q', branch]);
      writeFileSync(join(merging, 'unrelated.txt'), 'main\n');
      runGit(merging, ['commit', '-qam', 'main']);
      spawnSync('git', ['-C', merging, 'merge', 'side'], { encoding: 'utf8' });
      writeFileSync(join(merging, 'docs', 'checkpoints', 'state.md'), 'during merge\n');
      const mergeHead = runGit(merging, ['rev-parse', 'HEAD']);
      const duringMerge = runCheckpointCommands(merging);
      assert.notEqual(duringMerge.at(-1).status, 0, output(duringMerge));
      assert.equal(runGit(merging, ['rev-parse', 'HEAD']), mergeHead);
      assert.equal(existsSync(join(merging, '.git', 'MERGE_HEAD')), true);

      const lock = join(locked, '.git', 'index.lock');
      writeFileSync(lock, '');
      writeFileSync(join(locked, 'docs', 'checkpoints', 'state.md'), 'while locked\n');
      const lockedHead = runGit(locked, ['rev-parse', 'HEAD']);
      const whileLocked = runCheckpointCommands(locked);
      assert.notEqual(whileLocked.at(-1).status, 0);
      assert.match(output(whileLocked), /index\.lock/);
      assert.equal(existsSync(lock), true, 'a foreign lock is never removed');
      assert.equal(runGit(locked, ['rev-parse', 'HEAD']), lockedHead);
    } finally {
      rmSync(merging, { recursive: true, force: true });
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it('checkpoint, ccheckpoint, and resume resolve a linked worktree as the caller repo', () => {
    assert.match(CHECKPOINT_SKILL, /git rev-parse --show-toplevel/);
    assert.match(CHECKPOINT_SKILL, /linked worktree's `.git` file/);
    assert.match(RESUME_SKILL, /git rev-parse --show-toplevel/);
    assert.match(RESUME_SKILL, /linked worktree's `.git` file/);
    assert.doesNotMatch(RESUME_SKILL, /if a `.git` directory exists in the current working directory or any parent/);
    assert.match(RESUME_SKILL, /If the command fails or returns an empty path \(caller is outside any Git repository\), refuse and stop/);
    assert.match(RESUME_SKILL, /never read `~\/\.claude\/checkpoints\/` or any other path shared across projects\/agents/);
    assert.match(RESUME_SKILL, /Exact filename match \(with or without `\.md`\): take it/);
    assert.match(RESUME_SKILL, /sort every `\.md` in the directory by filesystem mtime descending/);

    const parentRepo = makeCheckpointRepo('cah-ccheckpoint-linked-parent-');
    const worktree = mkdtempSync(join(tmpdir(), 'cah-ccheckpoint-linked-worktree-'));
    rmSync(worktree, { recursive: true, force: true });
    try {
      runGit(parentRepo, ['worktree', 'add', '-q', '-b', 'linked-contract', worktree, 'HEAD']);
      assert.equal(readFileSync(join(worktree, '.git'), 'utf8').startsWith('gitdir: '), true);
      assert.equal(samePath(runGit(worktree, ['rev-parse', '--show-toplevel']), worktree), true);

      writeFileSync(join(parentRepo, 'docs', 'checkpoints', 'state.md'), 'parent must stay untouched\n');
      writeFileSync(join(worktree, 'docs', 'checkpoints', 'state.md'), 'linked worktree update\n');
      writeFileSync(join(worktree, 'unrelated.txt'), 'linked staged update\n');
      runGit(worktree, ['add', '--', 'unrelated.txt']);
      const parentHead = runGit(parentRepo, ['rev-parse', 'HEAD']);

      const results = runCheckpointCommands(worktree);

      assert.ok(results.every((r) => r.status === 0), output(results));
      assert.equal(runGit(parentRepo, ['rev-parse', 'HEAD']), parentHead);
      assert.equal(readFileSync(join(parentRepo, 'docs', 'checkpoints', 'state.md'), 'utf8'), 'parent must stay untouched\n');
      assert.equal(runGit(worktree, ['show', 'HEAD:docs/checkpoints/state.md']), 'linked worktree update');
      assert.deepEqual(stagedNames(worktree), ['unrelated.txt']);

      const resumeRepoRoot = runGit(worktree, ['rev-parse', '--show-toplevel']);
      assert.equal(samePath(resumeRepoRoot, worktree), true);
      assert.equal(readFileSync(join(resumeRepoRoot, 'docs', 'checkpoints', 'state.md'), 'utf8'), 'linked worktree update\n');
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

  it('README documents the Haiku 5.5 / 4.5 commands, the retired aliases and shared-bin uninstall', () => {
    const readme = read('README.md');
    assert.match(readme, /\/hm\s+Haiku 5\.5 \(top\), medium effort/);
    assert.match(readme, /\/h1x\s+Haiku 4\.5/);
    assert.match(readme, /\| \*\*Haiku\*\* \(top, 1M\) \| `claude-haiku-5-5` \| `\/hl` \| `\/hm` \| `\/hh` \| `\/hx` \| `\/hxx` \|/);
    assert.match(readme, /\| Haiku 4\.5 \(200k\) \| `claude-haiku-4-5` \| `\/h1l` \| `\/h1m` \| `\/h1h` \| `\/h1x` \| `\/h1xx` \|/);
    assert.doesNotMatch(readme, /\| `\/h45` \|/, 'the retired h45 alias is gone from the tables');
    assert.doesNotMatch(readme, /\| `\/h` \|/, 'the retired bare h alias is gone from the tables');
    assert.match(readme, /uninstall --only bins.*shared bins globally/);
  });
});
