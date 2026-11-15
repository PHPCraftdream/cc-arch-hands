// checkpoint-watch.js — turn the checkpoint-watch mod on or off for one
// project. The mod (templates/skills/checkpoint-watch/hooks/) acts only where
// <project>/.claude/settings.local.json holds { "cahCheckpointWatch": { "mode" } }:
// a personal, uncommitted file, so the cycle never spreads to teammates.
//
// Earlier releases wired a Stop hook (cah-hook:v1, cah-name "checkpoint-watch")
// into <project>/.claude/settings.json; on and off both remove it.
// Writers share settings.json.lock-style locks and publish with compare-and-swap.

import { captureRegularFileSnapshot } from './fs-atomic-identity.js';
import { editSettings, isPlainObject, parseSettings } from './settings-file.js';

export const SETTINGS_KEY = 'cahCheckpointWatch';
export const WATCH_MODES = Object.freeze(['checkpoint', 'commit']);
export const LEGACY_HOOK = Object.freeze({ sentinel: 'cah-hook:v1', name: 'checkpoint-watch' });

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
