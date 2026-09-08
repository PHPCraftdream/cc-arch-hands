// Contract tests for the instructions published to LLM agents in the clock
// and checkpoint-watch SKILL.md templates. The skill files are prose, so
// these tests pin the *published text* to the library's guarantees (extract
// the literal command lines, compare the documented unsafe-character list
// with lib/probe.js's refusal policy) and exercise a faithful transcription
// of the published "Atomic write only — with a concurrent-edit check" write
// protocol under the exact races the release review reproduced. If the
// SKILL.md wording changes, update the model and anchors here to match: the
// model IS the executable form of the published contract.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { UNSAFE_STATUSLINE_CHARS } from '../lib/probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOCK = readFileSync(join(__dirname, '..', 'templates', 'skills', 'clock', 'SKILL.md'), 'utf8');
const WATCH = readFileSync(
  join(__dirname, '..', 'templates', 'skills', 'checkpoint-watch', 'SKILL.md'), 'utf8');

function commandLines(text) {
  return text.match(/^node "<HOME>[^\n]*$/gm) || [];
}

// Faithful transcription of the "Atomic write only — with a concurrent-edit
// check" rule both SKILL.md files publish:
// 1. read the raw settings text;
// 2. apply the skill's own edits to the parsed object;
// 3. serialize with JSON.stringify(value, null, 2) + "\n";
// 4. write to a FRESH UNIQUE temp beside settings.json — never into an
//    existing settings.json.tmp* path;
// 5. immediately before the final rename, re-read settings.json and compare
//    byte for byte with the text from (1) — on mismatch, delete the temp and
//    refuse to publish;
// 6. only on match, rename the temp over settings.json.
// hooks.beforeFinalRename is the test seam standing for "anything that can
// happen while the agent works" — the concurrent writer lands there, before
// the verification the rule mandates.
function documentedAtomicSave(settingsPath, mutator, hooks = {}) {
  const before = readFileSync(settingsPath, 'utf8');
  const value = JSON.parse(before);
  mutator(value);
  const payload = JSON.stringify(value, null, 2) + '\n';
  const temp = join(
    dirname(settingsPath),
    'settings.json.tmp.' + Math.random().toString(36).slice(2),
  );
  if (existsSync(temp)) {
    throw new Error('temp name collision — the published rule says pick another suffix');
  }
  writeFileSync(temp, payload);
  if (hooks.beforeFinalRename) hooks.beforeFinalRename();
  const current = readFileSync(settingsPath, 'utf8');
  if (current !== before) {
    unlinkSync(temp);
    return { published: false, conflict: true };
  }
  renameSync(temp, settingsPath);
  return { published: true, conflict: false };
}

describe('published clock/checkpoint-watch settings instructions', () => {
  it('publishes exactly the three cah-bin command lines, double-quoted', () => {
    assert.deepEqual(commandLines(CLOCK).sort(), [
      'node "<HOME>/.claude/cah-bin/bin/cah-stamp.js"',
      'node "<HOME>/.claude/cah-bin/bin/cah-status.js"',
    ]);
    assert.deepEqual(commandLines(WATCH), [
      'node "<HOME>/.claude/cah-bin/bin/cah-checkpoint-hint.js"',
    ]);
  });

  it('the published command line still runs through the platform shell for a safe spaced home', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'cah-contract-home-')), 'user home (ok)');
    mkdirSync(join(home, '.claude', 'cah-bin', 'bin'), { recursive: true });
    const bin = join(home, '.claude', 'cah-bin', 'bin', 'cah-status.js');
    writeFileSync(bin, "process.stdout.write('CAH_CONTRACT_OK');" + '\n');
    const literal = commandLines(CLOCK).find((line) => line.includes('cah-status.js'));
    const homeSep = String.fromCharCode(92);
    const command = literal.split('<HOME>').join(home.split(homeSep).join('/'));
    const shell = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command],
        { encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(shell.status, 0, `shell run failed: ${shell.stderr}`);
    assert.equal(shell.stdout.trim(), 'CAH_CONTRACT_OK',
      'the published double-quoted command must reach the script through the shell');
    rmSync(join(home, '..'), { recursive: true, force: true });
  });

  it('the documented unsafe-character list matches the library refusal policy exactly', () => {
    const refused = ['"', '`', '$', '&', '<', '>', '|', ';', '^', '!', '%'];
    for (const ch of refused) {
      assert.equal(UNSAFE_STATUSLINE_CHARS.test(ch), true,
        `the library must refuse ${JSON.stringify(ch)} like the templates document`);
    }
    for (const ch of ['(', ')', ' ', '-', '_', '.', ',', "'", '+', '=', '@', '#']) {
      assert.equal(UNSAFE_STATUSLINE_CHARS.test(ch), false,
        `the library must treat ${JSON.stringify(ch)} as safe like the templates promise`);
    }
    for (const [name, text] of [['clock', CLOCK], ['checkpoint-watch', WATCH]]) {
      const anchor = text.indexOf('check the expanded home path');
      assert.ok(anchor !== -1, `${name}: unsafe-path section missing`);
      const start = text.indexOf('```', anchor);
      const end = text.indexOf('```', start + 3);
      const documented = text.slice(start + 3, end).trim().split(/\s+/).sort();
      assert.deepEqual(documented, [...refused].sort(),
        `${name}: documented unsafe characters must mirror UNSAFE_STATUSLINE_CHARS`);
      assert.match(text, /control characters \(code points U\+0000 through U\+001F\)/,
        `${name}: the control-character refusal must be documented`);
      assert.match(text, /Refuse unsafe home paths before writing anything/,
        `${name}: the refusal instruction must be present`);
    }
  });

  it('prescribes the safe write protocol and no longer the fixed-name tmp+rename', () => {
    for (const [name, text] of [['clock', CLOCK], ['checkpoint-watch', WATCH]]) {
      assert.match(text, /settings\.json\.tmp\.<random-suffix>/,
        `${name}: a unique per-invocation temp name must be prescribed`);
      assert.match(text, /Never write into a pre-existing `settings\.json\.tmp\*/ ,
        `${name}: a pre-existing settings.json.tmp must be declared untouchable`);
      assert.match(text, /Immediately before the final rename/,
        `${name}: the pre-rename verification must be mandated`);
      assert.match(text, /refuse to publish/, `${name}: refusal on conflict must be mandated`);
      assert.match(text, /byte for byte/, `${name}: byte-for-byte verification mandated`);
      assert.match(text, /Never delete `settings\.json` itself/,
        `${name}: the never-delete rule must stay intact`);
      assert.doesNotMatch(text, /write to `settings\.json\.tmp`, then rename/,
        `${name}: the old unsafe fixed-name instruction must be gone`);
      assert.ok((text.match(/safe write protocol/g) || []).length >= 2,
        `${name}: every save site must reference the shared protocol`);
    }
  });

  it('the published protocol preserves a foreign settings.json.tmp and still saves safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        statusLine: { type: 'command', command: 'original-user-command' },
      }, null, 2) + '\n');
      const foreignTmp = join(dir, 'settings.json.tmp');
      const foreignPayload = '{"recovery":"someone-elses-in-flight-write"}';
      writeFileSync(foreignTmp, foreignPayload);

      const result = documentedAtomicSave(settingsPath, (value) => {
        value.editorSetting = 'added-by-clock';
      });

      assert.deepEqual(result, { published: true, conflict: false });
      assert.equal(existsSync(foreignTmp), true,
        'a pre-existing settings.json.tmp is never touched');
      assert.equal(readFileSync(foreignTmp, 'utf8'), foreignPayload,
        'foreign recovery data in the pre-existing tmp must survive byte for byte');
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(saved.editorSetting, 'added-by-clock');
      assert.equal(saved.statusLine.command, 'original-user-command');
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith('settings.json.tmp.')),
        [], 'the unique temp must be gone after the rename');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the published protocol refuses to publish when a concurrent edit landed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-race-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        statusLine: { type: 'command', command: 'original-user-command' },
      }, null, 2) + '\n');
      const foreignTmp = join(dir, 'settings.json.tmp');
      const foreignPayload = '{"recovery":"someone-elses-in-flight-write"}';
      writeFileSync(foreignTmp, foreignPayload);

      const result = documentedAtomicSave(settingsPath, (value) => {
        value.editorSetting = 'added-by-clock';
      }, {
        beforeFinalRename: () => {
          // A concurrent writer lands between the initial read and the
          // pre-rename verification the published protocol requires.
          const current = JSON.parse(readFileSync(settingsPath, 'utf8'));
          current.independentlyAdded = 'must survive';
          const temp = join(dir, 'settings.json.tmp.race-writer');
          writeFileSync(temp, JSON.stringify(current, null, 2) + '\n');
          renameSync(temp, settingsPath);
        },
      });

      assert.deepEqual(result, { published: false, conflict: true },
        'the protocol must refuse to publish over a concurrent edit');
      assert.equal(existsSync(foreignTmp), true,
        'the pre-existing settings.json.tmp must still be untouched');
      assert.equal(readFileSync(foreignTmp, 'utf8'), foreignPayload);
      const leftAlone = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(leftAlone.independentlyAdded, 'must survive',
        'the concurrent writer\'s change must not be clobbered');
      assert.equal(leftAlone.editorSetting, undefined,
        'the refused save must not leak its own edit');
      assert.equal(existsSync(join(dir, 'settings.json.tmp.race-writer')), false,
        'the race writer consumed its own temp');
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith('settings.json.tmp.')),
        [], 'the refused save must delete its unique temp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the published read-modify-write keeps checkpoint-watch and clock hooks coexisting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-hooks-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      const checkpointHook = {
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'node "C:/Users/Alice/.claude/cah-bin/bin/cah-checkpoint-hint.js"',
          'cah-sentinel': 'cah-hook:v1',
          'cah-name': 'checkpoint-watch',
        }],
      };
      writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [checkpointHook] } }, null, 2) + '\n');

      const result = documentedAtomicSave(settingsPath, (value) => {
        // /clock's own merge rule: append our Stop matcher entry, never
        // replace what is there (sentinel preservation).
        value.statusLine = {
          type: 'command',
          command: 'node "C:/Users/Alice/.claude/cah-bin/bin/cah-status.js"',
          padding: 0,
          refreshInterval: 60000,
          'cah-sentinel': 'cah-status:v1',
          'cah-name': 'clock',
        };
        value.hooks = value.hooks || {};
        value.hooks.Stop = value.hooks.Stop || [];
        value.hooks.Stop.push({
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node "C:/Users/Alice/.claude/cah-bin/bin/cah-stamp.js"',
            'cah-sentinel': 'cah-hook:v1',
            'cah-name': 'clock',
          }],
        });
      });

      assert.deepEqual(result, { published: true, conflict: false });
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(saved.hooks.Stop.length, 2, 'both skills hook entries must remain');
      assert.equal(saved.hooks.Stop[0].hooks[0]['cah-name'], 'checkpoint-watch');
      assert.equal(saved.hooks.Stop[1].hooks[0]['cah-name'], 'clock');
      assert.equal(saved.statusLine['cah-name'], 'clock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
