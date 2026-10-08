import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllModelCommands, AllCodexAgents } from '../lib/manifest.js';
import { CodexModelSpecs } from '../lib/codex-model-specs.js';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'cah.js');
const PACKAGE = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const call = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
});

describe('cah models --json', () => {
  it('prints the whole manifest as one JSON line', () => {
    const result = call('models', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.endsWith('}\n'), true);
    assert.equal(result.stdout.trimEnd().includes('\n'), false, 'single line');
    const doc = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(doc), ['schemaVersion', 'version', 'claude', 'codex']);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.version, PACKAGE.version);
    assert.deepEqual(doc.claude.aliases, JSON.parse(JSON.stringify(AllModelCommands)));
    assert.deepEqual(doc.codex.aliases, JSON.parse(JSON.stringify(AllCodexAgents)));
    assert.deepEqual(doc.codex.models, JSON.parse(JSON.stringify(CodexModelSpecs)));
  });

  it('carries windows and accepted efforts a consumer needs without running the manifest', () => {
    const doc = JSON.parse(call('models', '--json').stdout);
    const byName = (list, name) => list.find((alias) => alias.name === name);
    assert.deepEqual(byName(doc.claude.aliases, 'h1m'), {
      name: 'h1m', model: 'claude-haiku-4-5', effort: 'medium', display: 'Haiku 4.5 (200k) – medium', contextWindow: 200000,
    });
    assert.deepEqual(byName(doc.codex.aliases, 'ua'), {
      name: 'ua', model: 'gpt-6-astra', effort: 'ultra', display: 'Astra - ultra', contextWindow: 272000, maxContextWindow: 872000,
    });
    assert.equal(byName(doc.codex.aliases, 'ul1'), undefined);
    assert.deepEqual(doc.codex.models['gpt-5.6-luna'].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('refuses to run without --json and rejects unknown arguments', () => {
    const bare = call('models');
    assert.equal(bare.status, 2);
    assert.equal(bare.stdout, '');
    assert.match(bare.stderr, /--json is required/);
    const unknown = call('models', '--json', '--bogus');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /cah models: /);
    assert.equal(call('models', '--json', 'extra').status, 2);
  });

  it('is listed in the usage text', () => {
    assert.match(call('help').stdout, /cah models --json/);
  });
});
