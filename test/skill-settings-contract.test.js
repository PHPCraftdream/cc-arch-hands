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
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  ProbeBusyError, UNSAFE_STATUSLINE_CHARS, enableProbe,
} from '../lib/probe.js';
import {
  acquireSettingsLock, releaseSettingsLock, settingsLockOwned, settingsLockPath,
} from '../lib/settings-lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Normalize CRLF -> LF once at the source: a Windows checkout (core.autocrlf)
// converts the checked-in LF line endings to CRLF, and every regex below
// anchored on `$`/end-of-line would otherwise capture a trailing \r.
const readSkill = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const CLOCK = readSkill(join(__dirname, '..', 'templates', 'skills', 'clock', 'SKILL.md'));
const SETTINGS_LOCK_URL = pathToFileURL(join(__dirname, '..', 'lib', 'settings-lock.js')).href;
const WATCH = readSkill(
  join(__dirname, '..', 'templates', 'skills', 'checkpoint-watch', 'SKILL.md'));

function commandLines(text) {
  return text.match(/^node "<HOME>[^\n]*$/gm) || [];
}

// Faithful transcription of the "Lock settings.json for the whole
// read-modify-write cycle" + "Atomic write only — with a concurrent-edit
// check" rules both SKILL.md files publish, executed through the real shared
// module lib/settings-lock.js (built on lib/lease-lock.js directory
// leases). Steps as documented:
// 0. acquire the shared cross-process settings lock via
//    acquireSettingsLock(): bounded ~30 s wait (~25 ms between attempts;
//    hooks.acquireDeadlineMs scales it down for tests). An ownerless lock is
//    possibly-initializing, never abandoned: it stays untouchable until its
//    directory mtime ages past the ~30 s grace. A readable owner is
//    abandoned only when its pid is dead or its timestamp is more than 5
//    minutes old (the lib/lease-lock.js lease window); reclaim goes through
//    the verified fence — rename aside, re-verify, quarantine anything
//    unrecognized — never blind deletion. If the lock cannot be acquired,
//    refuse with reason 'lock-timeout';
// 1. read the raw settings text;
// 2. apply the skill's own edits to the parsed object;
// 3. serialize with JSON.stringify(value, null, 2) + "\n";
// 4. write to a FRESH UNIQUE temp beside settings.json — never into an
//    existing settings.json.tmp* path;
// 5. immediately before the final rename, re-read settings.json and compare
//    byte for byte with the text from (1) — on mismatch, delete the temp and
//    refuse to publish — AND re-verify via settingsLockOwned(handle) that
//    the lease was not reclaimed while we worked (reason 'lock-lost',
//    refused exactly like a concurrent edit);
// 6. only on match AND still owning the lock, rename the temp over
//    settings.json;
// 7. release the lock on EVERY exit path via releaseSettingsLock(handle),
//    which deletes it only when the recorded token still proves OUR
//    ownership — a successor's live claim is never deleted — including the
//    concurrent-edit refusal, an unreadable-JSON abort, and any thrown
//    error.
// hooks.beforeFinalRename is the test seam standing for "anything that can
// happen while the agent works" — the concurrent writer lands there, before
// the verification the rule mandates.
const LEASE_STALE_MS = 5 * 60 * 1000; // the published 5-minute lease window

function documentedAtomicSave(settingsPath, mutator, hooks = {}) {
  const handle = acquireSettingsLock(settingsPath, {
    deadlineMs: hooks.acquireDeadlineMs ?? 30_000,
    waitStepMs: 25,
    testLeaseEnv: 'CAH_TEST_ONLY_SETTINGS_LEASE_MS',
  });
  if (!handle) return { published: false, conflict: true, reason: 'lock-timeout' };
  try {
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
    if (!settingsLockOwned(handle)) {
      unlinkSync(temp);
      return { published: false, conflict: true, reason: 'lock-lost' };
    }
    renameSync(temp, settingsPath);
    return { published: true, conflict: false };
  } finally {
    releaseSettingsLock(handle);
  }
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
      assert.match(text, /settings\.json\.lock/,
        `${name}: the shared cross-process settings lock must be prescribed`);
      assert.match(text, /owner\.json/,
        `${name}: the lock owner file must be prescribed`);
      assert.match(text, /process id/, `${name}: the owner payload must pin the process id`);
      assert.match(text, /epoch ms/, `${name}: the owner payload must pin the epoch ms`);
      assert.match(text, /more than 5 minutes old/,
        `${name}: the published 5-minute lease window must be pinned`);
      assert.match(text, /lib\/lease-lock\.js/,
        `${name}: the lock must mirror the library's lease semantics`);
      assert.match(text, /settings\.json\.lock\.stale-<pid>-<random-suffix>/,
        `${name}: abandoned-lock recovery must rename the lock aside`);
      assert.match(text, /about 30 seconds/,
        `${name}: the bounded lock wait must be pinned`);
      assert.match(text, /ignores it/,
        `${name}: the non-cooperating-writer limitation must be stated`);
      assert.match(text, /Release the lock on EVERY exit path/,
        `${name}: lock release on every exit path must be mandated`);
      assert.match(text, /lib\/settings-lock\.js/,
        `${name}: the executable lock implementation must be referenced`);
      assert.match(text, /possibly-initializing/,
        `${name}: an ownerless lock must be documented as possibly-initializing, never abandoned`);
      assert.match(text, /quarantine/,
        `${name}: unrecognized reclaimed content must be quarantined, not deleted`);
      assert.match(text, /still carries YOUR process id and\s+token/,
        `${name}: release must be conditional on still owning the lock`);
      assert.match(text, /re-verify the lock owner immediately before the\s+final rename/,
        `${name}: pre-rename ownership re-verification must be mandated`);
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
      assert.equal(existsSync(join(dir, 'settings.json.lock')), false,
        'the settings lock must be released even on the concurrent-edit refusal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the published protocol releases the settings lock after a successful save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-lock-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      const result = documentedAtomicSave(settingsPath, (value) => {
        value.added = 'by-clock';
      });
      assert.deepEqual(result, { published: true, conflict: false });
      assert.equal(existsSync(join(dir, 'settings.json.lock')), false,
        'the lock must be released after a successful save');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the published protocol refuses to write while a live fresh lock is held, and never deletes that lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-busy-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      const original = JSON.stringify({ kept: true }, null, 2) + '\n';
      writeFileSync(settingsPath, original);
      // A real owner payload: pid + timestamp + token, as the published rule
      // and lib/settings-lock.js require.
      const ownerPayload = JSON.stringify({
        pid: process.pid, timestamp: Date.now(), token: 'fixture-live-holder',
      }) + '\n';
      mkdirSync(join(dir, 'settings.json.lock'));
      writeFileSync(join(dir, 'settings.json.lock', 'owner.json'), ownerPayload);

      const result = documentedAtomicSave(settingsPath, (value) => {
        value.added = 'by-clock';
      }, { acquireDeadlineMs: 150 });

      assert.deepEqual(result, { published: false, conflict: true, reason: 'lock-timeout' });
      assert.equal(existsSync(join(dir, 'settings.json.lock')), true,
        'a live holder\'s lock must never be deleted by a blocked writer');
      assert.equal(readFileSync(join(dir, 'settings.json.lock', 'owner.json'), 'utf8'),
        ownerPayload, 'the live holder\'s owner.json must survive byte for byte');
      assert.equal(readFileSync(settingsPath, 'utf8'), original,
        'a lock-blocked writer must not touch settings.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the published protocol recovers an abandoned stale lock and saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-stale-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      mkdirSync(join(dir, 'settings.json.lock'));
      writeFileSync(join(dir, 'settings.json.lock', 'owner.json'), JSON.stringify({
        pid: process.pid,
        timestamp: Date.now() - LEASE_STALE_MS - 60000,
        token: 'fixture-stale-holder',
      }) + '\n');

      const result = documentedAtomicSave(settingsPath, (value) => {
        value.added = 'by-clock';
      });

      assert.deepEqual(result, { published: true, conflict: false });
      assert.equal(existsSync(join(dir, 'settings.json.lock')), false,
        'the stale lock must be recovered and not left behind');
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith('settings.json.lock')),
        [], 'no settings.json.lock* residue may remain after recovery');
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(saved.added, 'by-clock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the published protocol recovers an abandoned dead-holder lock and saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-dead-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      const deadPid = dead.pid;
      let gone = false;
      try { process.kill(deadPid, 0); } catch { gone = true; }
      assert.ok(gone, 'sanity: the harvested pid must genuinely be dead');

      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      mkdirSync(join(dir, 'settings.json.lock'));
      writeFileSync(join(dir, 'settings.json.lock', 'owner.json'), JSON.stringify({
        pid: deadPid, timestamp: Date.now(), token: 'fixture-dead-holder',
      }) + '\n');

      const result = documentedAtomicSave(settingsPath, (value) => {
        value.added = 'by-clock';
      });

      assert.deepEqual(result, { published: true, conflict: false });
      assert.equal(existsSync(join(dir, 'settings.json.lock')), false,
        'a dead holder\'s lock must be recovered and released');
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

// ---------------------------------------------------------------------------
// Two-real-process race harness: reproduces the review's exact interleave
// (both writers read S0, both recheck successfully, both rename in a forced
// order) against real separate Node child processes speaking the documented
// protocol over IPC.
// ---------------------------------------------------------------------------

const PHASE_RANK = { start: 0, 'read-done': 1, 'recheck-done': 2, 'rename-wait': 3, done: 4 };

function childWriterSource(withLock) {
  return `import {
  closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireSettingsLock, releaseSettingsLock, settingsLockOwned } from '${SETTINGS_LOCK_URL}';

const WITH_LOCK = ${withLock};
const [settingsPath, hookName] = process.argv.slice(2);
const bin = hookName === 'clock' ? 'cah-stamp.js' : 'cah-checkpoint-hint.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function awaitMessage() {
  return new Promise((resolve) => { process.once('message', resolve); });
}
let lockBlockedReported = false;
function attemptLock() {
  const first = acquireSettingsLock(settingsPath, { deadlineMs: 0, waitStepMs: 25 });
  if (first) return first;
  if (!lockBlockedReported) {
    lockBlockedReported = true;
    process.send({ type: 'lock-blocked' });
  }
  return acquireSettingsLock(settingsPath, { deadlineMs: 15000, waitStepMs: 25 });
}

async function main() {
let handle = null;
try {
  handle = WITH_LOCK ? attemptLock() : null;
  if (WITH_LOCK && !handle) {
    process.send({ type: 'result', published: false, conflict: true, reason: 'lock-timeout' });
    await awaitMessage(); // 'bye'
    return;
  }
  const before = readFileSync(settingsPath, 'utf8');
  process.send({ type: 'phase', name: 'read-done' });
  await awaitMessage(); // 'go'
  const value = JSON.parse(before);
  value.hooks = value.hooks || {};
  value.hooks.Stop = value.hooks.Stop || [];
  value.hooks.Stop.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: 'node "<HOME>/.claude/cah-bin/bin/' + bin + '"',
      'cah-sentinel': 'cah-hook:v1',
      'cah-name': hookName,
    }],
  });
  const payload = JSON.stringify(value, null, 2) + '\\n';
  const temp = join(dirname(settingsPath),
    'settings.json.tmp.' + Math.random().toString(36).slice(2));
  const fd = openSync(temp, 'wx');
  writeFileSync(fd, payload);
  closeSync(fd);
  const current = readFileSync(settingsPath, 'utf8');
  const match = current === before;
  process.send({ type: 'phase', name: 'recheck-done', match });
  await awaitMessage(); // 'go'
  if (!match) {
    rmSync(temp, { force: true });
    process.send({ type: 'result', published: false, conflict: true });
    await awaitMessage(); // 'bye'
    return;
  }
  process.send({ type: 'phase', name: 'rename-wait' });
  await awaitMessage(); // 'go'
  const stillOwned = WITH_LOCK ? settingsLockOwned(handle) : true;
  if (!stillOwned) {
    rmSync(temp, { force: true });
    process.send({ type: 'result', published: false, conflict: true, reason: 'lock-lost' });
    await awaitMessage(); // 'bye'
    return;
  }
  renameSync(temp, settingsPath);
  process.send({ type: 'result', published: true, conflict: false });
  await awaitMessage(); // 'bye'
} finally {
  if (WITH_LOCK && handle) releaseSettingsLock(handle);
}
}

await main();
process.disconnect();
`;
}

// Spawns two real child writers (clock first, checkpoint-watch second) and
// forces the review's interleave via IPC phase gates: both read before either
// rechecks, both recheck before either renames, and the rename order is
// clock-then-watch. `withLock` switches the documented lock step in the child
// template on (the primary test) or off (the load-bearing companion test).
async function runTwoWriterRace(withLock) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-skill-contract-2proc-'));
  const state = {};
  try {
    const settingsPath = join(dir, 'settings.json');
    const initial = {
      hooks: {
        Stop: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node "<HOME>/.claude/cah-bin/bin/foreign.js"',
            'cah-sentinel': 'cah-hook:v1',
            'cah-name': 'foreign-existing',
          }],
        }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initial, null, 2) + '\n');

    const childPath = join(dir, 'settings-writer-child.mjs');
    writeFileSync(childPath, childWriterSource(withLock));

    const names = ['clock', 'checkpoint-watch'];
    for (const name of names) {
      state[name] = {
        phase: 'start', lockBlocked: false, result: undefined,
        stderr: '', exited: false, exitCode: null,
      };
    }
    let resolveAll;
    const allDone = new Promise((resolve) => { resolveAll = resolve; });

    function maybeGrant() {
      for (const name of names) {
        const self = state[name];
        const other = state[name === 'clock' ? 'checkpoint-watch' : 'clock'];
        const gate = self.pendingGate;
        if (gate === undefined || self.granted) continue;
        const otherBeyond = PHASE_RANK[other.phase] >= PHASE_RANK[gate];
        const otherCannotReach = other.lockBlocked && PHASE_RANK[other.phase] < PHASE_RANK[gate];
        const otherDone = other.result !== undefined;
        if (gate === 'rename-wait' && !otherDone && name !== 'clock') continue;
        if (otherDone || otherBeyond || otherCannotReach) {
          self.granted = true;
          self.pendingGate = undefined;
          self.child.send('go');
        }
      }
    }

    function onMessage(name, msg) {
      const self = state[name];
      if (msg.type === 'phase') {
        self.phase = msg.name;
        if (msg.name === 'rename-wait') self.pendingGate = 'rename-wait';
        else self.pendingGate = msg.name;
        self.granted = false;
      } else if (msg.type === 'lock-blocked') {
        self.lockBlocked = true;
      } else if (msg.type === 'result') {
        const { type, ...result } = msg;
        self.result = result;
        self.phase = 'done';
        self.child.send('bye');
      }
      maybeGrant();
    }

    for (const name of names) {
      const child = spawn(process.execPath, [childPath, settingsPath, name],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      state[name].child = child;
      child.on('message', (msg) => onMessage(name, msg));
      child.stderr.on('data', (chunk) => { state[name].stderr += chunk; });
      child.on('exit', (code) => {
        state[name].exited = true;
        state[name].exitCode = code;
        if (names.every((n) => state[n].exited)) resolveAll();
      });
    }

    const timeout = setTimeout(() => {
      for (const name of names) {
        if (!state[name].exited) {
          state[name].timedOut = true;
          state[name].child.kill();
        }
      }
      resolveAll();
    }, 30000);
    await allDone;
    clearTimeout(timeout);

    for (const name of names) {
      const self = state[name];
      assert.equal(self.timedOut, undefined,
        `${name}: child timed out after 30s; stderr:\n${self.stderr}`);
      assert.equal(self.exitCode, 0,
        `${name}: child exited ${self.exitCode}; stderr:\n${self.stderr}`);
      assert.ok(self.result, `${name}: child exited without a result; stderr:\n${self.stderr}`);
    }
    return { dir, settingsPath, state };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

describe('two real cooperating writer processes at the commit boundary', () => {
  it('two real cooperating writer processes cannot lose either hook at the commit boundary', async () => {
    const { dir, settingsPath, state } = await runTwoWriterRace(true);
    try {
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const names = saved.hooks.Stop.flatMap((entry) =>
        entry.hooks.map((hook) => hook['cah-name']));
      // Review closure criterion: both hooks survive, OR a writer detects the
      // conflict and reports an explicit error (lock-timeout / concurrent-edit
      // refusal) — never both success with one change silently lost.
      assert.ok(names.includes('foreign-existing'),
        `the pre-existing foreign hook must never be clobbered; got ${JSON.stringify(names)}`);
      for (const [name, self] of Object.entries(state)) {
        if (self.result.published) {
          assert.ok(names.includes(name),
            `${name} reported published=true but its hook is gone from the final file`);
        }
      }
      if (state.clock.result.published && state['checkpoint-watch'].result.published) {
        for (const expected of ['clock', 'checkpoint-watch']) {
          assert.ok(names.includes(expected),
            `both writers reported published=true: the ${expected} hook must survive; got ${JSON.stringify(names)}`);
        }
      }
      assert.deepEqual(
        readdirSync(dir).filter((n) => n.startsWith('settings.json.tmp.')),
        [], 'no unique temp files may remain after the race');
      assert.equal(existsSync(join(dir, 'settings.json.lock')), false,
        'the settings lock must be released after the race');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without the lock the same interleave silently loses the clock hook (the published lock is load-bearing)', async () => {
    const { dir, settingsPath, state } = await runTwoWriterRace(false);
    try {
      assert.deepEqual(state.clock.result, { published: true, conflict: false },
        'the known-bad run must have both writers report success');
      assert.deepEqual(state['checkpoint-watch'].result, { published: true, conflict: false },
        'the known-bad run must have both writers report success');
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const names = saved.hooks.Stop.flatMap((entry) =>
        entry.hooks.map((hook) => hook['cah-name']));
      assert.ok(!names.includes('clock'),
        'the silent loss must reproduce: both published=true yet the clock hook is gone');
      assert.ok(names.includes('checkpoint-watch'),
        'the second rename wins and carries its own hook');
      assert.ok(names.includes('foreign-existing'),
        'the pre-existing foreign hook survives');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round-4 regression races: each test pins one review observation about the
// settings-lock lifecycle itself (initialization gap, verified-fence reclaim,
// stale releaser, probe interleave) or demonstrates, as an in-process
// transcription, why the OLD published reclaim protocol the review reproved
// was load-bearing-wrong (the "fails-without" companions).
// ---------------------------------------------------------------------------

// Template for a lock-race child process. Writes a real .mjs that imports the
// SAME module instance (via file URL) the parent tests: no reimplementation.
function lockRaceChildSource(mode) {
  return `import {
  existsSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireSettingsLock, releaseSettingsLock, settingsLockOwned } from '${SETTINGS_LOCK_URL}';

const MODE = ${JSON.stringify(mode)};
const [settingsPath, gatePath, markerKey] = process.argv.slice(2);

// Synchronous file gate: spin on the gate file's existence, parking the
// thread 10 ms at a time with Atomics.wait (no busy CPU spin), with a hard
// 30 s deadline so a lost 'go' can never hang the suite.
function waitFileSync(path) {
  const deadline = Date.now() + 30000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('gate timeout: ' + path);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function awaitMessage() {
  return new Promise((resolve) => { process.once('message', resolve); });
}

async function main() {
  if (MODE === 'gap-hold') {
    let handle = null;
    try {
      // testInterlock('lease-owner-write', 'before') fires BETWEEN the
      // winning mkdir and the owner.json write: exactly the crash-in-the-
      // initialization-gap window, held open until the parent opens the gate.
      handle = acquireSettingsLock(settingsPath, {
        deadlineMs: 15000,
        waitStepMs: 25,
        testInterlock: (phase, stage) => {
          if (phase === 'lease-owner-write' && stage === 'before') {
            process.send({ type: 'gap' });
            waitFileSync(gatePath);
          }
        },
      });
      process.send({ type: 'result', owned: Boolean(handle), token: handle ? handle.token : null });
      await awaitMessage(); // 'bye'
      if (handle) releaseSettingsLock(handle);
    } finally {
      process.disconnect();
    }
    return;
  }
  if (MODE === 'stale-hold-refuse') {
    let handle = null;
    try {
      // The parent exports CAH_TEST_ONLY=1 + CAH_TEST_ONLY_SETTINGS_LEASE_MS
      // before spawning: both sides shorten the lease through the SAME
      // leaseExpired code path a real expired lease takes — never doctored
      // fixture timestamps.
      handle = acquireSettingsLock(settingsPath, {
        deadlineMs: 15000,
        waitStepMs: 25,
        testLeaseEnv: 'CAH_TEST_ONLY_SETTINGS_LEASE_MS',
      });
      process.send({ type: 'acquired', token: handle ? handle.token : null });
      await awaitMessage(); // 'go'
      // The documented save-shaped cycle: read, mutate, unique temp,
      // byte re-read, then re-verify ownership BEFORE publishing.
      const before = readFileSync(settingsPath, 'utf8');
      const value = JSON.parse(before);
      value[markerKey] = 'stale-writer';
      const payload = JSON.stringify(value, null, 2) + '\\n';
      const temp = join(dirname(settingsPath),
        'settings.json.tmp.' + Math.random().toString(36).slice(2));
      writeFileSync(temp, payload);
      const current = readFileSync(settingsPath, 'utf8');
      if (current !== before || !settingsLockOwned(handle)) {
        rmSync(temp, { force: true });
        process.send({
          type: 'result', published: false, reason: 'lock-lost',
          released: releaseSettingsLock(handle),
        });
      } else {
        renameSync(temp, settingsPath);
        process.send({ type: 'result', published: true, released: releaseSettingsLock(handle) });
      }
      await awaitMessage(); // 'bye'
    } finally {
      process.disconnect();
    }
  }
}

await main();
`;
}

// Parent-side await for one specific child message type with a hard timeout,
// so a wedged child fails the test instead of hanging the suite. Rejects if
// the child exits before the message arrives.
function awaitChildMessage(child, type, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for child message ${type}`));
    }, timeoutMs);
    function onMessage(msg) {
      if (msg && msg.type === type) {
        cleanup();
        resolve(msg);
      }
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`child exited ${code} before sending ${type}`));
    }
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function writeGate(path) {
  writeFileSync(path, 'go');
}

function awaitChildExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
  });
}

function walkCollect(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkCollect(full, out);
    else out.push(full);
  }
  return out;
}

describe('settings-lock lifecycle races (round-4 review observations)', () => {
  it('a fresh ownerless reservation survives a concurrent reader (observation A)', async () => {
    // Observation A: a crash between mkdir and the owner write leaves a
    // FRESH OWNERLESS reservation. A concurrent acquirer must see "busy",
    // never steal or fence the reservation aside, and the reservation must
    // land intact for its own creator.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-fresh-'));
    let child = null;
    let childGone = false;
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      const gatePath = join(dir, 'gate');
      const childPath = join(dir, 'lock-race-child.mjs');
      writeFileSync(childPath, lockRaceChildSource('gap-hold'));
      child = spawn(process.execPath, [childPath, settingsPath, gatePath],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.once('exit', () => { childGone = true; });

      await awaitChildMessage(child, 'gap');
      const lockDir = join(dir, 'settings.json.lock');
      assert.equal(existsSync(lockDir), true, 'the child reservation dir must exist');
      assert.equal(existsSync(join(lockDir, 'owner.json')), false,
        'the reservation is inside the initialization gap: no owner.json yet');
      assert.equal(
        acquireSettingsLock(settingsPath, { deadlineMs: 500, waitStepMs: 50 }),
        null,
        'a concurrent acquirer must report busy against a fresh ownerless reservation, never steal it',
      );
      assert.equal(existsSync(lockDir), true,
        'the blocked acquirer must not delete the reservation');
      assert.equal(existsSync(join(lockDir, 'owner.json')), false,
        'the blocked acquirer must not write an owner into the reservation');
      assert.deepEqual(
        readdirSync(dir).filter((n) => n.startsWith('settings.json.lock.stale.')),
        [], 'the blocked acquirer must never fence a fresh ownerless reservation aside',
      );

      writeGate(gatePath);
      const result = await awaitChildMessage(child, 'result');
      assert.equal(result.owned, true,
        'the original creator must still win its own reservation after the gap');
      child.send('bye');
      await awaitChildExit(child);
      childGone = true;

      // The lock stays fully usable after the gap closed and released.
      const handle = acquireSettingsLock(settingsPath, { deadlineMs: 5000, waitStepMs: 25 });
      assert.ok(handle, 'the lock must remain acquirable after the child released');
      assert.equal(releaseSettingsLock(handle), true,
        'the post-gap acquisition must release cleanly');
    } finally {
      if (child && !childGone) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the round-3 published protocol destroys a fresh ownerless reservation (load-bearing fails-without)', () => {
    // IN-PROCESS transcription of the OLD published reclaim rule ("owner
    // missing = abandoned → rename aside + delete"), kept to show the exact
    // behavior the round-4 review reproved: it destroys a reservation that
    // is merely initializing. This is the behavior test 1 pins as fixed.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-oldproto-'));
    try {
      const lock = join(dir, 'settings.json.lock');
      mkdirSync(lock); // no owner.json — old rule reads this as "abandoned"
      const aside = lock + '.stale.' + Math.random().toString(36).slice(2);
      renameSync(lock, aside);
      rmSync(aside, { recursive: true, force: true });
      assert.equal(existsSync(lock), false,
        'the old protocol destroys the fresh ownerless reservation outright');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaiming an abandoned ownerless lock preserves unrecognized content (observation A)', () => {
    // Observation A: when the aged ownerless claim IS reclaimed, reclaim
    // must go through lease-lock's verified fence — anything unrecognized
    // inside is QUARANTINED, never destroyed. Directory mtime aging is the
    // same isOlderThan path a genuinely old ownerless claim takes.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-quarantine-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      const lockDir = join(dir, 'settings.json.lock');
      mkdirSync(lockDir);
      const recoveryBytes = 'user-recovery-data: KEEP ME\n';
      writeFileSync(join(lockDir, 'user-recovery.txt'), recoveryBytes);
      const past = new Date(Date.now() - 10 * 60 * 1000);
      utimesSync(lockDir, past, past); // age the claim past staleAfterMs

      const handle = acquireSettingsLock(settingsPath, {
        deadlineMs: 5000, waitStepMs: 25, staleAfterMs: 30_000,
      });
      assert.ok(handle, 'the aged ownerless claim must be reclaimable');
      try {
        const files = walkCollect(dir);
        const recovery = files.filter((p) => p.endsWith('user-recovery.txt'));
        assert.equal(recovery.length, 1,
          'the foreign file must survive somewhere in the sandbox, never destroyed');
        assert.ok(recovery[0].includes('.cah-lease-quarantine'),
          `the foreign file must be quarantined, got ${recovery[0]}`);
        assert.equal(readFileSync(recovery[0], 'utf8'), recoveryBytes,
          'quarantined content must survive byte for byte');
        assert.deepEqual(readdirSync(lockDir), ['owner.json'],
          'the canonical lock dir must contain exactly the new owner.json');
      } finally {
        assert.equal(releaseSettingsLock(handle), true,
          'the reclaimed lock must release cleanly');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the round-3 published protocol destroys foreign content in a reclaimed lock (load-bearing fails-without)', () => {
    // IN-PROCESS transcription of the OLD published reclaim rule, kept to
    // show the exact destruction the review reproved: blind delete of the
    // renamed-aside lock destroys foreign content inside it. This is the
    // behavior test 3 pins as fixed.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-oldcontent-'));
    try {
      const lock = join(dir, 'settings.json.lock');
      mkdirSync(lock); // no owner.json — old rule reads this as "abandoned"
      writeFileSync(join(lock, 'user-recovery.txt'), 'user-recovery-data\n');
      const aside = lock + '.stale.' + Math.random().toString(36).slice(2);
      renameSync(lock, aside);
      rmSync(aside, { recursive: true, force: true });
      assert.equal(existsSync(join(aside, 'user-recovery.txt')), false,
        'the old protocol destroys the foreign content with the renamed copy');
      assert.deepEqual(walkCollect(dir).filter((p) => p.endsWith('user-recovery.txt')), [],
        'the foreign content is gone from the entire sandbox');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two writers never both own the lock across the initialization gap (observation B)', async () => {
    // Observation B: a second writer racing the mkdir→owner-write gap must
    // be told "busy" — and once the gap closes, exactly one owner exists,
    // whose recorded pid+token is the first writer's own reservation.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-gap-'));
    let child = null;
    let childGone = false;
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      const gatePath = join(dir, 'gate');
      const childPath = join(dir, 'lock-race-child.mjs');
      writeFileSync(childPath, lockRaceChildSource('gap-hold'));
      child = spawn(process.execPath, [childPath, settingsPath, gatePath],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.once('exit', () => { childGone = true; });

      await awaitChildMessage(child, 'gap');
      const lockDir = join(dir, 'settings.json.lock');
      assert.equal(
        acquireSettingsLock(settingsPath, { deadlineMs: 800, waitStepMs: 25 }),
        null,
        'the racing writer must not displace the fresh ownerless reservation',
      );
      assert.equal(existsSync(join(lockDir, 'owner.json')), false,
        'the racing writer must not have forced an owner into the reservation');
      writeGate(gatePath);

      const result = await awaitChildMessage(child, 'result');
      assert.equal(result.owned, true, 'the first writer must win its own reservation');
      const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
      assert.equal(owner.pid, child.pid,
        'the surviving owner.json must record the child\'s own pid — nothing overwrote it');
      assert.equal(owner.token, result.token,
        'the surviving owner.json must record the child\'s own token — nothing overwrote it');
      child.send('bye');
      await awaitChildExit(child);
      childGone = true;

      // Serialization: the parent can only own AFTER the child released.
      const handle = acquireSettingsLock(settingsPath, { deadlineMs: 5000, waitStepMs: 25 });
      assert.ok(handle, 'the parent must acquire only after the child released');
      assert.equal(releaseSettingsLock(handle), true,
        'the parent\'s post-child acquisition must release cleanly');
    } finally {
      if (child && !childGone) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the round-3 protocol lets both writers believe they own the lock (observation B, two real processes)', async () => {
    // Deterministic port of the review's reproduction: the child holds the
    // mkdir→owner-write gap open; the OLD protocol (transcribed in-process)
    // steals the reservation and writes its own owner; then the child
    // resumes and overwrites the owner with its own. Both believers end up
    // "owning" — the defect this suite pins as fixed.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-bothbelieve-'));
    let child = null;
    let childGone = false;
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      const childPath = join(dir, 'raw-mkdir-gap-child.mjs');
      // Minimal non-cooperating writer: raw mkdir, gap, then owner write.
      writeFileSync(childPath, `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [settingsPath] = process.argv.slice(2);
const lockDir = settingsPath + '.lock';
function awaitMessage() {
  return new Promise((resolve) => { process.once('message', resolve); });
}
mkdirSync(lockDir);
process.send({ type: 'gap' });
await awaitMessage(); // 'go'
writeFileSync(join(lockDir, 'owner.json'),
  JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\\n');
process.send({ type: 'resumed' });
process.disconnect();
`);
      child = spawn(process.execPath, [childPath, settingsPath],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.once('exit', () => { childGone = true; });

      await awaitChildMessage(child, 'gap');
      const lockDir = join(dir, 'settings.json.lock');
      // OLD PUBLISHED PROTOCOL, in-process: owner missing → "abandoned" →
      // rename aside + blind recursive delete → recreate and self-own.
      const aside = lockDir + '.stale.' + Math.random().toString(36).slice(2);
      renameSync(lockDir, aside);
      rmSync(aside, { recursive: true, force: true });
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\n');
      const bBelievesOwned = true; // the old protocol gave B a clean acquire
      child.send('go');

      await awaitChildMessage(child, 'resumed');
      const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
      const aOverwroteB = owner.pid !== process.pid;
      assert.equal(bBelievesOwned, true,
        'the old protocol reported success to the second writer');
      assert.equal(aOverwroteB, true,
        'the old protocol then let the first writer overwrite the owner.json: '
        + `owner pid is now ${owner.pid}, not the parent's ${process.pid} — two believers`);
    } finally {
      if (child && !childGone) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stale owner's release cannot delete a live successor's lock (observation C)", async () => {
    // Observation C: an owner whose lease expired (here shortened through
    // the SHARED CAH_TEST_ONLY lease path on both sides — the same
    // leaseExpired code a real expired lease takes) must, on release, find
    // its token gone and delete NOTHING: the successor's live lock survives
    // byte-identical and exclusivity is restored.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-stalerelease-'));
    const prior = {
      CAH_TEST_ONLY: process.env.CAH_TEST_ONLY,
      CAH_TEST_ONLY_SETTINGS_LEASE_MS: process.env.CAH_TEST_ONLY_SETTINGS_LEASE_MS,
    };
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_SETTINGS_LEASE_MS = '150';
    let child = null;
    let childGone = false;
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ kept: true }, null, 2) + '\n');
      const gatePath = join(dir, 'gate');
      const childPath = join(dir, 'lock-race-child.mjs');
      writeFileSync(childPath, lockRaceChildSource('stale-hold-refuse'));
      child = spawn(process.execPath, [childPath, settingsPath, gatePath, 'staleWriterMarker'],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env } });
      child.once('exit', () => { childGone = true; });

      const acquired = await awaitChildMessage(child, 'acquired');
      assert.ok(acquired.token, 'the stale writer must report its token');
      // ~400 ms of REAL elapsed time through the shared leaseExpired path on
      // both sides: the 150 ms test lease genuinely expires.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);

      const parentHandle = acquireSettingsLock(settingsPath, {
        deadlineMs: 5000, waitStepMs: 25,
        testLeaseEnv: 'CAH_TEST_ONLY_SETTINGS_LEASE_MS',
      });
      assert.ok(parentHandle, 'the successor must reclaim the genuinely expired lease');
      const tokenB = parentHandle.token;
      const ownerPath = join(dir, 'settings.json.lock', 'owner.json');
      assert.equal(JSON.parse(readFileSync(ownerPath, 'utf8')).token, tokenB,
        'the canonical owner.json must now record the successor\'s token');
      child.send('go');

      const result = await awaitChildMessage(child, 'result');
      assert.equal(result.published, false, 'the stale writer must refuse to publish');
      assert.equal(result.reason, 'lock-lost',
        'the stale writer must refuse via the lock-lost path');
      assert.equal(result.released, false,
        'the stale writer\'s release must delete nothing');
      assert.equal(existsSync(join(dir, 'settings.json.lock')), true,
        'the successor\'s live lock must survive the stale releaser');
      assert.equal(JSON.parse(readFileSync(ownerPath, 'utf8')).token, tokenB,
        'the successor\'s owner.json must survive byte-identical (same token)');
      child.send('bye');
      await awaitChildExit(child);
      childGone = true;

      assert.equal(releaseSettingsLock(parentHandle), true,
        'the successor must release its own lock cleanly');
      const third = acquireSettingsLock(settingsPath, {
        deadlineMs: 5000, waitStepMs: 25,
        testLeaseEnv: 'CAH_TEST_ONLY_SETTINGS_LEASE_MS',
      });
      assert.ok(third, 'exclusivity must be restored for a fresh acquirer');
      assert.equal(releaseSettingsLock(third), true,
        'the third acquirer must release cleanly');
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (child && !childGone) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enableProbe cannot interleave with a skill holding the settings lock (round-4 P2-1)', async () => {
    // P2-1: probe rewiring shares the skills' settings.json.lock namespace.
    // With the old separate settings.json.probe-lock name this interleave
    // let enableProbe succeed DURING the skill's hold and the skill's final
    // rename silently erased the probe's change (the review's repro). The
    // shared namespace makes that impossible: the probe transition reports
    // busy, and the skill's published result then contains both parties.
    const dir = mkdtempSync(join(tmpdir(), 'cah-skill-race-probe-'));
    let child = null;
    let childGone = false;
    try {
      const settingsPath = join(dir, 'settings.json');
      const initial = {
        statusLine: {
          type: 'command',
          command: 'node "<HOME>/.claude/cah-bin/bin/cah-status.js"',
          'cah-sentinel': 'cah-status:v1',
          'cah-name': 'clock',
        },
        hooks: {
          Stop: [{
            matcher: '',
            hooks: [{
              type: 'command',
              command: 'node "<HOME>/.claude/cah-bin/bin/foreign.js"',
              'cah-sentinel': 'cah-hook:v1',
              'cah-name': 'foreign-existing',
            }],
          }],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(initial, null, 2) + '\n');

      const childPath = join(dir, 'settings-writer-child.mjs');
      writeFileSync(childPath, childWriterSource(true));
      let stderr = '';
      child = spawn(process.execPath, [childPath, settingsPath, 'checkpoint-watch'],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('exit', () => { childGone = true; });

      // Drive the writer's gates manually; the probe interleave lands in the
      // rename-wait gate: the skill HOLDS the lock, paused before its rename.
      let probeError = null;
      for (;;) {
        const msg = await awaitChildMessage(child, 'phase');
        if (msg.name === 'rename-wait') {
          try {
            enableProbe({
              settingsPath,
              probeBinAbsPath: join(dir, 'bin', 'cah-status-probe.js'),
              backupPath: join(dir, 'cache', 'probe-backup.json'),
              logPath: join(dir, 'cache', 'envelope-probe.log'),
            });
          } catch (error) {
            probeError = error; // recorded, never allowed to escape
          }
          child.send('go');
          break;
        }
        child.send('go');
      }
      const { type, ...skillResult } = await awaitChildMessage(child, 'result');
      child.send('bye');
      await awaitChildExit(child);
      childGone = true;

      assert.ok(probeError,
        `enableProbe must throw while the skill holds the lock; stderr:\n${stderr}`);
      assert.ok(probeError instanceof ProbeBusyError,
        `the busy lock must surface as ProbeBusyError, got ${probeError.name}`);
      assert.deepEqual(skillResult, { published: true, conflict: false },
        `the skill's save must succeed despite the probe's attempt; stderr:\n${stderr}`);

      const afterSkill = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(afterSkill.statusLine['cah-name'], 'clock',
        'the skill\'s statusLine must survive the probe interleave');
      const hookNames = (afterSkill.hooks.Stop || []).flatMap((entry) =>
        entry.hooks.map((hook) => hook['cah-name']));
      assert.ok(hookNames.includes('checkpoint-watch'),
        `the checkpoint-watch hook must be present; got ${JSON.stringify(hookNames)}`);
      assert.equal(existsSync(join(dir, 'cache', 'probe-backup.json')), false,
        'the refused probe must not have published a backup');

      // With the lock free, the same probe enable succeeds — and BOTH
      // first-party changes coexist afterward.
      enableProbe({
        settingsPath,
        probeBinAbsPath: join(dir, 'bin', 'cah-status-probe.js'),
        backupPath: join(dir, 'cache', 'probe-backup.json'),
        logPath: join(dir, 'cache', 'envelope-probe.log'),
      });
      const afterProbe = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(afterProbe.statusLine['cah-name'], 'probe',
        'the free-lock probe enable must arm the probe statusLine');
      const afterNames = (afterProbe.hooks.Stop || []).flatMap((entry) =>
        entry.hooks.map((hook) => hook['cah-name']));
      assert.ok(afterNames.includes('checkpoint-watch'),
        `both first-party changes must coexist; got ${JSON.stringify(afterNames)}`);
      assert.equal(existsSync(join(dir, 'cache', 'probe-backup.json')), true,
        'the successful probe enable must publish its backup');
    } finally {
      if (child && !childGone) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
