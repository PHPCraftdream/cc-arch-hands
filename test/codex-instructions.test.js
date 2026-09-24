import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from '../lib/scope.js';
import {
  CODEX_CLI_RUN_BEGIN, CODEX_CLI_RUN_END,
  inspectCodexInstructions, writeCodexInstructions, removeCodexInstructions,
} from '../lib/codex-instructions.js';

const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-codex-instructions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function call(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8', timeout: 30_000,
  });
}

function missingCount(home) {
  const doctor = call(home, 'doctor');
  assert.equal(doctor.status, 1, doctor.stderr);
  const match = doctor.stdout.match(/missing: (\d+)/);
  assert.ok(match, doctor.stdout);
  return Number(match[1]);
}

describe('managed Codex AGENTS.md section', () => {
  it('restores the original bytes after install and removal', (t) => {
    const dir = sandbox(t);
    const codexDir = join(dir, '.codex');
    mkdirSync(codexDir);
    const path = join(codexDir, 'AGENTS.md');
    const original = Buffer.from('# My rules\r\n\r\n- Пользовательский текст\r\n', 'utf8');
    writeFileSync(path, original);
    const scope = new Scope({ cwd: dir });
    assert.equal(writeCodexInstructions(scope).written, 1);
    const installed = readFileSync(path, 'utf8');
    assert.ok(installed.includes(CODEX_CLI_RUN_BEGIN));
    assert.ok(installed.includes('Start every CLI command'));
    assert.equal(writeCodexInstructions(scope).written, 0);
    assert.equal(removeCodexInstructions(scope).removed, 1);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(removeCodexInstructions(scope).removed, 0);
  });

  it('refreshes only its own block and preserves later user text', (t) => {
    const dir = sandbox(t);
    const scope = new Scope({ cwd: dir });
    writeCodexInstructions(scope);
    const path = join(dir, '.codex', 'AGENTS.md');
    const modified = readFileSync(path, 'utf8').replace('Start every CLI command', 'Old wording every CLI command');
    writeFileSync(path, `${modified}\n## User appendix\nKeep me.\n`);
    assert.equal(writeCodexInstructions(scope).written, 1);
    const refreshed = readFileSync(path, 'utf8');
    assert.equal(refreshed.split(CODEX_CLI_RUN_BEGIN).length - 1, 1);
    assert.ok(refreshed.includes('Start every CLI command'));
    assert.ok(refreshed.endsWith('\n## User appendix\nKeep me.\n'));
    removeCodexInstructions(scope);
    assert.ok(readFileSync(path, 'utf8').includes('## User appendix\nKeep me.'));
  });

  it('rejects broken or duplicate markers without changing the file', (t) => {
    const dir = sandbox(t);
    const codexDir = join(dir, '.codex');
    mkdirSync(codexDir);
    const path = join(codexDir, 'AGENTS.md');
    const scope = new Scope({ cwd: dir });
    for (const body of [CODEX_CLI_RUN_BEGIN, `${CODEX_CLI_RUN_BEGIN}\n${CODEX_CLI_RUN_BEGIN}\n${CODEX_CLI_RUN_END}`]) {
      writeFileSync(path, body);
      assert.throws(() => inspectCodexInstructions(scope), /incomplete or duplicate/);
      assert.throws(() => writeCodexInstructions(scope), /incomplete or duplicate/);
      assert.equal(readFileSync(path, 'utf8'), body);
    }
  });

  it('updates global AGENTS.md with install/reinstall/uninstall', (t) => {
    const home = sandbox(t);
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir);
    const path = join(codexDir, 'AGENTS.md');
    const original = '# Personal guidance\nDo not change this line.\n';
    writeFileSync(path, original);
    assert.equal(call(home, 'install', '--codex-skills').status, 0);
    assert.ok(readFileSync(path, 'utf8').includes(CODEX_CLI_RUN_BEGIN));
    writeFileSync(path, readFileSync(path, 'utf8').replace('Start every CLI command', 'Old wording every CLI command'));
    assert.equal(call(home, 'reinstall', '--codex-skills').status, 0);
    const refreshed = readFileSync(path, 'utf8');
    assert.ok(refreshed.includes('Start every CLI command'));
    assert.ok(refreshed.startsWith(original));
    const listed = call(home, 'list', '--json');
    assert.equal(listed.status, 0);
    const instructionRow = listed.stdout.trim().split('\n').map((line) => JSON.parse(line))
      .find((entry) => entry.kind === 'codex-instructions');
    assert.deepEqual(instructionRow, { name: 'AGENTS.md', kind: 'codex-instructions', state: 'mine' });
    const baselineMissing = missingCount(home);
    writeFileSync(path, original);
    assert.equal(missingCount(home), baselineMissing + 1);
    assert.equal(call(home, 'install', '--codex-skills').status, 0);
    assert.equal(missingCount(home), baselineMissing);
    assert.equal(call(home, 'uninstall', '--codex-skills').status, 0);
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('manages the same global section for local skill selections', (t) => {
    const home = sandbox(t);
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir);
    const path = join(codexDir, 'AGENTS.md');
    const original = '# Keep this global rule\n';
    writeFileSync(path, original);
    const project = join(home, 'project');
    mkdirSync(project);
    assert.equal(call(home, 'install', '--codex-skills', '--cwd', project).status, 0);
    assert.ok(readFileSync(path, 'utf8').includes(CODEX_CLI_RUN_BEGIN));
    assert.ok(!existsSync(join(project, '.codex', 'AGENTS.md')));
    assert.equal(call(home, 'reinstall', '--codex-skills', '--cwd', project).status, 0);
    assert.equal(readFileSync(path, 'utf8').split(CODEX_CLI_RUN_BEGIN).length - 1, 1);
    assert.equal(call(home, 'uninstall', '--codex-skills', '--cwd', project).status, 0);
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('preflights malformed markers and an active global override before installing skills', (t) => {
    const home = sandbox(t);
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir);
    const path = join(codexDir, 'AGENTS.md');
    writeFileSync(path, CODEX_CLI_RUN_BEGIN);
    assert.equal(call(home, 'install', '--codex-skills').status, 1);
    assert.ok(!existsSync(join(codexDir, 'skills', 'cli-run')));
    assert.equal(readFileSync(path, 'utf8'), CODEX_CLI_RUN_BEGIN);

    writeFileSync(path, '# Personal guidance\n');
    writeFileSync(join(codexDir, 'AGENTS.override.md'), '# Active override\n');
    const blocked = call(home, 'install', '--codex-skills');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /AGENTS\.override\.md masks/);
    assert.ok(!existsSync(join(codexDir, 'skills', 'cli-run')));
  });
});
