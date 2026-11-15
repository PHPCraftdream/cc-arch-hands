import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRegularFileSnapshot } from '../lib/fs-atomic-identity.js';
import {
  SettingsBusyError, SettingsFileError, UNSAFE_SHELL_CHARS, editSettings, parseSettings, settingsText,
} from '../lib/settings-file.js';
import { acquireSettingsLock, releaseSettingsLock } from '../lib/settings-lock.js';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-settings-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const snapshotOf = (text) => ({ present: true, content: Buffer.from(text) });
const ABSENT = { present: false, content: null };

describe('parseSettings', () => {
  it('reads an absent file as an empty object', () => {
    assert.deepEqual(parseSettings('x.json', ABSENT), {});
  });

  it('strips a byte order mark', () => {
    assert.deepEqual(parseSettings('x.json', snapshotOf('\uFEFF{"a":1}')), { a: 1 });
  });

  it('refuses invalid JSON and a root that is not an object, naming the file', () => {
    for (const text of ['{oops', '[]', '"text"', 'null']) {
      assert.throws(() => parseSettings('C:/x/settings.json', snapshotOf(text)),
        (error) => error instanceof SettingsFileError
          && error.message.startsWith('C:/x/settings.json: ')
          && error.message.endsWith('; nothing was written'), text);
    }
  });
});

describe('settingsText', () => {
  it('uses two spaces and a trailing newline for a new file', () => {
    assert.equal(settingsText({ a: { b: 1 } }, ABSENT), '{\n  "a": {\n    "b": 1\n  }\n}\n');
  });

  it('keeps the indent and the line ends of the existing file', () => {
    assert.equal(settingsText({ a: 1 }, snapshotOf('{\n\t"b": 2\n}\n')), '{\n\t"a": 1\n}\n');
    assert.equal(settingsText({ a: 1 }, snapshotOf('{\r\n    "b": 2\r\n}\r\n')),
      '{\r\n    "a": 1\r\n}\r\n');
  });
});

describe('UNSAFE_SHELL_CHARS', () => {
  it('flags what a shell would interpret inside double quotes, and nothing else', () => {
    for (const ch of ['"', '`', '$', '&', '<', '>', '|', ';', '^', '!', '%', '\u0000', '\u001f']) {
      assert.equal(UNSAFE_SHELL_CHARS.test(ch), true, JSON.stringify(ch));
    }
    for (const ch of ['a', '1', ' ', '-', '_', '(', ')', '/', ':', '.']) {
      assert.equal(UNSAFE_SHELL_CHARS.test(ch), false, JSON.stringify(ch));
    }
  });
});

describe('editSettings', () => {
  it('does nothing for a missing file unless asked to create it', (t) => {
    const path = join(sandbox(t), 'sub', 'settings.json');
    assert.equal(editSettings(path, () => 'changed', { create: false, lockOptions: {} }), null);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(path, '..')), false, 'no directory is created either');
  });

  it('creates the file and its folder when asked, and returns the outcome', (t) => {
    const path = join(sandbox(t), 'sub', 'settings.json');
    const outcome = editSettings(path, (settings) => { settings.key = 1; return 'enabled'; },
      { create: true, lockOptions: {} });
    assert.equal(outcome, 'enabled');
    assert.equal(readFileSync(path, 'utf8'), '{\n  "key": 1\n}\n');
  });

  it('writes nothing when the edit answers null', (t) => {
    const path = join(sandbox(t), 'settings.json');
    const original = '{\r\n\t"keep": true\r\n}\r\n';
    writeFileSync(path, original);
    const before = captureRegularFileSnapshot(path);
    assert.equal(editSettings(path, () => null, { create: false, lockOptions: {} }), null);
    const after = captureRegularFileSnapshot(path);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(after.expectedDestination.identity.ino, before.expectedDestination.identity.ino);
    assert.equal(after.expectedDestination.identity.mtimeNs, before.expectedDestination.identity.mtimeNs);
  });

  it('keeps the file\'s own indent and CRLF on a change', (t) => {
    const path = join(sandbox(t), 'settings.json');
    writeFileSync(path, '{\r\n\t"a": 1\r\n}\r\n');
    editSettings(path, (settings) => { settings.b = 2; return 'updated'; },
      { create: false, lockOptions: {} });
    assert.equal(readFileSync(path, 'utf8'), '{\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n');
  });

  it('refuses a broken file and leaves it as it was', (t) => {
    const path = join(sandbox(t), 'settings.json');
    writeFileSync(path, '{broken');
    assert.throws(() => editSettings(path, () => 'x', { create: false, lockOptions: {} }),
      SettingsFileError);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  });

  it('reports a busy lock instead of waiting or overwriting', (t) => {
    const path = join(sandbox(t), 'settings.json');
    writeFileSync(path, '{}\n');
    const held = acquireSettingsLock(path);
    assert.ok(held, 'the test holds the lock');
    try {
      assert.throws(() => editSettings(path, (settings) => { settings.x = 1; return 'x'; },
        { create: false, lockOptions: { deadlineMs: 0 } }), SettingsBusyError);
    } finally {
      releaseSettingsLock(held);
    }
    assert.equal(readFileSync(path, 'utf8'), '{}\n');
  });
});
