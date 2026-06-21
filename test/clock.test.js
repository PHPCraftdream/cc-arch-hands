import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-status.js');

function run(stdinData) {
  const res = spawnSync(process.execPath, [BIN], {
    input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
    encoding: 'utf8',
  });
  return { stdout: res.stdout.trimEnd(), status: res.status };
}

const TIME_RE = /^\d{2}:\d{2}/;

function makePayload(overrides = {}) {
  return {
    hook_event_name: 'Status',
    session_id: 'test-session',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 67,
      remaining_percentage: 33,
      context_window_size: 1_000_000,
      total_input_tokens: 670_000,
      total_output_tokens: 1204,
    },
    ...overrides,
  };
}

describe('cah-status bin', () => {
  it('full payload (Opus 4.8, 67%, 670k/1M) → correct format', () => {
    const { stdout, status } = run(makePayload());
    assert.equal(status, 0);
    assert.match(stdout, TIME_RE);
    assert.match(stdout, /· Opus 4\.8 · 67% \(670k\/1M\)$/);
  });

  it('Sonnet 200K (Sonnet 4.6, 92%, 184k/200k) → correct format', () => {
    const { stdout, status } = run(
      makePayload({
        model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
        context_window: {
          used_percentage: 92,
          remaining_percentage: 8,
          context_window_size: 200_000,
          total_input_tokens: 184_000,
          total_output_tokens: 500,
        },
      }),
    );
    assert.equal(status, 0);
    assert.match(stdout, TIME_RE);
    assert.match(stdout, /· Sonnet 4\.6 · 92% \(184k\/200k\)$/);
  });

  it('context_window: null → only HH:MM · model', () => {
    const { stdout, status } = run(makePayload({ context_window: null }));
    assert.equal(status, 0);
    assert.match(stdout, TIME_RE);
    assert.match(stdout, /· Opus 4\.8$/);
    assert.ok(!stdout.includes('%'), 'should not include percentage');
  });

  it('missing model entirely → only HH:MM', () => {
    const { stdout, status } = run({ hook_event_name: 'Status', context_window: null });
    assert.equal(status, 0);
    assert.match(stdout, TIME_RE);
    assert.ok(!stdout.includes('·'), 'should not include separator');
  });

  it('empty stdin → only HH:MM', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.match(stdout, TIME_RE);
    assert.ok(!stdout.includes('·'), 'should not include separator');
  });

  it('malformed JSON stdin → only HH:MM', () => {
    const { stdout, status } = run('{not valid json');
    assert.equal(status, 0);
    assert.match(stdout, TIME_RE);
    assert.ok(!stdout.includes('·'), 'should not include separator');
  });

  it('display_name "Claude Opus 4.6" → trimmed to "Opus 4.6"', () => {
    const { stdout, status } = run(
      makePayload({ model: { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' } }),
    );
    assert.equal(status, 0);
    assert.match(stdout, /· Opus 4\.6 ·/);
    assert.ok(!stdout.includes('Claude Opus'), 'should not contain "Claude Opus"');
  });

  it('used_percentage with decimals (67.4) → rounded to 67%', () => {
    const payload = makePayload({
      context_window: {
        used_percentage: 67.4,
        remaining_percentage: 32.6,
        context_window_size: 1_000_000,
        total_input_tokens: 670_000,
        total_output_tokens: 1000,
      },
    });
    const { stdout, status } = run(payload);
    assert.equal(status, 0);
    assert.match(stdout, /· 67% /);
    assert.ok(!stdout.includes('67.4'), 'should not include decimal percentage');
  });
});
