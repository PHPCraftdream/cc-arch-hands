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
  it('full payload → "<model> · X% (Nk/Mk)" with no clock', () => {
    const { stdout, status } = run(makePayload());
    assert.equal(status, 0);
    assert.equal(stdout, 'Opus 4.8 · 67% (670k/1M)');
    assert.ok(!/^\d{2}:\d{2}/.test(stdout), 'must NOT start with HH:MM — clock was dropped to dodge Windows cold-start race');
  });

  it('Sonnet 200K → correct format without clock', () => {
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
    assert.equal(stdout, 'Sonnet 4.6 · 92% (184k/200k)');
  });

  it('context_window: null → only model name', () => {
    const { stdout, status } = run(makePayload({ context_window: null }));
    assert.equal(status, 0);
    assert.equal(stdout, 'Opus 4.8');
  });

  it('missing model entirely → fallback dash', () => {
    const { stdout, status } = run({ hook_event_name: 'Status', context_window: null });
    assert.equal(status, 0);
    assert.equal(stdout, '—', 'never produce empty stdout — harness would blank the statusbar');
  });

  it('empty stdin → fallback dash', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(stdout, '—');
  });

  it('malformed JSON stdin → fallback dash', () => {
    const { stdout, status } = run('{not valid json');
    assert.equal(status, 0);
    assert.equal(stdout, '—');
  });

  it('display_name "Claude Opus 4.6" → trimmed to "Opus 4.6"', () => {
    const { stdout, status } = run(
      makePayload({ model: { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' } }),
    );
    assert.equal(status, 0);
    assert.match(stdout, /^Opus 4\.6 ·/);
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
