import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, statSync, lstatSync, unlinkSync,
  symlinkSync, linkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

import { SentinelBin } from '../lib/sentinel.js';
import {
  writeBins, removeBins, BinFiles, binLifecycleLockPath,
} from '../lib/binstall.js';
import { enumerateRecoveryArtifacts, maintainRecoveryArtifacts } from '../lib/fs-atomic.js';
import { Scope } from '../lib/scope.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cah-bin-test-'));
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

function waitForPath(path, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolvePromise();
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

function runBinWorker(
  dst,
  src,
  interlock,
  phase = 'prune-before-remove',
  operation = 'writeBins',
  leaseMs = null,
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
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dst, src, interlock, phase, operation, leaseMs, moduleUrl, hooksUrl },
    });
    worker.once('message', (value) => {
      if (!value?.__workerError) {
        resolvePromise(value);
        return;
      }
      const error = new Error(value.__workerError.message);
      error.name = value.__workerError.name || 'Error';
      if (value.__workerError.code) error.code = value.__workerError.code;
      if (leaseMs !== null) resolvePromise(error);
      else reject(error);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`bin worker exited with code ${code}`));
    });
  });
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
    await waitForPath(`${interlock}.ready`);
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
    assert.deepEqual(
      removed.skipped,
      ['bin/old-tool.js', 'lib/old-helper.js'],
    );
    assert.equal(new Set(removed.skipped).size, removed.skipped.length);
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
    await waitForPath(`${interlock}.ready`);
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
    await waitForPath(`${interlock}.ready`);

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

  it('keeps C during boundary rollback without a publication vacancy', async () => {
    writeBins(dst, src);
    const sourceThatWillFail = join(src, 'bin', 'cah-stamp.js');
    const packagePath = join(dst, 'package.json');
    const oldBoundary = readFileSync(packagePath, 'utf8');
    const interlock = join(dst, 'boundary-rollback-vacancy-interlock');
    const running = runBinWorker(
      dst,
      src,
      interlock,
      'binstall-after-first-leaf,binstall-rollback-before-final',
    );

    await waitForPath(`${interlock}.binstall-after-first-leaf.ready`);
    unlinkSync(sourceThatWillFail);
    writeFileSync(`${interlock}.binstall-after-first-leaf.go`, 'go');
    await waitForPath(`${interlock}.binstall-rollback-before-final.ready`);
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
    await waitForPath(`${interlock}.ready`);

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
    await waitForPath(`${interlock}.ready`);

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
    await waitForPath(`${interlock}.ready`);

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
    await waitForPath(`${interlock}.ready`);

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
      dst, src, interlock, 'binstall-after-boundary', 'writeBins', 500,
    );
    await waitForPath(`${interlock}.ready`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
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
      dst, src, interlock, 'binstall-after-boundary', 'writeBins', 500,
    );
    await waitForPath(`${interlock}.ready`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
    const expiredOwnerPath = join(binLifecycleLockPath(dst), 'owner.json');
    const expiredOwner = JSON.parse(readFileSync(expiredOwnerPath, 'utf8'));
    expiredOwner.timestamp = Date.now() - 1000;
    writeFileSync(expiredOwnerPath, JSON.stringify(expiredOwner) + '\n');

    const priorTestOnly = process.env.CAH_TEST_ONLY;
    const priorLeaseMs = process.env.CAH_TEST_ONLY_BIN_LEASE_MS;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_BIN_LEASE_MS = '500';
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
      dst, src, interlock, 'binstall-before-leaf-remove', 'removeBins', 500,
    );
    await waitForPath(`${interlock}.ready`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
    const expiredOwnerPath = join(binLifecycleLockPath(dst), 'owner.json');
    const expiredOwner = JSON.parse(readFileSync(expiredOwnerPath, 'utf8'));
    expiredOwner.timestamp = Date.now() - 1000;
    writeFileSync(expiredOwnerPath, JSON.stringify(expiredOwner) + '\n');

    const priorTestOnly = process.env.CAH_TEST_ONLY;
    const priorLeaseMs = process.env.CAH_TEST_ONLY_BIN_LEASE_MS;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_BIN_LEASE_MS = '500';
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
        const result = spawnSync(process.execPath, [join(dst, 'bin', name)], {
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
