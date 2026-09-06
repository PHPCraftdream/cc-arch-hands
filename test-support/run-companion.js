import { makeInterlock } from './interlocks.js';

const kind = process.argv[2];
if (process.env.CAH_TEST_ONLY_HANG === '1') {
  // Deterministic lifecycle fixture for the test harness.  This is checked
  // before importing a companion so a hung child cannot touch real state.
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const targets = {
    hint: '../bin/cah-checkpoint-hint.js',
    stamp: '../bin/cah-stamp.js',
  };
  const target = targets[kind];
  if (!target) throw new Error(`unknown companion kind: ${kind}`);
  const module = await import(new URL(`${target}?test-runner`, import.meta.url));
  const testInterlock = makeInterlock();
  module.main({ testInterlock, protectMarker: testInterlock.protectMarker });
  if (kind === 'hint') process.exit(0);
}
