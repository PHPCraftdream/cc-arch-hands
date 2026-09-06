import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareFreshness } from '../lib/marker-state.js';

describe('marker state freshness ordering', () => {
  it('orders BigInt nanosecond mtimes exactly beyond Number safe range', () => {
    const older = 2n ** 53n + 100n;
    const newer = older + 1n;
    const base = { delivered: 0, time: -1 };
    assert.equal(compareFreshness({ ...base, mtime: newer }, { ...base, mtime: older }), 1);
    assert.equal(compareFreshness({ ...base, mtime: older }, { ...base, mtime: newer }), -1);
  });
});
