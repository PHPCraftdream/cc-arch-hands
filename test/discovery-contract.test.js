import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// Bare `node --test` with no arguments uses Node's default test-file discovery:
// recursively, from the current working directory, it runs files matching any of
//   **/*.test.{cjs,mjs,js}
//   **/test.{cjs,mjs,js}
//   **/test-*.{cjs,mjs,js}
//   **/*-test.{cjs,mjs,js}
// (see "Test runner execution model" in the Node docs), skipping node_modules
// and dot-directories. discoveryCandidates mirrors those patterns with an
// independent recursive scan so the assertions below cannot be tautologies.
function discoveryCandidates() {
  const skip = new Set(['node_modules', '.git']);
  const matches = /(\/|^)([^/]*\.test\.(?:c|m)?js|test\.(?:c|m)?js|test-[^/]*\.(?:c|m)?js|[^/]*-test\.(?:c|m)?js)$/;
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (entry.isDirectory() && skip.has(entry.name))) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && matches.test(full.replaceAll('\\', '/'))) {
        found.push(relative(ROOT, full).replaceAll('\\', '/'));
      }
    }
  };
  walk(ROOT);
  return found.sort();
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
  it('runs every repo test file exactly once via bare node --test discovery', () => {
    const expected = filesystemTests();
    const tokens = commandTokens(PACKAGE.scripts?.test);
    assert.equal(tokens.shift(), 'node', 'npm test must invoke Node directly');
    assert.equal(PACKAGE.engines?.node, '>=18.19.0', 'test-concurrency requires the fixed Node minimum');
    assert.deepEqual(
      tokens,
      ['--test', '--test-concurrency=1'],
      'npm test must use serialized bare Node discovery exactly once',
    );

    const discovered = filesystemTests();

    // Bare `node --test` discovers exactly the files Node's default name
    // patterns match anywhere in the repo. Both directions must hold: every
    // test-named file must live in test/ (nothing stranded where bare `node
    // --test` from the repo root would still pick it up or where tooling
    // misses it), and every test/ entry must match the default pattern.
    const candidates = discoveryCandidates();
    assert.deepEqual(
      candidates,
      discovered,
      'every test-named file in the repo must be exactly the suite under test/ (bare `node --test` discovery)',
    );

    assert.equal(new Set(discovered).size, discovered.length, 'test entries must not be duplicated');

    for (const entry of discovered) {
      assert.ok(statSync(join(ROOT, entry)).isFile(), `${entry} must resolve to an existing regular file`);
    }
  });
});
