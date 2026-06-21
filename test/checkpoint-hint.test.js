import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-checkpoint-hint.js');

// Spawn the bin as a black box: feed `stdinJson` (already a string), point
// CAH_HINT_HOME at an isolated home, and capture stdout/exit code.
function runHint(stdin, home) {
  const res = spawnSync(process.execPath, [BIN], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CAH_HINT_HOME: home },
  });
  return { stdout: res.stdout, status: res.status };
}

function isolatedHome() {
  return mkdtempSync(join(tmpdir(), 'cah-hint-'));
}

// Write a JSONL transcript with one line carrying model + usage.input_tokens.
function writeTranscript(home, model, usedTokens) {
  const path = join(home, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: { input_tokens: usedTokens, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function markerExists(home, sessionId) {
  return existsSync(join(home, '.claude', `cah-hint-shown-${sessionId}`));
}

const EXPECTED =
  '{"continue":true,"systemMessage":"[hint] Context at 90%. Run /checkpoint to save state before auto-compact."}\n';

describe('cah-checkpoint-hint bin', () => {
  it('stop_hook_active=true → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's1', stop_hook_active: true, transcript_path: 'x' }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('empty stdin → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint('', home);
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('malformed JSON stdin → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint('{not json', home);
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('marker already exists → silent, no duplicate hint', () => {
    const home = isolatedHome();
    const sessionId = 'dup-session';
    // Pre-create the marker.
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', `cah-hint-shown-${sessionId}`), '');
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tp }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('transcript missing/unreadable → silent, exit 0', () => {
    const home = isolatedHome();
    const { stdout, status } = runHint(
      JSON.stringify({
        session_id: 's-missing',
        transcript_path: join(home, 'does-not-exist.jsonl'),
      }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-missing'), false);
  });

  it('usage 0.50 of limit → silent, no marker', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-opus-4-8', 500_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's-half', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, '');
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-half'), false);
  });

  it('Opus at 0.95 (950k / 1M) → emits hint, creates marker', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's-opus', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, EXPECTED);
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-opus'), true);
  });

  it('Sonnet at 0.92 (184k / 200k) → emits hint, creates marker', () => {
    const home = isolatedHome();
    const tp = writeTranscript(home, 'claude-sonnet-4-6', 184_000);
    const { stdout, status } = runHint(
      JSON.stringify({ session_id: 's-sonnet', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, EXPECTED);
    assert.equal(status, 0);
    assert.equal(markerExists(home, 's-sonnet'), true);
  });

  it('0.50 then 0.95 same session: first silent, second emits once', () => {
    const home = isolatedHome();
    const sessionId = 's-grow';

    const tpLow = writeTranscript(home, 'claude-opus-4-8', 500_000);
    const first = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tpLow }),
      home,
    );
    assert.equal(first.stdout, '');
    assert.equal(markerExists(home, sessionId), false);

    const tpHigh = writeTranscript(home, 'claude-opus-4-8', 950_000);
    const second = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tpHigh }),
      home,
    );
    assert.equal(second.stdout, EXPECTED);
    assert.equal(markerExists(home, sessionId), true);

    // A third call must stay silent (marker dedupes).
    const third = runHint(
      JSON.stringify({ session_id: sessionId, transcript_path: tpHigh }),
      home,
    );
    assert.equal(third.stdout, '');
  });

  it('unknown model falls back to 200K limit', () => {
    const home = isolatedHome();
    // 184k / 200k = 0.92 → should fire under fallback.
    const tp = writeTranscript(home, 'some-mystery-model', 184_000);
    const { stdout } = runHint(
      JSON.stringify({ session_id: 's-fallback', transcript_path: tp }),
      home,
    );
    assert.equal(stdout, EXPECTED);
  });
});
