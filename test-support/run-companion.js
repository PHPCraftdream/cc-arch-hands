import { makeInterlock } from './interlocks.js';

const kind = process.argv[2];
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
