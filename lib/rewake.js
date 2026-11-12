// rewake.js — wire bin/cah-rewake.js into a settings.json as two hooks:
// StopFailure (async + asyncRewake: back off, then wake the session) and Stop
// (async: a completed turn resets the attempt counter).
//
// Our hooks carry the cah-hook:v1 sentinel with cah-name "rewake"; every other
// hook is left exactly as it is. Writers share settings.json.lock with the
// clock/checkpoint-watch skills and `cah probe`, and publish through an atomic
// compare-and-swap, so a concurrent edit is refused instead of overwritten.

import { captureRegularFileSnapshot } from './fs-atomic-identity.js';
import { writeFileAtomic } from './fsutil.js';
import { withSettingsLock } from './settings-lock.js';

export const REWAKE_NAME = 'rewake';
export const HOOK_SENTINEL = 'cah-hook:v1';
export const REWAKE_EVENTS = Object.freeze(['StopFailure', 'Stop']);
// Seconds. Longer than the 900 s back-off cap: Claude Code enforces it on asyncRewake hooks.
export const WAIT_TIMEOUT_S = 1000;
const RESET_TIMEOUT_S = 30;
// Characters a shell would interpret inside the double-quoted bin path.
const UNSAFE_PATH = /["`$&<>|;^!%]|[\u0000-\u001f]/;

export class RewakeSettingsError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}; nothing was written`);
    this.name = 'RewakeSettingsError';
  }
}

export class RewakeBusyError extends Error {
  constructor(path) {
    super(`${path} is locked by another cah operation; retry when it finishes`);
    this.name = 'RewakeBusyError';
  }
}

export function rewakeHooks(binPath) {
  const path = String(binPath).replace(/\\/g, '/');
  if (UNSAFE_PATH.test(path)) {
    throw new RewakeSettingsError(path, 'the bin path holds characters a shell would interpret');
  }
  const hook = (mode, extra) => ({
    type: 'command', command: `node "${path}" ${mode}`, async: true, ...extra,
    'cah-sentinel': HOOK_SENTINEL, 'cah-name': REWAKE_NAME,
  });
  return {
    StopFailure: { matcher: '', hooks: [hook('wait', { asyncRewake: true, timeout: WAIT_TIMEOUT_S })] },
    Stop: { matcher: '', hooks: [hook('reset', { timeout: RESET_TIMEOUT_S })] },
  };
}

function isOurs(hook) {
  return hook?.['cah-sentinel'] === HOOK_SENTINEL && hook?.['cah-name'] === REWAKE_NAME;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ourHooks(settings, event) {
  const entries = isPlainObject(settings.hooks) && Array.isArray(settings.hooks[event])
    ? settings.hooks[event] : [];
  return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks.filter(isOurs) : []));
}

// 'enabled' (both hooks, current command), 'stale' (ours, but outdated or
// incomplete) or 'disabled' (none of ours).
export function rewakeState(settings, wanted) {
  const found = REWAKE_EVENTS.map((event) => ourHooks(settings, event));
  if (found.every((hooks) => hooks.length === 0)) return 'disabled';
  const current = REWAKE_EVENTS.every((event, i) => found[i].length === 1
    && JSON.stringify(found[i][0]) === JSON.stringify(wanted[event].hooks[0]));
  return current ? 'enabled' : 'stale';
}

// Drops our hooks, then any matcher entry, event array and hooks object left empty.
function stripOurs(settings) {
  if (!isPlainObject(settings.hooks)) return 0;
  let removed = 0;
  for (const event of REWAKE_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isOurs)) { kept.push(entry); continue; }
      const hooks = entry.hooks.filter((hook) => !isOurs(hook));
      removed += entry.hooks.length - hooks.length;
      if (hooks.length) kept.push({ ...entry, hooks });
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function parseSettings(path, snapshot) {
  if (!snapshot.present) return {};
  let value;
  try {
    value = JSON.parse(snapshot.content.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new RewakeSettingsError(path, 'invalid JSON');
  }
  if (!isPlainObject(value)) throw new RewakeSettingsError(path, 'the JSON root is not an object');
  return value;
}

function indentOf(snapshot) {
  const match = snapshot.present && snapshot.content.toString('utf8').match(/\n([ \t]+)\S/);
  if (!match) return 2;
  return match[1][0] === '\t' ? '\t' : match[1].length;
}

export function readRewakeState(settingsPath, binPath) {
  const snapshot = captureRegularFileSnapshot(settingsPath);
  if (!snapshot.present) return 'disabled';
  return rewakeState(parseSettings(settingsPath, snapshot), rewakeHooks(binPath));
}

// action 'enable' → 'enabled' | 'updated' | 'already-enabled';
// action 'disable' → 'disabled' | 'not-enabled'.
export function updateRewake(settingsPath, action, { binPath, lockOptions = {} } = {}) {
  const wanted = action === 'enable' ? rewakeHooks(binPath) : null;
  const result = withSettingsLock(settingsPath, () => {
    const snapshot = captureRegularFileSnapshot(settingsPath);
    if (action === 'disable' && !snapshot.present) return 'not-enabled';
    const settings = parseSettings(settingsPath, snapshot);
    let outcome;
    if (action === 'enable') {
      if (rewakeState(settings, wanted) === 'enabled') return 'already-enabled';
      if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
        throw new RewakeSettingsError(settingsPath, '"hooks" is not an object');
      }
      for (const event of REWAKE_EVENTS) {
        const entries = settings.hooks?.[event];
        if (entries !== undefined && !Array.isArray(entries)) {
          throw new RewakeSettingsError(settingsPath, `"hooks.${event}" is not an array`);
        }
      }
      outcome = stripOurs(settings) ? 'updated' : 'enabled';
      settings.hooks ??= {};
      for (const event of REWAKE_EVENTS) (settings.hooks[event] ??= []).push(wanted[event]);
    } else {
      if (!stripOurs(settings)) return 'not-enabled';
      outcome = 'disabled';
    }
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, indentOf(snapshot)) + '\n', {
      expectedDestination: snapshot.expectedDestination,
    });
    return outcome;
  }, lockOptions);
  if (!result.ok) throw new RewakeBusyError(settingsPath);
  return result.value;
}
