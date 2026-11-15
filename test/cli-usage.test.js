import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE } from '../lib/cli-usage.js';
import { SettingsCommands } from '../lib/cli-settings-commands.js';

describe('cah --help', () => {
  it('has a line for every settings subcommand', () => {
    for (const name of Object.keys(SettingsCommands)) {
      assert.match(USAGE, new RegExp(`^  cah ${name} `, 'm'), `no usage line for \`cah ${name}\``);
    }
  });

  it('names every companion bin consumer of the shared bin root', () => {
    assert.match(USAGE, /\/clock, \/rewake and \/nobg/);
  });
});
