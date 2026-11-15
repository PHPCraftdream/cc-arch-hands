// settings-file.js — reading, rendering and editing one Claude Code settings file.
// Shared by the hook editor (`cah rewake`, `cah nobg`) and the checkpoint switches:
// one parser, one text renderer that keeps the file's indent and line ends, and one
// edit under the shared settings lock with a compare-and-swap publish.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureRegularFileSnapshot } from './fs-atomic-identity.js';
import { writeFileAtomic } from './fsutil.js';
import { withSettingsLock } from './settings-lock.js';

// Characters a shell would interpret inside a double-quoted command path.
export const UNSAFE_SHELL_CHARS = /["`$&<>|;^!%]|[\u0000-\u001f]/;

export class SettingsFileError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}; nothing was written`);
    this.name = 'SettingsFileError';
  }
}

export class SettingsBusyError extends Error {
  constructor(path) {
    super(`${path} is locked by another cah operation; retry when it finishes`);
    this.name = 'SettingsBusyError';
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The settings object of a snapshot ({} for an absent file); invalid JSON or a
// root that is not an object throws.
export function parseSettings(path, snapshot) {
  if (!snapshot.present) return {};
  let value;
  try {
    const text = snapshot.content.toString('utf8');
    value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    throw new SettingsFileError(path, 'invalid JSON');
  }
  if (!isPlainObject(value)) throw new SettingsFileError(path, 'the JSON root is not an object');
  return value;
}

function indentOf(snapshot) {
  const match = snapshot.present && snapshot.content.toString('utf8').match(/\n([ \t]+)\S/);
  if (!match) return 2;
  return match[1][0] === '\t' ? '\t' : match[1].length;
}

// The settings as text, in the file's own indent and line ends.
export function settingsText(settings, snapshot) {
  const text = `${JSON.stringify(settings, null, indentOf(snapshot))}\n`;
  return snapshot.present && snapshot.content.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

// Runs `edit(settings)` on one file under its lock; `edit` returns an outcome
// string, or null when nothing changed (no write).
export function editSettings(path, edit, { create, lockOptions }) {
  if (!create && !captureRegularFileSnapshot(path).present) return null;
  if (create) mkdirSync(dirname(path), { recursive: true });
  const result = withSettingsLock(path, () => {
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present && !create) return null;
    const settings = parseSettings(path, snapshot);
    const outcome = edit(settings);
    if (outcome === null) return null;
    writeFileAtomic(path, settingsText(settings, snapshot), {
      expectedDestination: snapshot.expectedDestination,
    });
    return outcome;
  }, lockOptions);
  if (!result.ok) throw new SettingsBusyError(path);
  return result.value;
}
