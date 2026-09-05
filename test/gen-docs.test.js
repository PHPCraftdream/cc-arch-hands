import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllCodexAgents } from '../lib/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'gen-docs.js');

describe('gen-docs --check', () => {
  it('README.md is in sync with lib/manifest.js', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    assert.equal(
      res.status,
      0,
      `README.md is out of sync with lib/manifest.js — run \`npm run gen:docs\`.\n${res.stdout}${res.stderr}`,
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
