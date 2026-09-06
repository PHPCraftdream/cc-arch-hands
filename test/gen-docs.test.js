import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllModelCommands, AllCodexAgents } from '../lib/manifest.js';
import {
  BinFiles, deriveBinFilePublicationOrder, getBinFileImportGraph, validateBinFileOrder,
} from '../lib/binstall.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'gen-docs.js');
const README = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
const CHANGELOG = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const CLAUDE = readFileSync(join(__dirname, '..', 'CLAUDE.md'), 'utf8');

const EXPECTED_RUNTIME_BINS = [
  'bin/cah-checkpoint-hint.js',
  'bin/cah-stamp.js',
  'bin/cah-status-probe.js',
  'bin/cah-status.js',
];
const EXPECTED_SHARED_LIB_LEAVES = [
  'lib/fs-atomic-identity.js',
  'lib/fs-atomic-publication.js',
  'lib/fs-atomic.js',
  'lib/fsutil.js',
  'lib/lease-lock.js',
  'lib/marker-capacity-stage.js',
  'lib/marker-state.js',
  'lib/sentinel.js',
  'lib/transcript-stats.js',
  'lib/update-check.js',
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

    const installSectionStart = CLAUDE.indexOf('companion runtime bins and their shared library leaves');
    const installSectionEnd = CLAUDE.indexOf('`~/.claude/cah-bin/`', installSectionStart);
    const documentedSharedLibLeaves = [...CLAUDE
      .slice(installSectionStart, installSectionEnd)
      .matchAll(/`(lib\/[^`]+\.js)`/g)]
      .map((match) => match[1]);
    assert.deepEqual(
      sorted(documentedSharedLibLeaves),
      EXPECTED_SHARED_LIB_LEAVES,
      'CLAUDE.md must list each shared companion leaf exactly once',
    );

    for (const leaf of [...EXPECTED_RUNTIME_BINS, ...EXPECTED_SHARED_LIB_LEAVES]) {
      assert.ok(README.includes(leaf) || README.includes(leaf.slice(leaf.indexOf('/') + 1)),
        `README.md must name installed runtime leaf ${leaf}`);
      assert.ok(CLAUDE.includes(leaf) || CLAUDE.includes(leaf.slice(leaf.indexOf('/') + 1)),
        `CLAUDE.md must name installed runtime leaf ${leaf}`);
    }
  });

  it('keeps companion publication dependency-first', () => {
    assert.deepEqual(
      deriveBinFilePublicationOrder(BinFiles).map((file) => file.dest),
      BinFiles.map((file) => file.dest),
      'BinFiles must be the order derived from the local source import graph',
    );
    const validation = validateBinFileOrder(BinFiles);
    assert.deepEqual(validation.order, BinFiles.map((file) => file.dest));
    const graph = getBinFileImportGraph(BinFiles);
    for (const [importer, dependencies] of graph) {
      for (const dependency of dependencies) {
        assert.ok(
          validation.order.indexOf(dependency) < validation.order.indexOf(importer),
          `${dependency} must precede importer ${importer}`,
        );
      }
    }
    assert.ok(
      validation.order.indexOf('lib/fs-atomic.js')
        < validation.order.indexOf('lib/fsutil.js')
        && validation.order.indexOf('lib/fsutil.js')
        < validation.order.indexOf('lib/lease-lock.js'),
      'the actual local import graph must place fs-atomic before fsutil before lease-lock',
    );
    assert.match(
      README,
      /package\.json[\s\S]*sentinel\.js[\s\S]*fs-atomic-identity\.js[\s\S]*fs-atomic-publication\.js[\s\S]*fs-atomic\.js[\s\S]*fsutil\.js[\s\S]*lease-lock\.js[\s\S]*marker-capacity-stage\.js[\s\S]*marker-state\.js[\s\S]*transcript-stats\.js[\s\S]*update-check\.js[\s\S]*executable leaves/,
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
        { name: 'xa', model: 'gpt-6-astra', effort: 'xhigh', display: 'Astra - Extra High' },
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

  it('uses official xhigh for every Extra High Codex tier and excludes obsolete GPT models', () => {
    assert.deepEqual(
      AllCodexAgents.filter((agent) => ['xt', 'xl', 'xs', 'xa'].includes(agent.name)),
      [
        { name: 'xt', model: 'gpt-5.6-terra', effort: 'xhigh', display: 'Terra - Extra High' },
        { name: 'xl', model: 'gpt-5.6-luna', effort: 'xhigh', display: 'Luna - Extra High' },
        { name: 'xs', model: 'gpt-5.6-sol', effort: 'xhigh', display: 'Sol - Extra High' },
        { name: 'xa', model: 'gpt-6-astra', effort: 'xhigh', display: 'Astra - Extra High' },
      ],
    );
    assert.deepEqual(
      AllCodexAgents.filter((agent) => agent.model === 'gpt-6-astra').map((agent) => agent.name),
      ['la', 'ma', 'ha', 'xa', 'xxa', 'ua'],
    );
    assert.ok(AllCodexAgents.every((agent) => !['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'].includes(agent.model)));
  });

  it('keeps non-generated Codex prose on xhigh and the generated Astra row aligned', () => {
    const releaseStart = CHANGELOG.indexOf('## [0.8.0]');
    const nextRelease = CHANGELOG.indexOf('\n## [', releaseStart + 1);
    const currentRelease = CHANGELOG.slice(releaseStart, nextRelease === -1 ? undefined : nextRelease);

    assert.match(
      README,
      /`x\/xx\/u` for `xhigh\/max\/ultra`\.[\s\S]*`gpt-6-astra`/,
      'README prose must use the official xhigh effort key and exact Astra model id',
    );
    assert.doesNotMatch(README, /`x\/xx\/u` for `extra\/max\/ultra`/);
    assert.match(currentRelease, /`gpt-6-astra` with `low`, `medium`, `high`, `xhigh`, `max`,/);
    assert.doesNotMatch(currentRelease, /`extra`/);

    assert.ok(
      README.includes('| Astra | `la` low · `ma` medium · `ha` high · `xa` xhigh · `xxa` max · `ua` ultra |'),
      'generated Codex table must keep all Astra aliases aligned',
    );
  });
});
