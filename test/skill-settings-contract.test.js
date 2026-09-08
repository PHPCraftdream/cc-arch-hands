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
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { UNSAFE_STATUSLINE_CHARS } from '../lib/probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Normalize CRLF -> LF once at the source: a Windows checkout (core.autocrlf)
// converts the checked-in LF line endings to CRLF, and every regex below
// anchored on `$`/end-of-line would otherwise capture a trailing \r.
const readSkill = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const CLOCK = readSkill(join(__dirname, '..', 'templates', 'skills', 'clock', 'SKILL.md'));
const WATCH = readSkill(
  join(__dirname, '..', 'templates', 'skills', 'checkpoint-watch', 'SKILL.md'));

function commandLines(text) {
  return text.match(/^node "<HOME>[^\n]*$/gm) || [];
}

// Faithful transcription of the "Lock settings.json for the whole
// read-modify-write cycle" + "Atomic write only — with a concurrent-edit
// check" rules both SKILL.md files publish. Steps as documented:
// 0. acquire the shared cross-process settings lock: mkdir
//    settings.json.lock (atomic across processes), write owner.json with our
//    pid + epoch ms, recover abandoned locks (owner file unreadable, holder
//    pid dead, or heartbeat more than 5 minutes old — the same lease window
//    lib/lease-lock.js uses for the companion bins) by renaming them aside
//    and deleting the renamed copy, wait ~25 ms between retries against a
//    live holder, and refuse to write anything if the lock cannot be taken
//    before the acquire deadline (hooks.acquireDeadlineMs scales the
//    published ~30 s wait down for tests; default 30000);
// 1. read the raw settings text;
// 2. apply the skill's own edits to the parsed object;
// 3. serialize with JSON.stringify(value, null, 2) + "\n";
// 4. write to a FRESH UNIQUE temp beside settings.json — never into an
//    existing settings.json.tmp* path;
// 5. immediately before the final rename, re-read settings.json and compare
//    byte for byte with the text from (1) — on mismatch, delete the temp and
//    refuse to publish;
// 6. only on match, rename the temp over settings.json;
// 7. release the lock on EVERY exit path, including the concurrent-edit
//    refusal, an unreadable-JSON abort, and any thrown error.
// hooks.beforeFinalRename is the test seam standing for "anything that can
// happen while the agent works" — the concurrent writer lands there, before
// the verification the rule mandates.
const LEASE_STALE_MS = 5 * 60 * 1000; // the published 5-minute lease window

function holderIsStale(owner) {
  if (!owner || !Number.isFinite(owner.timestamp)) return true;
  if (Date.now() - owner.timestamp > LEASE_STALE_MS) return true;
  try { process.kill(owner.pid, 0); return false; } catch (error) {
    return error.code !== 'EPERM'; // EPERM = alive but owned by someone else
  }
}

// Windows can throw a transient EPERM/EBUSY on rmSync of a directory whose
// entries were just created (AV scan / journaling lag) — the same class
// lib/lease-lock.js retries via its own TRANSIENT_LEASE_ERRORS set. A bare
// rmSync here would let that transient turn into a flaky test failure.
function rmDirWithRetry(path) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
      if (!transient || Date.now() >= deadline) throw error;
    }
  }
}

function documentedAtomicSave(settingsPath, mutator, hooks = {}) {
  const lockDir = settingsPath + '.lock';
  const deadline = Date.now() + (hooks.acquireDeadlineMs ?? 30_000);
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')); } catch { /* unreadable = abandoned */ }
      if (!holderIsStale(owner)) {
        if (Date.now() >= deadline) {
          return { published: false, conflict: true, reason: 'lock-timeout' };
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        continue;
      }
      const aside = lockDir + '.stale.' + Math.random().toString(36).slice(2);
      renameSync(lockDir, aside);
      rmDirWithRetry(aside);
    }
  }
  writeFileSync(join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\n');
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
    renameSync(temp, settingsPath);
    return { published: true, conflict: false };
  } finally {
    rmDirWithRetry(lockDir);
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
      assert.match(text, /settings\.json\.lock\.stale\.<random-suffix>/,
        `${name}: abandoned-lock recovery must rename the lock aside`);
      assert.match(text, /about 30 seconds/,
        `${name}: the bounded lock wait must be pinned`);
      assert.match(text, /ignores it/,
        `${name}: the non-cooperating-writer limitation must be stated`);
      assert.match(text, /Release the lock by deleting `settings\.json\.lock` in EVERY outcome/,
        `${name}: lock release on every exit path must be mandated`);
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
      const ownerPayload = JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\n';
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
        pid: deadPid, timestamp: Date.now(),
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
  mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const WITH_LOCK = ${withLock};
const LEASE_STALE_MS = 5 * 60 * 1000;
const [settingsPath, hookName] = process.argv.slice(2);
const lockDir = settingsPath + '.lock';
const bin = hookName === 'clock' ? 'cah-stamp.js' : 'cah-checkpoint-hint.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function awaitMessage() {
  return new Promise((resolve) => { process.once('message', resolve); });
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error.code === 'EPERM';
  }
}
// Windows can throw a transient EPERM/EBUSY on rmSync of a directory whose
// entries were just created (AV scan / journaling lag) — the same class
// lib/lease-lock.js retries via its own TRANSIENT_LEASE_ERRORS set. A bare
// rmSync here would let that transient turn into a flaky test failure.
function rmDirWithRetry(path) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
      if (!transient || Date.now() >= deadline) throw error;
    }
  }
}

let lockBlockedReported = false;
async function attemptLock() {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!lockBlockedReported) {
        lockBlockedReported = true;
        process.send({ type: 'lock-blocked' });
      }
      let owner = null;
      try { owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')); } catch {}
      const stale = !owner || !Number.isFinite(owner.timestamp)
        || Date.now() - owner.timestamp > LEASE_STALE_MS
        || !pidAlive(owner.pid);
      if (stale) {
        const aside = lockDir + '.stale.' + Math.random().toString(36).slice(2);
        renameSync(lockDir, aside);
        rmDirWithRetry(aside);
        continue;
      }
      if (Date.now() >= deadline) return false;
      await sleep(25);
    }
  }
}

async function main() {
try {
  if (WITH_LOCK) {
    const won = await attemptLock();
    if (!won) {
      process.send({ type: 'result', published: false, conflict: true, reason: 'lock-timeout' });
      await awaitMessage(); // 'bye'
      return;
    }
    writeFileSync(join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\\n');
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
  renameSync(temp, settingsPath);
  process.send({ type: 'result', published: true, conflict: false });
  await awaitMessage(); // 'bye'
} finally {
  if (WITH_LOCK) rmDirWithRetry(lockDir);
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
