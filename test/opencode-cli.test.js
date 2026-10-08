import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const cli = join(worktree, 'bin', 'cah.js');

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-opencode-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function call(home, env = {}, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', HOME: home, USERPROFILE: home, ...env },
    encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
  });
}

function ok(home, env = {}, ...args) {
  const result = call(home, env, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function rows(home, env = {}, ...args) {
  return ok(home, env, 'list', '--json', ...args).stdout.trim()
    .split('\n').filter(Boolean).map(JSON.parse);
}

const OC_ROW_TOTAL = 40 + 1 + 9 + 3 + 9;

describe('OpenCode CLI integration', () => {
  it('--opencode selects all three classes without installing Claude defaults', (t) => {
    const home = sandbox(t);
    ok(home, {}, 'install', '--opencode');
    assert.equal(existsSync(join(home, '.claude')), false);
    assert.equal(existsSync(join(home, '.codex')), false);
    const root = join(home, '.config', 'opencode');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), true);
    assert.equal(existsSync(join(root, 'commands', 'babysit.md')), true);
    assert.equal(existsSync(join(root, 'skills', 'task', 'SKILL.md')), true);
    assert.equal(existsSync(join(root, 'cah-opencode', 'cah-babysit-scheduler.js')), true);
    assert.equal(existsSync(join(root, 'plugins', 'cah-babysit.js')), true);
    // reinstall is byte-stable
    const command = readFileSync(join(root, 'commands', 'babysit.md'));
    ok(home, {}, 'reinstall', '--opencode');
    assert.deepEqual(readFileSync(join(root, 'commands', 'babysit.md')), command);
    ok(home, {}, 'uninstall', '--opencode');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), false);
    assert.equal(existsSync(join(root, 'commands', 'babysit.md')), false);
    assert.equal(existsSync(join(root, 'plugins', 'cah-babysit.js')), false);
  });

  it('migrates the old misplaced plugin location and preserves foreign files', (t) => {
    const home = sandbox(t);
    const root = join(home, '.config', 'opencode');
    ok(home, {}, 'install', '--opencode');
    // simulate a pre-migration install: owned plugin at the old singular path
    const oldPlugin = join(root, 'plugin', 'cah-babysit-plugin.js');
    mkdirSync(join(root, 'plugin'), { recursive: true });
    writeFileSync(oldPlugin, '// cah-opencode-runtime:v1\nold placement\n');
    ok(home, {}, 'reinstall', '--opencode');
    assert.equal(existsSync(oldPlugin), false, 'owned old placement pruned');
    assert.equal(existsSync(join(root, 'plugins', 'cah-babysit.js')), true);
    // a foreign plugin file in the scanned directory is never touched
    const foreign = join(root, 'plugins', 'user-plugin.js');
    writeFileSync(foreign, '// user plugin\n');
    ok(home, {}, 'uninstall', '--opencode');
    assert.equal(readFileSync(foreign, 'utf8'), '// user plugin\n');
  });

  it('individual class flags replace defaults alone and add to --only', (t) => {
    const home = sandbox(t);
    ok(home, {}, 'install', '--opencode-skills');
    assert.equal(existsSync(join(home, '.config', 'opencode', 'skills', 'triage', 'SKILL.md')), true);
    assert.equal(existsSync(join(home, '.config', 'opencode', 'cah-opencode', 'commit-checkpoint.mjs')), true);
    ok(home, {}, 'uninstall', '--opencode-skills', '--opencode-commands');
    assert.equal(existsSync(join(home, '.config', 'opencode', 'skills', 'triage')), false);
    const home2 = sandbox(t);
    ok(home2, {}, 'install', '--only', 'commands', '--opencode-agents');
    assert.equal(existsSync(join(home2, '.claude', 'commands')), true, 'kept --only selection');
    assert.equal(existsSync(join(home2, '.config', 'opencode', 'agents', 'hs.md')), true, 'added flag class');
  });

  it('doctor --opencode checks only OpenCode artefacts with 0/1/2 semantics', (t) => {
    const home = sandbox(t);
    // explicit selection on a fresh machine is NEVER healthy
    const fresh = call(home, {}, 'doctor', '--opencode');
    assert.equal(fresh.status, 1, 'all-missing explicit selection is not healthy');
    assert.equal(Number(fresh.stdout.match(/missing: (\d+)/)[1]), OC_ROW_TOTAL);
    assert.equal(Number(fresh.stdout.match(/out of (\d+)/)[1]), OC_ROW_TOTAL);
    ok(home, {}, 'install', '--opencode');
    const healthy = call(home, {}, 'doctor', '--opencode');
    assert.equal(healthy.status, 0);
    assert.ok(healthy.stdout.includes(join(home, '.config', 'opencode')));
    assert.doesNotMatch(healthy.stdout, /\.claude|\.codex/);
    const scheduler = join(home, '.config', 'opencode', 'cah-opencode', 'cah-babysit-scheduler.js');
    const saved = readFileSync(scheduler);
    rmSync(scheduler);
    assert.equal(call(home, {}, 'doctor', '--opencode').status, 1);
    writeFileSync(scheduler, 'foreign scheduler');
    const blocked = call(home, {}, 'doctor', '--opencode');
    assert.equal(blocked.status, 2);
    assert.match(blocked.stdout, /foreign/);
  });

  it('explicit per-class doctor selections count missing and foreign leaves independently', (t) => {
    for (const [flag, total, rel] of [
      ['--opencode-agents', 41, 'agents/hs.md'],
      ['--opencode-commands', 12, 'commands/task.md'],
      ['--opencode-skills', 9, 'skills/task/SKILL.md'],
    ]) {
      const home = sandbox(t);
      const fresh = call(home, {}, 'doctor', flag);
      assert.equal(fresh.status, 1);
      assert.equal(Number(fresh.stdout.match(/missing: (\d+)/)[1]), total);
      ok(home, {}, 'install', flag);
      assert.equal(call(home, {}, 'doctor', flag).status, 0);
      const path = join(home, '.config', 'opencode', rel);
      rmSync(path); assert.equal(call(home, {}, 'doctor', flag).status, 1);
      writeFileSync(path, 'foreign bytes'); assert.equal(call(home, {}, 'doctor', flag).status, 2);
    }
  });

  it('per-class inspection flags enumerate only their OpenCode groups', (t) => {
    const home = sandbox(t);
    ok(home, {}, 'install', '--opencode');
    assert.equal(rows(home, {}, '--opencode-agents')
      .every((r) => r.kind === 'opencode-agent' || r.kind === 'opencode-instructions'), true);
    assert.equal(rows(home, {}, '--opencode-commands')
      .every((r) => r.kind === 'opencode-command' || r.kind === 'opencode-command-runtime'), true);
    assert.equal(rows(home, {}, '--opencode-skills')
      .every((r) => r.kind === 'opencode-skill'), true);
    assert.equal(rows(home, {}, '--opencode-skills').length, 9);
    // explicit selection counts even when nothing is installed
    const fresh = sandbox(t);
    const skills = rows(fresh, {}, '--opencode-skills');
    assert.equal(skills.filter((r) => r.state === 'missing').length, 9);
  });

  it('bare strict-local inspection tolerates absent OpenCode while retaining both explicit root guards', (t) => {
    const home = sandbox(t);
    const project = join(home, 'claude-only');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const localRows = rows(home, {}, '--local', '--cwd', project);
    const optionalRows = localRows.filter((row) => row.kind.startsWith('opencode'));
    assert.equal(optionalRows.length, OC_ROW_TOTAL);
    assert.ok(optionalRows.every((row) => row.state === 'missing'));
    const defaultRows = localRows.filter((row) => ['command', 'agent', 'skill', 'bin'].includes(row.kind));
    const doctor = call(home, {}, 'doctor', '--local', '--cwd', project);
    assert.equal(doctor.status, 1);
    assert.equal(doctor.stderr, '');
    assert.equal(Number(doctor.stdout.match(/missing: (\d+)/)[1]), defaultRows.length);
    assert.equal(Number(doctor.stdout.match(/out of (\d+)/)[1]), defaultRows.length);
    for (const subcommand of ['list', 'doctor']) {
      const explicit = call(home, {}, subcommand, '--local', '--cwd', project, '--opencode');
      assert.equal(explicit.status, 1);
      assert.match(explicit.stderr, /\.opencode\/ does not exist/);
    }
    assert.equal(existsSync(join(project, '.opencode')), false);
    rmSync(join(project, '.claude'), { recursive: true });
    for (const subcommand of ['list', 'doctor']) {
      const bare = call(home, {}, subcommand, '--local', '--cwd', project);
      assert.equal(bare.status, 1);
      assert.match(bare.stderr, /\.claude\/ does not exist/);
    }
  });

  it('strict --local list/doctor --opencode never resolves Claude directories', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(join(project, '.opencode'), { recursive: true });
    ok(home, {}, 'install', '--opencode-agents', '--local', '--cwd', project);
    const localRows = rows(home, {}, '--local', '--cwd', project, '--opencode');
    assert.equal(localRows.length, OC_ROW_TOTAL);
    assert.equal(localRows.find((r) => r.kind === 'opencode-agent' && r.name === 'hs').state, 'mine');
    const doctor = call(home, {}, 'doctor', '--opencode', '--local', '--cwd', project);
    assert.equal(doctor.status, 1, 'commands/skills missing in agents-only install');
    assert.ok(!existsSync(join(project, '.claude')), 'no hidden .claude guard');
  });

  it('list --opencode --json reports only OpenCode kinds', (t) => {
    const home = sandbox(t);
    ok(home, {}, 'install', '--opencode');
    const all = rows(home, {}, '--opencode');
    assert.equal(all.length, OC_ROW_TOTAL);
    for (const row of all) assert.ok(row.kind.startsWith('opencode'), row.kind);
    assert.equal(all.filter((r) => r.state === 'mine').length, all.length);
  });

  it('honours OPENCODE_CONFIG_DIR and absolute XDG roots with env isolation', (t) => {
    const home = sandbox(t);
    const override = join(home, 'opencode-cfg');
    ok(home, { OPENCODE_CONFIG_DIR: override }, 'install', '--opencode-agents');
    assert.equal(existsSync(join(override, 'agents', 'hs.md')), true);
    assert.equal(existsSync(join(home, '.config', 'opencode')), false);
    const xdg = join(home, 'xdg');
    const home2 = sandbox(t);
    ok(home2, { XDG_CONFIG_HOME: xdg }, 'install', '--opencode-agents');
    assert.equal(existsSync(join(xdg, 'opencode', 'agents', 'hs.md')), true);
    ok(home, { OPENCODE_CONFIG_DIR: override }, 'uninstall', '--opencode-agents');
    assert.equal(existsSync(join(override, 'agents', 'hs.md')), false);
  });

  it('ignores a relative XDG_CONFIG_HOME (xdg-basedir semantics)', (t) => {
    const home = sandbox(t);
    ok(home, { XDG_CONFIG_HOME: 'relative/xdg' }, 'install', '--opencode-agents');
    assert.equal(existsSync(join(home, 'relative', 'xdg', 'opencode')), false);
    assert.equal(existsSync(join(home, '.config', 'opencode', 'agents', 'hs.md')), true);
  });

  it('strict --local refuses a missing .opencode for OpenCode-only selectors without a .claude guard', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(project, { recursive: true });
    const refused = call(home, {}, 'install', '--opencode-agents', '--local', '--cwd', project);
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(join(project, '.claude')), false);
    mkdirSync(join(project, '.opencode'));
    ok(home, {}, 'install', '--opencode-agents', '--local', '--cwd', project);
    assert.equal(existsSync(join(project, '.opencode', 'agents', 'hs.md')), true);
  });

  it('an OpenCode-only local install describes the OpenCode scope and says where the rule goes', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(project, { recursive: true });
    const out = ok(home, {}, 'install', '--opencode', '--cwd', project).stdout;
    assert.match(out, /^installing into local \(.*\.opencode\/\) from /m);
    assert.doesNotMatch(out, /\.claude|\.codex/);
    assert.doesNotMatch(out, /config root via/, 'a project-local target has no config-root source');
    assert.ok(out.includes(`notice: the agent-tag rule is written to ${join(project, 'AGENTS.md')}`), out);
    const global = ok(home, { XDG_CONFIG_HOME: join(home, 'xdg') }, 'install', '--opencode-agents').stdout;
    assert.match(global, /config root via XDG_CONFIG_HOME/);
    assert.ok(global.includes(join(home, 'xdg', 'opencode', 'AGENTS.md')), global);
    const mixed = ok(home, {}, 'install', '--only', 'commands', '--opencode-agents', '--cwd', project).stdout;
    assert.match(mixed, /^installing into local \(.*\.claude\//m, 'mixed selections keep the Claude header');
  });

  it('publishes the runtime before the skills that need it and removes it last', (t) => {
    const home = sandbox(t);
    const installed = ok(home, {}, 'install', '--opencode').stdout;
    assert.ok(installed.indexOf('opencode-commands:') < installed.indexOf('opencode-skills:'), installed);
    const removed = ok(home, {}, 'uninstall', '--opencode').stdout;
    assert.ok(removed.indexOf('opencode-skills:') < removed.indexOf('opencode-commands:'), removed);
  });

  it('reports version counts for the OpenCode classes', (t) => {
    const home = sandbox(t);
    const version = ok(home, {}, 'version').stdout;
    assert.match(version, /opencode-agents=40/);
    assert.match(version, /opencode-skills=9/);
    assert.match(version, /opencode-commands=9/);
  });

  it('reinstall fails loudly for a bad --templates tree before deleting anything', (t) => {
    const home = sandbox(t);
    ok(home, {}, 'install', '--opencode');
    const command = join(home, '.config', 'opencode', 'commands', 'task.md');
    const installed = readFileSync(command);
    const templates = join(home, 'bad-templates');
    mkdirSync(templates);
    assert.equal(call(home, {}, 'reinstall', '--opencode', '--templates', templates).status, 1);
    assert.deepEqual(readFileSync(command), installed);
  });
});
