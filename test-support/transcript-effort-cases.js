import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatStatusLine } from '../lib/transcript-stats.js';

// ---------------------------------------------------------------------------
// effortCode mapping (one-letter codes that match the /sl /sm /sh /sx /sxx
// slash-command suffix convention)
// ---------------------------------------------------------------------------

describe('effortCode', () => {
  it('maps the five known levels to their slash-command suffixes', async () => {
    const { effortCode } = await import('../lib/transcript-stats.js');
    assert.equal(effortCode('low'), 'l');
    assert.equal(effortCode('medium'), 'm');
    assert.equal(effortCode('high'), 'h');
    assert.equal(effortCode('xhigh'), 'x');
    assert.equal(effortCode('max'), 'xx');
  });

  it('is case-insensitive', async () => {
    const { effortCode } = await import('../lib/transcript-stats.js');
    assert.equal(effortCode('MAX'), 'xx');
    assert.equal(effortCode('Medium'), 'm');
  });

  it('returns null for unknown / missing / non-string input', async () => {
    const { effortCode } = await import('../lib/transcript-stats.js');
    assert.equal(effortCode('extreme'), null);
    assert.equal(effortCode(''), null);
    assert.equal(effortCode(null), null);
    assert.equal(effortCode(undefined), null);
    assert.equal(effortCode(5), null);
  });
});

describe('formatStatusLine — effort suffix', () => {
  it('appends [code] after the model name when effort is supplied', () => {
    const line = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-7',
      usedTokens: 240_000,
      limit: 1_000_000,
      effort: 'max',
      bars: false,
    });
    assert.match(line, /^Opus 4\.7 \[xx\] · /);
  });

  it('omits the suffix when effort is missing or unknown', () => {
    const a = formatStatusLine({
      time: null,
      displayName: 'claude-haiku-4-5',
      usedTokens: 24_000,
      limit: 200_000,
      bars: false,
    });
    assert.match(a, /^Haiku 4\.5 · /);
    const b = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-8',
      usedTokens: 1,
      limit: 1_000_000,
      effort: 'extreme', // unknown level
      bars: false,
    });
    assert.match(b, /^Opus 4\.8 · /);
  });
});
