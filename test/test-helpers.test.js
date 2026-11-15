// The shared test helpers many suites lean on: a bug here would hide or fake
// failures everywhere, so they get their own checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllSkills } from '../lib/manifest.js';
import { withEnv, withHome } from '../test-support/env.js';
import { cliCaller, tempDir } from '../test-support/cli-sandbox.js';
import { withSkills } from '../test-support/installer-test-helpers.js';
import {
  markerEnv, readClaim, sessionHash, writeClaim, writeTranscript,
} from '../test-support/marker-fixtures.js';

const KEY = 'CAH_TEST_HELPER_PROBE';
const OTHER = 'CAH_TEST_HELPER_OTHER';

describe('withEnv', () => {
  it('sets variables for the call, deletes on undefined, and puts everything back', () => {
    process.env[OTHER] = 'before';
    delete process.env[KEY];
    const seen = withEnv({ [KEY]: 'x', [OTHER]: undefined }, () => [process.env[KEY], process.env[OTHER]]);
    assert.deepEqual(seen, ['x', undefined]);
    assert.equal(process.env[KEY], undefined, 'a variable that did not exist is deleted again');
    assert.equal(process.env[OTHER], 'before');
    delete process.env[OTHER];
  });

  it('stringifies values and returns the result of fn', () => {
    assert.equal(withEnv({ [KEY]: 5 }, () => process.env[KEY]), '5');
    assert.equal(process.env[KEY], undefined);
  });

  it('restores when fn throws', () => {
    process.env[KEY] = 'kept';
    assert.throws(() => withEnv({ [KEY]: 'tmp' }, () => { throw new Error('boom'); }), /boom/);
    assert.equal(process.env[KEY], 'kept');
    delete process.env[KEY];
  });

  it('keeps the variables set until a returned promise settles, then restores', async () => {
    delete process.env[KEY];
    const pending = withEnv({ [KEY]: 'async' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return process.env[KEY];
    });
    assert.equal(process.env[KEY], 'async', 'still set while the promise is pending');
    assert.equal(await pending, 'async');
    assert.equal(process.env[KEY], undefined);
    await assert.rejects(withEnv({ [KEY]: 'rejected' }, async () => { throw new Error('late'); }), /late/);
    assert.equal(process.env[KEY], undefined, 'restored after a rejection too');
  });

  it('withHome points HOME and USERPROFILE at the folder', () => {
    const seen = withHome('/somewhere', () => [process.env.HOME, process.env.USERPROFILE]);
    assert.deepEqual(seen, ['/somewhere', '/somewhere']);
    assert.notEqual(process.env.HOME, '/somewhere');
  });
});

describe('tempDir', () => {
  it('exists during the test and is gone once the test that asked for it ends', async (t) => {
    let created;
    await t.test('inner', (inner) => {
      created = tempDir(inner, 'cah-helper-check');
      assert.ok(existsSync(created));
      writeFileSync(join(created, 'file'), 'x');
    });
    assert.ok(created.includes('cah-helper-check-'));
    assert.equal(existsSync(created), false);
  });
});

describe('cliCaller', () => {
  const { call, ok } = cliCaller();

  it('runs cah, treats a leading object as extra environment and not as an argument', (t) => {
    const home = tempDir(t, 'cah-helper-cli');
    assert.equal(call(home, 'version').status, 0);
    assert.equal(call(home, { CAH_LOCALE: 'fr-FR' }, 'version').status, 0);
    assert.match(ok(home, {}, 'version').stdout, /cc-arch-hands/);
  });

  it('ok throws on a failing command', (t) => {
    const home = tempDir(t, 'cah-helper-cli-fail');
    assert.throws(() => ok(home, 'sideways'), assert.AssertionError);
  });

  it('works against the given home, never the real one', (t) => {
    const home = tempDir(t, 'cah-helper-cli-home');
    ok(home, 'install', '--only', 'clock');
    assert.ok(existsSync(join(home, '.claude', 'skills', 'clock', 'SKILL.md')));
  });

  it('cliCaller(baseEnv) is applied and a per-call object overrides it', (t) => {
    const home = tempDir(t, 'cah-helper-cli-env');
    const sandboxed = cliCaller({ OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: join(home, 'xdg') });
    sandboxed.ok(home, 'install', '--opencode-agents');
    assert.ok(existsSync(join(home, 'xdg', 'opencode', 'agents', 'hs.md')));
    const other = join(home, 'other');
    sandboxed.ok(home, { XDG_CONFIG_HOME: other }, 'install', '--opencode-agents');
    assert.ok(existsSync(join(other, 'opencode', 'agents', 'hs.md')));
  });
});

describe('withSkills', () => {
  it('swaps the registry for the call and restores it, also after a throw', () => {
    const before = [...AllSkills];
    const inside = withSkills(['only-one'], () => [...AllSkills]);
    assert.deepEqual(inside, ['only-one']);
    assert.deepEqual(AllSkills, before);
    assert.throws(() => withSkills(['x', 'y'], () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(AllSkills, before);
  });
});

describe('marker fixtures', () => {
  it('sessionHash is the sha256 of the typed session id, and distinguishes a missing one', () => {
    assert.equal(sessionHash('abc'), createHash('sha256').update('string:abc', 'utf8').digest('hex'));
    assert.equal(sessionHash(undefined), createHash('sha256').update('missing:', 'utf8').digest('hex'));
    assert.notEqual(sessionHash('undefined'), sessionHash(undefined));
  });

  it('writeClaim and readClaim round-trip an owner and refuse an existing claim', (t) => {
    const dir = tempDir(t, 'cah-helper-claim');
    const claim = join(dir, 'claim');
    writeClaim(claim, { pid: 1, token: 't' });
    assert.deepEqual(readClaim(claim), { pid: 1, token: 't' });
    assert.throws(() => writeClaim(claim, {}), { code: 'EEXIST' });
  });

  it('writeTranscript writes the user line and the assistant line the bins read', (t) => {
    const dir = tempDir(t, 'cah-helper-transcript');
    const path = writeTranscript(dir, 'claude-opus-5-5', 1234);
    assert.equal(path, join(dir, 'transcript.jsonl'));
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[1].message.model, 'claude-opus-5-5');
    assert.equal(lines[1].message.usage.input_tokens, 1234);
  });

  it('markerEnv carries the sandbox home, the test guard and the short lease', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-helper-env-'));
    try {
      const env = markerEnv(home, join(home, 'markers'));
      assert.equal(env.HOME, home);
      assert.equal(env.USERPROFILE, home);
      assert.equal(env.CAH_TEST_ONLY, '1');
      assert.equal(env.CAH_TEST_MARKER_DIR, join(home, 'markers'));
      assert.equal(env.CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS, '100');
      assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, 'the inherited environment is kept');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
