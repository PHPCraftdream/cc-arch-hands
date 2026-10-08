import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { OmpAgents, SentinelOmpAgent } from '../lib/omp-scope.js';
import { OMP_AGENT_TAGS_BEGIN, OMP_AGENT_TAGS_END } from '../lib/omp-instructions.js';

const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));
function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-omp-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function call(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
  });
}
function ok(home, ...args) {
  const result = call(home, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function rows(home, ...args) {
  return ok(home, 'list', '--json', ...args).stdout.trim().split('\n').map(JSON.parse);
}

describe('OMP installer', () => {
  it('registers all Ultra agents even when OMP is unavailable', (t) => {
    const home = sandbox(t);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      ok(home, 'install', '--omp-agents');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    for (const name of ['us', 'us1', 'us2', 'ut', 'ua']) {
      assert.match(readFileSync(join(home, '.omp', 'agent', 'agents', `${name}.md`), 'utf8'),
        /^thinking-level: ultra$/m);
    }
  });

  it('installs, updates, reinstalls and removes only managed definitions and rule bytes', (t) => {
    const home = sandbox(t);
    const root = join(home, '.omp', 'agent');
    mkdirSync(root, { recursive: true });
    const rule = join(root, 'APPEND_SYSTEM.md');
    const original = Buffer.from('# Personal rules\r\nПравило пользователя.\r\n');
    writeFileSync(rule, original);
    ok(home, 'install', '--omp-agents');
    for (const agent of OmpAgents) {
      const content = readFileSync(join(root, 'agents', `${agent.name}.md`), 'utf8');
      assert.match(content, new RegExp(`model: openai-codex/${agent.model}\\n`));
      assert.match(content, new RegExp(`thinking-level: ${agent.effort}\\n`));
    }
    for (const name of ['us', 'us1', 'us2', 'ut', 'ua']) {
      assert.match(readFileSync(join(root, 'agents', `${name}.md`), 'utf8'), /^thinking-level: ultra$/m);
    }
    assert.equal(existsSync(join(home, '.claude')), false);
    const hs = join(root, 'agents', 'hs.md');
    writeFileSync(hs, `${SentinelOmpAgent}\nold model\n`);
    ok(home, 'install', '--only', 'omp-agents');
    assert.match(readFileSync(hs, 'utf8'), /model: openai-codex\/gpt-6\.1-sol/);
    const foreign = join(root, 'agents', 'custom.md');
    writeFileSync(foreign, 'personal agent');
    const orphan = join(root, 'agents', 'obsolete.md');
    writeFileSync(orphan, `${SentinelOmpAgent}\nobsolete`);
    ok(home, 'reinstall', '--omp-agents');
    assert.equal(existsSync(orphan), false);
    assert.equal(readFileSync(foreign, 'utf8'), 'personal agent');
    const installedRule = readFileSync(rule);
    assert.deepEqual(installedRule.subarray(0, original.length), original);
    assert.equal(rows(home).find((r) => r.kind === 'omp-instructions').state, 'mine');
    ok(home, 'uninstall', '--omp-agents');
    assert.equal(existsSync(hs), false);
    assert.equal(readFileSync(foreign, 'utf8'), 'personal agent');
    assert.deepEqual(readFileSync(rule), original);
  });

  it('preserves foreign same-name agents through every lifecycle operation', (t) => {
    const home = sandbox(t);
    const dir = join(home, '.omp', 'agent', 'agents');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'hs.md');
    writeFileSync(path, 'foreign hs');
    for (const command of ['install', 'reinstall', 'uninstall']) {
      ok(home, command, '--omp-agents');
      assert.equal(readFileSync(path, 'utf8'), 'foreign hs');
    }
  });

  it('rejects malformed rule markers before reinstall removes agents', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--omp-agents');
    const root = join(home, '.omp', 'agent');
    const rule = join(root, 'APPEND_SYSTEM.md');
    const hs = readFileSync(join(root, 'agents', 'hs.md'));
    for (const body of [OMP_AGENT_TAGS_BEGIN, `${OMP_AGENT_TAGS_BEGIN}\n${OMP_AGENT_TAGS_BEGIN}\n${OMP_AGENT_TAGS_END}`]) {
      writeFileSync(rule, body);
      assert.equal(call(home, 'reinstall', '--omp-agents').status, 1);
      assert.equal(readFileSync(rule, 'utf8'), body);
      assert.deepEqual(readFileSync(join(root, 'agents', 'hs.md')), hs);
    }
  });

  it('isolates named profiles and ignores Claude project scope for OMP targets', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(project);
    ok(home, 'install', '--omp-agents', '--omp-profile', 'work', '--cwd', project);
    const root = join(home, '.omp', 'profiles', 'work', 'agent');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), true);
    assert.equal(existsSync(join(home, '.omp', 'agent')), false);
    assert.equal(existsSync(join(project, '.omp')), false);
    assert.equal(rows(home, '--omp-profile', 'work').find((r) => r.kind === 'omp-agent' && r.name === 'hs').state, 'mine');
    ok(home, 'uninstall', '--omp-agents', '--omp-profile', 'work');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), false);
    for (const profile of ['../escape', 'CON', 'work/path']) {
      assert.notEqual(call(home, 'install', '--omp-agents', '--omp-profile', profile).status, 0);
    }
  });

  it('counts missing OMP rule and foreign agents only when the class is present', (t) => {
    const home = sandbox(t);
    const baseline = call(home, 'doctor');
    assert.equal(baseline.status, 1);
    const missing = Number(baseline.stdout.match(/missing: (\d+)/)[1]);
    ok(home, 'install', '--omp-agents');
    assert.equal(Number(call(home, 'doctor').stdout.match(/missing: (\d+)/)[1]), missing);
    writeFileSync(join(home, '.omp', 'agent', 'APPEND_SYSTEM.md'), '# Personal only\n');
    assert.equal(Number(call(home, 'doctor').stdout.match(/missing: (\d+)/)[1]), missing + 1);
    writeFileSync(join(home, '.omp', 'agent', 'agents', 'hs.md'), 'foreign');
    assert.equal(call(home, 'doctor').status, 2);
  });
  it('manages all OMP artifacts through --omp without installing Claude defaults', (t) => {
    const home = sandbox(t);
    const root = join(home, '.omp', 'agent');
    ok(home, 'install', '--omp');
    assert.equal(existsSync(join(home, '.claude')), false);
    assert.equal(existsSync(join(home, '.codex')), false);
    const hs = join(root, 'agents', 'hs.md');
    const checkpoint = join(root, 'commands', 'checkpoint.md');
    const agent = readFileSync(hs);
    const command = readFileSync(checkpoint);
    writeFileSync(hs, `${SentinelOmpAgent}\nold generation`);
    writeFileSync(checkpoint, '<!-- cah-omp-command:v1 -->\nold generation');
    ok(home, 'reinstall', '--omp');
    assert.deepEqual(readFileSync(hs), agent);
    assert.deepEqual(readFileSync(checkpoint), command);
    assert.equal(rows(home).find((r) => r.kind === 'omp-command' && r.name === 'checkpoint').state, 'mine');
    assert.equal(existsSync(join(root, 'extensions', 'cah-babysit.js')), true);
    ok(home, 'uninstall', '--omp');
    assert.equal(existsSync(hs), false);
    assert.equal(existsSync(checkpoint), false);
    assert.equal(existsSync(join(root, 'extensions', 'cah-babysit.js')), false);
    assert.equal(existsSync(join(root, 'cah', 'commit-checkpoint.mjs')), false);
    assert.equal(rows(home).find((r) => r.kind === 'omp-instructions').state, 'missing');
  });

  it('adds --omp to --only and isolates the selected named profile', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--only', 'commands', '--omp', '--omp-profile', 'work');
    const root = join(home, '.omp', 'profiles', 'work', 'agent');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), true);
    assert.equal(existsSync(join(root, 'commands', 'checkpoint.md')), true);
    assert.equal(existsSync(join(home, '.omp', 'agent')), false);
    assert.equal(existsSync(join(home, '.claude', 'commands', 'oh.md')), true);
    assert.equal(existsSync(join(home, '.claude', 'skills')), false);
    ok(home, 'uninstall', '--omp', '--omp-profile', 'work');
    assert.equal(existsSync(join(root, 'agents', 'hs.md')), false);
    assert.equal(existsSync(join(root, 'commands', 'checkpoint.md')), false);
    assert.equal(existsSync(join(home, '.claude', 'commands', 'oh.md')), true);
  });
});
