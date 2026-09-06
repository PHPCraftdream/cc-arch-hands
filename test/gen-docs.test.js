import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllModelCommands, AllCodexAgents } from '../lib/manifest.js';
import { BinFiles } from '../lib/binstall.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'gen-docs.js');
const README = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
const CLAUDE = readFileSync(join(__dirname, '..', 'CLAUDE.md'), 'utf8');

const EXPECTED_RUNTIME_BINS = [
  'bin/cah-checkpoint-hint.js',
  'bin/cah-stamp.js',
  'bin/cah-status-probe.js',
  'bin/cah-status.js',
];
const EXPECTED_SHARED_LIB_LEAVES = [
  'lib/fs-atomic.js',
  'lib/fsutil.js',
  'lib/lease-lock.js',
  'lib/marker-state.js',
  'lib/sentinel.js',
  'lib/transcript-stats.js',
  'lib/update-check.js',
];
const EXPECTED_PUBLICATION_ORDER = [
  'package.json',
  'lib/sentinel.js',
  'lib/fs-atomic.js',
  'lib/fsutil.js',
  'lib/lease-lock.js',
  'lib/marker-state.js',
  'lib/transcript-stats.js',
  'lib/update-check.js',
  'bin/cah-checkpoint-hint.js',
  'bin/cah-status.js',
  'bin/cah-stamp.js',
  'bin/cah-status-probe.js',
];

function sorted(values) {
  return [...values].sort();
}

describe('gen-docs --check', () => {
  it('README.md is in sync with lib/manifest.js', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    assert.equal(
      res.status,
      0,
      `README.md is out of sync with lib/manifest.js — run \`npm run gen:docs\`.\n${res.stdout}${res.stderr}`,
    );
  });

  it('keeps the current narrative counts tied to the fixed registry oracle', () => {
    assert.equal(AllModelCommands.length, 44);
    assert.equal(AllModelCommands.length * 2, 88);
    assert.equal(AllCodexAgents.length, 24);

    assert.match(README, /<!--gen:count:model-commands-->44<!--\/gen-->/);
    assert.match(README, /<!--gen:count:model-bodies-->88<!--\/gen--> command\+agent bodies/);
    assert.match(README, /<!--gen:count:codex-agents-->24<!--\/gen-->/);
    assert.match(CLAUDE, /44 current Claude model definitions[\s\S]*88 installed bodies total/);
    assert.match(CLAUDE, /current `AllCodexAgents` registry contains 24 optional Codex agents/);

    for (const stale of [
      'three companion',
      'All three hook bins',
      '35 per-model',
      '70 nearly-identical',
    ]) {
      assert.doesNotMatch(`${README}\n${CLAUDE}`, new RegExp(stale, 'i'));
    }
  });

  it('documents the complete installed companion runtime closure', () => {
    const runtimeBins = sorted(
      BinFiles.filter((file) => file.dest.startsWith('bin/')).map((file) => file.dest),
    );
    const sharedLibLeaves = sorted(
      BinFiles.filter((file) => file.dest.startsWith('lib/')).map((file) => file.dest),
    );

    assert.deepEqual(runtimeBins, EXPECTED_RUNTIME_BINS);
    assert.deepEqual(sharedLibLeaves, EXPECTED_SHARED_LIB_LEAVES);
    assert.equal(runtimeBins.length, 4);

    for (const leaf of [...EXPECTED_RUNTIME_BINS, ...EXPECTED_SHARED_LIB_LEAVES]) {
      assert.ok(README.includes(leaf) || README.includes(leaf.slice(leaf.indexOf('/') + 1)),
        `README.md must name installed runtime leaf ${leaf}`);
      assert.ok(CLAUDE.includes(leaf) || CLAUDE.includes(leaf.slice(leaf.indexOf('/') + 1)),
        `CLAUDE.md must name installed runtime leaf ${leaf}`);
    }
  });

  it('keeps companion publication dependency-first', () => {
    assert.deepEqual(
      BinFiles.map((file) => file.dest),
      EXPECTED_PUBLICATION_ORDER,
    );
    assert.match(
      README,
      /package\.json[\s\S]*sentinel\.js[\s\S]*fs-atomic\.js[\s\S]*fsutil\.js[\s\S]*lease-lock\.js[\s\S]*marker-state\.js[\s\S]*transcript-stats\.js[\s\S]*update-check\.js[\s\S]*executable leaves/,
      'README.md must describe the dependency-first runtime closure',
    );
  });

  it('defines exactly six collision-free Astra Codex agents', () => {
    assert.equal(AllCodexAgents.length, 24);
    const astra = AllCodexAgents.filter((agent) => agent.model === 'gpt-6-astra');
    assert.deepEqual(
      astra,
      [
        { name: 'la', model: 'gpt-6-astra', effort: 'low', display: 'Astra - low' },
        { name: 'ma', model: 'gpt-6-astra', effort: 'medium', display: 'Astra - medium' },
        { name: 'ha', model: 'gpt-6-astra', effort: 'high', display: 'Astra - high' },
        { name: 'xa', model: 'gpt-6-astra', effort: 'extra', display: 'Astra - extra' },
        { name: 'xxa', model: 'gpt-6-astra', effort: 'max', display: 'Astra - max' },
        { name: 'ua', model: 'gpt-6-astra', effort: 'ultra', display: 'Astra - ultra' },
      ],
    );

    const names = AllCodexAgents.map((agent) => agent.name);
    assert.equal(new Set(names).size, names.length, 'Codex agent aliases must be unique');

    const familyCounts = new Map();
    for (const agent of AllCodexAgents) {
      familyCounts.set(agent.model, (familyCounts.get(agent.model) ?? 0) + 1);
    }
    assert.deepEqual([...familyCounts.entries()], [
      ['gpt-5.6-terra', 6],
      ['gpt-5.6-luna', 6],
      ['gpt-5.6-sol', 6],
      ['gpt-6-astra', 6],
    ]);
  });
});
