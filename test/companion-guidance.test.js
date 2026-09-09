import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

it('contributor guidance distinguishes silent hooks from statusLine fallback output', () => {
  const text = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
  assert.match(text, /Stop\/PostToolUse[\s\S]*?silent/);
  assert.match(text, /statusLine[\s\S]*?non-empty fallback/);
  assert.doesNotMatch(text, /exit 0 with no stdout/);
});
