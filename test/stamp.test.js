import { describe } from 'node:test';
import { registerStampCoreCases } from '../test-support/stamp-core.cases.js';
import { registerStampStateCases } from '../test-support/stamp-state.cases.js';
import { registerStampUpdateCases } from '../test-support/stamp-update.cases.js';

describe('cah-stamp bin', () => {
  registerStampCoreCases();
  registerStampStateCases();
  registerStampUpdateCases();
});
