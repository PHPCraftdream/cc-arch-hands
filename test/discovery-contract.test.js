import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = join(ROOT, 'test');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function filesystemTests() {
  return readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

function commandTokens(command) {
  // The test script is deliberately a small node command. Rejecting shell
  // syntax here keeps this contract about the files npm actually launches,
  // rather than trying to emulate a shell parser.
  assert.equal(typeof command, 'string');
  assert.doesNotMatch(command, /[;&|<>]/, 'test script must not hide discovery behind shell syntax');
  return command.trim().split(/\s+/).filter(Boolean);
}

describe('test discovery contract', () => {
  it('runs every filesystem test entry exactly once', () => {
    const expected = filesystemTests();
    const tokens = commandTokens(PACKAGE.scripts?.test);
    assert.equal(tokens.shift(), 'node', 'npm test must invoke Node directly');
    assert.ok(tokens.includes('--test'), 'npm test must use Node test discovery');
    assert.ok(tokens.includes('--test-concurrency=1'), 'npm test must serialize the suite');

    const explicit = tokens
      .filter((token) => token.replaceAll('\\', '/').startsWith('test/'))
      .map((token) => token.replaceAll('\\', '/'));
    const discovered = explicit.length === 0 ? expected : explicit;

    assert.equal(new Set(discovered).size, discovered.length, 'test entries must not be duplicated');
    assert.deepEqual(
      discovered,
      expected,
      explicit.length === 0
        ? 'bare Node discovery must cover every test/*.test.js file'
        : 'explicit npm test entries must match test/*.test.js exactly',
    );

    for (const entry of discovered) {
      assert.equal(relative(ROOT, join(ROOT, entry)).replaceAll('\\', '/'), entry);
    }
  });
});
