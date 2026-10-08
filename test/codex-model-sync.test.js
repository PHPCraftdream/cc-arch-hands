import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AllCodexAgents } from '../lib/manifest.js';
import { CodexModelSpecs } from '../lib/codex-model-specs.js';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import {
  codexInstalled, readCodexModels, parseCodexModels, buildSpecs, renderSpecsModule,
  effortDrift, unlistedModels,
} from '../scripts/codex-models.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'sync-codex-models.js');
const ids = Object.keys(CodexModelSpecs);

// A `codex debug models` document that describes the given specs.
function codexDocument(specs, extra = []) {
  const models = Object.entries(specs).map(([slug, spec]) => ({
    slug,
    visibility: 'list',
    context_window: spec.contextWindow,
    max_context_window: spec.maxContextWindow,
    supported_reasoning_levels: spec.efforts.map((effort) => ({ effort, description: effort })),
  }));
  return JSON.stringify({ models: [...models, ...extra] });
}

const clone = (specs) => JSON.parse(JSON.stringify(specs));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-sync-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sync(dir, document, ...args) {
  const from = join(dir, 'models.json');
  writeFileSync(from, document);
  return spawnSync(process.execPath, [script, '--from', from, '--out', join(dir, 'specs.js'), ...args], {
    encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
  });
}

describe('codex debug models parsing', () => {
  it('extracts slug, windows and efforts in Codex order', () => {
    const [sol] = parseCodexModels(codexDocument({ 'gpt-6-sol': CodexModelSpecs['gpt-6-sol'] }));
    assert.deepEqual(sol, {
      slug: 'gpt-6-sol',
      visibility: 'list',
      contextWindow: 272000,
      maxContextWindow: 872000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
  });

  it('rejects documents without usable windows or efforts', () => {
    const model = { slug: 'x', context_window: 1, max_context_window: 2, supported_reasoning_levels: [{ effort: 'low' }] };
    assert.throws(() => parseCodexModels('{}'), /no "models" array/);
    assert.throws(() => parseCodexModels(JSON.stringify({ models: [{ ...model, slug: '' }] })), /without slug/);
    assert.throws(() => parseCodexModels(JSON.stringify({ models: [{ ...model, context_window: 0 }] })), /x has no valid context_window/);
    assert.throws(() => parseCodexModels(JSON.stringify({ models: [{ ...model, supported_reasoning_levels: [] }] })), /x has no supported_reasoning_levels/);
  });
});

describe('spec building and rendering', () => {
  const codexModels = parseCodexModels(codexDocument(CodexModelSpecs, [
    { slug: 'gpt-hidden', visibility: 'hide', context_window: 5, max_context_window: 6, supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-new', visibility: 'list', context_window: 5, max_context_window: 6, supported_reasoning_levels: [{ effort: 'low' }] },
  ]));

  it('builds specs only for the requested ids, in that order', () => {
    assert.deepEqual(buildSpecs(codexModels, [...ids].reverse()), clone(Object.fromEntries([...ids].reverse().map((id) => [id, CodexModelSpecs[id]]))));
    assert.deepEqual(Object.keys(buildSpecs(codexModels, ids)), ids);
  });

  it('fails when Codex does not list a manifest model', () => {
    assert.throws(() => buildSpecs(codexModels, ['gpt-gone']), /model "gpt-gone" is not listed by codex debug models/);
  });

  it('renders a module that imports back to the same specs and is what lib ships', async (t) => {
    const dir = sandbox(t);
    const rendered = renderSpecsModule(buildSpecs(codexModels, ids));
    assert.equal(rendered, readFileSync(join(root, 'lib', 'codex-model-specs.js'), 'utf8'));
    writeFileSync(join(dir, 'specs.mjs'), rendered);
    const loaded = await import(pathToFileURL(join(dir, 'specs.mjs')).href);
    assert.deepEqual(loaded.CodexModelSpecs, CodexModelSpecs);
    assert.equal(Object.isFrozen(loaded.CodexModelSpecs['gpt-6-sol'].efforts), true);
  });

  it('lists visible Codex models the manifest has no agents for', () => {
    assert.deepEqual(unlistedModels(codexModels, ids), ['gpt-new']);
  });

  it('reports efforts a model rejects and accepted efforts without an agent', () => {
    const specs = clone(CodexModelSpecs);
    specs['gpt-5.6-luna'].efforts = ['low', 'medium', 'high', 'xhigh'];
    specs['gpt-6-luna'].efforts.push('ultra');
    assert.deepEqual(effortDrift(AllCodexAgents, specs), {
      unsupported: [{ name: 'xxl1', model: 'gpt-5.6-luna', effort: 'max' }],
      uncovered: [{ model: 'gpt-6-luna', effort: 'ultra' }],
    });
    assert.deepEqual(effortDrift(AllCodexAgents, CodexModelSpecs), { unsupported: [], uncovered: [] });
  });
});

describe('sync-codex-models script', () => {
  it('writes the module and then reports it in sync', (t) => {
    const dir = sandbox(t);
    const first = sync(dir, codexDocument(CodexModelSpecs));
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /specs file updated from codex debug models/);
    assert.equal(readFileSync(join(dir, 'specs.js'), 'utf8'), readFileSync(join(root, 'lib', 'codex-model-specs.js'), 'utf8'));
    const second = sync(dir, codexDocument(CodexModelSpecs), '--check');
    assert.equal(second.status, 0, second.stderr);
  });

  it('--check fails on a stale module without rewriting it', (t) => {
    const dir = sandbox(t);
    const specs = clone(CodexModelSpecs);
    specs['gpt-6-luna'].contextWindow = 123456;
    writeFileSync(join(dir, 'specs.js'), renderSpecsModule(specs));
    const before = readFileSync(join(dir, 'specs.js'), 'utf8');
    const result = sync(dir, codexDocument(CodexModelSpecs), '--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /differs from codex debug models/);
    assert.equal(readFileSync(join(dir, 'specs.js'), 'utf8'), before);
  });

  it('refreshes windows in place and exits 0 when efforts still match', (t) => {
    const dir = sandbox(t);
    const specs = clone(CodexModelSpecs);
    specs['gpt-6-luna'].contextWindow = 300000;
    const result = sync(dir, codexDocument(specs));
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(dir, 'specs.js'), 'utf8'), /'gpt-6-luna': spec\(300000, 872000,/);
  });

  it('exits 1 and names the agent when Codex rejects an effort the manifest uses', (t) => {
    const dir = sandbox(t);
    const specs = clone(CodexModelSpecs);
    specs['gpt-6-sol'].efforts = specs['gpt-6-sol'].efforts.filter((effort) => effort !== 'ultra');
    const result = sync(dir, codexDocument(specs));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent us1 uses effort ultra, which gpt-6-sol does not accept/);
  });

  it('exits 1 and names the model when Codex accepts an effort no agent covers', (t) => {
    const dir = sandbox(t);
    const specs = clone(CodexModelSpecs);
    specs['gpt-5.6-luna'].efforts.push('ultra');
    const result = sync(dir, codexDocument(specs));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gpt-5\.6-luna accepts effort ultra but has no agent/);
  });

  it('exits 1 when Codex no longer lists a manifest model', (t) => {
    const dir = sandbox(t);
    const specs = clone(CodexModelSpecs);
    delete specs['gpt-6-astra'];
    const result = sync(dir, codexDocument(specs));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /model "gpt-6-astra" is not listed by codex debug models/);
  });
});

describe('manifest against the installed Codex', () => {
  it('matches codex debug models (skipped when Codex is not installed)', { timeout: 300_000 }, (t) => {
    if (!codexInstalled()) {
      t.skip('codex is not installed');
      return;
    }
    const live = buildSpecs(readCodexModels(), ids);
    assert.deepEqual(clone(CodexModelSpecs), clone(live),
      'lib/codex-model-specs.js is stale — run `npm run sync:codex`');
    assert.deepEqual(effortDrift(AllCodexAgents, live), { unsupported: [], uncovered: [] });
  });
});
