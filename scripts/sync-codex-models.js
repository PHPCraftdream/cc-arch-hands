#!/usr/bin/env node
// Syncs lib/codex-model-specs.js (context windows and accepted efforts of every
// model in AllCodexAgents) from `codex debug models` on this machine.
//
//   npm run sync:codex                 # rewrite lib/codex-model-specs.js
//   npm run sync:codex -- --check      # exit 1 if it differs from Codex
//   --from FILE   read saved `codex debug models` JSON instead of running codex
//   --out FILE    write (or compare against) FILE instead of the lib module
//
// Run before a release, next to `npm run gen:docs`. Exits 1 when the manifest
// disagrees with Codex about efforts: alias names are not invented here, so
// add or remove the agent entry in lib/manifest.js by hand.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AllCodexAgents } from '../lib/manifest.js';
import {
  parseCodexModels, readCodexModels, buildSpecs, renderSpecsModule, effortDrift, unlistedModels,
} from './codex-models.js';

const DEFAULT_OUT = fileURLToPath(new URL('../lib/codex-model-specs.js', import.meta.url));

function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      from: { type: 'string' },
      out: { type: 'string', default: DEFAULT_OUT },
    },
    strict: true,
    allowPositionals: false,
  });

  const codexModels = values.from ? parseCodexModels(readFileSync(values.from, 'utf8')) : readCodexModels();
  const ids = [...new Set(AllCodexAgents.map((agent) => agent.model))];
  const specs = buildSpecs(codexModels, ids);
  const next = renderSpecsModule(specs);
  const current = existsSync(values.out) ? readFileSync(values.out, 'utf8') : null;
  const stale = current !== next;

  const label = values.out === DEFAULT_OUT ? 'lib/codex-model-specs.js' : 'specs file';
  if (values.check) {
    if (stale) console.error(`${label} differs from codex debug models — run \`npm run sync:codex\`.`);
  } else if (stale) {
    writeFileSync(values.out, next);
    console.log(`${label} updated from codex debug models.`);
  } else {
    console.log(`${label} is already in sync with codex debug models.`);
  }

  const drift = effortDrift(AllCodexAgents, specs);
  for (const { name, model, effort } of drift.unsupported) {
    console.error(`manifest: agent ${name} uses effort ${effort}, which ${model} does not accept — remove it from lib/manifest.js.`);
  }
  for (const { model, effort } of drift.uncovered) {
    console.error(`manifest: ${model} accepts effort ${effort} but has no agent — add one to lib/manifest.js.`);
  }
  const unlisted = unlistedModels(codexModels, ids);
  if (unlisted.length > 0) console.log(`info: Codex also lists ${unlisted.join(', ')} (no agents in the manifest).`);

  const bad = drift.unsupported.length + drift.uncovered.length > 0;
  process.exitCode = bad || (values.check && stale) ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`sync:codex: ${error.message}`);
  process.exitCode = 1;
}
