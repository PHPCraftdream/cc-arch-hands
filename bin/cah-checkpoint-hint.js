#!/usr/bin/env node
// cah-checkpoint-hint — Claude Code Stop hook.
//
// Reads the hook JSON payload from stdin, inspects the session transcript,
// and emits ONE soft systemMessage suggesting /checkpoint when context usage
// crosses 90% of the model's limit. It is deliberately fail-silent: any error,
// missing input, or filesystem hiccup results in `exit 0` with no stdout, so it
// can never break the user's session.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SONNET_HAIKU_LIMIT = 200_000;
const OPUS_FABLE_LIMIT = 1_000_000;
const THRESHOLD = 0.9;
const MESSAGE =
  '{"continue":true,"systemMessage":"[hint] Context at 90%. Run /checkpoint to save state before auto-compact."}';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Walk the transcript JSONL from the bottom and return the latest
// usage.input_tokens value found, plus the latest model string seen.
function scanTranscript(transcriptPath) {
  let usedTokens = null;
  let model = null;

  const raw = readFileSync(transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (usedTokens === null) {
      const tokens = findInputTokens(obj);
      if (tokens !== null) usedTokens = tokens;
    }
    if (model === null) {
      const m = findModel(obj);
      if (m) model = m;
    }
    if (usedTokens !== null && model !== null) break;
  }

  return { usedTokens, model };
}

// Recursively look for a `usage.input_tokens` number anywhere in the object.
function findInputTokens(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return null;
  if (
    node.usage &&
    typeof node.usage === 'object' &&
    typeof node.usage.input_tokens === 'number'
  ) {
    return node.usage.input_tokens;
  }
  for (const key of Object.keys(node)) {
    const found = findInputTokens(node[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// Recursively look for a `model` string anywhere in the object.
function findModel(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return null;
  if (typeof node.model === 'string' && node.model) return node.model;
  for (const key of Object.keys(node)) {
    const found = findModel(node[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function limitForModel(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return OPUS_FABLE_LIMIT;
  if (m.includes('sonnet') || m.includes('haiku')) return SONNET_HAIKU_LIMIT;
  return SONNET_HAIKU_LIMIT;
}

function main() {
  const input = readStdin();
  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  // Loop guard: don't react to our own continuation.
  if (payload.stop_hook_active === true) return;

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) return;

  const home = process.env.CAH_HINT_HOME || homedir();
  const markerDir = join(home, '.claude');
  const marker = join(markerDir, `cah-hint-shown-${sessionId}`);

  // Already shown this session.
  if (existsSync(marker)) return;

  let usedTokens = null;
  let model = null;
  try {
    ({ usedTokens, model } = scanTranscript(transcriptPath));
  } catch {
    return; // transcript missing / unreadable
  }
  if (usedTokens === null) return;

  const limit = limitForModel(model);
  const ratio = usedTokens / limit;
  if (ratio < THRESHOLD) return;

  // Threshold crossed: mark and emit.
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(marker, '');
  process.stdout.write(MESSAGE + '\n');
}

try {
  main();
} catch (err) {
  try {
    process.stderr.write(`cah-checkpoint-hint: ${err && err.message}\n`);
  } catch {
    /* ignore */
  }
}

process.exit(0);
