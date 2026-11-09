#!/usr/bin/env node
// License policy gate: fails when the package or any dependency in the lockfile
// carries a license outside the permissive allowlist, so nothing incompatible
// with our `MIT OR Apache-2.0` outbound license can slip in unnoticed.
//
//   npm run check:licenses
//
// Scope: package.json's own `license` plus every entry of package-lock.json
// (runtime, dev, optional, peer alike). The package has no dependencies today;
// the gate exists so the first one is vetted the moment it is added.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Permissive SPDX ids that may be combined with MIT / Apache-2.0 distribution.
export const ALLOWED_LICENSES = Object.freeze([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'CC0-1.0', 'ISC', 'MIT', 'MIT-0', 'Python-2.0', 'Unlicense', 'Zlib',
]);

// Reviewed one-offs: `name@version` -> reason. Keep empty unless a human vetted it.
export const EXCEPTIONS = Object.freeze({});

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function tokenize(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  return tokens ?? [];
}

// Evaluates an SPDX expression: OR needs one allowed side, AND needs both.
// Returns { ok, reason }; a malformed expression is never ok.
export function evaluateLicense(expression, allowed = ALLOWED_LICENSES) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { ok: false, reason: 'license missing' };
  }
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (word) => peek()?.toUpperCase() === word;
  const fail = (message) => { throw new Error(message); };

  function term() {
    const token = tokens[pos++];
    if (token === undefined) fail('unexpected end');
    if (token === '(') {
      const value = orExpr();
      if (tokens[pos++] !== ')') fail('missing )');
      return value;
    }
    if (token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) fail(`unexpected ${token}`);
    if (isOp('WITH')) { pos += 1; if (tokens[pos++] === undefined) fail('missing exception'); }
    return allowed.includes(token.replace(/\+$/, ''));
  }
  function andExpr() {
    let value = term();
    while (isOp('AND')) { pos += 1; const right = term(); value = value && right; }
    return value;
  }
  function orExpr() {
    let value = andExpr();
    while (isOp('OR')) { pos += 1; const right = andExpr(); value = value || right; }
    return value;
  }

  try {
    const value = orExpr();
    if (pos !== tokens.length) fail(`unexpected ${tokens[pos]}`);
    return value ? { ok: true } : { ok: false, reason: `not allowed: ${expression}` };
  } catch (error) {
    return { ok: false, reason: `unparseable license "${expression}": ${error.message}` };
  }
}

function lockLicense(entry) {
  if (typeof entry.license === 'string') return entry.license;
  if (entry.license && typeof entry.license.type === 'string') return entry.license.type;
  if (Array.isArray(entry.licenses)) {
    const types = entry.licenses.map((item) => (typeof item === 'string' ? item : item?.type));
    if (types.length > 0 && types.every((type) => typeof type === 'string')) return types.join(' OR ');
  }
  return undefined;
}

function packageName(key) {
  const marker = 'node_modules/';
  return key.slice(key.lastIndexOf(marker) + marker.length);
}

// Pure core: `pkg` is parsed package.json, `lock` parsed package-lock.json or null.
export function checkLicenses(pkg, lock, { exceptions = EXCEPTIONS } = {}) {
  const violations = [];
  let checked = 0;

  const own = evaluateLicense(pkg.license);
  if (!own.ok) violations.push(`package.json: ${own.reason}`);

  const declared = DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {}));
  if (declared.length > 0 && !lock) {
    violations.push(`package.json declares ${declared.length} dependencies but package-lock.json is missing`);
  }

  const entries = Object.entries(lock?.packages ?? {}).filter(([key]) => key !== '');
  const present = new Set(entries.map(([key]) => packageName(key)));
  for (const name of declared) {
    if (lock && !present.has(name)) violations.push(`${name}: declared in package.json but absent from package-lock.json`);
  }

  for (const [key, entry] of entries) {
    checked += 1;
    const id = `${packageName(key)}@${entry.version ?? '?'}`;
    if (Object.hasOwn(exceptions, id)) continue;
    const verdict = evaluateLicense(lockLicense(entry));
    if (!verdict.ok) violations.push(`${id}: ${verdict.reason}`);
  }
  return { checked, violations };
}

export function runCheck(rootDir) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const lockPath = join(rootDir, 'package-lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
  const report = checkLicenses(pkg, lock);
  for (const required of ['MIT', 'Apache-2.0']) {
    const file = required === 'MIT' ? 'LICENSE-MIT' : 'LICENSE-APACHE';
    if (typeof pkg.license === 'string' && pkg.license.includes(required) && !existsSync(join(rootDir, file))) {
      report.violations.push(`package.json lists ${required} but ${file} is missing`);
    }
  }
  return { ...report, license: pkg.license };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { checked, violations, license } = runCheck(root);
  if (violations.length > 0) {
    console.error(`license check failed (${violations.length}):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log(`license check ok: ${checked} dependencies, package license ${license}`);
}
