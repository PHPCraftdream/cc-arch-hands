// sentinel-hooks.js — add, update and remove a cah-owned set of hooks in one
// settings.json. Our hooks carry the cah-hook:v1 sentinel and a cah-name; every
// other hook is left exactly as it is. Writers share settings.json.lock with the
// clock/checkpoint-watch skills and `cah probe`, and publish through an atomic
// compare-and-swap, so a concurrent edit is refused instead of overwritten.
// Used by `cah rewake` and `cah nobg`.

import { captureRegularFileSnapshot } from './fs-atomic-identity.js';
import { writeFileAtomic } from './fsutil.js';
import { withSettingsLock } from './settings-lock.js';

export const HOOK_SENTINEL = 'cah-hook:v1';
// Characters a shell would interpret inside the double-quoted bin path.
const UNSAFE_PATH = /["`$&<>|;^!%]|[\u0000-\u001f]/;

export class HookSettingsError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}; nothing was written`);
    this.name = 'HookSettingsError';
  }
}

export class HookBusyError extends Error {
  constructor(path) {
    super(`${path} is locked by another cah operation; retry when it finishes`);
    this.name = 'HookBusyError';
  }
}

// The bin path as it goes into a hook command: forward slashes, no shell syntax.
export function hookBinPath(binPath) {
  const path = String(binPath).replace(/\\/g, '/');
  if (UNSAFE_PATH.test(path)) {
    throw new HookSettingsError(path, 'the bin path holds characters a shell would interpret');
  }
  return path;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSettings(path, snapshot) {
  if (!snapshot.present) return {};
  let value;
  try {
    value = JSON.parse(snapshot.content.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new HookSettingsError(path, 'invalid JSON');
  }
  if (!isPlainObject(value)) throw new HookSettingsError(path, 'the JSON root is not an object');
  return value;
}

function indentOf(snapshot) {
  const match = snapshot.present && snapshot.content.toString('utf8').match(/\n([ \t]+)\S/);
  if (!match) return 2;
  return match[1][0] === '\t' ? '\t' : match[1].length;
}

// `name` is the cah-name of the hooks; `events` the hook events they sit under;
// `wantedFor(binPath)` returns { [event]: { matcher, hooks: [one hook] } }.
export function createHookEditor({ name, events, wantedFor }) {
  const isOurs = (hook) => hook?.['cah-sentinel'] === HOOK_SENTINEL && hook?.['cah-name'] === name;

  function ourHooks(settings, event) {
    const entries = isPlainObject(settings.hooks) && Array.isArray(settings.hooks[event])
      ? settings.hooks[event] : [];
    return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks.filter(isOurs) : []));
  }

  // 'enabled' (all hooks, current command), 'stale' (ours, but outdated or
  // incomplete) or 'disabled' (none of ours).
  function state(settings, wanted) {
    const found = events.map((event) => ourHooks(settings, event));
    if (found.every((hooks) => hooks.length === 0)) return 'disabled';
    const current = events.every((event, i) => found[i].length === 1
      && JSON.stringify(found[i][0]) === JSON.stringify(wanted[event].hooks[0]));
    return current ? 'enabled' : 'stale';
  }

  // Drops our hooks, then any matcher entry, event array and hooks object left empty.
  function stripOurs(settings) {
    if (!isPlainObject(settings.hooks)) return 0;
    let removed = 0;
    for (const event of events) {
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

  function read(settingsPath, binPath) {
    const snapshot = captureRegularFileSnapshot(settingsPath);
    if (!snapshot.present) return 'disabled';
    return state(parseSettings(settingsPath, snapshot), wantedFor(binPath));
  }

  // action 'enable' → 'enabled' | 'updated' | 'already-enabled';
  // action 'disable' → 'disabled' | 'not-enabled'.
  function update(settingsPath, action, { binPath, lockOptions = {} } = {}) {
    const wanted = action === 'enable' ? wantedFor(binPath) : null;
    const result = withSettingsLock(settingsPath, () => {
      const snapshot = captureRegularFileSnapshot(settingsPath);
      if (action === 'disable' && !snapshot.present) return 'not-enabled';
      const settings = parseSettings(settingsPath, snapshot);
      let outcome;
      if (action === 'enable') {
        if (state(settings, wanted) === 'enabled') return 'already-enabled';
        if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
          throw new HookSettingsError(settingsPath, '"hooks" is not an object');
        }
        for (const event of events) {
          const entries = settings.hooks?.[event];
          if (entries !== undefined && !Array.isArray(entries)) {
            throw new HookSettingsError(settingsPath, `"hooks.${event}" is not an array`);
          }
        }
        outcome = stripOurs(settings) ? 'updated' : 'enabled';
        settings.hooks ??= {};
        for (const event of events) (settings.hooks[event] ??= []).push(wanted[event]);
      } else {
        if (!stripOurs(settings)) return 'not-enabled';
        outcome = 'disabled';
      }
      writeFileAtomic(settingsPath, JSON.stringify(settings, null, indentOf(snapshot)) + '\n', {
        expectedDestination: snapshot.expectedDestination,
      });
      return outcome;
    }, lockOptions);
    if (!result.ok) throw new HookBusyError(settingsPath);
    return result.value;
  }

  return { state, read, update };
}
