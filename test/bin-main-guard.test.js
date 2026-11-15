import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = fileURLToPath(new URL('../bin', import.meta.url));

// The bins run their main only when started directly. Started through a
// directory link (a symlinked ~/.claude, an npm bin link), Node resolves the
// module URL through the link while argv[1] keeps the linked path.
describe('hook bins started through a linked directory', () => {
  function sandbox(t) {
    const dir = mkdtempSync(join(tmpdir(), 'cah-main-guard-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const link = join(dir, 'binlink');
    symlinkSync(binDir, link, 'junction');
    const home = join(dir, 'home');
    mkdirSync(home);
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      CAH_REWAKE_HOME: home, CAH_HINT_HOME: home, CAH_STAMP_HINT_HOME: home,
      CAH_RATE_LIMITS_CACHE: join(home, 'rate-limits.json'),
      CAH_STAMP_THROTTLE_PATH: join(home, 'stamp-state', 'last-stamp.json'),
      CAH_UPDATE_CHECK_CACHE: join(home, 'update-check.json'),
      CAH_TEST_ONLY: '1', CAH_TEST_ONLY_REWAKE_DELAY_MS: '0',
    };
    const run = (name, payload, args = []) => spawnSync(process.execPath, [join(link, name), ...args], {
      input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 60_000,
    });
    return { dir, run };
  }

  it('cah-nobg still denies', (t) => {
    const { run } = sandbox(t);
    const out = run('cah-nobg.js', { tool_name: 'Bash', tool_input: { command: 'server &' } });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('cah-rewake still wakes', (t) => {
    const { run } = sandbox(t);
    const out = run('cah-rewake.js', { session_id: 's1', error: 'server_error' }, ['wait']);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /cah-rewake: the previous turn was cut off/);
  });

  it('cah-stamp and cah-checkpoint-hint still answer', (t) => {
    const { dir, run } = sandbox(t);
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, `${JSON.stringify({
      type: 'assistant', requestId: 'req_1',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 190_000 } },
    })}\n`);
    const stamp = run('cah-stamp.js', { session_id: 's1', transcript_path: transcript, hook_event_name: 'PostToolUse' });
    assert.equal(stamp.status, 0, stamp.stderr);
    assert.match(JSON.parse(stamp.stdout).systemMessage, /95%/);
    const hint = run('cah-checkpoint-hint.js', { session_id: 's1', transcript_path: transcript });
    assert.equal(hint.status, 0, hint.stderr);
    assert.match(JSON.parse(hint.stdout).systemMessage, /Context at 90%/);
  });
});
