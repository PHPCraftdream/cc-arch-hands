import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicenses, evaluateLicense, runCheck } from '../scripts/check-licenses.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const lockOf = (packages) => ({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });

describe('evaluateLicense', () => {
  it('accepts permissive ids and rejects copyleft or unknown ones', () => {
    for (const ok of ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', '0BSD', 'Unlicense']) {
      assert.equal(evaluateLicense(ok).ok, true, ok);
    }
    for (const bad of ['GPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'MPL-2.0', 'UNLICENSED', 'Proprietary']) {
      assert.equal(evaluateLicense(bad).ok, false, bad);
    }
  });

  it('needs one allowed side of OR and both sides of AND', () => {
    assert.equal(evaluateLicense('(MIT OR Apache-2.0)').ok, true);
    assert.equal(evaluateLicense('GPL-3.0-only OR MIT').ok, true);
    assert.equal(evaluateLicense('MIT AND GPL-3.0-only').ok, false);
    assert.equal(evaluateLicense('(MIT AND ISC) OR GPL-2.0-only').ok, true);
  });

  it('judges a WITH exception by its base license', () => {
    assert.equal(evaluateLicense('Apache-2.0 WITH LLVM-exception').ok, true);
    assert.equal(evaluateLicense('GPL-2.0-only WITH Classpath-exception-2.0').ok, false);
  });

  it('rejects missing and malformed expressions instead of passing them', () => {
    for (const bad of [undefined, null, '', '   ', 'MIT OR', '(MIT', 'MIT)', 'OR MIT', 'MIT ISC', 'SEE LICENSE IN LICENSE.txt']) {
      assert.equal(evaluateLicense(bad).ok, false, String(bad));
    }
  });
});

describe('checkLicenses', () => {
  const pkg = { license: '(MIT OR Apache-2.0)' };

  it('passes a dependency-free package without a lockfile', () => {
    assert.deepEqual(checkLicenses(pkg, null), { checked: 0, violations: [] });
  });

  it('checks every lockfile entry, nested and dev ones included', () => {
    const lock = lockOf({
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/a/node_modules/@s/b': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
      'node_modules/c': { version: '3.0.0' },
    });
    const { checked, violations } = checkLicenses({ ...pkg, devDependencies: { a: '^1' } }, lock);
    assert.equal(checked, 3);
    assert.equal(violations.length, 2);
    assert.match(violations[0], /^@s\/b@2\.0\.0: not allowed: GPL-3\.0-only$/);
    assert.match(violations[1], /^c@3\.0\.0: license missing$/);
  });

  it('fails when declared dependencies have no lockfile or are absent from it', () => {
    const declared = { ...pkg, dependencies: { a: '^1' } };
    assert.match(checkLicenses(declared, null).violations[0], /lockfile is missing/);
    assert.match(checkLicenses(declared, lockOf({})).violations[0], /a: declared in package.json but absent/);
  });

  it('fails on a disallowed package license', () => {
    assert.match(checkLicenses({ license: 'GPL-3.0-only' }, null).violations[0], /^package\.json: not allowed/);
    assert.match(checkLicenses({}, null).violations[0], /^package\.json: license missing/);
  });

  it('skips only reviewed exceptions, matched by exact name@version', () => {
    const lock = lockOf({ 'node_modules/odd': { version: '1.0.0', license: 'GPL-3.0-only' } });
    assert.equal(checkLicenses(pkg, lock, { exceptions: { 'odd@1.0.0': 'vetted' } }).violations.length, 0);
    assert.equal(checkLicenses(pkg, lock, { exceptions: { 'odd@2.0.0': 'vetted' } }).violations.length, 1);
  });
});

describe('repository license gate', () => {
  it('has no license violations', () => {
    const { violations } = runCheck(ROOT);
    assert.deepEqual(violations, []);
  });
});
