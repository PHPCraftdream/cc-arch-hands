import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'gen-docs.js');

describe('gen-docs --check', () => {
  it('README.md is in sync with lib/manifest.js', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    assert.equal(
      res.status,
      0,
      `README.md is out of sync with lib/manifest.js — run \`npm run gen:docs\`.\n${res.stdout}${res.stderr}`,
    );
  });
});
