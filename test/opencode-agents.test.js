import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { AllCodexAgents } from '../lib/manifest.js';
import { SentinelOpencodeAgent } from '../lib/opencode-agents.js';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const cli = join(worktree, 'bin', 'cah.js');

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-opencode-agents-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function call(home, ...rest) {
  const env = rest.length > 0 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])
    ? rest.shift() : {};
  return spawnSync(process.execPath, [cli, ...rest], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
  });
}

function ok(home, ...args) {
  const result = call(home, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

describe('OpenCode agent installer', () => {
  it('writes all 39 agents with openai models, literal efforts, no variant key', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-agents');
    const dir = join(home, '.config', 'opencode', 'agents');
    assert.equal(readdirSync(dir).length, AllCodexAgents.length);
    for (const agent of AllCodexAgents) {
      const content = readFileSync(join(dir, `${agent.name}.md`), 'utf8');
      assert.match(content, /^---\nname: (\S+)\n/m);
      assert.match(content, new RegExp(`^name: ${agent.name}$`, 'm'));
      assert.match(content, new RegExp(`^model: openai/${agent.model.replace(/\./g, '\\.')}$`, 'm'));
      assert.match(content, new RegExp(`^  reasoningEffort: ${agent.effort}$`, 'm'));
      assert.doesNotMatch(content, /^variant:/m);
      assert.match(content, /^mode: subagent$/m);
      assert.ok(content.includes(SentinelOpencodeAgent), `sentinel in ${agent.name}`);
    }
    for (const name of ['us', 'us2', 'ut', 'ul1']) {
      assert.match(readFileSync(join(dir, `${name}.md`), 'utf8'), /^  reasoningEffort: ultra$/m);
    }
    assert.match(readFileSync(join(dir, 'xxa.md'), 'utf8'), /openai\/gpt-6-astra/);
  });

  it('works without OpenCode installed, without a provider or model', (t) => {
    const home = sandbox(t);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      ok(home, 'install', '--opencode-agents');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(existsSync(join(home, '.config', 'opencode', 'agents', 'hs.md')), true);
  });

  it('updates owned definitions, prunes owned orphans and skips foreign agents', (t) => {
    const home = sandbox(t);
    const dir = join(home, '.config', 'opencode', 'agents');
    mkdirSync(dir, { recursive: true });
    const foreign = join(dir, 'custom.md');
    writeFileSync(foreign, 'personal agent');
    const orphan = join(dir, 'obsolete.md');
    writeFileSync(orphan, `${SentinelOpencodeAgent}\nobsolete`);
    ok(home, 'install', '--opencode-agents');
    assert.equal(readFileSync(foreign, 'utf8'), 'personal agent');
    assert.equal(existsSync(orphan), false);
    const hs = join(dir, 'hs.md');
    writeFileSync(hs, `${SentinelOpencodeAgent}\nold generation`);
    ok(home, 'reinstall', '--opencode-agents');
    assert.match(readFileSync(hs, 'utf8'), /model: openai\/gpt-6\.1-sol/);
    assert.equal(readFileSync(foreign, 'utf8'), 'personal agent');
    ok(home, 'uninstall', '--opencode-agents');
    assert.equal(existsSync(hs), false);
    assert.equal(readFileSync(foreign, 'utf8'), 'personal agent');
  });

  it('preserves a foreign same-name agent through every lifecycle operation', (t) => {
    const home = sandbox(t);
    const dir = join(home, '.config', 'opencode', 'agents');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'hs.md');
    writeFileSync(path, 'foreign hs');
    for (const command of ['install', 'reinstall', 'uninstall']) {
      ok(home, command, '--opencode-agents');
      assert.equal(readFileSync(path, 'utf8'), 'foreign hs');
    }
  });

  it('reports each agent in list --json --opencode', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-agents');
    const rows = ok(home, 'list', '--json', '--opencode').stdout.trim()
      .split('\n').map(JSON.parse);
    for (const agent of AllCodexAgents) {
      const row = rows.find((r) => r.kind === 'opencode-agent' && r.name === agent.name);
      assert.equal(row.state, 'mine', agent.name);
    }
  });
});
