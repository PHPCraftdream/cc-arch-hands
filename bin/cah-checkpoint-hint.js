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
import { readTranscriptStats, modelLimit } from '../lib/transcript-stats.js';

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
  let modelId = null;
  try {
    const stats = readTranscriptStats(transcriptPath);
    if (!stats) return;
    ({ usedTokens, modelId } = stats);
  } catch {
    return; // transcript missing / unreadable
  }
  if (usedTokens === null) return;

  const limit = modelLimit(modelId);
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
