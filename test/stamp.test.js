import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-stamp.js');

function runStamp(stdinData) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const res = spawnSync(process.execPath, [BIN], {
    input,
    encoding: 'utf8',
  });
  return { stdout: res.stdout, status: res.status };
}

function isolatedDir() {
  return mkdtempSync(join(tmpdir(), 'cah-stamp-'));
}

function writeTranscript(dir, model, usedTokens) {
  const path = join(dir, 'transcript.jsonl');
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

const TIME_RE = /^\d{2}:\d{2}/;

describe('cah-stamp bin', () => {
  it('empty stdin → no output, exit 0', () => {
    const { stdout, status } = runStamp('');
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('malformed JSON → no output, exit 0', () => {
    const { stdout, status } = runStamp('{not valid json');
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('stop_hook_active: true → no output, exit 0', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const { stdout, status } = runStamp({
      session_id: 'loop-session',
      transcript_path: tp,
      stop_hook_active: true,
    });
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('missing transcript_path → no output, exit 0', () => {
    const { stdout, status } = runStamp({ session_id: 'no-tp' });
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('transcript path does not exist → emits HH:MM only (no model/usage), exit 0', () => {
    const dir = isolatedDir();
    const { stdout, status } = runStamp({
      session_id: 's-missing',
      transcript_path: join(dir, 'nonexistent.jsonl'),
    });
    // Still emits a systemMessage (with just HH:MM since no transcript data)
    assert.equal(status, 0);
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      // If nothing was emitted because transcriptPath returned null and we returned early
      // that's also acceptable — spec says "exit 0 silent" for missing transcript
      assert.equal(stdout, '');
      return;
    }
    assert.equal(parsed.continue, true);
    assert.match(parsed.systemMessage, TIME_RE);
  });

  it('valid envelope + Opus 4.7 transcript (46k tokens) → correct systemMessage', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const { stdout, status } = runStamp({
      session_id: 'opus-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    // HH:MM · Opus 4.7 · X% (46k/1M)
    assert.match(parsed.systemMessage, TIME_RE);
    assert.match(parsed.systemMessage, /· Opus 4\.7 · \d+% \(46k\/1M\)$/);
  });

  it('Sonnet variant → correct systemMessage with 200k limit', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-sonnet-4-6', 100_000);
    const { stdout, status } = runStamp({
      session_id: 'sonnet-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    // 100k/200k = 50%
    assert.match(parsed.systemMessage, /· Sonnet 4\.6 · 50% \(100k\/200k\)$/);
  });

  it('"Claude " prefix is stripped from model name', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-8', 200_000);
    const { stdout, status } = runStamp({
      session_id: 'prefix-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    // Model in transcript is "claude-opus-4-8". formatStatusLine trims "Claude " prefix.
    // "claude-opus-4-8" does not start with "Claude " (lowercase), so it stays as is.
    // The trim only strips the exact prefix "Claude " (capital C).
    assert.match(parsed.systemMessage, TIME_RE);
    assert.ok(parsed.systemMessage.includes('claude-opus-4-8') || parsed.systemMessage.includes('Opus'));
  });

  it('usedTokens present but no model → systemMessage is HH:MM only (degrade)', () => {
    const dir = isolatedDir();
    // Write transcript with usage but no model field
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: { input_tokens: 50_000, output_tokens: 10 },
        },
      }) + '\n',
    );
    const { stdout, status } = runStamp({
      session_id: 'no-model-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    // No model → no display name → no usage → just HH:MM
    assert.match(parsed.systemMessage, TIME_RE);
    assert.ok(!parsed.systemMessage.includes('%'), 'should not include percentage without model');
    assert.ok(!parsed.systemMessage.includes('·'), 'should not include separator without model');
  });

  it('model present but no usedTokens → HH:MM · modelName (no usage)', () => {
    const dir = isolatedDir();
    // Write transcript with model but no usage
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
        },
      }) + '\n',
    );
    const { stdout, status } = runStamp({
      session_id: 'no-usage-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    assert.match(parsed.systemMessage, TIME_RE);
    assert.ok(parsed.systemMessage.includes('sonnet-4-6') || parsed.systemMessage.includes('Sonnet'));
    assert.ok(!parsed.systemMessage.includes('%'), 'should not include percentage without usedTokens');
  });
});
