import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import {
  OPENCODE_AGENT_TAGS_BEGIN, OPENCODE_AGENT_TAGS_END,
} from '../lib/opencode-instructions.js';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const cli = join(worktree, 'bin', 'cah.js');

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-opencode-instructions-'));
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

describe('OpenCode instructions', () => {
  it('appends the marked section to a foreign global AGENTS.md preserving bytes', (t) => {
    const home = sandbox(t);
    const root = join(home, '.config', 'opencode');
    mkdirSync(root, { recursive: true });
    const path = join(root, 'AGENTS.md');
    const original = Buffer.from('# My rules\r\nНе удаляй мои правила.\r\n');
    writeFileSync(path, original);
    ok(home, 'install', '--opencode-agents');
    const installed = readFileSync(path);
    assert.deepEqual(installed.subarray(0, original.length), original);
    assert.ok(installed.includes(Buffer.from(OPENCODE_AGENT_TAGS_BEGIN)));
    assert.ok(installed.includes(Buffer.from(OPENCODE_AGENT_TAGS_END)));
    ok(home, 'uninstall', '--opencode-agents');
    assert.deepEqual(readFileSync(path), original);
  });

  it('replaces an existing managed section in place', (t) => {
    const home = sandbox(t);
    const root = join(home, '.config', 'opencode');
    mkdirSync(root, { recursive: true });
    const path = join(root, 'AGENTS.md');
    writeFileSync(path, Buffer.from('prefix\n'));
    ok(home, 'install', '--opencode-agents');
    const withSection = readFileSync(path, 'utf8');
    ok(home, 'install', '--opencode-agents');
    assert.equal(readFileSync(path, 'utf8'), withSection);
  });

  it('preserves foreign separators around an existing section and newly appended user suffix', (t) => {
    const home = sandbox(t);
    const root = join(home, '.config', 'opencode');
    mkdirSync(root, { recursive: true });
    const path = join(root, 'AGENTS.md');
    const prefix = Buffer.from('foreign prefix\n\n');
    const suffix = Buffer.from('\n\nforeign suffix\r\n');
    writeFileSync(path, Buffer.concat([prefix, Buffer.from(`${OPENCODE_AGENT_TAGS_BEGIN}\nold\n${OPENCODE_AGENT_TAGS_END}`), suffix]));
    ok(home, 'install', '--opencode-agents');
    ok(home, 'uninstall', '--opencode-agents');
    assert.deepEqual(readFileSync(path), Buffer.concat([prefix, suffix]));
    writeFileSync(path, prefix);
    ok(home, 'install', '--opencode-agents');
    writeFileSync(path, Buffer.concat([readFileSync(path), suffix]));
    ok(home, 'uninstall', '--opencode-agents');
    assert.deepEqual(readFileSync(path), Buffer.concat([prefix, suffix]));
  });

  it('rejects duplicate or mid-line markers without writing', (t) => {
    const home = sandbox(t);
    const root = join(home, '.config', 'opencode');
    mkdirSync(root, { recursive: true });
    const path = join(root, 'AGENTS.md');
    ok(home, 'install', '--opencode-agents');
    for (const body of [
      OPENCODE_AGENT_TAGS_BEGIN,
      `${OPENCODE_AGENT_TAGS_BEGIN}\n${OPENCODE_AGENT_TAGS_BEGIN}\n${OPENCODE_AGENT_TAGS_END}`,
      `x ${OPENCODE_AGENT_TAGS_BEGIN}\n${OPENCODE_AGENT_TAGS_END}`,
      `${OPENCODE_AGENT_TAGS_BEGIN} suffix\n${OPENCODE_AGENT_TAGS_END}`,
      `${OPENCODE_AGENT_TAGS_BEGIN}\nprefix ${OPENCODE_AGENT_TAGS_END}`,
      `${OPENCODE_AGENT_TAGS_BEGIN}\n${OPENCODE_AGENT_TAGS_END}\rforeign`,
    ]) {
      writeFileSync(path, body);
      assert.notEqual(call(home, 'install', '--opencode-agents').status, 0, body);
      assert.equal(readFileSync(path, 'utf8'), body);
      assert.notEqual(call(home, 'uninstall', '--opencode-agents').status, 0, body);
      assert.equal(readFileSync(path, 'utf8'), body);
    }
  });

  it('local install writes the project-root AGENTS.md, not .opencode/AGENTS.md', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(join(project, '.opencode'), { recursive: true });
    ok(home, 'install', '--opencode-agents', '--local', '--cwd', project);
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8').includes(OPENCODE_AGENT_TAGS_BEGIN), true);
    const parsed = ok(home, 'list', '--json', '--opencode', '--local', '--cwd', project)
      .stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(parsed.filter((r) => r.kind === 'opencode-agent' && r.state === 'mine').length, 39);
    // strict-local inspection resolves only .opencode — never Claude dirs
    const doctor = call(home, 'doctor', '--opencode', '--local', '--cwd', project);
    assert.equal(doctor.status, 1, 'commands/skills missing in an agents-only install');
    assert.ok(!existsSync(join(project, '.claude')), 'no hidden .claude guard');
    ok(home, 'uninstall', '--opencode-agents', '--local', '--cwd', project);
    assert.equal(existsSync(join(project, 'AGENTS.md')), false,
      'a project AGENTS.md that only ever held our section is removed with it');
  });

  it('uninstall keeps a pre-existing project AGENTS.md and only strips the section', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(join(project, '.opencode'), { recursive: true });
    const foreign = '# Project rules\n\nBe nice.\n';
    writeFileSync(join(project, 'AGENTS.md'), foreign);
    ok(home, 'install', '--opencode-agents', '--local', '--cwd', project);
    assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').startsWith(foreign));
    ok(home, 'uninstall', '--opencode-agents', '--local', '--cwd', project);
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), foreign);
  });
});
