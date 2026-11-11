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
import { dirname, join } from 'node:path';
import { embeddedTemplates } from '../lib/templates.js';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url);

function read(name) {
  // Normalize CRLF -> LF: a Windows checkout (core.autocrlf) converts the
  // checked-in LF line endings to CRLF, and CHECKPOINT_BLOCK's regex below
  // (and other line-anchored patterns in this file) require a literal \n.
  return readFileSync(new URL(name, ROOT), 'utf8').replaceAll('\r\n', '\n');
}


// Installed text: shared fragments expanded, exactly as every installer sees it.
function installed(kind, name, leaf) {
  const file = embeddedTemplates().skillTree(name, kind).find((entry) => entry.relPath === leaf);
  return file.bytes.toString('utf8').replaceAll('\r\n', '\n');
}

const CHECKPOINT_SKILL = installed('skills', 'ccheckpoint', 'SKILL.md');
const RESUME_SKILL = installed('skills', 'resume', 'SKILL.md');
const MAIN_FOLDER_FRAGMENT = read('templates/shared/checkpoint-main-worktree.md').trimEnd();
// Every checkpoint-family template that writes or reads checkpoints itself.
const MAIN_FOLDER_TEMPLATES = [
  ['skills', 'checkpoint', 'SKILL.md'], ['skills', 'resume', 'SKILL.md'],
  ['codex-skills', 'checkpoint', 'SKILL.md'], ['codex-skills', 'resume', 'SKILL.md'],
  ['opencode-skills', 'checkpoint', 'SKILL.md'], ['opencode-skills', 'ccheckpoint', 'SKILL.md'],
  ['opencode-skills', 'checkpoint-resume', 'SKILL.md'],
  ['opencode-commands', 'checkpoint', 'command.md'], ['opencode-commands', 'ccheckpoint', 'command.md'],
  ['opencode-commands', 'checkpoint-resume', 'command.md'],
  ['omp-commands', 'checkpoint', 'command.md'], ['omp-commands', 'checkpoint-resume', 'command.md'],
];

// The first ```bash block of a skill, one command per line.
function bashCommands(skill) {
  return skill.match(/```bash\n([\s\S]*?)```/)[1]
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

// The published commit commands, with NAME as the stem placeholder.
const CHECKPOINT_COMMANDS = bashCommands(CHECKPOINT_SKILL);
// The published main-folder check.
const GUARD_COMMANDS = bashCommands(MAIN_FOLDER_FRAGMENT);
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
// The main folder as the skill resolves it: the parent of the common git dir.
function mainFolder(cwd) {
  return dirname(runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

function runCheckpointCommands(cwd, stem = 'state', commands = CHECKPOINT_COMMANDS) {
  const results = [];
  for (const command of commands) {
    const script = command.replaceAll('NAME', stem).replaceAll('<folder>', mainFolder(cwd));
    const result = spawnSync(BASH, ['-c', script], { cwd, encoding: 'utf8' });
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
      `git -C "<folder>" status --porcelain -- ':(top)docs/checkpoints/NAME.md'`,
      `git -C "<folder>" add -- ':(top)docs/checkpoints/NAME.md'`,
      `git -C "<folder>" commit --only -m 'checkpoint: NAME' -- ':(top)docs/checkpoints/NAME.md'`,
      'git -C "<folder>" rev-parse --short HEAD',
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

  it('ccheckpoint commits a new untracked checkpoint', () => {
    const repo = makeCheckpointRepo();
    try {
      writeFileSync(join(repo, 'docs', 'checkpoints', '2026-10-26-1226.md'), 'fresh\n');
      const results = runCheckpointCommands(repo, '2026-10-26-1226');

      assert.ok(results.every((r) => r.status === 0), output(results));
      assert.deepEqual(committedNames(repo), ['docs/checkpoints/2026-10-26-1226.md']);
      assert.equal(runGit(repo, ['status', '--porcelain']), '');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ccheckpoint run from a linked worktree commits in the main folder only', () => {
    const repo = makeCheckpointRepo('cah-checkpoint-wt-');
    const linked = mkdtempSync(join(tmpdir(), 'cah-checkpoint-wt-linked-'));
    rmSync(linked, { recursive: true, force: true });
    try {
      runGit(repo, ['worktree', 'add', '-q', '-b', 'side', linked, 'HEAD']);
      const sideHead = runGit(linked, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'docs', 'checkpoints', 'from-side.md'), 'from side\n');
      const results = runCheckpointCommands(linked, 'from-side');

      assert.ok(results.every((r) => r.status === 0), output(results));
      assert.deepEqual(committedNames(repo), ['docs/checkpoints/from-side.md']);
      assert.equal(runGit(linked, ['rev-parse', 'HEAD']), sideHead, 'the worktree branch is untouched');
    } finally {
      try {
        runGit(repo, ['worktree', 'remove', '--force', linked]);
      } catch {
        // The worktree may not have been registered if setup failed.
      }
      rmSync(linked, { recursive: true, force: true });
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

  it('every checkpoint template, in every harness, carries the one shared main-folder rule', () => {
    assert.deepEqual(GUARD_COMMANDS, [
      'git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir',
    ]);
    assert.match(MAIN_FOLDER_FRAGMENT, /fails or prints nothing → not a Git repository: refuse and stop/i);
    assert.match(MAIN_FOLDER_FRAGMENT, /main folder \(its main worktree\) is the reference point for everything/);
    assert.match(MAIN_FOLDER_FRAGMENT, /equals line 3 \(`--git-common-dir`\) → the caller is in the main folder/);
    assert.match(MAIN_FOLDER_FRAGMENT, /linked worktree \(line 1\): `<repo-root>` is the parent directory of line 3/);
    assert.match(MAIN_FOLDER_FRAGMENT, /Do not refuse, and do not move, merge or change anything in any worktree/);
    assert.match(MAIN_FOLDER_FRAGMENT, /From the caller's directory run `git worktree list --porcelain`/);
    assert.match(MAIN_FOLDER_FRAGMENT, /Never work around such a refusal/);
    assert.match(MAIN_FOLDER_FRAGMENT, /"not readable from this session"/);
    assert.match(MAIN_FOLDER_FRAGMENT, /the checkpoint directory becomes `<worktree>\/docs\/checkpoints\/`/);
    assert.match(MAIN_FOLDER_FRAGMENT, /carry this file into <repo-root>\/docs\/checkpoints\//);
    assert.match(MAIN_FOLDER_FRAGMENT, /for every linked worktree that `git worktree list --porcelain` lists, its `docs\/checkpoints\/`/);
    assert.match(MAIN_FOLDER_FRAGMENT, /Never create or enter a worktree for a checkpoint/);
    assert.match(MAIN_FOLDER_FRAGMENT, /any other path shared across projects\/agents/);
    assert.doesNotMatch(MAIN_FOLDER_FRAGMENT, /~\/\.claude|TaskList|todo/, 'the shared rule stays harness-neutral');
    for (const [kind, name, leaf] of MAIN_FOLDER_TEMPLATES) {
      assert.ok(installed(kind, name, leaf).includes(MAIN_FOLDER_FRAGMENT), `${kind}/${name}`);
    }
    assert.match(CHECKPOINT_SKILL, /Invoke `Skill\('checkpoint'/);
    assert.match(CHECKPOINT_SKILL, /git -C "<folder>" add/);
    assert.match(CHECKPOINT_SKILL, /Never enter a worktree for this/);
    assert.match(CHECKPOINT_SKILL, /not committed: this session is confined to its\s+worktree/);
    assert.match(RESUME_SKILL, /Exact filename match \(with or without `\.md`\): take it/);
    assert.match(RESUME_SKILL, /sort every `\.md` in those directories by filesystem mtime descending/);
  });

  it('the main-folder check finds the main folder on any branch and from a linked worktree', () => {
    const repo = makeCheckpointRepo('cah-checkpoint-guard-');
    const linked = mkdtempSync(join(tmpdir(), 'cah-checkpoint-guard-linked-'));
    rmSync(linked, { recursive: true, force: true });
    const guard = (cwd) => spawnSync(BASH, ['-c', GUARD_COMMANDS[0]], { cwd, encoding: 'utf8' });
    const lines = (result) => result.stdout.trim().split(/\r?\n/).filter(Boolean);
    try {
      runGit(repo, ['switch', '-q', '-c', 'feature']);
      const main = guard(join(repo, 'sub'));
      assert.equal(main.status, 0, main.stderr);
      const [top, gitDir, commonDir] = lines(main);
      assert.equal(samePath(top, repo), true);
      assert.equal(gitDir, commonDir, 'the main folder passes on any branch');

      runGit(repo, ['worktree', 'add', '-q', '-b', 'side', linked, 'HEAD']);
      const side = guard(linked);
      assert.equal(side.status, 0, side.stderr);
      const [linkedTop, linkedGitDir, linkedCommonDir] = lines(side);
      assert.equal(samePath(linkedTop, linked), true);
      assert.notEqual(linkedGitDir, linkedCommonDir, 'a linked worktree has its own git dir');
      assert.equal(samePath(dirname(linkedCommonDir), repo), true, 'the main folder is the parent of the common dir');

      const outside = mkdtempSync(join(tmpdir(), 'cah-checkpoint-guard-outside-'));
      try {
        const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) };
        const none = spawnSync('git', GUARD_COMMANDS[0].split(' ').slice(1), { cwd: outside, env, encoding: 'utf8' });
        assert.notEqual(none.status, 0);
        assert.equal(none.stdout.trim(), '');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      try {
        runGit(repo, ['worktree', 'remove', '--force', linked]);
      } catch {
        // The worktree may not have been registered if setup failed.
      }
      rmSync(linked, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
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
