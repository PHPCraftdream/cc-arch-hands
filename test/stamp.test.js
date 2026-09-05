import { describe } from 'node:test';
import { registerStampCoreCases } from './stamp-core.cases.js';
import { registerStampStateCases } from './stamp-state.cases.js';
import { registerStampUpdateCases } from './stamp-update.cases.js';

describe('cah-stamp bin', () => {
  registerStampCoreCases();
  registerStampStateCases();
  registerStampUpdateCases();
});
