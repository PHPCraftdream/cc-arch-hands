#!/usr/bin/env node
// Regenerates the model-commands table, the Codex-agents table, and every
// wrapped item count in README.md from lib/manifest.js — the single source
// of truth for command/agent names, model ids, and effort levels.
//
// Run after any change to AllModelCommands / AllCodexAgents:
//   npm run gen:docs          # rewrite README.md in place
//   npm run gen:docs:check    # exit 1 if README.md is out of sync (CI gate)
//
// README.md marks the generated regions with HTML comments so this script
// never has to guess where prose ends and generated content begins:
//   <!--gen:table:KEY ...--> ... <!--/gen:table:KEY-->
//   <!--gen:count:KEY-->N<!--/gen-->

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllModelCommands, AllCodexAgents } from '../lib/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, '..', 'README.md');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// "Opus 4.8 (1M) – low" -> "Opus 4.8 (1M)" ; "GPT-5.5 - low" -> "GPT-5.5"
function stripEffortSuffix(display) {
  return display.replace(/\s*[–-]\s*(low|medium|high|xhigh|extra|max|ultra)\s*$/i, '').trim();
}

// "Fable (top, 1M)" -> "**Fable** (top, 1M)" ; "Opus 4.8 (1M)" unchanged —
// only family labels whose parenthetical starts with "top" get bolded.
function boldIfTop(label) {
  const idx = label.indexOf(' (');
  if (idx === -1) return label;
  const rest = label.slice(idx);
  if (!/^\s*\(top\b/.test(rest)) return label;
  return `**${label.slice(0, idx)}**${rest}`;
}

// Groups consecutive manifest entries sharing the same display label
// (preserving manifest order — each tier's block is already contiguous).
// Grouping on the label rather than the raw `model` id matters: a "top"
// alias and a versioned entry can point at the identical model id (e.g.
// Haiku (top) and Haiku 4.5 are both claude-haiku-4-5) while still being
// two distinct rows in the table.
function groupByLabel(entries) {
  const groups = [];
  let current = null;
  for (const e of entries) {
    const label = stripEffortSuffix(e.display);
    if (!current || current.label !== label) {
      current = { model: e.model, label, entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }
  return groups;
}

function renderModelCommandsTable(entries) {
  const groups = groupByLabel(entries);
  const header = '| Model | model id | low | medium | high | xhigh | max |\n|---|---|---|---|---|---|---|';
  const rows = groups.map((g) => {
    const byEffort = Object.fromEntries(g.entries.map((e) => [e.effort, e.name]));
    const cells = CLAUDE_EFFORTS.map((eff) => (byEffort[eff] ? `\`/${byEffort[eff]}\`` : '—'));
    return `| ${boldIfTop(g.label)} | \`${g.model}\` | ${cells.join(' | ')} |`;
  });
  return [header, ...rows].join('\n');
}

function renderCodexAgentsTable(entries) {
  const groups = groupByLabel(entries);
  const header = '| Model | Agents by effort |\n|---|---|';
  const rows = groups.map((g) => {
    const cells = g.entries.map((e) => `\`${e.name}\` ${e.effort}`).join(' · ');
    return `| ${g.label} | ${cells} |`;
  });
  return [header, ...rows].join('\n');
}

const TABLES = {
  'model-commands': () => renderModelCommandsTable(AllModelCommands),
  'codex-agents': () => renderCodexAgentsTable(AllCodexAgents),
};

const COUNTS = {
  'model-commands': AllModelCommands.length,
  'codex-agents': AllCodexAgents.length,
};

function substituteTables(content) {
  return content.replace(
    /(<!--gen:table:(\S+)[^>]*-->\n)[\s\S]*?(\n<!--\/gen:table:\2-->)/g,
    (whole, begin, key, end) => {
      const render = TABLES[key];
      if (!render) throw new Error(`gen-docs: unknown table key "${key}" in README.md`);
      return `${begin}${render()}${end}`;
    },
  );
}

function substituteCounts(content) {
  return content.replace(/<!--gen:count:(\S+)-->\d+<!--\/gen-->/g, (whole, key) => {
    if (!(key in COUNTS)) throw new Error(`gen-docs: unknown count key "${key}" in README.md`);
    return `<!--gen:count:${key}-->${COUNTS[key]}<!--/gen-->`;
  });
}

function main() {
  const check = process.argv.includes('--check');
  const original = readFileSync(README_PATH, 'utf8');
  const updated = substituteCounts(substituteTables(original));

  if (updated === original) {
    console.log('README.md is already in sync with lib/manifest.js.');
    return;
  }

  if (check) {
    console.error('README.md is out of sync with lib/manifest.js — run `npm run gen:docs`.');
    process.exitCode = 1;
    return;
  }

  writeFileSync(README_PATH, updated);
  console.log('README.md updated from lib/manifest.js.');
}

main();
