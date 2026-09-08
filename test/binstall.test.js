import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, statSync, lstatSync,
  symlinkSync, linkSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

import { SentinelBin } from '../lib/sentinel.js';
import {
  writeBins, removeBins, BinFiles, binLifecycleLockPath,
  deriveBinFilePublicationOrder, getBinFileImportGraph,
} from '../lib/binstall.js';
import { sameRollbackState } from '../lib/binstall-repair.js';
import { enumerateRecoveryArtifacts, maintainRecoveryArtifacts } from '../lib/fs-atomic.js';
import { recoverPublicationFence } from '../lib/fs-atomic-publication.js';
import { Scope } from '../lib/scope.js';
import {
  DEFAULT_CHILD_DEADLINE_MS, DEFAULT_WORKER_DEADLINE_MS, TERMINATION_GRACE_MS, runWorker,
} from '../test-support/process-batches.js';
import { stampInvocationEnv, stampSidecarPath, writeTranscript } from '../test-support/stamp-helpers.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cah-bin-test-'));
}

function runBinSync(file, args, options = {}) {
  return spawnSync(file, args, {
    ...options,
    timeout: options.timeout ?? DEFAULT_CHILD_DEADLINE_MS,
    killSignal: options.killSignal ?? 'SIGKILL',
  });
}

function smokeEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.FORCE_COLOR;
  return env;
}

// A throwaway package layout that mirrors what writeBins reads from: a bin/
// with shebang'd entry points and a lib/ dependency.
function fakeSource(root) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(
    join(root, 'bin', 'cah-status.js'),
    "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log(x);\n",
  );
  writeFileSync(
    join(root, 'bin', 'cah-stamp.js'),
    "#!/usr/bin/env node\nconsole.log('stamp');\n",
  );
  writeFileSync(
    join(root, 'bin', 'cah-checkpoint-hint.js'),
    "#!/usr/bin/env node\nconsole.log('hint');\n",
  );
  writeFileSync(
    join(root, 'bin', 'cah-status-probe.js'),
    "#!/usr/bin/env node\nconsole.log('probe');\n",
  );
  writeFileSync(join(root, 'lib', 'transcript-stats.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'lib', 'update-check.js'), 'export const y = 1;\n');
  writeFileSync(join(root, 'lib', 'lease-lock.js'), 'export const lease = 1;\n');
  writeFileSync(join(root, 'lib', 'marker-state.js'), 'export const marker = 1;\n');
  writeFileSync(join(root, 'lib', 'fsutil.js'), 'export const z = 1;\n');
  writeFileSync(join(root, 'lib', 'fs-atomic-identity.js'), 'export const identity = 1;\n');
  writeFileSync(join(root, 'lib', 'lease-clock.js'), 'export const clock = 1;\n');
  writeFileSync(join(root, 'lib', 'fs-atomic-publication.js'), 'export const publication = 1;\n');
  writeFileSync(join(root, 'lib', 'marker-capacity-stage.js'), 'export const stage = 1;\n');
  writeFileSync(join(root, 'lib', 'marker-capacity-recovery.js'), 'export const recovery = 1;\n');
  writeFileSync(join(root, 'lib', 'marker-capacity-ops.js'), 'export const ops = 1;\n');
  writeFileSync(join(root, 'lib', 'fs-atomic.js'), 'export const atomic = 1;\n');
  writeFileSync(join(root, 'lib', 'sentinel.js'), 'export const sentinel = 1;\n');
  writeFileSync(
    join(root, 'lib', 'cah-bin-package.json'),
    JSON.stringify({
      name: 'cc-arch-hands-cah-bin',
      private: true,
      type: 'module',
      'cah-managed': SentinelBin,
    }, null, 2) + '\n',
  );
}

// Worker startup can be scheduler-delayed on a loaded Windows host; keep the
// readiness bound finite but separate from the interlock's race semantics.
function waitForPath(path, timeoutMs = 60000, failurePromise = null) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    let timer = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      callback(value);
    };
    const poll = () => {
      if (existsSync(path)) {
        finish(resolvePromise);
        return;
      }
      if (Date.now() >= deadline) {
        finish(reject, new Error(`timed out waiting for ${path}`));
        return;
      }
      timer = setTimeout(poll, 10);
    };
    poll();
    if (failurePromise) {
      Promise.resolve(failurePromise).catch((error) => finish(reject, error));
    }
  });
}

function runBinWorker(
  dst,
  src,
  interlock,
  phase = 'prune-before-remove',
  operation = 'writeBins',
  leaseMs = null,
  {
    timeoutMs = DEFAULT_WORKER_DEADLINE_MS,
    graceMs = TERMINATION_GRACE_MS,
    hang = false,
    slowClose = false,
  } = {},
) {
  const moduleUrl = new URL('../lib/binstall.js', import.meta.url).href;
  const hooksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      delete process.env.CAH_TEST_ONLY_OWNER_INTERLOCK;
      delete process.env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE;
      delete process.env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK;
      delete process.env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK_PHASE;
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_OWNER_INTERLOCK: undefined,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: undefined,
        CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK: undefined,
        CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK_PHASE: undefined,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: workerData.phase,
      });
      if (workerData.leaseMs !== null) {
        process.env.CAH_TEST_ONLY_BIN_LEASE_MS = String(workerData.leaseMs);
      }
      if (workerData.hang) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      if (workerData.slowClose) {
        await new Promise((resolve) => {
          parentPort.once('message', (message) => {
            if (message?.__testShutdown) setTimeout(resolve, 10);
          });
        });
        return;
      }
      const { writeBins, removeBins } = await import(workerData.moduleUrl);
      const operation = workerData.operation === 'removeBins' ? removeBins : writeBins;
      try {
        parentPort.postMessage(operation(workerData.dst, workerData.src, { testInterlock }));
      } catch (error) {
        parentPort.postMessage({
          __workerError: {
            name: error?.name,
            message: error?.message,
            code: error?.code,
          },
        });
      }
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      dst, src, interlock, phase, operation, leaseMs, hang, slowClose, moduleUrl, hooksUrl,
    },
  });
  return runWorker(worker, { label: 'binstall worker', timeoutMs, graceMs }).then((value) => {
    if (!value?.__workerError) return value;
    const error = new Error(value.__workerError.message);
    error.name = value.__workerError.name || 'Error';
    if (value.__workerError.code) error.code = value.__workerError.code;
    if (leaseMs !== null) return error;
    throw error;
  });
}

// P2 regression fixtures: a real writeFileAtomic() publisher paused at the
// library's own write-after-proof-before-final-operation crash boundary
// (proof + temp on disk, canonical rename not yet done), raced against the
// installer's cache-maintenance sweep.
const P2_INTERLOCK_PHASE = 'write-after-proof-before-final-operation';
const RUN_COMPANION = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'run-companion.js');

function p2PublisherScript() {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  return `
    import { writeFileAtomic, captureRegularFileSnapshot } from ${JSON.stringify(fsutilUrl)};
    import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
    const dest = process.env.CAH_TEST_P2_DEST;
    try {
      writeFileAtomic(dest, 'child-payload\\n', {
        expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,
        testInterlock: makeInterlock(),
      });
      process.stdout.write('PUBLISHED\\n');
    } catch (error) {
      process.stdout.write('FAILED:' + (error.code || '') + ':' + error.message + '\\n');
      process.exit(3);
    }
  `;
}

function spawnPausedPublisher(dest, interlockBase, phase = P2_INTERLOCK_PHASE) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', p2PublisherScript()], {
    env: {
      ...process.env,
      HOME: dirname(dest), USERPROFILE: dirname(dest),
      CAH_TEST_ONLY: '1',
      CAH_TEST_P2_DEST: dest,
      CAH_TEST_ONLY_OWNER_INTERLOCK: interlockBase,
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: phase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout })));
  return { child, exited };
}

describe('writeBins', () => {
  let src, dst;
  beforeEach(() => {
    src = tmpDir();
    dst = tmpDir();
    fakeSource(src);
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
    rmSync(binLifecycleLockPath(dst), { recursive: true, force: true });
  });

  it('does not sweep a publication fence whose publisher is paused mid-write', async () => {
    const stateDir = join(dst, 'cache', 'stamp-state');
    mkdirSync(stateDir, { recursive: true });
    const dest = join(stateDir, 'last-stamp.json.session-p2race.json');
    writeFileSync(dest, 'ORIGINAL\n');
    const interlockBase = join(dst, 'p2-live-publisher-interlock');
    const { exited } = spawnPausedPublisher(dest, interlockBase);
    await waitForPath(`${interlockBase}.ready`, 60000);
    const result = writeBins(dst, src);
    writeFileSync(`${interlockBase}.go`, 'go');
    const { code, stdout } = await exited;
    assert.equal(code, 0, `the paused publisher must complete its write, got: ${stdout}`);
    assert.equal(stdout, 'PUBLISHED\n');
    assert.equal(readFileSync(dest, 'utf8'), 'child-payload\n',
      'the canonical destination must receive the publisher payload');
    assert.equal((result.maintenance?.swept || []).some((p) => p.includes('stamp-state')), false,
      `a live publisher's fence must be preserved, not swept: ${JSON.stringify(result.maintenance?.swept)}`);
  });

  it('still recovers a publication fence whose publisher crashed at the same boundary', async () => {
    const stateDir = join(dst, 'cache', 'stamp-state');
    mkdirSync(stateDir, { recursive: true });
    const dest = join(stateDir, 'last-stamp.json.session-p2crash.json');
    writeFileSync(dest, 'ORIGINAL\n');
    const interlockBase = join(dst, 'p2-crashed-publisher-interlock');
    const { child, exited } = spawnPausedPublisher(dest, interlockBase);
    await waitForPath(`${interlockBase}.ready`, 60000);
    child.kill('SIGKILL');
    await exited;
    // The proof's createdAtMs must pass the 1000 ms fence-staleness check so
    // recovery treats the fence as genuinely abandoned.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = writeBins(dst, src);
    assert.ok((result.maintenance?.swept || []).some((p) => p.includes('stamp-state')
      && p.endsWith('.cah-owned-publish')),
      `the crashed publisher's fence must still be recovered: ${JSON.stringify(result.maintenance)}`);
    assert.equal(readFileSync(dest, 'utf8'), 'ORIGINAL\n',
      'recovering an unpublished temp must not touch the canonical destination');
  });

  it('does not sweep a publication fence whose publisher is paused after the canonical rename', async () => {
    const stateDir = join(dst, 'cache', 'stamp-state');
    mkdirSync(stateDir, { recursive: true });
    const dest = join(stateDir, 'last-stamp.json.session-p2committed.json');
    writeFileSync(dest, 'ORIGINAL\n');
    const interlockBase = join(dst, 'p2-window-b-publisher-interlock');
    const { exited } = spawnPausedPublisher(dest, interlockBase, 'write-after-rename-before-sync');
    await waitForPath(`${interlockBase}.ready`, 60000);
    const result = writeBins(dst, src);
    writeFileSync(`${interlockBase}.go`, 'go');
    const { code, stdout } = await exited;
    assert.equal(code, 0, `a publisher raced between rename and cleanup must still succeed: ${stdout}`);
    assert.equal(stdout, 'PUBLISHED\n');
    assert.equal(readFileSync(dest, 'utf8'), 'child-payload\n',
      'the canonical destination must receive the publisher payload');
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false,
      'the publisher must finish cleaning up its own fence');
    assert.equal((result.maintenance?.swept || []).some((p) => p.includes('stamp-state')), false,
      `a live publisher's committed fence must be preserved, not swept: ${JSON.stringify(result.maintenance?.swept)}`);
  });

  it('a concurrent install does not drop the stamp of a cah-stamp child paused after the rename', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-bin-p2b-e2e-'));
    const stateDir = join(dst, 'cache', 'stamp-state');
    mkdirSync(stateDir, { recursive: true });
    const transcript = writeTranscript(home, 'Opus 5', 1000);
    const throttlePath = join(dst, 'cache', 'last-stamp.json');
    const interlockBase = join(dst, 'p2-e2e-windowb-stamp-interlock');
    const invocation = stampInvocationEnv({
      CAH_STAMP_HINT_HOME: home,
      CAH_STAMP_THROTTLE_PATH: throttlePath,
      CAH_TEST_ONLY: '1',
      CAH_TEST_ONLY_OWNER_INTERLOCK: interlockBase,
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'write-after-rename-before-sync',
    });
    const child = spawn(process.execPath, [RUN_COMPANION, 'stamp'], {
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stamp child did not exit; stdout=${stdout} stderr=${stderr}`)), 30000);
      child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    child.stdin.end(JSON.stringify({
      session_id: 'p2-e2e-windowb', hook_event_name: 'Stop', transcript_path: transcript,
    }));
    try {
      await waitForPath(`${interlockBase}.ready`, 60000);
      const result = writeBins(dst, src);
      writeFileSync(`${interlockBase}.go`, 'go');
      const code = await closed;
      assert.equal(code, 0, `the stamp child must exit cleanly, stdout=${stdout} stderr=${stderr}`);
      const line = stdout.split(/\r?\n/).find((entry) => entry.includes('systemMessage'));
      assert.ok(line, `the stamp must not be dropped by a window-B race, stdout=${JSON.stringify(stdout)}`);
      const envelope = JSON.parse(line);
      assert.match(envelope.systemMessage, /\d{2}:\d{2}/);
      assert.equal((result.maintenance?.swept || []).some((p) => p.includes('stamp-state')), false,
        `the install must not sweep the stamp child's committed fence: ${JSON.stringify(result.maintenance?.swept)}`);
      const sidecar = JSON.parse(readFileSync(stampSidecarPath(throttlePath, 'p2-e2e-windowb'), 'utf8'));
      assert.equal(sidecar.deliveryState, 'delivered',
        'the raced write must not leave a pending record that suppresses the turn retry');
    } finally {
      rmSync(home, { recursive: true, force: true });
      child.kill('SIGKILL');
    }
  });

  it('a publisher paused past the freshness window still succeeds; a dead recycled-pid publisher is still recovered', async () => {
    const stateDir = join(dst, 'cache', 'stamp-state');
    mkdirSync(stateDir, { recursive: true });
    // (a) A live publisher parked AFTER its canonical rename, explicitly
    // longer than the 1000 ms FENCE_STALE_MS freshness window.
    const liveDest = join(stateDir, 'last-stamp.json.session-windowb-slow.json');
    writeFileSync(liveDest, 'ORIGINAL\n');
    const liveBase = join(dst, 'p2-windowb-slow-live-interlock');
    const live = spawnPausedPublisher(liveDest, liveBase, 'write-after-rename-before-sync');
    await waitForPath(`${liveBase}.ready`, 60000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // (b) A successor publisher parked BEFORE its rename.
    const successorDest = join(stateDir, 'last-stamp.json.session-windowb-successor.json');
    writeFileSync(successorDest, 'ORIGINAL\n');
    const successorBase = join(dst, 'p2-windowb-successor-interlock');
    const successor = spawnPausedPublisher(successorDest, successorBase, P2_INTERLOCK_PHASE);
    await waitForPath(`${successorBase}.ready`, 60000);
    // (c) A dead publisher parked after its rename, to be recycled onto the
    // sleeper below.
    const deadDest = join(stateDir, 'last-stamp.json.session-windowb-dead.json');
    writeFileSync(deadDest, 'ORIGINAL\n');
    const deadBase = join(dst, 'p2-windowb-dead-interlock');
    const dead = spawnPausedPublisher(deadDest, deadBase, 'write-after-rename-before-sync');
    await waitForPath(`${deadBase}.ready`, 60000);
    dead.child.kill('SIGKILL');
    await dead.exited;
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {
      stdio: 'ignore',
    });
    try {
      // Age every proof past even a wide freshness window.
      const ageProof = (dest) => {
        const proofPath = join(`${dest}.cah-owned-publish`, 'publication.json');
        const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
        proof.createdAtMs = Date.now() - 3_600_000;
        writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
      };
      ageProof(liveDest);
      ageProof(deadDest);
      // The successor's proof is deliberately NOT aged: its deferral in the
      // uncommitted branch rests on pid liveness alone, and rewriting the
      // proof file would invalidate the in-memory proof identity the paused
      // publisher itself needs to clean up its own fence later.
      // Simulate exact pid recycling: patch only the dead publisher's pid
      // onto the live sleeper process.
      const deadProofPath = join(`${deadDest}.cah-owned-publish`, 'publication.json');
      const deadProof = JSON.parse(readFileSync(deadProofPath, 'utf8'));
      deadProof.ownerPid = sleeper.pid;
      writeFileSync(deadProofPath, `${JSON.stringify(deadProof)}\n`);
      // Run the exact maintenance decision writeBins uses.
      const reclaim = (dest) => recoverPublicationFence(dest, { deferFresh: true, deferCommitted: true });
      assert.equal(reclaim(deadDest), true,
        'a dead recycled-pid publisher\'s aged committed fence must be recovered');
      assert.equal(existsSync(`${deadDest}.cah-owned-publish`), false,
        'the recovered fence directory must be gone');
      assert.equal(readFileSync(deadDest, 'utf8'), 'child-payload\n',
        'recovery must not touch a committed payload');
      assert.equal(reclaim(successorDest), false,
        'a live successor parked before its rename must be preserved');
      assert.equal(existsSync(`${successorDest}.cah-owned-publish`), true,
        'the live successor\'s uncommitted fence must still exist');
      assert.equal(reclaim(liveDest), true,
        'an aged lease-less committed fence is identity-unverifiable and reclaimable');
      assert.equal(existsSync(`${liveDest}.cah-owned-publish`), false,
        'the reclaimed live fence directory must be gone');
      // The crux: a live publisher whose committed fence was reclaimed must
      // still complete successfully.
      writeFileSync(`${liveBase}.go`, 'go');
      const liveResult = await live.exited;
      assert.equal(liveResult.code, 0,
        `a live publisher whose committed fence was reclaimed must still succeed: ${liveResult.stdout}`);
      assert.equal(liveResult.stdout, 'PUBLISHED\n');
      assert.equal(readFileSync(liveDest, 'utf8'), 'child-payload\n');
      writeFileSync(`${successorBase}.go`, 'go');
      const successorResult = await successor.exited;
      assert.equal(successorResult.code, 0,
        `the successor publisher must complete: ${successorResult.stdout}`);
      assert.equal(successorResult.stdout, 'PUBLISHED\n');
      assert.equal(readFileSync(successorDest, 'utf8'), 'child-payload\n');
      assert.equal(existsSync(`${successorDest}.cah-owned-publish`), false,
        'the successor must clean up its own fence');
    } finally {
      sleeper.kill('SIGKILL');
      live.child.kill('SIGKILL');
      successor.child.kill('SIGKILL');
    }
  });

  it('a concurrent install does not drop the stamp of a paused cah-stamp child', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-bin-p2-e2e-'));
    const stateDir = join(dst, 'cache', 'stamp-state');
    mkdirSync(stateDir, { recursive: true });
    const transcript = writeTranscript(home, 'Opus 5', 1000);
    const interlockBase = join(dst, 'p2-e2e-stamp-interlock');
    const invocation = stampInvocationEnv({
      CAH_STAMP_HINT_HOME: home,
      CAH_STAMP_THROTTLE_PATH: join(dst, 'cache', 'last-stamp.json'),
      CAH_TEST_ONLY: '1',
      CAH_TEST_ONLY_OWNER_INTERLOCK: interlockBase,
      CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: P2_INTERLOCK_PHASE,
    });
    const child = spawn(process.execPath, [RUN_COMPANION, 'stamp'], {
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stamp child did not exit; stdout=${stdout} stderr=${stderr}`)), 30000);
      child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    child.stdin.end(JSON.stringify({
      session_id: 'p2-e2e-race', hook_event_name: 'Stop', transcript_path: transcript,
    }));
    try {
      await waitForPath(`${interlockBase}.ready`, 60000);
      const result = writeBins(dst, src);
      writeFileSync(`${interlockBase}.go`, 'go');
      const code = await closed;
      assert.equal(code, 0, `the stamp child must exit cleanly, stdout=${stdout} stderr=${stderr}`);
      const line = stdout.split(/\r?\n/).find((entry) => entry.includes('systemMessage'));
      assert.ok(line, `the stamp must not be dropped, stdout=${JSON.stringify(stdout)}`);
      const envelope = JSON.parse(line);
      assert.match(envelope.systemMessage, /\d{2}:\d{2}/);
      assert.equal((result.maintenance?.swept || []).some((p) => p.includes('stamp-state')), false,
        `the install must not sweep the stamp child's in-flight fence: ${JSON.stringify(result.maintenance?.swept)}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      child.kill('SIGKILL');
    }
  });

  it('copies every bin file mirroring bin/ + lib/ structure', () => {
    const r = writeBins(dst, src);
    assert.equal(r.written, BinFiles.length);
    assert.equal(r.skipped.length, 0);
    for (const f of BinFiles) {
      assert.ok(existsSync(join(dst, f.dest)), `${f.dest} should exist`);
    }
    const installedPackage = JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8'));
    assert.equal(installedPackage.type, 'module', 'installed tree must have an explicit ESM boundary');
    assert.equal(installedPackage['cah-managed'], SentinelBin, 'package ownership must be a JSON field');
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dst, 'bin', 'cah-status.js')).mode & 0o777, 0o755);
    }
  });

  it('terminates a deterministically hung worker before resolving', async () => {
    const started = Date.now();
    await assert.rejects(
      runBinWorker(dst, src, join(dst, 'hung-worker-interlock'), 'unused', 'writeBins', null, {
        timeoutMs: 50,
        graceMs: 25,
        hang: true,
      }),
      (error) => error?.code === 'ETIMEDOUT',
    );
    assert.ok(Date.now() - started < 2_000, 'hung worker must be bounded');
    assert.ok(existsSync(src), 'fixtures remain until the worker has terminated');
  });

  it('waits for a deterministic slow-close worker before settling', async () => {
    const started = Date.now();
    await assert.rejects(
      runBinWorker(dst, src, join(dst, 'slow-worker-interlock'), 'unused', 'writeBins', null, {
        timeoutMs: 50,
        graceMs: 100,
        slowClose: true,
      }),
      (error) => error?.code === 'ETIMEDOUT',
    );
    assert.ok(Date.now() - started >= 10, 'worker close is awaited after timeout');
    assert.ok(existsSync(src), 'fixtures remain until the worker has terminated');
  });

  it('keeps a deterministic dependency-first order for every frozen generation', () => {
    const first = deriveBinFilePublicationOrder(BinFiles, src).map((file) => file.dest);
    const second = deriveBinFilePublicationOrder(BinFiles, src).map((file) => file.dest);
    const graph = getBinFileImportGraph(BinFiles, src);
    assert.deepEqual(first, second);
    for (const [importer, dependencies] of graph) {
      for (const dependency of dependencies) {
        assert.ok(first.indexOf(dependency) < first.indexOf(importer),
          `${dependency} must precede ${importer}`);
      }
    }
    assert.equal(first[0], 'package.json', 'the synthetic ESM boundary remains first');
  });

  it('rejects any foreign package boundary before any bin mutation', () => {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'package.json'), JSON.stringify({ type: 'module', owner: 'user' }) + '\n');
    assert.throws(
      () => writeBins(dst, src),
      /foreign package boundary.*managed companion bins require/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')), {
      type: 'module', owner: 'user',
    });
    assert.ok(!existsSync(join(dst, 'bin')), 'foreign-boundary preflight must not create bin leaves');
    assert.ok(!existsSync(join(dst, 'lib')), 'foreign-boundary preflight must not create lib leaves');
  });

  it('rejects an incompatible foreign boundary before any bin mutation', () => {
    mkdirSync(join(dst, 'bin'), { recursive: true });
    mkdirSync(join(dst, 'lib'), { recursive: true });
    const packagePath = join(dst, 'package.json');
    const existingBin = join(dst, 'bin', 'cah-status.js');
    const orphan = join(dst, 'lib', 'cah-old.js');
    const foreign = join(dst, 'bin', 'someone-elses-tool.js');
    writeFileSync(packagePath, JSON.stringify({ type: 'commonjs', owner: 'user' }) + '\n', { mode: 0o640 });
    writeFileSync(existingBin, `#!/usr/bin/env node\n${SentinelBin}\nexisting\n`, { mode: 0o640 });
    writeFileSync(orphan, `#!/usr/bin/env node\n${SentinelBin}\norphan\n`);
    writeFileSync(foreign, 'foreign\n');
    const beforeBin = readFileSync(existingBin);

    assert.throws(
      () => writeBins(dst, src),
      /foreign package boundary.*managed companion bins require/,
    );
    assert.deepEqual(readFileSync(packagePath), Buffer.from(JSON.stringify({ type: 'commonjs', owner: 'user' }) + '\n'));
    assert.deepEqual(readFileSync(existingBin), beforeBin);
    if (process.platform !== 'win32') assert.equal(statSync(existingBin).mode & 0o777, 0o640);
    assert.ok(existsSync(orphan), 'preflight failure must not prune owned leaves');
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign\n');
    assert.ok(!existsSync(join(dst, 'bin', 'cah-stamp.js')), 'preflight failure must not publish other bins');
  });

  it('rejects a malformed foreign boundary before any bin mutation', () => {
    const packagePath = join(dst, 'package.json');
    writeFileSync(packagePath, '{ malformed package\n');
    assert.throws(
      () => writeBins(dst, src),
      /foreign package boundary.*managed companion bins require/,
    );
    assert.equal(readFileSync(packagePath, 'utf8'), '{ malformed package\n');
    assert.ok(!existsSync(join(dst, 'bin')), 'preflight failure must not create bin leaves');
    assert.ok(!existsSync(join(dst, 'lib')), 'preflight failure must not create lib leaves');
  });

  it('rejects a foreign boundary that omits the module type before any bin mutation', () => {
    const packagePath = join(dst, 'package.json');
    writeFileSync(packagePath, JSON.stringify({ owner: 'user' }) + '\n');
    assert.throws(
      () => writeBins(dst, src),
      /foreign package boundary.*managed companion bins require/,
    );
    assert.equal(readFileSync(packagePath, 'utf8'), '{"owner":"user"}\n');
    assert.ok(!existsSync(join(dst, 'bin')), 'preflight failure must not create bin leaves');
    assert.ok(!existsSync(join(dst, 'lib')), 'preflight failure must not create lib leaves');
  });

  it('injects the sentinel after the shebang and preserves it', () => {
    writeBins(dst, src);
    const status = readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8');
    const lines = status.split('\n');
    assert.equal(lines[0], '#!/usr/bin/env node');
    assert.equal(lines[1], SentinelBin);
    // shebang line not duplicated, original body intact
    assert.ok(status.includes("import { x } from '../lib/transcript-stats.js';"));
  });

  it('injects the sentinel as the first line when there is no shebang', () => {
    writeBins(dst, src);
    const lib = readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8');
    assert.equal(lib.split('\n')[0], SentinelBin);
    assert.ok(lib.includes('export const x = 1;'));
  });

  it('is idempotent — re-running does not double-inject', () => {
    writeBins(dst, src);
    writeBins(dst, src);
    const status = readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8');
    const count = status.split('\n').filter((l) => l === SentinelBin).length;
    assert.equal(count, 1);
  });

  it('prunes an orphan bin file that carries our sentinel', () => {
    writeBins(dst, src);
    const orphan = join(dst, 'bin', 'cah-old.js');
    writeFileSync(orphan, `#!/usr/bin/env node\n${SentinelBin}\nconsole.log('old');\n`);
    const r = writeBins(dst, src);
    assert.equal(r.pruned, 1);
    assert.ok(!existsSync(orphan), 'orphan should be pruned');
  });

  it('rejects a foreign declared runtime leaf before any mutation', () => {
    writeBins(dst, src);
    const foreignLeaf = join(dst, 'bin', 'cah-status.js');
    writeFileSync(foreignLeaf, 'foreign content, no sentinel\n');
    const foreignExtra = join(dst, 'bin', 'someones-tool.js');
    writeFileSync(foreignExtra, 'not ours\n');

    assert.throws(() => writeBins(dst, src), /foreign managed runtime leaf.*cah-status\.js/);
    assert.equal(readFileSync(foreignLeaf, 'utf8'), 'foreign content, no sentinel\n');
    assert.ok(existsSync(foreignExtra), 'foreign extra left untouched');
  });

  it('preflights foreign shared dependencies and executables as a zero-mutation closure', () => {
    for (const dest of ['lib/fsutil.js', 'lib/lease-lock.js', 'bin/cah-status.js']) {
      const caseDir = join(dst, dest.replaceAll('/', '-'));
      mkdirSync(dirname(caseDir), { recursive: true });
      const foreignPath = join(caseDir, dest);
      mkdirSync(dirname(foreignPath), { recursive: true });
      writeFileSync(foreignPath, `foreign ${dest}\n`);

      assert.throws(
        () => writeBins(caseDir, src),
        new RegExp(`foreign managed runtime leaf.*${dest.split('/').pop()}`),
      );
      assert.equal(readFileSync(foreignPath, 'utf8'), `foreign ${dest}\n`);
      assert.ok(!existsSync(join(caseDir, 'package.json')), `${dest} rejection must not publish boundary`);
      assert.ok(!existsSync(join(caseDir, 'bin', 'cah-status.js')) || dest === 'bin/cah-status.js');
    }
  });

  it('rejects a directory at every declared leaf before publishing anything', () => {
    const conflict = join(dst, 'bin', 'cah-status.js');
    mkdirSync(conflict, { recursive: true });

    assert.throws(
      () => writeBins(dst, src),
      /foreign managed runtime leaf.*cah-status\.js.*directory/,
    );
    assert.ok(existsSync(conflict), 'the foreign directory must survive preflight');
    assert.ok(!existsSync(join(dst, 'package.json')));
    assert.ok(!existsSync(join(dst, 'lib', 'fsutil.js')));
  });

  it('rejects valid and dangling declared symlinks without following them', (t) => {
    const target = join(dst, 'foreign-target.js');
    writeFileSync(target, `#!/usr/bin/env node\n${SentinelBin}\nforeign target\n`);
    const linked = join(dst, 'bin', 'cah-status.js');
    mkdirSync(dirname(linked), { recursive: true });
    try {
      symlinkSync(target, linked, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip('symbolic links are unavailable on this Windows runner');
        return;
      }
      throw error;
    }

    assert.throws(() => writeBins(dst, src), /foreign managed runtime leaf.*cah-status\.js.*symbolic link/);
    assert.ok(existsSync(linked), 'the valid symlink must survive preflight');
    assert.equal(readFileSync(target, 'utf8').includes('foreign target'), true);

    rmSync(linked);
    symlinkSync(join(dst, 'missing-target.js'), linked, 'file');
    assert.throws(() => writeBins(dst, src), /foreign managed runtime leaf.*cah-status\.js.*symbolic link/);
    assert.ok(lstatSync(linked).isSymbolicLink(), 'the dangling symlink must survive preflight');
    assert.ok(!existsSync(join(dst, 'package.json')));
  });

  it('rejects a multi-hardlink declared leaf before any mutation', (t) => {
    if (process.platform === 'win32') {
      t.skip('hardlink metadata is not portable on this Windows runner');
      return;
    }
    const conflict = join(dst, 'bin', 'cah-status.js');
    const secondLink = join(dst, 'foreign-hardlink.js');
    mkdirSync(dirname(conflict), { recursive: true });
    writeFileSync(conflict, `#!/usr/bin/env node\n${SentinelBin}\nforeign\n`);
    linkSync(conflict, secondLink);

    assert.throws(
      () => writeBins(dst, src),
      /foreign managed runtime leaf.*cah-status\.js.*multi-hardlink/,
    );
    assert.ok(existsSync(conflict));
    assert.ok(existsSync(secondLink));
    assert.ok(!existsSync(join(dst, 'package.json')));
  });

  it('preserves a foreign successor installed during orphan pruning', async () => {
    writeBins(dst, src);
    const orphan = join(dst, 'bin', 'cah-old.js');
    const interlock = join(dst, 'prune-successor-interlock');
    writeFileSync(orphan, `#!/usr/bin/env node\n${SentinelBin}\nold\n`);

    const running = runBinWorker(dst, src, interlock);
    await waitForPath(`${interlock}.ready`, 60000, running);
    rmSync(orphan);
    writeFileSync(orphan, 'foreign successor\n');
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.skipped, ['bin/cah-old.js']);
    assert.equal(readFileSync(orphan, 'utf8'), 'foreign successor\n');
  });

  it('reports unknown foreign orphans with bin-root-relative paths exactly once', () => {
    mkdirSync(join(dst, 'bin'), { recursive: true });
    mkdirSync(join(dst, 'lib'), { recursive: true });
    writeFileSync(join(dst, 'bin', 'old-tool.js'), 'foreign orphan bin\n');
    writeFileSync(join(dst, 'lib', 'old-helper.js'), 'foreign orphan lib\n');

    const installed = writeBins(dst, src);
    assert.deepEqual(
      installed.skipped,
      ['bin/old-tool.js', 'lib/old-helper.js'],
    );
    assert.ok(installed.skipped.every((value) => !['old-tool.js', 'old-helper.js'].includes(value)));

    const removed = removeBins(dst);
    assert.ok(removed.skipped.includes('bin/old-tool.js'));
    assert.ok(removed.skipped.includes('lib/old-helper.js'));
    for (const file of BinFiles) {
      assert.ok(existsSync(join(dst, file.dest)), `${file.dest} must remain beside opaque bin data`);
    }
  });

  it('silently preserves the reserved root cache while reporting unknown dirs relative to the bin root', () => {
    mkdirSync(join(dst, 'cache'), { recursive: true });
    mkdirSync(join(dst, 'unknown-root-dir'), { recursive: true });

    const installed = writeBins(dst, src);
    assert.ok(existsSync(join(dst, 'cache')), 'reserved runtime cache must survive install');
    assert.ok(existsSync(join(dst, 'unknown-root-dir')), 'unknown root dir must survive install');
    assert.ok(!installed.skipped.includes('cache'), 'reserved cache must not be reported');
    assert.ok(installed.skipped.includes('unknown-root-dir'));
    assert.ok(installed.skipped.every((value) => !value.includes(dst)));

    const removed = removeBins(dst);
    assert.ok(existsSync(join(dst, 'cache')), 'reserved runtime cache must survive removal');
    assert.ok(existsSync(join(dst, 'unknown-root-dir')), 'unknown root dir must survive removal');
    assert.ok(!removed.skipped.includes('cache'), 'reserved cache must stay silent on removal');
    assert.ok(removed.skipped.includes('unknown-root-dir'));
  });

  it('keeps install and uninstall successful when cache enumeration is unreadable', () => {
    const cache = join(dst, 'cache');
    mkdirSync(cache, { recursive: true });
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'opendir';
    try {
      const installed = writeBins(dst, src);
      assert.equal(installed.written, BinFiles.length);
      assert.equal(installed.maintenance.incomplete, true);
      assert.equal(installed.maintenance.truncated, false);
      const removed = removeBins(dst);
      assert.equal(removed.maintenance.incomplete, true);
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
    }
  });

  it('merges root and cache maintenance visits exactly once for install and uninstall', () => {
    const cache = join(dst, 'cache');
    mkdirSync(cache, { recursive: true });

    const baseline = writeBins(dst, src);
    writeFileSync(join(dst, '.cah-tmp-root-maintenance'), 'root recovery\n');
    writeFileSync(join(cache, '.cah-tmp-cache-maintenance'), 'cache recovery\n');

    const installed = writeBins(dst, src);
    const cacheVisits = maintainRecoveryArtifacts(cache).visits;
    // The root temp is observed once by each of the three bounded recovery
    // category scans. The cache report contributes its own visits once.
    assert.equal(installed.maintenance.visits, baseline.maintenance.visits + 3 + cacheVisits);
    assert.equal(new Set(installed.maintenance.recovery).size,
      installed.maintenance.recovery.length);
    assert.equal(new Set(installed.maintenance.unprovedTemps).size,
      installed.maintenance.unprovedTemps.length);

    const removed = removeBins(dst);
    // After the runtime leaves are removed, the root scan sees only cache and
    // the preserved root temp: two entries across three category scans.
    assert.equal(removed.maintenance.visits, cacheVisits + 6);
    assert.equal(new Set(removed.maintenance.recovery).size,
      removed.maintenance.recovery.length);
    assert.equal(new Set(removed.maintenance.unprovedTemps).size,
      removed.maintenance.unprovedTemps.length);
  });

  it('reports lease quarantines produced inside the cah-owned cache sub-namespaces', () => {
    const cache = join(dst, 'cache');
    const stampQuarantine = join(cache, 'stamp-state', '.cah-lease-quarantine', 'last-stamp.json.lock.taken-1-a');
    const markerQuarantine = join(cache, 'update-markers', '.cah-lease-quarantine', 'claim.taken-2-b');
    mkdirSync(stampQuarantine, { recursive: true });
    writeFileSync(join(stampQuarantine, 'stray'), 'stray');
    mkdirSync(markerQuarantine, { recursive: true });
    writeFileSync(join(markerQuarantine, 'owner.json'), 'displaced\n');

    const installed = writeBins(dst, src);
    assert.ok(installed.maintenance.recovery.includes('cache/stamp-state/.cah-lease-quarantine'),
      'stamp-state quarantine root must surface in the install maintenance report');
    assert.ok(installed.maintenance.recovery.includes('cache/update-markers/.cah-lease-quarantine'),
      'update-markers quarantine root must surface in the install maintenance report');
    assert.equal(new Set(installed.maintenance.recovery).size,
      installed.maintenance.recovery.length, 'recovery paths must stay unique');

    const removed = removeBins(dst);
    assert.ok(removed.maintenance.recovery.includes('cache/stamp-state/.cah-lease-quarantine'));
    assert.ok(removed.maintenance.recovery.includes('cache/update-markers/.cah-lease-quarantine'));
  });

  it('reports each root and cache maintenance failure exactly once', () => {
    const cache = join(dst, 'cache');
    mkdirSync(cache, { recursive: true });
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'opendir';
    try {
      const installed = writeBins(dst, src);
      assert.equal(installed.maintenance.failures.length, 4);
      assert.equal(installed.maintenance.failures.filter((failure) => failure.path === 'cache').length, 1);
      assert.ok(installed.maintenance.failures.every((failure) => failure.code === 'EACCES'));

      const removed = removeBins(dst);
      assert.equal(removed.maintenance.failures.length, 4);
      assert.equal(removed.maintenance.failures.filter((failure) => failure.path === 'cache').length, 1);
      assert.ok(removed.maintenance.failures.every((failure) => failure.code === 'EACCES'));
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
    }
  });

  it('bounds streamed recovery visits while giving displaced data its own budget', () => {
    const cache = join(dst, 'cache');
    const quarantine = join(cache, 'lost.txt.cah-owned-remove');
    mkdirSync(quarantine, { recursive: true });
    writeFileSync(join(quarantine, 'payload'), 'displaced\n');
    for (let i = 0; i < 1500; i++) writeFileSync(join(cache, `.cah-tmp-noise-${i}`), 'x');
    const artifacts = enumerateRecoveryArtifacts(cache, {
      displacedVisitLimit: 2048, namespaceVisitLimit: 16, tempVisitLimit: 16,
    });
    assert.ok(artifacts.some((artifact) => artifact.path === join(quarantine, 'payload')));
    assert.ok(artifacts.visits <= 2080, `unexpected recovery visits: ${artifacts.visits}`);
    assert.equal(artifacts.truncated, true);
  });

  it('does not call a zero recovery budget truncated', () => {
    mkdirSync(join(dst, 'cache'), { recursive: true });
    writeFileSync(join(dst, 'cache', '.cah-tmp-unvisited'), 'x');
    const artifacts = enumerateRecoveryArtifacts(join(dst, 'cache'), { visitLimit: 0 });
    assert.equal(artifacts.visits, 0);
    assert.equal(artifacts.truncated, false);
    assert.equal(artifacts.length, 0);
  });

  it('caps displaced, namespace, and temp output independently', () => {
    const cache = join(dst, 'cache');
    mkdirSync(cache, { recursive: true });
    for (const name of ['a', 'b']) {
      const quarantine = join(cache, `${name}.txt.cah-owned-remove`);
      mkdirSync(quarantine);
      writeFileSync(join(quarantine, 'payload'), name);
      mkdirSync(join(cache, `${name}.js.cah-owned-publish`));
    }
    for (let i = 0; i < 1500; i++) writeFileSync(join(cache, `.cah-tmp-cap-${i}`), 'x');

    const artifacts = enumerateRecoveryArtifacts(cache, { limit: 1 });
    assert.ok(artifacts.length <= 3, `unexpected result length: ${artifacts.length}`);
    assert.ok(artifacts.displaced.length <= 1);
    assert.ok(artifacts.namespaces.length <= 1);
    assert.ok(artifacts.temps.length <= 1);
  });

  it('uses lookahead to distinguish exact cap, cap minus one, and cap plus one', () => {
    for (const count of [127, 128, 129]) {
      const cache = join(dst, `cache-${count}`);
      mkdirSync(cache, { recursive: true });
      for (let i = 0; i < count; i++) writeFileSync(join(cache, `.cah-tmp-exact-${i}`), 'x');
      const artifacts = enumerateRecoveryArtifacts(cache, {
        limit: 128, displacedVisitLimit: 0, namespaceVisitLimit: 0, tempVisitLimit: 128,
      });
      assert.equal(artifacts.visits, Math.min(count, 128));
      assert.equal(artifacts.truncated, count === 129);
      assert.ok(artifacts.length <= 128);
    }
  });

  it('reports child-lstat recovery failures as incomplete metadata', () => {
    const cache = join(dst, 'cache-child-failure');
    const quarantine = join(cache, 'lost.txt.cah-owned-remove');
    mkdirSync(quarantine, { recursive: true });
    writeFileSync(join(quarantine, 'payload'), 'displaced\n');
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'child';
    try {
      const artifacts = enumerateRecoveryArtifacts(cache, { displacedVisitLimit: 1 });
      assert.equal(artifacts.incomplete, true);
      assert.ok(artifacts.failures.some((failure) => failure.path.endsWith('payload')));
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
    }
  });

  it('refuses a foreign successor at the publication leaf and preserves its mode', async () => {
    writeBins(dst, src);
    const destination = join(dst, 'lib', 'sentinel.js');
    const interlock = join(dst, 'write-successor-interlock');
    const running = runBinWorker(dst, src, interlock, 'binstall-before-leaf-write');
    await waitForPath(`${interlock}.ready`, 60000, running);
    rmSync(destination);
    writeFileSync(destination, 'foreign successor\n', { mode: 0o640 });
    writeFileSync(`${interlock}.go`, 'go');
    await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(destination, 'utf8'), 'foreign successor\n');
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o640);
  });

  it('fails and rolls back leaves when a foreign boundary replaces the boundary mid-run', async () => {
    const packagePath = join(dst, 'package.json');
    const interlock = join(dst, 'boundary-successor-interlock');
    const running = runBinWorker(dst, src, interlock, 'binstall-after-first-leaf');
    await waitForPath(`${interlock}.ready`, 60000, running);

    rmSync(packagePath);
    const foreignPackage = JSON.stringify({ type: 'commonjs', owner: 'user' }) + '\n';
    writeFileSync(packagePath, foreignPackage);
    writeFileSync(`${interlock}.go`, 'go');

    await assert.rejects(
      running,
      /managed package boundary changed concurrently.*refusing operation/,
    );
    assert.equal(readFileSync(packagePath, 'utf8'), foreignPackage);
    assert.ok(!existsSync(join(dst, 'bin', 'cah-status.js')),
      'a failed run must not report or leave a successfully usable bin tree');
    assert.ok(!existsSync(join(dst, 'lib', 'transcript-stats.js')),
      'rollback must remove leaves published by this invocation');
  });

  it('enrolls a leaf whose atomic publication commits before throwing', () => {
    let threw = false;
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase) => {
          if (phase === 'write-after-rename' && !threw) {
            threw = true;
            throw new Error('test-only post-publication failure');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.equal(threw, true);
    assert.ok(failure);
    assert.ok(!existsSync(join(dst, 'package.json')),
      'a committed boundary must be rolled back after its publication throws');
    assert.ok(!existsSync(join(dst, 'bin', 'cah-status.js')),
      'rollback must not leave an untracked committed runtime leaf');
  });

  it('enrolls a rename committed before post-rename sync failure', () => {
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase) => {
          if (phase === 'write-after-rename-before-sync') {
            throw new Error('test-only sync failure');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.message, 'test-only sync failure');
    assert.ok(!existsSync(join(dst, 'package.json')),
      'rollback must track a publication before sync can fail');
    assert.ok(!existsSync(join(dst, 'lib', 'sentinel.js')),
      'rollback must not strand a leaf after sync failure');
  });

  it('enrolls a commit when destination inspection fails afterward', () => {
    const priorTestOnly = process.env.CAH_TEST_ONLY;
    const priorFailures = process.env.CAH_TEST_ONLY_FSUTIL_DESTINATION_READ_FAILURES;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_DESTINATION_READ_FAILURES = '1';
    let failure;
    try {
      writeBins(dst, src);
    } catch (error) {
      failure = error;
    } finally {
      if (priorTestOnly === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTestOnly;
      if (priorFailures === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_DESTINATION_READ_FAILURES;
      else process.env.CAH_TEST_ONLY_FSUTIL_DESTINATION_READ_FAILURES = priorFailures;
    }

    assert.equal(failure?.message, 'test-only post-publication destination inspection failure');
    assert.ok(!existsSync(join(dst, 'package.json')),
      'rollback must use commit metadata when destination inspection fails');
    assert.ok(!existsSync(join(dst, 'lib', 'sentinel.js')),
      'post-commit inspection failure must not strand a runtime leaf');
  });

  it('does not accept content-equivalent rollback state with a corrupted mode', () => {
    if (process.platform === 'win32') return;
    const state = (mode) => ({
      present: true,
      contentDigest: 'same-content',
      contentBytes: 12,
      expectedDestination: { identity: { mode } },
    });

    assert.equal(sameRollbackState(state(0o640), state(0o755)), false);
    assert.equal(sameRollbackState(state(0o755), state(0o755)), true);
  });

  it('keeps C during boundary rollback without a publication vacancy', async () => {
    writeBins(dst, src);
    const packagePath = join(dst, 'package.json');
    const oldBoundary = readFileSync(packagePath, 'utf8');
    const interlock = join(dst, 'boundary-rollback-vacancy-interlock');
    const running = runBinWorker(
      dst,
      src,
      interlock,
      'binstall-after-first-leaf,binstall-rollback-before-final',
    );

    await waitForPath(`${interlock}.binstall-after-first-leaf.ready`, 60000, running);
    const successorLeaf = join(dst, 'lib', 'fs-atomic-identity.js');
    rmSync(successorLeaf);
    writeFileSync(successorLeaf, 'foreign successor during rollback\n');
    writeFileSync(`${interlock}.binstall-after-first-leaf.go`, 'go');
    await waitForPath(`${interlock}.binstall-rollback-before-final.ready`, 60000, running);
    assert.equal(readFileSync(packagePath, 'utf8'), oldBoundary,
      'rollback must keep the old boundary visible until replacement');
    const successor = JSON.stringify({ owner: 'C' }) + '\n';
    writeFileSync(packagePath, successor);
    writeFileSync(`${interlock}.binstall-rollback-before-final.go`, 'go');

    await assert.rejects(running);
    assert.equal(readFileSync(packagePath, 'utf8'), successor);
    assert.equal(existsSync(`${packagePath}.cah-owned-publish`), false,
      'rollback must not leave a publication fence after a successor wins');
  });

  it('protects dependencies of an executable that survives rollback', () => {
    let failedForward = false;
    let failure;
    const statusPath = join(dst, 'bin', 'cah-status.js');
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-stamp.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only forward publication failure');
          }
          if (phase === 'binstall-before-rollback' && dest === 'bin/cah-status.js') {
            rmSync(statusPath, { force: true });
            writeFileSync(statusPath, 'foreign successor executable\n');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'the missing source executable must fail the install');
    assert.equal(failure.rollbackIncomplete, true);
    assert.match(failure.message, /incomplete rollback recovery/);
    assert.ok(failure.rollback.failedExecutables.some((entry) =>
      entry.dest === 'bin/cah-status.js' && entry.action === 'remove'));
    assert.ok(failure.rollback.protected.some((entry) =>
      entry.dest === 'lib/transcript-stats.js'
      && entry.requiredBy.includes('bin/cah-status.js')));
    assert.equal(readFileSync(statusPath, 'utf8'), 'foreign successor executable\n');
    assert.ok(existsSync(join(dst, 'lib', 'transcript-stats.js')),
      'a surviving executable must keep its dependency available');
    assert.ok(!existsSync(join(dst, 'lib', 'update-check.js')),
      'unrelated libraries remain eligible for rollback');
  });

  it('preflights disablement and removes importers before their dependencies', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('new', x);\n",
    );
    writeFileSync(
      join(src, 'lib', 'transcript-stats.js'),
      "import { y } from './update-check.js';\nexport const x = y;\n",
    );
    writeFileSync(join(src, 'lib', 'update-check.js'), 'export const y = 2;\n');

    const disableInterlocks = [];
    const statusPath = join(dst, 'bin', 'cah-status.js');
    const updateCheckPath = join(dst, 'lib', 'update-check.js');
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write' && dest === 'bin/cah-status-probe.js') {
            throw new Error('test-only disablement failure');
          }
          if (phase === 'binstall-before-rollback' && dest === 'lib/update-check.js') {
            rmSync(updateCheckPath, { force: true });
            writeFileSync(updateCheckPath, 'foreign update-check successor\n');
          }
          if (phase === 'binstall-before-disable') {
            disableInterlocks.push(dest);
            if (dest === 'bin/cah-status.js') {
              rmSync(statusPath, { force: true });
              writeFileSync(statusPath, 'foreign status successor\n');
            }
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure);
    assert.deepEqual(disableInterlocks, ['bin/cah-status.js'],
      'the importer is preflighted and attempted before its dependencies');
    assert.ok(failure.rollback.disableFailures.some((entry) =>
      entry.dest === 'bin/cah-status.js' && entry.reason === 'successor-preserved'));
    assert.ok(failure.rollback.disableFailures.some((entry) =>
      entry.dest === 'lib/update-check.js' && entry.reason === 'foreign-successor'));
    assert.ok(failure.rollback.protected.some((entry) =>
      entry.dest === 'lib/transcript-stats.js'
      && entry.requiredBy.includes('bin/cah-status.js')));
    assert.equal(readFileSync(statusPath, 'utf8'), 'foreign status successor\n');
    assert.match(readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8'), /export const x = 1/,
      'a failed importer disable must preserve its dependency');
  });

  it('reports failed executable restoration and preserves its dependency closure', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('new', x);\n",
    );
    writeFileSync(join(src, 'lib', 'transcript-stats.js'), 'export const x = 2;\n');

    let failedForward = false;
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-stamp.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only forward publication failure');
          }
          if (failedForward && phase === 'write-before-final-operation') {
            throw new Error('test-only rollback restoration failure');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'the missing source executable must fail the reinstall');
    assert.equal(failure.rollbackIncomplete, true);
    assert.ok(failure.rollback.failedExecutables.some((entry) =>
      entry.dest === 'bin/cah-status.js' && entry.action === 'restore'));
    assert.ok(failure.rollback.protected.some((entry) =>
      entry.dest === 'lib/transcript-stats.js'));
    assert.match(failure.message, /incomplete rollback recovery.*bin\/cah-status\.js/);
    assert.match(readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8'), /x = 2/);
  });

  it('republishes restored dependents when a dependency cannot roll back', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('new', x);\n",
    );
    writeFileSync(join(src, 'lib', 'transcript-stats.js'), 'export const x = 2;\n');

    let failedForward = false;
    let failDependencyRollback = false;
    let threwDependencyRollback = false;
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-status-probe.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only forward publication failure');
          }
          if (phase === 'binstall-before-rollback'
              && dest === 'lib/transcript-stats.js') {
            failDependencyRollback = true;
          }
          if (phase === 'write-before-final-operation'
              && failDependencyRollback && !threwDependencyRollback) {
            threwDependencyRollback = true;
            throw new Error('test-only dependency rollback failure');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'the missing executable source must fail the reinstall');
    assert.equal(failure.rollbackIncomplete, true);
    assert.ok(failure.rollback.republished.includes('bin/cah-status.js'),
      'a dependent restored before its failed dependency must be republished');
    assert.match(readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8'), /console\.log\('new'/);
    assert.match(readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8'), /x = 2/);
  });

  it('converges a failed executable repair after exact post-publication success', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('new', x);\n",
    );
    writeFileSync(join(src, 'lib', 'transcript-stats.js'), 'export const x = 2;\n');

    let failedForward = false;
    let failDependencyRollback = false;
    let threwDependencyRollback = false;
    let postRepairStatus = false;
    let threwPostRepair = false;
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-status-probe.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only convergence forward failure');
          }
          if (phase === 'binstall-before-rollback'
              && dest === 'lib/transcript-stats.js') {
            failDependencyRollback = true;
          }
          if (phase === 'write-before-final-operation'
              && failDependencyRollback && !threwDependencyRollback) {
            threwDependencyRollback = true;
            throw new Error('test-only dependency rollback failure');
          }
          if (phase === 'binstall-before-rollback-republish'
              && dest === 'bin/cah-status.js' && !postRepairStatus) {
            postRepairStatus = true;
          }
          if (phase === 'write-after-rename' && postRepairStatus && !threwPostRepair) {
            threwPostRepair = true;
            throw new Error('test-only post-publication executable failure');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure);
    assert.equal(threwPostRepair, true);
    assert.ok(failure.rollback.republished.includes('bin/cah-status.js'));
    const smokeHome = tmpDir();
    try {
      const result = runBinSync(process.execPath, [join(dst, 'bin', 'cah-status.js')], {
        cwd: smokeHome,
        env: smokeEnv(smokeHome),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /new 2/);
    } finally {
      rmSync(smokeHome, { recursive: true, force: true });
    }
  });

  it('freezes one source generation for graph, publication, and repair', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('new', x);\n",
    );
    writeFileSync(join(src, 'lib', 'transcript-stats.js'), 'export const x = 2;\n');

    let sourceSwapped = false;
    let failedForward = false;
    let failDependencyRollback = false;
    let threwDependencyRollback = false;
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-after-source-freeze' && !sourceSwapped) {
            sourceSwapped = true;
            writeFileSync(join(src, 'lib', 'transcript-stats.js'), 'export const x = 9;\n');
          }
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-status-probe.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only frozen-generation failure');
          }
          if (phase === 'binstall-before-rollback'
              && dest === 'lib/transcript-stats.js') {
            failDependencyRollback = true;
          }
          if (phase === 'write-before-final-operation'
              && failDependencyRollback && !threwDependencyRollback) {
            threwDependencyRollback = true;
            throw new Error('test-only frozen-generation repair failure');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure);
    assert.equal(sourceSwapped, true);
    assert.equal(failure.rollbackIncomplete, true);
    assert.match(readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8'), /x = 2/);
    assert.doesNotMatch(readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8'), /x = 9/);
    assert.match(readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8'), /console\.log\('new'/);
  });

  it('retries the whole capture when an early dependency changes before a later source', () => {
    const dependency = join(src, 'lib', 'transcript-stats.js');
    let changed = false;
    let retryObserved = false;
    const result = writeBins(dst, src, {
      testInterlock: (phase, dest, attempt) => {
        if (phase === 'binstall-before-source-capture' && dest === 'lib/update-check.js') {
          if (!changed) {
            changed = true;
            writeFileSync(dependency, 'export const x = 2;\n');
          } else if (attempt > 0) {
            retryObserved = true;
          }
        }
      },
    });

    assert.equal(result.written, BinFiles.length);
    assert.equal(changed, true);
    assert.equal(retryObserved, true);
    assert.equal(readFileSync(join(dst, 'lib', 'transcript-stats.js'), 'utf8'),
      `${SentinelBin}\nexport const x = 2;\n`);
    assert.match(readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8'),
      /import \{ x \} from '..\/lib\/transcript-stats\.js'/);
  });

  it('does not publish dependents when the synthetic package boundary is unproved', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('new', x);\n",
    );
    writeFileSync(join(src, 'lib', 'transcript-stats.js'), 'export const x = 2;\n');

    let failedForward = false;
    let failure;
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-status-probe.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only boundary-preflight failure');
          }
          if (phase === 'binstall-before-rollback' && dest === 'package.json') {
            rmSync(join(dst, 'package.json'), { force: true });
            writeFileSync(join(dst, 'package.json'), '{"owner":"successor"}\n');
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure);
    assert.equal(failure.rollbackIncomplete, true);
    assert.ok(failure.rollback.preflight.some((entry) => entry.dest === 'package.json'));
    assert.equal(JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')).owner, 'successor');
    assert.doesNotMatch(readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8'), /console\.log\('new'/);
    assert.match(readFileSync(join(dst, 'bin', 'cah-status.js'), 'utf8'), /console\.log\(x\)/);
  });

  it('fresh-install surviving executables retain the ESM boundary for runtime smoke', () => {
    let failedForward = false;
    let failure;
    const statusPath = join(dst, 'bin', 'cah-status.js');
    try {
      writeBins(dst, src, {
        testInterlock: (phase, dest) => {
          if (phase === 'binstall-before-leaf-write'
              && dest === 'bin/cah-stamp.js' && !failedForward) {
            failedForward = true;
            throw new Error('test-only forward publication failure');
          }
          if (phase === 'binstall-before-rollback' && dest === 'bin/cah-status.js') {
            rmSync(statusPath, { force: true });
            writeFileSync(
              statusPath,
              "#!/usr/bin/env node\nimport { x } from '../lib/transcript-stats.js';\nconsole.log('surviving', x);\n",
            );
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'the missing executable source must fail the fresh install');
    assert.equal(JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')).type, 'module');
    const smokeHome = tmpDir();
    try {
      const result = runBinSync(process.execPath, [statusPath], {
        cwd: smokeHome,
        env: smokeEnv(smokeHome),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, 'surviving executable process failed to start');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /surviving 1/);
    } finally {
      rmSync(smokeHome, { recursive: true, force: true });
    }
  });

  it('publishes the complete dependency chain before any executable leaf', async () => {
    writeBins(dst, src);
    const statusPath = join(dst, 'bin', 'cah-status.js');
    const oldStatus = readFileSync(statusPath, 'utf8');
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nconsole.log('new executable');\n",
    );

    const interlock = join(dst, 'dependency-boundary-interlock');
    const running = runBinWorker(dst, src, interlock, 'binstall-after-dependencies');
    await waitForPath(`${interlock}.ready`, 60000, running);

    assert.ok(existsSync(join(dst, 'package.json')));
    for (const file of BinFiles.filter((entry) => entry.dest.startsWith('lib/'))) {
      assert.ok(existsSync(join(dst, file.dest)), `${file.dest} must precede executables`);
    }
    assert.equal(readFileSync(statusPath, 'utf8'), oldStatus,
      'an executable must remain old until the dependency boundary is released');

    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.equal(result.written, BinFiles.length);
    assert.notEqual(readFileSync(statusPath, 'utf8'), oldStatus,
      'the executable may update after its dependency chain is complete');
  });

  it('removes executables and libraries before the Node 18 boundary, preserving cache', async () => {
    writeBins(dst, src);
    const cache = join(dst, 'cache');
    mkdirSync(cache);
    const oldExecutable = join(dst, 'bin', 'cah-old.js');
    const oldLibrary = join(dst, 'lib', 'cah-old.js');
    writeFileSync(oldExecutable, `#!/usr/bin/env node\n${SentinelBin}\nold\n`);
    writeFileSync(oldLibrary, `${SentinelBin}\nold\n`);
    const interlock = join(dst, 'uninstall-boundary-interlock');
    const running = runBinWorker(
      dst,
      src,
      interlock,
      'binstall-before-boundary-remove',
      'removeBins',
    );
    await waitForPath(`${interlock}.ready`, 60000, running);

    assert.ok(existsSync(join(dst, 'package.json')), 'Node 18 ESM boundary must be last');
    assert.equal(JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')).type, 'module');
    for (const file of BinFiles.filter((entry) => entry.dest !== 'package.json')) {
      assert.ok(!existsSync(join(dst, file.dest)), `${file.dest} must precede boundary removal`);
    }
    assert.ok(!existsSync(oldExecutable), 'legacy executable orphans must precede boundary removal');
    assert.ok(!existsSync(oldLibrary), 'legacy library orphans must precede boundary removal');
    assert.ok(existsSync(cache), 'reserved cache must survive the staged uninstall');

    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.equal(result.removed, BinFiles.length + 2);
    assert.ok(!existsSync(join(dst, 'package.json')));
    assert.ok(existsSync(cache), 'reserved cache must survive uninstall');
  });

  it('holds one lease across install preflight and rejects a concurrent uninstall', async () => {
    const interlock = join(dst, 'lifecycle-install-interlock');
    const installing = runBinWorker(dst, src, interlock, 'binstall-after-lease', 'writeBins');
    await waitForPath(`${interlock}.ready`, 60000, installing);

    await assert.rejects(
      runBinWorker(dst, src, join(dst, 'unused-remove-interlock'), 'binstall-after-lease', 'removeBins'),
      /companion bins are busy/,
    );

    writeFileSync(`${interlock}.go`, 'go');
    const result = await installing;
    assert.equal(result.written, BinFiles.length);
    assert.ok(!existsSync(binLifecycleLockPath(dst)), 'released lifecycle lease must not remain');
  });

  it('holds one lease across uninstall and rejects a concurrent install', async () => {
    writeBins(dst, src);
    const interlock = join(dst, 'lifecycle-remove-interlock');
    const removing = runBinWorker(dst, src, interlock, 'binstall-after-lease', 'removeBins');
    await waitForPath(`${interlock}.ready`, 60000, removing);

    await assert.rejects(
      runBinWorker(dst, src, join(dst, 'unused-install-interlock'), 'binstall-after-lease', 'writeBins'),
      /companion bins are busy/,
    );

    writeFileSync(`${interlock}.go`, 'go');
    const result = await removing;
    assert.equal(result.removed, BinFiles.length);
    assert.ok(!existsSync(join(dst, 'package.json')), 'uninstall should finish as one serialized operation');
  });

  it('aborts an expired install resume with a truthful lost-lease error', async () => {
    const interlock = join(dst, 'expired-install-resume-interlock');
    const installing = runBinWorker(
      dst, src, interlock, 'binstall-after-boundary', 'writeBins', 2000,
    );
    await waitForPath(`${interlock}.ready`, 60000, installing);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2200));
    writeFileSync(`${interlock}.go`, 'go');

    const failure = await installing;
    assert.equal(failure?.code, 'ERR_BIN_LIFECYCLE_LEASE_LOST');
    assert.match(failure?.message || '', /lease lost/);
    assert.ok(existsSync(join(dst, 'package.json')), 'expired owner must not roll back its successor boundary');
    assert.ok(!existsSync(join(dst, 'lib', 'sentinel.js')), 'expired owner must stop before publishing leaves');
  });

  it('does not roll back a successor uninstall after an expired install pauses', async () => {
    const interlock = join(dst, 'expired-install-uninstall-interlock');
    const installing = runBinWorker(
      dst, src, interlock, 'binstall-after-boundary', 'writeBins', 2000,
    );
    await waitForPath(`${interlock}.ready`, 60000, installing);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2200));
    const expiredOwnerPath = join(binLifecycleLockPath(dst), 'owner.json');
    const expiredOwner = JSON.parse(readFileSync(expiredOwnerPath, 'utf8'));
    expiredOwner.timestamp = Date.now() - 1000;
    writeFileSync(expiredOwnerPath, JSON.stringify(expiredOwner) + '\n');

    const priorTestOnly = process.env.CAH_TEST_ONLY;
    const priorLeaseMs = process.env.CAH_TEST_ONLY_BIN_LEASE_MS;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_BIN_LEASE_MS = '2000';
    let successor;
    for (let attempt = 0; attempt < 8 && !successor; attempt += 1) {
      try { successor = removeBins(dst); } catch (error) {
        if (error?.name !== 'BinLifecycleBusyError' || attempt === 7) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    if (priorTestOnly === undefined) delete process.env.CAH_TEST_ONLY;
    else process.env.CAH_TEST_ONLY = priorTestOnly;
    if (priorLeaseMs === undefined) delete process.env.CAH_TEST_ONLY_BIN_LEASE_MS;
    else process.env.CAH_TEST_ONLY_BIN_LEASE_MS = priorLeaseMs;
    assert.equal(successor.removed, 1, 'successor uninstall removes the paused install boundary');
    writeFileSync(`${interlock}.go`, 'go');
    const failure = await installing;
    assert.match(failure?.message || '', /lease lost/);
    assert.ok(!existsSync(join(dst, 'package.json')), 'successor uninstall must remain authoritative');
  });

  it('does not remove a successor install after an expired uninstall pauses', async () => {
    writeBins(dst, src);
    const interlock = join(dst, 'expired-uninstall-install-interlock');
    const removing = runBinWorker(
      dst, src, interlock, 'binstall-before-leaf-remove', 'removeBins', 2000,
    );
    await waitForPath(`${interlock}.ready`, 60000, removing);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2200));
    const expiredOwnerPath = join(binLifecycleLockPath(dst), 'owner.json');
    const expiredOwner = JSON.parse(readFileSync(expiredOwnerPath, 'utf8'));
    expiredOwner.timestamp = Date.now() - 1000;
    writeFileSync(expiredOwnerPath, JSON.stringify(expiredOwner) + '\n');

    const priorTestOnly = process.env.CAH_TEST_ONLY;
    const priorLeaseMs = process.env.CAH_TEST_ONLY_BIN_LEASE_MS;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_BIN_LEASE_MS = '2000';
    let successor;
    for (let attempt = 0; attempt < 8 && !successor; attempt += 1) {
      try { successor = writeBins(dst, src); } catch (error) {
        if (error?.name !== 'BinLifecycleBusyError' || attempt === 7) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    if (priorTestOnly === undefined) delete process.env.CAH_TEST_ONLY;
    else process.env.CAH_TEST_ONLY = priorTestOnly;
    if (priorLeaseMs === undefined) delete process.env.CAH_TEST_ONLY_BIN_LEASE_MS;
    else process.env.CAH_TEST_ONLY_BIN_LEASE_MS = priorLeaseMs;
    assert.equal(successor.written, BinFiles.length);
    writeFileSync(`${interlock}.go`, 'go');
    const failure = await removing;
    assert.match(failure?.message || '', /lease lost/);
    for (const file of BinFiles) {
      assert.ok(existsSync(join(dst, file.dest)), `${file.dest} from successor install must survive`);
    }
  });

  it('smoke-runs every installed companion binary from the mirrored tree', () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const smokeHome = tmpDir();
    const smokeCache = join(smokeHome, 'cache');
    const env = {
      ...process.env,
      HOME: smokeHome,
      USERPROFILE: smokeHome,
      CAH_UPDATE_CHECK_CACHE: join(smokeCache, 'update-check.json'),
      CAH_RATE_LIMITS_CACHE: join(smokeCache, 'rate-limits.json'),
      CAH_STAMP_THROTTLE_PATH: join(smokeCache, 'last-stamp.json'),
      CAH_PROBE_LOG: join(smokeCache, 'probe.log'),
    };

    try {
      writeBins(dst, packageRoot);
      const bins = BinFiles
        .filter((file) => file.dest.startsWith('bin/'))
        .map((file) => file.dest.slice('bin/'.length));
      for (const name of bins) {
        const result = runBinSync(process.execPath, [join(dst, 'bin', name)], {
          cwd: smokeHome,
          env,
          input: '{}\n',
          encoding: 'utf8',
          timeout: 10_000,
        });
        assert.equal(result.error, undefined, `${name} process failed to start`);
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
      }
      for (const file of BinFiles) {
        assert.ok(existsSync(join(dst, file.dest)), `${file.dest} was not installed`);
      }
    } finally {
      rmSync(smokeHome, { recursive: true, force: true });
    }
  });
});

describe('removeBins', () => {
  let src, dst;
  beforeEach(() => {
    src = tmpDir();
    dst = tmpDir();
    fakeSource(src);
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
    rmSync(binLifecycleLockPath(dst), { recursive: true, force: true });
  });

  it('removes all our files and the now-empty bin root', () => {
    writeBins(dst, src);
    const r = removeBins(dst);
    assert.equal(r.removed, BinFiles.length);
    assert.ok(!existsSync(dst), 'empty cah-bin dir should be removed');
  });

  it('rejects a foreign declared leaf before removing any managed files', () => {
    writeBins(dst, src);
    const foreign = join(dst, 'lib', 'fsutil.js');
    writeFileSync(foreign, 'not ours\n');
    assert.throws(() => removeBins(dst), /foreign managed runtime leaf.*fsutil\.js/);
    assert.equal(readFileSync(foreign, 'utf8'), 'not ours\n');
    assert.ok(existsSync(join(dst, 'bin', 'cah-status.js')), 'zero-mutation rejection must keep executables');
  });

  it('protects dependencies when an importer survives an uninstall race', () => {
    writeBins(dst, src);
    const importer = join(dst, 'bin', 'cah-status.js');
    let preserved = false;
    const result = removeBins(dst, src, {
      testInterlock: (phase, dest) => {
        if (phase === 'binstall-before-leaf-remove'
            && dest === 'bin/cah-status.js' && !preserved) {
          preserved = true;
          rmSync(importer, { force: true });
          writeFileSync(importer, 'foreign importer successor\n', { mode: 0o755 });
        }
      },
    });

    assert.equal(preserved, true);
    assert.equal(readFileSync(importer, 'utf8'), 'foreign importer successor\n');
    assert.ok(existsSync(join(dst, 'lib', 'transcript-stats.js')),
      'a preserved importer must keep its direct dependency');
    assert.ok(existsSync(join(dst, 'package.json')),
      'a preserved importer must keep the ESM boundary');
    assert.ok(existsSync(join(dst, 'lib', 'update-check.js')),
      'an opaque importer must retain every managed dependency');
    assert.ok(result.skipped.includes('lib/transcript-stats.js'));
    assert.ok(result.skipped.includes('package.json'));
  });

  it('uses installed importer bytes when source changes before an uninstall race', () => {
    writeBins(dst, src);
    writeFileSync(
      join(src, 'bin', 'cah-status.js'),
      "#!/usr/bin/env node\nconsole.log('source no longer imports transcript');\n",
    );
    const importer = join(dst, 'bin', 'cah-status.js');
    let preserved = false;
    const result = removeBins(dst, src, {
      testInterlock: (phase, dest) => {
        if (phase === 'binstall-before-leaf-remove'
            && dest === 'bin/cah-status.js' && !preserved) {
          preserved = true;
          rmSync(importer, { force: true });
          writeFileSync(importer, 'opaque successor\n', { mode: 0o755 });
        }
      },
    });

    assert.equal(preserved, true);
    assert.ok(existsSync(join(dst, 'lib', 'transcript-stats.js')),
      'installed importer bytes must retain its dependency');
    assert.ok(existsSync(join(dst, 'package.json')),
      'installed importer bytes must retain the ESM boundary');
    assert.ok(existsSync(join(dst, 'lib', 'update-check.js')),
      'opaque imports must retain the complete managed closure');
    assert.ok(result.skipped.includes('lib/transcript-stats.js'));
  });

  it('retains the runtime when an opaque library successor imports outside its old graph', () => {
    writeBins(dst, src);
    const library = join(dst, 'lib', 'update-check.js');
    let preserved = false;
    const result = removeBins(dst, src, {
      testInterlock: (phase, dest) => {
        if (phase === 'binstall-before-leaf-remove'
            && dest === 'lib/update-check.js' && !preserved) {
          preserved = true;
          rmSync(library, { force: true });
          writeFileSync(library, "import './sentinel.js';\n", { mode: 0o755 });
        }
      },
    });

    assert.equal(preserved, true);
    assert.ok(existsSync(join(dst, 'lib', 'sentinel.js')),
      'an opaque library must retain its newly imported library');
    assert.ok(existsSync(join(dst, 'package.json')),
      'an opaque library must retain the ESM boundary');
    assert.ok(result.skipped.includes('lib/sentinel.js'));
  });

  it('rejects non-regular declared leaves before removing any managed files', (t) => {
    writeBins(dst, src);
    const conflict = join(dst, 'lib', 'fsutil.js');
    rmSync(conflict, { force: true });
    mkdirSync(conflict, { recursive: true });
    assert.throws(() => removeBins(dst), /foreign managed runtime leaf.*fsutil\.js.*directory/);
    assert.ok(existsSync(join(dst, 'bin', 'cah-status.js')));

    rmSync(conflict, { recursive: true, force: true });
    const target = join(dst, 'foreign-target.js');
    writeFileSync(target, 'foreign target\n');
    try {
      symlinkSync(target, conflict, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip('symbolic links are unavailable on this Windows runner');
        return;
      }
      throw error;
    }
    assert.throws(() => removeBins(dst), /foreign managed runtime leaf.*fsutil\.js.*symbolic link/);
    assert.ok(existsSync(join(dst, 'bin', 'cah-status.js')));
  });

  it('preserves and reports unproved cache crash temps without traversing cache', () => {
    writeBins(dst, src);
    const cache = join(dst, 'cache');
    const crashTemp = join(cache, '.cah-tmp-crashed-install');
    const nested = join(crashTemp, 'must-not-be-visited');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'payload'), 'foreign cache data\n');

    const installed = writeBins(dst, src);
    assert.ok(existsSync(crashTemp));
    assert.deepEqual(installed.maintenance.unprovedTemps, ['cache/.cah-tmp-crashed-install']);
    assert.deepEqual(installed.recovery, ['cache/.cah-tmp-crashed-install']);
    assert.ok(!installed.skipped.includes('cache'));

    const removed = removeBins(dst);
    assert.ok(existsSync(crashTemp));
    assert.deepEqual(removed.maintenance.unprovedTemps, ['cache/.cah-tmp-crashed-install']);
    assert.deepEqual(removed.recovery, ['cache/.cah-tmp-crashed-install']);
    assert.ok(!removed.skipped.includes('cache'));
  });

  it('leaves unknown foreign files and keeps the dir', () => {
    writeBins(dst, src);
    const foreign = join(dst, 'bin', 'someones-tool.js');
    writeFileSync(foreign, 'not ours\n');
    const r = removeBins(dst);
    assert.ok(r.skipped.includes('bin/someones-tool.js'));
    assert.ok(existsSync(foreign), 'foreign file must survive');
  });

  it('retains the complete runtime for an opaque preserved importer', () => {
    writeBins(dst, src);
    const foreign = join(dst, 'bin', 'opaque-tool.js');
    writeFileSync(foreign, "import '../lib/update-check.js';\n");
    const r = removeBins(dst);

    assert.equal(r.removed, 0);
    assert.ok(r.skipped.includes('bin/opaque-tool.js'));
    for (const file of BinFiles) {
      assert.ok(existsSync(join(dst, file.dest)), `${file.dest} must remain runnable`);
    }
  });

  it('is a no-op on a missing bin dir', () => {
    const r = removeBins(join(dst, 'does-not-exist'));
    assert.equal(r.removed, 0);
    assert.equal(r.skipped.length, 0);
  });
});

describe('Scope.resolveBinDir', () => {
  it('always points at the global ~/.claude/cah-bin regardless of scope', () => {
    const expected = join(homedir(), '.claude', 'cah-bin');
    assert.equal(new Scope({ global: true }).resolveBinDir(), expected);
    assert.equal(new Scope({ global: false, cwd: '/some/project' }).resolveBinDir(), expected);
  });
});
