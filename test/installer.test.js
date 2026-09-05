import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmdirSync, mkdtempSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';

import {
  SentinelBin, SentinelModelCommand, SentinelModelAgent, SentinelCodexAgent, SentinelSkill,
  LegacyModelCommand, LegacyModelAgent,
  SetForModelCommand, SetForModelAgent, SetForCodexAgent, SetForSkill,
  Ownership, classifyContent,
} from '../lib/sentinel.js';
import { AllModelCommands, AllCodexAgents, AllSkills } from '../lib/manifest.js';
import { Scope, StrictMissingRootError, SKILL_MANIFEST_LEAF } from '../lib/scope.js';
import { writeModelCommands, removeModelCommands } from '../lib/commands.js';
import { writeModelAgents, removeModelAgents } from '../lib/agents.js';
import { writeCodexAgents, removeCodexAgents } from '../lib/codex-agents.js';
import { removeBins } from '../lib/binstall.js';
import { writeSkills, removeSkills } from '../lib/skills.js';
import { embeddedTemplates, diskTemplates } from '../lib/templates.js';
import { writeFileAtomic, removeOwnedRegularFile, regularFileIdentity } from '../lib/fsutil.js';

const FABLE_ORACLE = [
  ['fl', 'claude-fable-5-1', 'low'],
  ['fm', 'claude-fable-5-1', 'medium'],
  ['fh', 'claude-fable-5-1', 'high'],
  ['fx', 'claude-fable-5-1', 'xhigh'],
  ['fxx', 'claude-fable-5-1', 'max'],
  ['f1l', 'claude-fable-5', 'low'],
  ['f1m', 'claude-fable-5', 'medium'],
  ['f1h', 'claude-fable-5', 'high'],
  ['f1x', 'claude-fable-5', 'xhigh'],
  ['f1xx', 'claude-fable-5', 'max'],
];

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cah-test-'));
}

function waitForWorker(worker) {
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`atomic-write worker exited with code ${code}`));
    });
  });
}

function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function runSkillWorker(action, dir, interlock, phase, subset = undefined) {
  const skillsUrl = new URL('../lib/skills.js', import.meta.url).href;
  const templatesUrl = new URL('../lib/templates.js', import.meta.url).href;
  const scopeUrl = new URL('../lib/scope.js', import.meta.url).href;
    const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = workerData.phase;
      const skills = await import(workerData.skillsUrl);
      const templates = await import(workerData.templatesUrl);
      const { Scope } = await import(workerData.scopeUrl);
      const scope = new Scope({ cwd: workerData.dir });
      const result = workerData.action === 'write'
        ? skills.writeSkills(templates.embeddedTemplates(), scope, workerData.subset
          ? { subset: workerData.subset } : {})
        : skills.removeSkills(templates.embeddedTemplates(), scope, workerData.subset
          ? { subset: workerData.subset } : {});
      parentPort.postMessage(result);
    })().catch((error) => {
      setImmediate(() => { throw error; });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { action, dir, interlock, phase, subset, skillsUrl, templatesUrl, scopeUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`skill worker exited with code ${code}`));
    });
  });
}

function runOwnedRemovalWorker(dest, interlock, phase, failures = undefined) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = workerData.phase;
      if (workerData.failures !== undefined) {
        process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = String(workerData.failures);
      }
      const fsutil = await import(workerData.fsutilUrl);
      const expected = fsutil.regularFileIdentity(workerData.dest);
      const result = fsutil.removeOwnedRegularFile(workerData.dest, expected);
      parentPort.postMessage(result);
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dest, interlock, phase, failures, fsutilUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`owned removal worker exited with code ${code}`));
    });
  });
}

function runLeafWriterWorker(kind, dir, interlock) {
  const moduleUrls = {
    commands: new URL('../lib/commands.js', import.meta.url).href,
    agents: new URL('../lib/agents.js', import.meta.url).href,
    codex: new URL('../lib/codex-agents.js', import.meta.url).href,
    scope: new URL('../lib/scope.js', import.meta.url).href,
  };
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = 'write-before-rename';
      const scopeModule = await import(workerData.scopeUrl);
      const scope = new scopeModule.Scope({ cwd: workerData.dir });
      const module = await import(workerData.writerUrl);
      const result = workerData.kind === 'commands'
        ? module.writeModelCommands(null, scope)
        : workerData.kind === 'agents'
          ? module.writeModelAgents(null, scope)
          : module.writeCodexAgents(null, scope);
      parentPort.postMessage(result);
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        kind,
        dir,
        interlock,
        writerUrl: moduleUrls[kind],
        scopeUrl: moduleUrls.scope,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`${kind} worker exited with code ${code}`));
    });
  });
}

function runAtomicRetryWorker(dest, interlock) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_RENAME_TRANSIENT_FAILURES = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = 'rename-retry';
      const fsutil = await import(workerData.fsutilUrl);
      const snapshot = fsutil.captureRegularFileSnapshot(workerData.dest);
      fsutil.writeFileAtomic(workerData.dest, 'new managed body\\n', {
        expectedDestination: snapshot.expectedDestination,
      });
      parentPort.postMessage('published');
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dest, interlock, fsutilUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`retry worker exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

describe('writeFileAtomic', () => {
  it('keeps normal umask/default modes and preserves an existing mode', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not portable on Windows');
      return;
    }
    const dir = tmpDir();
    const created = join(dir, 'created.txt');
    const existing = join(dir, 'existing.txt');
    writeFileAtomic(created, 'created\n');
    assert.equal(statSync(created).mode & 0o777, 0o666 & ~process.umask());
    writeFileSync(existing, 'before\n', { mode: 0o640 });
    writeFileAtomic(existing, 'after\n');
    assert.equal(statSync(existing).mode & 0o777, 0o640);
  });

  it('applies an explicit mode to the private temp before publication', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not portable on Windows');
      return;
    }
    const dir = tmpDir();
    const dest = join(dir, 'executable');
    writeFileAtomic(dest, '#!/usr/bin/env node\n', { mode: 0o755 });
    assert.equal(statSync(dest).mode & 0o777, 0o755);
  });

  it('does not follow or replace a predictable temp symlink', (t) => {
    const dir = tmpDir();
    const dest = join(dir, 'target.txt');
    const victim = join(dir, 'victim.txt');
    const predictable = `${dest}.cah-tmp`;
    writeFileSync(victim, 'outside stays intact\n');

    try {
      symlinkSync(victim, predictable, 'file');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('file symlink creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    writeFileAtomic(dest, 'complete payload\n');
    assert.equal(readFileSync(dest, 'utf8'), 'complete payload\n');
    assert.equal(readFileSync(victim, 'utf8'), 'outside stays intact\n');
    assert.equal(readFileSync(predictable, 'utf8'), 'outside stays intact\n');
  });

  it('leaves a foreign predictable temp untouched', () => {
    const dir = tmpDir();
    const dest = join(dir, 'target.txt');
    const predictable = `${dest}.cah-tmp`;
    writeFileSync(predictable, 'belongs to someone else\n');

    writeFileAtomic(dest, 'ours\n');
    assert.equal(readFileSync(dest, 'utf8'), 'ours\n');
    assert.equal(readFileSync(predictable, 'utf8'), 'belongs to someone else\n');
  });

  it('concurrent writers publish one complete payload and leave no owned temps', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'shared.bin');
    const payloads = ['A', 'B', 'C', 'D'].map((byte) => Buffer.alloc(256 * 1024, byte));
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const moduleUrl = new URL('../lib/fsutil.js', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { writeFileAtomic } = await import(workerData.moduleUrl);
        const state = new Int32Array(workerData.barrier);
        Atomics.add(state, 0, 1);
        Atomics.notify(state, 0);
        while (Atomics.load(state, 0) < workerData.total) {
          const observed = Atomics.load(state, 0);
          Atomics.wait(state, 0, observed);
        }
        writeFileAtomic(workerData.dest, Buffer.from(workerData.payload));
      })().catch((error) => {
        process.nextTick(() => { throw error; });
      });
    `;
    const workers = payloads.map((payload) => new Worker(workerSource, {
      eval: true,
      workerData: { barrier, dest, moduleUrl, payload, total: payloads.length },
    }));

    await Promise.all(workers.map(waitForWorker));
    const result = readFileSync(dest);
    assert.ok(payloads.some((payload) => payload.equals(result)));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.cah-tmp-')),
      [],
    );
  });

  it('cleans up its unique temp when publication fails', () => {
    const dir = tmpDir();
    const dest = join(dir, 'occupied-directory');
    mkdirSync(dest);

    assert.throws(() => writeFileAtomic(dest, 'cannot publish here'));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.cah-tmp-')),
      [],
    );
  });

  it('revalidates the expected leaf after an injected transient rename failure', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'retry-target.txt');
    const interlock = join(dir, 'rename-retry-interlock');
    writeFileSync(dest, 'old managed body\n');
    const running = runAtomicRetryWorker(dest, interlock);
    await waitForPath(`${interlock}.ready`);
    unlinkSync(dest);
    writeFileSync(dest, 'foreign successor\n', { mode: 0o640 });
    writeFileSync(`${interlock}.go`, 'go');
    await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(dest, 'utf8'), 'foreign successor\n');
    if (process.platform !== 'win32') assert.equal(statSync(dest).mode & 0o777, 0o640);
  });

  it('retries transient owned-file removal without leaving quarantine', () => {
    const dir = tmpDir();
    const dest = join(dir, 'remove-target.txt');
    writeFileSync(dest, 'owned\n');
    const identity = regularFileIdentity(dest);
    const old = process.env.CAH_TEST_ONLY;
    const oldFailures = process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = '2';
    try {
      assert.equal(removeOwnedRegularFile(dest, identity), true);
    } finally {
      if (old === undefined) delete process.env.CAH_TEST_ONLY; else process.env.CAH_TEST_ONLY = old;
      if (oldFailures === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES;
      else process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = oldFailures;
    }
    assert.ok(!existsSync(dest));
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.cah-owned-remove-')), []);
  });

  it('reserves an occupied quarantine namespace before touching the canonical leaf', () => {
    const dir = tmpDir();
    const dest = join(dir, 'occupied-quarantine.txt');
    const quarantine = `${dest}.cah-owned-remove`;
    writeFileSync(dest, 'owned A\n');
    const expected = regularFileIdentity(dest);
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'payload'), `${SentinelModelCommand}\n`);

    const result = removeOwnedRegularFile(dest, expected);
    assert.equal(result.removed, false);
    assert.equal(result.preservedPath, join(quarantine, 'payload'));
    assert.equal(readFileSync(dest, 'utf8'), 'owned A\n');
    assert.equal(readFileSync(join(quarantine, 'payload'), 'utf8'), `${SentinelModelCommand}\n`);
    assert.deepEqual(readdirSync(dir), ['occupied-quarantine.txt', 'occupied-quarantine.txt.cah-owned-remove']);
  });

  it('preserves B when B is displaced and C occupies the canonical name', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'three-party-remove.txt');
    const interlock = join(dir, 'three-party-remove-interlock');
    writeFileSync(dest, 'owned A\n');

    const running = runOwnedRemovalWorker(
      dest,
      interlock,
      'remove-before-rename,remove-after-rename',
    );
    await waitForPath(`${interlock}.remove-before-rename.ready`);
    unlinkSync(dest);
    writeFileSync(dest, 'foreign B\n');
    writeFileSync(`${interlock}.remove-before-rename.go`, 'go');

    await waitForPath(`${interlock}.remove-after-rename.ready`);
    writeFileSync(dest, 'successor C\n');
    writeFileSync(`${interlock}.remove-after-rename.go`, 'go');

    const result = await running;
    assert.equal(result.removed, false);
    assert.equal(
      result.preservedPath,
      `${dest}.cah-owned-remove\\payload`,
    );
    assert.equal(readFileSync(dest, 'utf8'), 'successor C\n');
    const quarantines = readdirSync(dir).filter((name) => name.includes('.cah-owned-remove'));
    assert.equal(quarantines.length, 1);
    assert.equal(readFileSync(result.preservedPath, 'utf8'), 'foreign B\n');
  });

  it('bounds repeated three-party races to one reported quarantine without hard links', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'repeated-three-party-remove.txt');
    const interlock = join(dir, 'repeated-three-party-remove-interlock');
    writeFileSync(dest, 'owned A\n');

    const running = runOwnedRemovalWorker(
      dest,
      interlock,
      'remove-before-rename,remove-after-rename',
    );
    await waitForPath(`${interlock}.remove-before-rename.ready`);
    unlinkSync(dest);
    writeFileSync(dest, 'foreign B\n');
    writeFileSync(`${interlock}.remove-before-rename.go`, 'go');
    await waitForPath(`${interlock}.remove-after-rename.ready`);
    writeFileSync(dest, 'successor C\n');
    writeFileSync(`${interlock}.remove-after-rename.go`, 'go');

    const first = await running;
    assert.equal(first.preservedPath, `${dest}.cah-owned-remove\\payload`);
    assert.equal(readFileSync(first.preservedPath, 'utf8'), 'foreign B\n');

    // Repeated reclaim attempts must refuse to move a new canonical inode
    // over the preserved slot. The same path is reported every time and B
    // remains recoverable; no hard-link restoration is involved.
    for (let attempt = 0; attempt < 3; attempt++) {
      unlinkSync(dest);
      writeFileSync(dest, `managed retry ${attempt}\n`);
      const retry = removeOwnedRegularFile(dest, regularFileIdentity(dest));
      assert.equal(retry.removed, false);
      assert.equal(retry.preservedPath, first.preservedPath);
      assert.equal(readFileSync(first.preservedPath, 'utf8'), 'foreign B\n');
      assert.equal(readFileSync(dest, 'utf8'), `managed retry ${attempt}\n`);
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.cah-owned-remove')),
      ['repeated-three-party-remove.txt.cah-owned-remove'],
    );
  });
});

// ---------------------------------------------------------------------------
// Fable model contract (fixed oracle, independent of manifest values)
// ---------------------------------------------------------------------------

describe('Fable model contract', () => {
  it('keeps all ten aliases pinned to their literal model and effort', () => {
    for (const [name, model, effort] of FABLE_ORACLE) {
      const matches = AllModelCommands.filter((entry) => entry.name === name);
      assert.equal(matches.length, 1, `${name} must occur exactly once in the model registry`);
      const [actual] = matches;
      assert.deepEqual(
        { model: actual.model, effort: actual.effort },
        { model, effort },
        `${name} mapping drifted`,
      );
    }
  });

  it('renders fixed command and agent frontmatter for top and previous Fable', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);
    writeModelAgents(null, scope);

    for (const [name, model, effort] of [
      ['fh', 'claude-fable-5-1', 'high'],
      ['f1h', 'claude-fable-5', 'high'],
    ]) {
      const command = readFileSync(join(dir, '.claude', 'commands', `${name}.md`), 'utf8');
      assert.ok(command.startsWith([
        '---',
        `description: ${model} effort=${effort}`,
        `model: ${model}`,
        `effort: ${effort}`,
        '---',
        '',
      ].join('\n')), `${name} command frontmatter drifted`);

      const agent = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8');
      assert.match(agent, new RegExp(`^---\\nname: ${name}\\ndescription: ${model} effort=${effort} \\(`));
      assert.ok(agent.includes(`\nmodel: ${model}\neffort: ${effort}\n---\n`), `${name} agent frontmatter drifted`);
      assert.ok(agent.includes(`reasoning effort: ${effort}.`), `${name} agent effort drifted`);
    }
  });
});

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

describe('classifyContent', () => {
  it('missing', () => {
    assert.equal(classifyContent(false, null, SetForModelCommand), Ownership.missing);
  });

  it('empty content present is foreign', () => {
    assert.equal(classifyContent(true, '', SetForModelCommand), Ownership.foreign);
  });

  it('new sentinel only is mine', () => {
    const body = `hello\n${SentinelModelCommand}\n`;
    assert.equal(classifyContent(true, body, SetForModelCommand), Ownership.mine);
  });

  it('legacy sentinel only is legacy', () => {
    const body = `hello\n${LegacyModelCommand}\n`;
    assert.equal(classifyContent(true, body, SetForModelCommand), Ownership.legacy);
  });

  it('both new and legacy yields legacy', () => {
    const body = `${SentinelModelCommand}\n${LegacyModelCommand}\n`;
    assert.equal(classifyContent(true, body, SetForModelCommand), Ownership.legacy);
  });

  it('empty-New set legacy match is legacy', () => {
    const set = { current: '', legacy: [LegacyModelCommand] };
    const body = `preamble\n${LegacyModelCommand}\n`;
    assert.equal(classifyContent(true, body, set), Ownership.legacy);
  });

  it('empty-New set no legacy match is foreign', () => {
    const set = { current: '', legacy: [LegacyModelCommand] };
    assert.equal(classifyContent(true, 'no marker', set), Ownership.foreign);
  });
});

// ---------------------------------------------------------------------------
// WriteModelCommands
// ---------------------------------------------------------------------------

describe('writeModelCommands', () => {
  it('empty dir installs all', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const { written, skipped } = writeModelCommands(null, scope);

    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const cmdDir = join(dir, '.claude', 'commands');
    const entries = readdirSync(cmdDir).filter((f) => f.endsWith('.md'));
    assert.equal(entries.length, AllModelCommands.length);

    for (const name of ['o2h', 'fh']) {
      const data = readFileSync(join(cmdDir, `${name}.md`), 'utf8');
      assert.ok(data.endsWith(`${SentinelModelCommand}\n`), `${name} must end with sentinel`);
      const mc = AllModelCommands.find((c) => c.name === name);
      assert.ok(data.includes(`description: ${mc.model} effort=${mc.effort}`));
    }
  });

  it('re-run is idempotent', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);
    const { written, skipped } = writeModelCommands(null, scope);

    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const cmdDir = join(dir, '.claude', 'commands');
    const entries = readdirSync(cmdDir).filter((f) => f.endsWith('.md'));
    assert.equal(entries.length, AllModelCommands.length);
  });

  it('foreign file is preserved and skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const foreignPath = join(cmdDir, 'o2x.md');
    const foreignBody = 'someone else owns this';
    writeFileSync(foreignPath, foreignBody);

    const { written, skipped } = writeModelCommands(null, scope);
    assert.equal(written, AllModelCommands.length - 1);
    assert.deepEqual(skipped, ['o2x.md']);

    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
    statSync(join(cmdDir, 'o2h.md'));
  });

  it('legacy file is migrated', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const legacyPath = join(cmdDir, 'o2h.md');
    writeFileSync(legacyPath, `---\ndescription: stale\n---\n\nold body\n${LegacyModelCommand}\n`);

    const { skipped } = writeModelCommands(null, scope);
    assert.deepEqual(skipped, []);

    const data = readFileSync(legacyPath, 'utf8');
    assert.ok(data.includes(SentinelModelCommand), 'must be stamped with new sentinel');
    assert.ok(!data.includes(LegacyModelCommand), 'legacy sentinel must be gone');
  });

  it('prunes orphans whose names are no longer in the manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const orphanMine = join(cmdDir, 'oldname.md');
    writeFileSync(orphanMine, `dropped\n${SentinelModelCommand}\n`);
    const orphanLegacy = join(cmdDir, 'oldlegacy.md');
    writeFileSync(orphanLegacy, `dropped legacy\n${LegacyModelCommand}\n`);
    const orphanForeign = join(cmdDir, 'someone-else.md');
    writeFileSync(orphanForeign, 'not yours');

    const { written, skipped, pruned } = writeModelCommands(null, scope);
    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);
    assert.equal(pruned, 2, 'mine + legacy orphans removed, foreign preserved');

    assert.throws(() => statSync(orphanMine), { code: 'ENOENT' });
    assert.throws(() => statSync(orphanLegacy), { code: 'ENOENT' });
    assert.equal(readFileSync(orphanForeign, 'utf8'), 'not yours');
  });
});

// ---------------------------------------------------------------------------
// RemoveModelCommands
// ---------------------------------------------------------------------------

describe('removeModelCommands', () => {
  it('all mine are removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);

    const { removed, skipped } = removeModelCommands(scope);
    assert.equal(removed, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const cmdDir = join(dir, '.claude', 'commands');
    assert.equal(readdirSync(cmdDir).length, 0);
  });

  it('mixed mine legacy foreign missing', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });

    const minePath = join(cmdDir, 'o2h.md');
    writeFileSync(minePath, `x\n${SentinelModelCommand}\n`);
    const legacyPath = join(cmdDir, 'o2m.md');
    writeFileSync(legacyPath, `y\n${LegacyModelCommand}\n`);
    const foreignPath = join(cmdDir, 'o2l.md');
    const foreignBody = 'not yours';
    writeFileSync(foreignPath, foreignBody);

    const { removed, skipped } = removeModelCommands(scope);
       assert.equal(removed, 2);
    assert.deepEqual(skipped, ['o2l.md']);

    assert.throws(() => statSync(minePath), { code: 'ENOENT' });
    assert.throws(() => statSync(legacyPath), { code: 'ENOENT' });
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });

  it('sweeps sentinel-owned orphan commands while preserving foreign files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const cmdDir = join(dir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const orphan = join(cmdDir, 'old-command.md');
    const foreign = join(cmdDir, 'foreign-command.md');
    writeFileSync(orphan, `${SentinelModelCommand}\n`);
    writeFileSync(foreign, 'foreign\n');
    const result = removeModelCommands(scope);
    assert.equal(result.pruned, 1);
    assert.throws(() => statSync(orphan), { code: 'ENOENT' });
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign\n');
  });
});

describe('Haiku no-effort aliases', () => {
  it('keeps only the stable no-effort aliases and does not alter Codex hl', () => {
    assert.deepEqual(
      AllModelCommands.filter((entry) => entry.model.includes('haiku')).map((entry) => [entry.name, entry.effort]),
      [['h', null], ['h45', null]],
    );
    assert.equal(AllCodexAgents.find((entry) => entry.name === 'hl').model, 'gpt-5.6-luna');
    for (const legacy of ['hl', 'hm', 'hh', 'h45l', 'h45m', 'h45h']) {
      assert.equal(AllModelCommands.some((entry) => entry.name === legacy), false, `${legacy} is a misleading legacy alias`);
    }
  });

  it('omits effort frontmatter for no-effort Haiku files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);
    writeModelAgents(null, scope);
    const command = readFileSync(join(dir, '.claude', 'commands', 'h.md'), 'utf8');
    const agent = readFileSync(join(dir, '.claude', 'agents', 'h.md'), 'utf8');
    assert.match(command, /description: claude-haiku-4-5\nmodel: claude-haiku-4-5\n---/);
    assert.doesNotMatch(command, /effort:/);
    assert.match(agent, /description: claude-haiku-4-5 \(Haiku \(top, 200k\)\)/);
    assert.match(agent, /model: claude-haiku-4-5\n---/);
    assert.doesNotMatch(agent, /effort:/);
  });
});

// ---------------------------------------------------------------------------
// WriteModelAgents
// ---------------------------------------------------------------------------

describe('writeModelAgents', () => {
  it('empty dir installs all without an a-prefix', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const { written, skipped } = writeModelAgents(null, scope);

    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const agentsDir = join(dir, '.claude', 'agents');
    for (const mc of AllModelCommands) {
      const data = readFileSync(join(agentsDir, `${mc.name}.md`), 'utf8');
      assert.ok(data.includes(`name: ${mc.name}`));
      assert.ok(!data.includes(`name: a${mc.name}`), `agent ${mc.name} must not carry legacy a-prefix in frontmatter`);
      assert.ok(data.includes(`model: ${mc.model}`));
      assert.ok(data.includes('Git safety'));
      assert.ok(data.includes('Test scope'));
      assert.ok(data.endsWith(`${SentinelModelAgent}\n`), `agent ${mc.name} must end with sentinel`);
    }
  });

  it('foreign is preserved and skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const foreignPath = join(agentsDir, 'o2h.md');
    const foreignBody = "someone else's agent";
    writeFileSync(foreignPath, foreignBody);

    const { written, skipped } = writeModelAgents(null, scope);
    assert.equal(written, AllModelCommands.length - 1);
    assert.deepEqual(skipped, ['o2h.md']);
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });

  it('prunes orphan agents whose names are no longer in the manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const orphanMine = join(agentsDir, 'oldname.md');
    writeFileSync(orphanMine, `dropped\n${SentinelModelAgent}\n`);
    const orphanLegacy = join(agentsDir, 'oldlegacy.md');
    writeFileSync(orphanLegacy, `dropped legacy\n${LegacyModelAgent}\n`);
    const orphanForeign = join(agentsDir, 'someone-else.md');
    writeFileSync(orphanForeign, 'not yours');

    const { written, skipped, pruned } = writeModelAgents(null, scope);
    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);
    assert.equal(pruned, 2, 'mine + legacy orphans removed, foreign preserved');

    assert.throws(() => statSync(orphanMine), { code: 'ENOENT' });
    assert.throws(() => statSync(orphanLegacy), { code: 'ENOENT' });
    assert.equal(readFileSync(orphanForeign, 'utf8'), 'not yours');
  });

  it('migrates legacy a-prefixed agents from pre-0.2.0 installs', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    // Pre-0.2.0 layout: agent file lives at agents/ao2h.md, stamped with our sentinel.
    const legacyPath = join(agentsDir, 'ao2h.md');
    writeFileSync(legacyPath, `old aoh body\n${SentinelModelAgent}\n`);
    // Also an a-prefixed file with the truly-legacy crush sentinel.
    const crushLegacyPath = join(agentsDir, 'ao2m.md');
    writeFileSync(crushLegacyPath, `old crush body\n${LegacyModelAgent}\n`);

    const { written, skipped, pruned } = writeModelAgents(null, scope);
    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);
    assert.equal(pruned, 2, 'both a-prefixed files swept');

    assert.throws(() => statSync(legacyPath), { code: 'ENOENT' });
    assert.throws(() => statSync(crushLegacyPath), { code: 'ENOENT' });

    // New files at the unprefixed paths.
    const newO47h = readFileSync(join(agentsDir, 'o2h.md'), 'utf8');
    assert.ok(newO47h.includes('name: o2h'));
    const newO47m = readFileSync(join(agentsDir, 'o2m.md'), 'utf8');
    assert.ok(newO47m.includes('name: o2m'));
  });
});

// ---------------------------------------------------------------------------
// RemoveModelAgents
// ---------------------------------------------------------------------------

describe('removeModelAgents', () => {
  it('all mine are removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelAgents(null, scope);

    const { removed, skipped } = removeModelAgents(scope);
    assert.equal(removed, AllModelCommands.length);
    assert.deepEqual(skipped, []);

    const agentsDir = join(dir, '.claude', 'agents');
    assert.equal(readdirSync(agentsDir).length, 0);
  });

  it('mixed mine legacy foreign missing at new (unprefixed) paths', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const minePath = join(agentsDir, 'o2h.md');
    writeFileSync(minePath, `x\n${SentinelModelAgent}\n`);
    const legacyPath = join(agentsDir, 'o2m.md');
    writeFileSync(legacyPath, `y\n${LegacyModelAgent}\n`);
    const foreignPath = join(agentsDir, 'o2l.md');
    const foreignBody = 'not yours';
    writeFileSync(foreignPath, foreignBody);

    const { removed, skipped } = removeModelAgents(scope);
    assert.equal(removed, 2);
    assert.deepEqual(skipped, ['o2l.md']);
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });

  it('removes a-prefixed legacy files from pre-0.2.0 installs', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    // Pre-0.2.0 file at agents/aoh.md with our sentinel.
    const legacyMine = join(agentsDir, 'aoh.md');
    writeFileSync(legacyMine, `legacy\n${SentinelModelAgent}\n`);
    // Pre-0.2.0 file at agents/ao2m.md with the crush-era sentinel.
    const legacyCrush = join(agentsDir, 'ao2m.md');
    writeFileSync(legacyCrush, `crush legacy\n${LegacyModelAgent}\n`);
    // Foreign a-prefixed file — must not be touched.
    const foreignA = join(agentsDir, 'ao2l.md');
    writeFileSync(foreignA, 'someone else');

    const { removed, skipped } = removeModelAgents(scope);
    assert.equal(removed, 2);
    assert.deepEqual(skipped, ['ao2l.md']);
    assert.throws(() => statSync(legacyMine), { code: 'ENOENT' });
    assert.throws(() => statSync(legacyCrush), { code: 'ENOENT' });
    assert.equal(readFileSync(foreignA, 'utf8'), 'someone else');
  });

  it('sweeps sentinel-owned orphan agents while preserving foreign files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const orphan = join(agentsDir, 'old-agent.md');
    const foreign = join(agentsDir, 'foreign-agent.md');
    writeFileSync(orphan, `${SentinelModelAgent}\n`);
    writeFileSync(foreign, 'foreign\n');
    const result = removeModelAgents(scope);
    assert.equal(result.pruned, 1);
    assert.throws(() => statSync(orphan), { code: 'ENOENT' });
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign\n');
  });
});

// ---------------------------------------------------------------------------
// WriteCodexAgents
// ---------------------------------------------------------------------------

describe('writeCodexAgents', () => {
  it('empty dir installs all Codex TOML agents', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const { written, skipped } = writeCodexAgents(null, scope);

    assert.equal(written, AllCodexAgents.length);
    assert.deepEqual(skipped, []);

    const agentsDir = join(dir, '.codex', 'agents');
    for (const agent of AllCodexAgents) {
      const data = readFileSync(join(agentsDir, `${agent.name}.toml`), 'utf8');
      assert.ok(data.startsWith(`${SentinelCodexAgent}\n`));
      assert.ok(data.includes(`name = "${agent.name}"`));
      assert.ok(data.includes(`model = "${agent.model}"`));
      assert.ok(data.includes(`model_reasoning_effort = "${agent.effort}"`));
      assert.ok(data.includes('developer_instructions = """'));
    }
  });

  it('foreign Codex agent is preserved and skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.codex', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const foreignPath = join(agentsDir, 'h55.toml');
    const foreignBody = 'someone else owns this';
    writeFileSync(foreignPath, foreignBody);

    const { written, skipped } = writeCodexAgents(null, scope);
    assert.equal(written, AllCodexAgents.length - 1);
    assert.deepEqual(skipped, ['h55.toml']);
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });

  it('prunes orphan Codex agents whose names are no longer in the manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.codex', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const orphanMine = join(agentsDir, 'old.toml');
    writeFileSync(orphanMine, `dropped\n${SentinelCodexAgent}\n`);
    const orphanForeign = join(agentsDir, 'foreign.toml');
    writeFileSync(orphanForeign, 'not yours');

    const { pruned } = writeCodexAgents(null, scope);
    assert.equal(pruned, 1);
    assert.throws(() => statSync(orphanMine), { code: 'ENOENT' });
    assert.equal(readFileSync(orphanForeign, 'utf8'), 'not yours');
  });
});

// ---------------------------------------------------------------------------
// RemoveCodexAgents
// ---------------------------------------------------------------------------

describe('removeCodexAgents', () => {
  it('all mine are removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeCodexAgents(null, scope);

    const { removed, skipped } = removeCodexAgents(scope);
    assert.equal(removed, AllCodexAgents.length);
    assert.deepEqual(skipped, []);

    const agentsDir = join(dir, '.codex', 'agents');
    assert.equal(readdirSync(agentsDir).length, 0);
  });

  it('mixed mine foreign missing', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.codex', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    const minePath = join(agentsDir, 'h55.toml');
    writeFileSync(minePath, `x\n${SentinelCodexAgent}\n`);
    const foreignPath = join(agentsDir, 'm55.toml');
    const foreignBody = 'not yours';
    writeFileSync(foreignPath, foreignBody);

    const { removed, skipped } = removeCodexAgents(scope);
    assert.equal(removed, 1);
    assert.deepEqual(skipped, ['m55.toml']);
    assert.throws(() => statSync(minePath), { code: 'ENOENT' });
    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBody);
  });

  it('sweeps sentinel-owned orphan Codex agents while preserving foreign files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.codex', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const orphan = join(agentsDir, 'old-agent.toml');
    const foreign = join(agentsDir, 'foreign-agent.toml');
    writeFileSync(orphan, `${SentinelCodexAgent}\n`);
    writeFileSync(foreign, 'foreign\n');
    const result = removeCodexAgents(scope);
    assert.equal(result.pruned, 1);
    assert.throws(() => statSync(orphan), { code: 'ENOENT' });
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign\n');
  });
});

describe('truthful deterministic quarantine reporting', () => {
  it('reports one preserved quarantine slot through every file consumer', () => {
    const cases = [
      {
        label: 'commands',
        dir: (root) => join(root, '.claude', 'commands'),
        leaf: 'orphan.md',
        sentinel: SentinelModelCommand,
        remove: removeModelCommands,
      },
      {
        label: 'agents',
        dir: (root) => join(root, '.claude', 'agents'),
        leaf: 'orphan.md',
        sentinel: SentinelModelAgent,
        remove: removeModelAgents,
      },
      {
        label: 'Codex agents',
        dir: (root) => join(root, '.codex', 'agents'),
        leaf: 'orphan.toml',
        sentinel: SentinelCodexAgent,
        remove: removeCodexAgents,
      },
      {
        label: 'bins',
        dir: (root) => join(root, 'bin-root', 'bin'),
        leaf: 'orphan.js',
        sentinel: SentinelBin,
        remove: removeBins,
        bin: true,
      },
    ];

    for (const entry of cases) {
      const root = tmpDir();
      const targetDir = entry.dir(root);
      mkdirSync(targetDir, { recursive: true });
      const orphan = join(targetDir, entry.leaf);
      const quarantine = `${orphan}.cah-owned-remove`;
      writeFileSync(orphan, `${entry.sentinel}\n`);
      mkdirSync(quarantine);
      writeFileSync(join(quarantine, 'payload'), `preserved ${entry.label}\n${entry.sentinel}\n`);

      const result = entry.bin
        ? entry.remove(join(root, 'bin-root'))
        : entry.remove(new Scope({ cwd: root }));
      const preserved = `${entry.leaf}.cah-owned-remove/payload`;
      const reported = entry.bin
        ? result.skipped.filter((value) => value.includes('orphan.js.cah-owned-remove/payload'))
        : result.skipped.filter((value) => value === preserved);

      assert.deepEqual(reported, [entry.bin ? 'bin/orphan.js.cah-owned-remove/payload' : preserved], entry.label);
      assert.equal(readFileSync(join(quarantine, 'payload'), 'utf8'), `preserved ${entry.label}\n${entry.sentinel}\n`);
      assert.equal(readFileSync(orphan, 'utf8'), `${entry.sentinel}\n`);
      assert.equal(
        result.skipped.filter((value) => value.includes('orphan')).length,
        1,
        `${entry.label} must report the bounded slot once`,
      );
    }

    const skillRoot = tmpDir();
    const orphanSkill = 'orphan-quarantine';
    const orphanDir = join(skillRoot, '.claude', 'skills', orphanSkill);
    mkdirSync(orphanDir, { recursive: true });
    const manifest = join(orphanDir, SKILL_MANIFEST_LEAF);
    const quarantine = `${manifest}.cah-owned-remove`;
    writeFileSync(manifest, `${SentinelSkill}\n`);
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'payload'), `preserved skill data\n${SentinelSkill}\n`);
    const skillResult = writeSkills(embeddedTemplates(), new Scope({ cwd: skillRoot }));
    assert.ok(skillResult.preserved.includes(`${orphanSkill}/${SKILL_MANIFEST_LEAF}.cah-owned-remove/payload`));
    assert.equal(readFileSync(join(quarantine, 'payload'), 'utf8'), `preserved skill data\n${SentinelSkill}\n`);

    const managedRoot = tmpDir();
    const managedScope = new Scope({ cwd: managedRoot });
    writeSkills(embeddedTemplates(), managedScope);
    const managedSkill = AllSkills[0];
    const managedManifest = join(
      managedRoot, '.claude', 'skills', managedSkill, SKILL_MANIFEST_LEAF,
    );
    const managedQuarantine = `${managedManifest}.cah-owned-remove`;
    mkdirSync(managedQuarantine);
    writeFileSync(join(managedQuarantine, 'payload'), `preserved managed skill data\n${SentinelSkill}\n`);
    const removeResult = removeSkills(embeddedTemplates(), managedScope, { subset: [managedSkill] });
    assert.ok(removeResult.preserved.includes(`${managedSkill}/${SKILL_MANIFEST_LEAF}.cah-owned-remove/payload`));
    assert.equal(readFileSync(join(managedQuarantine, 'payload'), 'utf8'), `preserved managed skill data\n${SentinelSkill}\n`);
  });
});

describe('shared leaf publication', () => {
  for (const [kind, install, leaf] of [
    ['commands', (scope) => writeModelCommands(null, scope), ['.claude', 'commands', 'fl.md']],
    ['agents', (scope) => writeModelAgents(null, scope), ['.claude', 'agents', 'fl.md']],
    ['codex', (scope) => writeCodexAgents(null, scope), ['.codex', 'agents', 'l55.toml']],
  ]) {
    it(`${kind} refuses a foreign successor and preserves its mode`, async () => {
      const dir = tmpDir();
      const scope = new Scope({ cwd: dir });
      install(scope);
      const destination = join(dir, ...leaf);
      const interlock = join(dir, `${kind}-leaf-successor-interlock`);
      const running = runLeafWriterWorker(kind, dir, interlock);
      await waitForPath(`${interlock}.ready`);
      unlinkSync(destination);
      writeFileSync(destination, 'foreign successor\n', { mode: 0o640 });
      writeFileSync(`${interlock}.go`, 'go');
      await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
      assert.equal(readFileSync(destination, 'utf8'), 'foreign successor\n');
      if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o640);
    });
  }
});

// ---------------------------------------------------------------------------
// WriteSkills
// ---------------------------------------------------------------------------

describe('writeSkills', () => {
  it('canonicalizes a symlinked scope ancestor on first install', (t) => {
    const dir = tmpDir();
    const realScope = join(dir, 'real-scope');
    const linkedScope = join(dir, 'linked-scope');
    mkdirSync(realScope);
    try {
      symlinkSync(realScope, linkedScope, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const scope = new Scope({ cwd: linkedScope });
    writeSkills(embeddedTemplates(), scope, { subset: [AllSkills[0]] });
    assert.ok(existsSync(join(realScope, '.claude', 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
    assert.ok(existsSync(join(linkedScope, '.claude', 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
  });

  it('canonicalizes an existing symlinked .claude/skills root', (t) => {
    const dir = tmpDir();
    const realClaude = join(dir, 'real-claude');
    const linkedClaude = join(dir, '.claude');
    mkdirSync(realClaude);
    try {
      symlinkSync(realClaude, linkedClaude, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const scope = new Scope({ cwd: dir });
    writeSkills(embeddedTemplates(), scope, { subset: [AllSkills[0]] });
    assert.ok(existsSync(join(realClaude, 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
    assert.ok(existsSync(join(linkedClaude, 'skills', AllSkills[0], SKILL_MANIFEST_LEAF)));
  });

  it('embedded smoke install', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();

    const { written, skipped } = writeSkills(tpl, scope);
    assert.equal(written, AllSkills.length);
    assert.deepEqual(skipped, []);

    for (const name of AllSkills) {
      const data = readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8');
      assert.ok(data.includes(SentinelSkill));
    }
  });

  it('re-run is idempotent and does not double-stamp', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();

    writeSkills(tpl, scope);
    const { written, skipped } = writeSkills(tpl, scope);
    assert.equal(written, AllSkills.length);
    assert.deepEqual(skipped, []);

    for (const name of AllSkills) {
      const data = readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8');
      const count = data.split(SentinelSkill).length - 1;
      assert.equal(count, 1, `sentinel must appear exactly once, got ${count}`);
    }
  });

  it('foreign skill is skipped', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const tplRoot = tmpDir();
    const skillDir = join(tplRoot, 'skills', 'mytestskill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# my skill\n');
    const tpl = diskTemplates(tplRoot);

    const origSkills = [...AllSkills];
    AllSkills.length = 0;
    AllSkills.push('mytestskill');

    try {
      const destSkill = join(dir, '.claude', 'skills', 'mytestskill');
      mkdirSync(destSkill, { recursive: true });
      const foreignBody = 'someone else owns this skill';
      writeFileSync(join(destSkill, SKILL_MANIFEST_LEAF), foreignBody);

      const { written, skipped } = writeSkills(tpl, scope);
      assert.equal(written, 0);
      assert.deepEqual(skipped, ['mytestskill']);
      assert.equal(readFileSync(join(destSkill, SKILL_MANIFEST_LEAF), 'utf8'), foreignBody);
    } finally {
      AllSkills.length = 0;
      AllSkills.push(...origSkills);
    }
  });

  it('foreign selected skill with a user symlink safely skips write and removal', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    const link = join(destDir, 'user-link');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(destDir, SKILL_MANIFEST_LEAF), 'foreign manifest\n');
    writeFileSync(join(outside, 'data.txt'), 'outside data\n');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# managed template\n') },
      ],
    };

    assert.deepEqual(writeSkills(tpl, scope, { subset: [name] }).skipped, [name]);
    assert.deepEqual(removeSkills(tpl, scope, { subset: [name] }).skipped, [name]);
    assert.equal(readFileSync(join(destDir, SKILL_MANIFEST_LEAF), 'utf8'), 'foreign manifest\n');
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside data\n');
  });

  it('managed skill preserves a user-extra symlink across write and remove', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    const link = join(destDir, 'user-link');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(destDir, SKILL_MANIFEST_LEAF), `# old managed\n${SentinelSkill}\n`);
    writeFileSync(join(outside, 'data.txt'), 'outside data\n');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# current managed\n') },
      ],
    };

    const written = writeSkills(tpl, scope, { subset: [name] });
    assert.ok(written.preserved.includes(`${name}/user-link`));
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside data\n');

    const removed = removeSkills(tpl, scope, { subset: [name] });
    assert.deepEqual(removed.preserved, [name]);
    assert.ok(!existsSync(join(destDir, SKILL_MANIFEST_LEAF)));
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside data\n');
  });

  it('subset install ignores an unrelated foreign skill containing a symlink', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const [selected, unrelated] = AllSkills;
    const unrelatedDir = join(dir, '.claude', 'skills', unrelated);
    const outside = join(dir, 'outside');
    mkdirSync(unrelatedDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(unrelatedDir, SKILL_MANIFEST_LEAF), 'foreign manifest\n');
    try {
      symlinkSync(
        outside,
        join(unrelatedDir, 'user-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# selected\n') },
      ],
    };

    const result = writeSkills(tpl, scope, { subset: [selected] });
    assert.equal(result.written, 1);
    assert.ok(existsSync(join(dir, '.claude', 'skills', selected, SKILL_MANIFEST_LEAF)));
    assert.equal(readFileSync(join(unrelatedDir, SKILL_MANIFEST_LEAF), 'utf8'), 'foreign manifest\n');
  });

  it('prunes orphan skill directories whose names are no longer in the manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();

    const skillsDir = join(dir, '.claude', 'skills');
    const orphanMineDir = join(skillsDir, 'oldskill');
    mkdirSync(orphanMineDir, { recursive: true });
    writeFileSync(join(orphanMineDir, SKILL_MANIFEST_LEAF), `# old skill\n${SentinelSkill}\n`);

    const orphanForeignDir = join(skillsDir, 'foreignskill');
    mkdirSync(orphanForeignDir, { recursive: true });
    writeFileSync(join(orphanForeignDir, SKILL_MANIFEST_LEAF), 'not ours');

    const { written, skipped, pruned } = writeSkills(tpl, scope);
    assert.equal(written, AllSkills.length);
    assert.deepEqual(skipped, []);
    assert.equal(pruned, 1, 'mine orphan dir removed, foreign preserved');

    assert.throws(() => statSync(orphanMineDir), { code: 'ENOENT' });
    assert.equal(readFileSync(join(orphanForeignDir, SKILL_MANIFEST_LEAF), 'utf8'), 'not ours');
  });

  it('preserves legacy agent-tree skills for migration by the standalone package', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const legacySentinel = '<!-- cah-agent-tree:v1 -->';

    for (const name of ['agent', 'agent-new']) {
      const legacyDir = join(skillsDir, name);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, SKILL_MANIFEST_LEAF), `# ${name}\n${legacySentinel}\n`);
      writeFileSync(join(legacyDir, 'legacy-asset.txt'), `${name} data\n`);
    }

    const { pruned } = writeSkills(embeddedTemplates(), scope);
    assert.equal(pruned, 0, 'legacy agent-tree dirs belong to the standalone package');

    for (const name of ['agent', 'agent-new']) {
      const legacyDir = join(skillsDir, name);
      assert.equal(
        readFileSync(join(legacyDir, SKILL_MANIFEST_LEAF), 'utf8'),
        `# ${name}\n${legacySentinel}\n`,
      );
      assert.equal(readFileSync(join(legacyDir, 'legacy-asset.txt'), 'utf8'), `${name} data\n`);
    }
  });

  it('source SKILL.md already stamped is copied verbatim', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const tplRoot = tmpDir();
    const skillDir = join(tplRoot, 'skills', 'prestamped');
    mkdirSync(skillDir, { recursive: true });
    const stamped = `# pre-stamped skill\n\nbody\n\n${SentinelSkill}\n`;
    writeFileSync(join(skillDir, 'SKILL.md'), stamped);
    const tpl = diskTemplates(tplRoot);

    const origSkills = [...AllSkills];
    AllSkills.length = 0;
    AllSkills.push('prestamped');

    try {
      const { written, skipped } = writeSkills(tpl, scope);
      assert.equal(written, 1);
      assert.deepEqual(skipped, []);

      const got = readFileSync(join(dir, '.claude', 'skills', 'prestamped', SKILL_MANIFEST_LEAF), 'utf8');
      assert.equal(got, stamped);
    } finally {
      AllSkills.length = 0;
      AllSkills.push(...origSkills);
    }
  });

  it('rejects duplicate relPaths before writing any skill files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# first\n') },
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# duplicate\n') },
      ],
    };

    assert.throws(
      () => writeSkills(tpl, scope, { subset: [name] }),
      /duplicate template relPath SKILL\.md/,
    );
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('rejects path escapes before the outside victim can change', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'must survive\n');

    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: '../../../victim.txt', bytes: Buffer.from('pwned\n') },
      ],
    };

    assert.throws(() => writeSkills(tpl, scope, { subset: [name] }), /invalid segment|escapes/i);
    assert.equal(readFileSync(victim, 'utf8'), 'must survive\n');
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('rejects absolute, device, mixed-separator, alias, and reserved paths', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const badPaths = [
      '/absolute.txt',
      'C:/absolute.txt',
      '//server/share/absolute.txt',
      '//?/C:/device.txt',
      'nested\\mixed/file.txt',
      'nested//empty.txt',
      './dot.txt',
      'nested/../escape.txt',
      'alias./file.txt',
      'alias /file.txt',
      'CON.txt',
      'nested/NUL',
      `nul\0byte.txt`,
    ];

    for (const relPath of badPaths) {
      const files = [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath, bytes: Buffer.from('bad\n') },
      ];
      assert.throws(
        () => writeSkills({ skillTree: () => files }, scope, { subset: [name] }),
        /relative|invalid segment|mixed separators|Windows separators|NUL|alias|device|escapes/i,
        relPath,
      );
    }
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('rejects malformed template bytes and validates all selected trees first', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const [first, second] = AllSkills;
    const trees = new Map([
      [first, [{ relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# first\n') }]],
      [second, [{ relPath: SKILL_MANIFEST_LEAF, bytes: 'not bytes' }]],
    ]);

    assert.throws(
      () => writeSkills({ skillTree: (name) => trees.get(name) }, scope, {
        subset: [first, second],
      }),
      /bytes must be Buffer or Uint8Array/,
    );
    assert.ok(!existsSync(join(dir, '.claude', 'skills', first, SKILL_MANIFEST_LEAF)));
  });

  it('rejects case-insensitive file and directory-prefix collisions', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const collisionTrees = [
      [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/readme.txt', bytes: Buffer.from('one\n') },
        { relPath: 'ASSETS/README.TXT', bytes: Buffer.from('two\n') },
      ],
      [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets', bytes: Buffer.from('file\n') },
        { relPath: 'assets/data.txt', bytes: Buffer.from('child\n') },
      ],
    ];
    for (const files of collisionTrees) {
      assert.throws(
        () => writeSkills({ skillTree: () => files }, scope, { subset: [name] }),
        /colliding template relPath/,
      );
    }
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('does not follow a symlink or junction directory outside the skill root', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);

    try {
      symlinkSync(outside, join(destDir, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/payload.txt', bytes: Buffer.from('must not escape\n') },
      ],
    };
    assert.throws(
      () => writeSkills(tpl, scope, { subset: [name] }),
      /symlink|junction|reparse|not a directory/i,
    );
    assert.ok(!existsSync(join(outside, 'payload.txt')));
  });

  it('accepts a valid multi-file skill tree with an exact root manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const tplRoot = tmpDir();
    const skillRoot = join(tplRoot, 'skills', name);
    mkdirSync(join(skillRoot, 'assets'), { recursive: true });
    writeFileSync(join(skillRoot, SKILL_MANIFEST_LEAF), '# multi-file skill\n');
    writeFileSync(join(skillRoot, 'assets', 'guide.txt'), 'companion data\n');

    const { written, skipped } = writeSkills(
      diskTemplates(tplRoot), scope, { subset: [name] },
    );
    assert.equal(written, 1);
    assert.deepEqual(skipped, []);
    assert.ok(readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8')
      .includes(SentinelSkill));
    assert.equal(
      readFileSync(join(dir, '.claude', 'skills', name, 'assets', 'guide.txt'), 'utf8'),
      'companion data\n',
    );
  });

  it('rejects lowercase or nested manifest paths even when they are the only manifests', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    for (const files of [
      [{ relPath: 'skill.md', bytes: Buffer.from('lowercase\n') }],
      [{ relPath: 'foo/SKILL.md', bytes: Buffer.from('nested\n') }],
    ]) {
      assert.throws(
        () => writeSkills({ skillTree: () => files }, scope, { subset: [name] }),
        /exactly one root SKILL\.md/,
      );
    }
    assert.ok(!existsSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)));
  });

  it('fails closed when a managed skill ancestor is replaced before owned write', async (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside-write-victim');
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'write-ancestor-replacement-interlock');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(manifest, `${SentinelSkill}\n`);
    writeFileSync(join(outside, SKILL_MANIFEST_LEAF), 'outside must survive\n');

    try {
      const probe = join(dir, 'directory-link-probe');
      symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
      unlinkSync(probe);
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const running = runSkillWorker('write', dir, interlock, 'write-before-owned-write');
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    rmdirSync(destDir);
    symlinkSync(outside, destDir, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(`${interlock}.go`, 'go');

    await assert.rejects(
      running,
      /managed (skill parent|destination parent) changed concurrently|refusing operation/,
    );
    assert.equal(readFileSync(join(outside, SKILL_MANIFEST_LEAF), 'utf8'), 'outside must survive\n');
    assert.equal(readFileSync(manifest, 'utf8'), 'outside must survive\n');
  });

  it('fails closed when the manifest leaf is replaced before atomic publication', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'write-leaf-replacement-interlock');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(manifest, `${SentinelSkill}\n`);

    const running = runSkillWorker('write', dir, interlock, 'write-before-rename', [name]);
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    writeFileSync(manifest, 'foreign successor\n');
    writeFileSync(`${interlock}.go`, 'go');

    await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(manifest, 'utf8'), 'foreign successor\n');
    assert.deepEqual(
      readdirSync(destDir).filter((entry) => entry.includes('.cah-tmp-')),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// RemoveSkills
// ---------------------------------------------------------------------------

describe('removeSkills', () => {
  it('mine removed', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const { removed, skipped } = removeSkills(tpl, scope);
    assert.equal(removed, AllSkills.length);
    assert.deepEqual(skipped, []);

    for (const name of AllSkills) {
      assert.throws(() => statSync(join(dir, '.claude', 'skills', name)), { code: 'ENOENT' });
    }
  });

  it('foreign kept and recorded', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const origSkills = [...AllSkills];
    AllSkills.length = 0;
    AllSkills.push('foreignskill');

    try {
      const destDir = join(dir, '.claude', 'skills', 'foreignskill');
      mkdirSync(destDir, { recursive: true });
      const foreignBody = 'not ours';
      writeFileSync(join(destDir, SKILL_MANIFEST_LEAF), foreignBody);

      const { removed, skipped } = removeSkills(embeddedTemplates(), scope);
      assert.equal(removed, 0);
      assert.deepEqual(skipped, ['foreignskill']);
      assert.equal(readFileSync(join(destDir, SKILL_MANIFEST_LEAF), 'utf8'), foreignBody);
    } finally {
      AllSkills.length = 0;
      AllSkills.push(...origSkills);
    }
  });

  it('missing is no-op', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    const { removed, skipped } = removeSkills(embeddedTemplates(), scope);
    assert.equal(removed, 0);
    assert.deepEqual(skipped, []);
  });

  it('preserves the original ownership decision when the manifest is replaced before capture', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'remove-manifest-capture-interlock');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(manifest, `original A\n${SentinelSkill}\n`);

    const running = runSkillWorker(
      'remove',
      dir,
      interlock,
      'remove-before-owned-capture',
      [name],
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    writeFileSync(manifest, `successor B\n${SentinelSkill}\n`);
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.removed, 0);
    assert.deepEqual(result.preserved, [name]);
    assert.equal(readFileSync(manifest, 'utf8'), `successor B\n${SentinelSkill}\n`);
  });

  it('rejects an unvalidated relPath escape without deleting the victim', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const [first, second] = AllSkills;
    const firstManifest = join(dir, '.claude', 'skills', first, SKILL_MANIFEST_LEAF);
    const destDir = join(dir, '.claude', 'skills', second);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const victim = join(dir, 'victim.txt');
    mkdirSync(join(dir, '.claude', 'skills', first), { recursive: true });
    mkdirSync(destDir, { recursive: true });
    writeFileSync(firstManifest, `# first managed\n${SentinelSkill}\n`);
    writeFileSync(manifest, `# managed\n${SentinelSkill}\n`);
    writeFileSync(victim, 'must not be deleted\n');
    const tpl = {
      skillTree: (name) => name === first
        ? [{ relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# first\n') }]
        : [
          { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# second\n') },
          { relPath: '../../../victim.txt', bytes: Buffer.from('victim\n') },
        ],
    };

    assert.throws(
      () => removeSkills(tpl, scope, { subset: [first, second] }),
      /invalid segment|escapes/i,
    );
    assert.equal(readFileSync(victim, 'utf8'), 'must not be deleted\n');
    assert.ok(existsSync(firstManifest));
    assert.ok(existsSync(manifest));
  });

  it('rejects a symlink or junction traversal before removing anything', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside');
    const outsideFile = join(outside, 'owned.txt');
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(manifest, `# managed\n${SentinelSkill}\n`);
    writeFileSync(outsideFile, 'outside stays\n');

    try {
      symlinkSync(outside, join(destDir, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/owned.txt', bytes: Buffer.from('owned\n') },
      ],
    };
    assert.throws(
      () => removeSkills(tpl, scope, { subset: [name] }),
      /symlink|junction|reparse|not a directory/i,
    );
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside stays\n');
    assert.ok(existsSync(manifest));
  });

  it('removes valid nested owned files while preserving user data', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const owned = join(destDir, 'assets', 'owned.txt');
    const userFile = join(destDir, 'notes.txt');
    mkdirSync(join(destDir, 'assets'), { recursive: true });
    writeFileSync(manifest, `# managed\n${SentinelSkill}\n`);
    writeFileSync(owned, 'owned\n');
    writeFileSync(userFile, 'keep\n');
    const tpl = {
      skillTree: () => [
        { relPath: SKILL_MANIFEST_LEAF, bytes: Buffer.from('# skill\n') },
        { relPath: 'assets/owned.txt', bytes: new Uint8Array([1, 2, 3]) },
      ],
    };

    const result = removeSkills(tpl, scope, { subset: [name] });
    assert.equal(result.removed, 0);
    assert.deepEqual(result.preserved, [name]);
    assert.ok(!existsSync(manifest));
    assert.ok(!existsSync(owned));
    assert.equal(readFileSync(userFile, 'utf8'), 'keep\n');
  });
});

// ---------------------------------------------------------------------------
// Skill data-loss protection (review H1/H2/M5)
// ---------------------------------------------------------------------------

describe('skill data-loss protection', () => {
  it('writeSkills preserves user files dropped into a managed skill dir', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const name = AllSkills[0];
    const userFile = join(dir, '.claude', 'skills', name, 'my-notes.md');
    writeFileSync(userFile, 'my private notes');

    const { preserved } = writeSkills(tpl, scope); // reinstall
    assert.equal(readFileSync(userFile, 'utf8'), 'my private notes');
    assert.ok(preserved.includes(`${name}/my-notes.md`));
    // the manifest is still rewritten (and stamped) alongside
    const manifest = readFileSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF), 'utf8');
    assert.ok(manifest.includes(SentinelSkill));
  });

  it('removeSkills keeps user files, removing only our manifest', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    const name = AllSkills[0];
    const userFile = join(dir, '.claude', 'skills', name, 'keep.md');
    writeFileSync(userFile, 'keep me');

    const { removed, preserved } = removeSkills(tpl, scope);
    assert.ok(preserved.includes(name));
    // the skill with user data is reported under preserved, not removed
    assert.equal(removed, AllSkills.length - 1);
    assert.equal(readFileSync(userFile, 'utf8'), 'keep me');
    assert.throws(
      () => statSync(join(dir, '.claude', 'skills', name, SKILL_MANIFEST_LEAF)),
      { code: 'ENOENT' },
    );
  });

  it('pruneOrphanDirs spares a copied skill dir that holds extra user files', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);

    // Simulate `cp -r ~/.claude/skills/<x> ~/.claude/skills/my-custom-copy`
    // followed by the user adding their own file.
    const copyDir = join(dir, '.claude', 'skills', 'my-custom-copy');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, SKILL_MANIFEST_LEAF), `# copy\n${SentinelSkill}\n`);
    writeFileSync(join(copyDir, 'extra.md'), 'user data');

    const { preserved, pruned } = writeSkills(tpl, scope);
    assert.equal(pruned, 0);
    assert.ok(preserved.some((p) => p.startsWith('my-custom-copy')));
    assert.equal(readFileSync(join(copyDir, 'extra.md'), 'utf8'), 'user data');
  });

  it('pruneOrphanDirs preserves an orphan with a user symlink without following it', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const orphanDir = join(skillsDir, 'orphan-with-link');
    const outside = join(dir, 'outside');
    const link = join(orphanDir, 'user-link');
    mkdirSync(orphanDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(orphanDir, SKILL_MANIFEST_LEAF), `# orphan\n${SentinelSkill}\n`);
    writeFileSync(join(outside, 'data.txt'), 'outside stays\n');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const result = writeSkills(embeddedTemplates(), scope);
    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('orphan-with-link')));
    assert.equal(readFileSync(join(link, 'data.txt'), 'utf8'), 'outside stays\n');
  });

  it('pruneOrphanDirs preserves an orphan containing an empty user directory', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const orphanDir = join(dir, '.claude', 'skills', 'orphan-with-empty-dir');
    const emptyDir = join(orphanDir, 'empty-user-dir');
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(orphanDir, SKILL_MANIFEST_LEAF), `# orphan\n${SentinelSkill}\n`);

    const result = writeSkills(embeddedTemplates(), scope);
    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('orphan-with-empty-dir')));
    assert.ok(statSync(emptyDir).isDirectory());
    assert.deepEqual(readdirSync(emptyDir), []);
  });

  it('pruneOrphanDirs preserves an entry appearing before final rmdir', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const orphanDir = join(skillsDir, 'race-orphan');
    const interlock = join(dir, 'prune-final-rmdir-interlock');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, SKILL_MANIFEST_LEAF), `# orphan\n${SentinelSkill}\n`);

    const running = runSkillWorker('write', dir, interlock, 'prune-before-rmdir');
    await waitForPath(`${interlock}.ready`);
    const userFile = join(orphanDir, 'user-created-during-prune.txt');
    writeFileSync(userFile, 'must survive\n');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('race-orphan')));
    assert.equal(readFileSync(userFile, 'utf8'), 'must survive\n');
  });

  it('pruneOrphanDirs preserves a manifest replaced by a symlink after validation', async (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const skillsDir = join(dir, '.claude', 'skills');
    const orphanDir = join(skillsDir, 'replacement-orphan');
    const manifest = join(orphanDir, SKILL_MANIFEST_LEAF);
    const outside = join(dir, 'outside-manifest.txt');
    const interlock = join(dir, 'prune-manifest-interlock');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(manifest, `# orphan\n${SentinelSkill}\n`);
    writeFileSync(outside, 'foreign target\n');

    try {
      const probe = join(dir, 'symlink-probe');
      symlinkSync(outside, probe, 'file');
      unlinkSync(probe);
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('file symlink creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const running = runSkillWorker('write', dir, interlock, 'prune-before-manifest-remove');
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    symlinkSync(outside, manifest, 'file');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.pruned, 0);
    assert.ok(result.preserved.some((value) => value.startsWith('replacement-orphan')));
    assert.equal(readFileSync(outside, 'utf8'), 'foreign target\n');
    assert.equal(readFileSync(manifest, 'utf8'), 'foreign target\n');
  });

  it('removeSkills preserves an entry appearing before final rmdir', async () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const tpl = embeddedTemplates();
    writeSkills(tpl, scope);
    const first = AllSkills[0];
    const firstDir = join(dir, '.claude', 'skills', first);
    const interlock = join(dir, 'remove-final-rmdir-interlock');

    const running = runSkillWorker('remove', dir, interlock, 'remove-before-rmdir');
    await waitForPath(`${interlock}.ready`);
    const userFile = join(firstDir, 'user-created-during-remove.txt');
    writeFileSync(userFile, 'must survive\n');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.removed, AllSkills.length - 1);
    assert.deepEqual(result.preserved, [first]);
    assert.equal(readFileSync(userFile, 'utf8'), 'must survive\n');
  });

  it('preserves an outside victim and successor when an ancestor is replaced before owned removal', async (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const name = AllSkills[0];
    const destDir = join(dir, '.claude', 'skills', name);
    const outside = join(dir, 'outside-remove-victim');
    const manifest = join(destDir, SKILL_MANIFEST_LEAF);
    const interlock = join(dir, 'remove-ancestor-replacement-interlock');
    mkdirSync(destDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(manifest, `${SentinelSkill}\n`);
    writeFileSync(join(outside, SKILL_MANIFEST_LEAF), 'outside must survive\n');

    try {
      const probe = join(dir, 'directory-link-probe');
      symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
      unlinkSync(probe);
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('junction creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const running = runSkillWorker('remove', dir, interlock, 'remove-before-owned-delete');
    await waitForPath(`${interlock}.ready`);
    unlinkSync(manifest);
    rmdirSync(destDir);
    symlinkSync(outside, destDir, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;

    assert.equal(result.removed, 0);
    assert.deepEqual(result.preserved, [name]);
    assert.ok(lstatSync(destDir).isSymbolicLink(), 'replacement successor must remain');
    assert.equal(readFileSync(join(outside, SKILL_MANIFEST_LEAF), 'utf8'), 'outside must survive\n');
    assert.equal(readFileSync(manifest, 'utf8'), 'outside must survive\n');
  });
});

// ---------------------------------------------------------------------------
// Strict scope
// ---------------------------------------------------------------------------

describe('strict scope', () => {
  it('missing .claude with strict throws StrictMissingRootError', () => {
    const dir = tmpDir();
    const scope = new Scope({ strict: true, cwd: dir });

    assert.throws(() => scope.resolveCommandsDir(), (e) => e instanceof StrictMissingRootError);
    assert.throws(() => scope.resolveAgentsDir(), (e) => e instanceof StrictMissingRootError);
    assert.throws(() => scope.resolveSkillsDir(), (e) => e instanceof StrictMissingRootError);
  });

  it('existing .claude with strict resolves cleanly', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.claude'));
    const scope = new Scope({ strict: true, cwd: dir });

    assert.equal(scope.resolveCommandsDir(), join(dir, '.claude', 'commands'));
  });

  it('.claude exists as a file, not a dir — strict refuses', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.claude'), 'not a dir');
    const scope = new Scope({ strict: true, cwd: dir });

    assert.throws(() => scope.resolveCommandsDir(), (e) => e instanceof StrictMissingRootError);
  });

  it('non-strict default ignores missing .claude', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });

    assert.equal(scope.resolveCommandsDir(), join(dir, '.claude', 'commands'));
  });

  it('writeModelCommands under strict refuses when .claude missing', () => {
    const dir = tmpDir();
    const scope = new Scope({ strict: true, cwd: dir });

    assert.throws(() => writeModelCommands(null, scope), (e) => e instanceof StrictMissingRootError);
  });

  it('writeModelCommands under strict succeeds when .claude exists', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.claude'));
    const scope = new Scope({ strict: true, cwd: dir });

    const { written, skipped } = writeModelCommands(null, scope);
    assert.equal(written, AllModelCommands.length);
    assert.deepEqual(skipped, []);
  });

  it('describe reflects strict mode', () => {
    const desc = new Scope({ strict: true, cwd: '/tmp/x' }).describe();
    assert.ok(desc.includes('local-strict'));
    assert.ok(desc.includes('/tmp/x'));
  });
});
