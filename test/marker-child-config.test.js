// The marker tests splice markerChildConfig() into child-process scripts. The
// objects below are the literals those scripts used to spell out by hand, so a
// change of the generator cannot silently change what the child tests run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markerChildConfig } from '../test-support/marker-child.js';
import { withEnv } from '../test-support/env.js';

const BASE = {
  markerDir: '/m', namespace: 'marker-tests', prefix: 'marker-', ttlMs: 86400000,
  maxSessions: 1, scanCap: 128, claimTtlMs: 30000,
  ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS', markerNameRe: /^marker-[a-f0-9]{64}$/,
};

// Evaluates the generated source the way the child script does.
function evaluate(source) {
  const makeInterlock = () => 'INTERLOCK';
  return withEnv({ CAH_TEST_MARKER_DIR: '/m' }, () =>
    new Function('makeInterlock', 'process', `return ${source}`)(makeInterlock, process));
}

describe('markerChildConfig', () => {
  it('the default is the 30 s claim config with an owner test lease and no interlock', () => {
    assert.deepEqual(evaluate(markerChildConfig()), BASE);
  });

  it('claimTtlMs, interlock and ownerTestEnv switch exactly their own field', () => {
    assert.deepEqual(evaluate(markerChildConfig({ claimTtlMs: 100 })), { ...BASE, claimTtlMs: 100 });
    assert.deepEqual(evaluate(markerChildConfig({ interlock: true })), { ...BASE, testInterlock: 'INTERLOCK' });
    assert.deepEqual(evaluate(markerChildConfig({ claimTtlMs: 100, interlock: true })),
      { ...BASE, claimTtlMs: 100, testInterlock: 'INTERLOCK' });
    const { ownerTestEnv, ...without } = BASE;
    assert.equal(ownerTestEnv, 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS');
    assert.deepEqual(evaluate(markerChildConfig({ ownerTestEnv: false })), without);
  });

  it('reads the marker folder from the environment of the child, not from the parent value', () => {
    const source = markerChildConfig();
    assert.match(source, /markerDir: process\.env\.CAH_TEST_MARKER_DIR,/);
    assert.equal(withEnv({ CAH_TEST_MARKER_DIR: '/other' }, () =>
      new Function('process', `return ${source}`)(process).markerDir), '/other');
  });

  it('is a single object literal that cannot swallow the code around it', () => {
    const source = markerChildConfig({ interlock: true });
    assert.ok(source.startsWith('{ ') && source.endsWith(' }'));
    assert.doesNotMatch(source, /[;\n]/);
  });
});
