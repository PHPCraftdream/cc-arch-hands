// checkpoint-watch.js — turn the checkpoint-watch mod on or off for one
// project. The mod (templates/skills/checkpoint-watch/hooks/) acts only where
// <project>/.claude/settings.local.json holds { "cahCheckpointWatch": { "mode" } }:
// a personal, uncommitted file, so the cycle never spreads to teammates.
//
// Earlier releases wired a Stop hook (cah-hook:v1, cah-name "checkpoint-watch")
// into <project>/.claude/settings.json; on and off both remove it.
// Writers share settings.json.lock-style locks and publish with compare-and-swap.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureRegularFileSnapshot } from './fs-atomic-identity.js';
import { writeFileAtomic } from './fsutil.js';
import { withSettingsLock } from './settings-lock.js';

export const SETTINGS_KEY = 'cahCheckpointWatch';
export const WATCH_MODES = Object.freeze(['checkpoint', 'commit']);
export const LEGACY_HOOK = Object.freeze({ sentinel: 'cah-hook:v1', name: 'checkpoint-watch' });

export class WatchSettingsError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}; nothing was written`);
    this.name = 'WatchSettingsError';
  }
}

export class WatchBusyError extends Error {
  constructor(path) {
    super(`${path} is locked by another cah operation; retry when it finishes`);
    this.name = 'WatchBusyError';
  }
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
    throw new WatchSettingsError(path, 'invalid JSON');
  }
  if (!isPlainObject(value)) throw new WatchSettingsError(path, 'the JSON root is not an object');
  return value;
}

function indentOf(snapshot) {
  const match = snapshot.present && snapshot.content.toString('utf8').match(/\n([ \t]+)\S/);
  if (!match) return 2;
  return match[1][0] === '\t' ? '\t' : match[1].length;
}

function isLegacyHook(hook) {
  return hook?.['cah-sentinel'] === LEGACY_HOOK.sentinel && hook?.['cah-name'] === LEGACY_HOOK.name;
}

export function hasLegacyHook(settings) {
  const entries = isPlainObject(settings.hooks) && Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  return entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some(isLegacyHook));
}

// Drops our Stop hook, then a matcher entry, Stop array and hooks object left empty.
function stripLegacyHook(settings) {
  if (!hasLegacyHook(settings)) return false;
  const kept = [];
  for (const entry of settings.hooks.Stop) {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isLegacyHook)) { kept.push(entry); continue; }
    const hooks = entry.hooks.filter((hook) => !isLegacyHook(hook));
    if (hooks.length) kept.push({ ...entry, hooks });
  }
  if (kept.length) settings.hooks.Stop = kept;
  else delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return true;
}

function modeIn(settings) {
  const mode = settings[SETTINGS_KEY]?.mode;
  return WATCH_MODES.includes(mode) ? mode : null;
}

// Runs `edit(settings)` on one file under its lock; `edit` returns an outcome
// string, or null when nothing changed (no write).
function editSettings(path, edit, { create, lockOptions }) {
  if (!create && !captureRegularFileSnapshot(path).present) return null;
  if (create) mkdirSync(dirname(path), { recursive: true });
  const result = withSettingsLock(path, () => {
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present && !create) return null;
    const settings = parseSettings(path, snapshot);
    const outcome = edit(settings, true);
    if (outcome === null) return null;
    writeFileAtomic(path, JSON.stringify(settings, null, indentOf(snapshot)) + '\n', {
      expectedDestination: snapshot.expectedDestination,
    });
    return outcome;
  }, lockOptions);
  if (!result.ok) throw new WatchBusyError(path);
  return result.value;
}

export function readWatchState({ localPath, projectPath }) {
  const local = captureRegularFileSnapshot(localPath);
  const project = captureRegularFileSnapshot(projectPath);
  return {
    mode: modeIn(parseSettings(localPath, local)),
    legacyHook: hasLegacyHook(parseSettings(projectPath, project)),
  };
}

// action 'enable' (with mode) → { local: 'enabled'|'updated'|'already-enabled', legacy };
// action 'disable' → { local: 'disabled'|'not-enabled', legacy }.
// legacy is 'removed' when the old Stop hook was dropped from settings.json, else null.
export function updateWatch({ localPath, projectPath }, action, { mode, lockOptions = {} } = {}) {
  if (action === 'enable' && !WATCH_MODES.includes(mode)) {
    throw new Error(`unknown checkpoint-watch mode "${mode}"`);
  }
  const local = editSettings(localPath, (settings) => {
    const current = modeIn(settings);
    if (action === 'enable') {
      if (current === mode) return null;
      const outcome = settings[SETTINGS_KEY] === undefined ? 'enabled' : 'updated';
      settings[SETTINGS_KEY] = { mode };
      return outcome;
    }
    if (settings[SETTINGS_KEY] === undefined) return null;
    delete settings[SETTINGS_KEY];
    return 'disabled';
  }, { create: action === 'enable', lockOptions });
  const legacy = editSettings(projectPath, (settings) => (stripLegacyHook(settings) ? 'removed' : null),
    { create: false, lockOptions });
  const fallback = action === 'enable' ? 'already-enabled' : 'not-enabled';
  return { local: local ?? fallback, legacy };
}
