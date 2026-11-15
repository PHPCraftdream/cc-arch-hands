import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENCODE_ENV, cliCaller, tempDir } from '../test-support/cli-sandbox.js';
import { withEnv } from '../test-support/env.js';
import { AllCodexAgents } from '../lib/manifest.js';
import { SentinelOpencodeAgent } from '../lib/opencode-agents.js';

const { ok } = cliCaller(OPENCODE_ENV);
const sandbox = (t) => tempDir(t, 'cah-opencode-agents');

describe('OpenCode agent installer', () => {
  it('writes every agent with openai models, literal efforts, no variant key', (t) => {
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
    for (const name of ['us', 'us1', 'us2', 'ut', 'ut1', 'ua']) {
      assert.match(readFileSync(join(dir, `${name}.md`), 'utf8'), /^  reasoningEffort: ultra$/m);
    }
    assert.match(readFileSync(join(dir, 'xxa.md'), 'utf8'), /openai\/gpt-6-astra/);
  });

  it('works without OpenCode installed, without a provider or model', (t) => {
    const home = sandbox(t);
    withEnv({ PATH: '' }, () => ok(home, 'install', '--opencode-agents'));
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
