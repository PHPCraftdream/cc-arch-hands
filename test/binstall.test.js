import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

import { SentinelBin } from '../lib/sentinel.js';
import { writeBins, removeBins, BinFiles } from '../lib/binstall.js';
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
  writeFileSync(join(root, 'lib', 'fsutil.js'), 'export const z = 1;\n');
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

function waitForPath(path, timeoutMs = 5000) {
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

function runBinWorker(dst, src, interlock, phase = 'prune-before-remove') {
  const moduleUrl = new URL('../lib/binstall.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = workerData.phase;
      const { writeBins } = await import(workerData.moduleUrl);
      parentPort.postMessage(writeBins(workerData.dst, workerData.src));
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dst, src, interlock, phase, moduleUrl },
    });
    worker.once('message', resolvePromise);
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

  it('preserves a foreign package boundary and reports it as skipped', () => {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'package.json'), JSON.stringify({ type: 'commonjs', owner: 'user' }) + '\n');
    const r = writeBins(dst, src);
    assert.ok(r.skipped.includes('package.json'));
    assert.deepEqual(JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')), {
      type: 'commonjs', owner: 'user',
    });
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

  it('never overwrites or prunes a foreign file', () => {
    writeBins(dst, src);
    const foreignLeaf = join(dst, 'bin', 'cah-status.js');
    writeFileSync(foreignLeaf, 'foreign content, no sentinel\n');
    const foreignExtra = join(dst, 'bin', 'someones-tool.js');
    writeFileSync(foreignExtra, 'not ours\n');

    const r = writeBins(dst, src);
    assert.ok(r.skipped.includes('bin/cah-status.js'));
    assert.equal(readFileSync(foreignLeaf, 'utf8'), 'foreign content, no sentinel\n');
    assert.equal(r.pruned, 0);
    assert.ok(existsSync(foreignExtra), 'foreign extra left untouched');
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
    assert.equal(readFileSync(orphan, 'utf8'), 'foreign successor\n');
  });

  it('refuses a foreign successor at the publication leaf and preserves its mode', async () => {
    writeBins(dst, src);
    const destination = join(dst, 'bin', 'cah-status.js');
    const interlock = join(dst, 'write-successor-interlock');
    const running = runBinWorker(dst, src, interlock, 'write-before-rename');
    await waitForPath(`${interlock}.ready`);
    rmSync(destination);
    writeFileSync(destination, 'foreign successor\n', { mode: 0o640 });
    writeFileSync(`${interlock}.go`, 'go');
    await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(destination, 'utf8'), 'foreign successor\n');
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o640);
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
  });

  it('removes all our files and the now-empty bin root', () => {
    writeBins(dst, src);
    const r = removeBins(dst);
    assert.equal(r.removed, BinFiles.length);
    assert.ok(!existsSync(dst), 'empty cah-bin dir should be removed');
  });

  it('leaves foreign files and keeps the dir', () => {
    writeBins(dst, src);
    const foreign = join(dst, 'bin', 'someones-tool.js');
    writeFileSync(foreign, 'not ours\n');
    const r = removeBins(dst);
    assert.ok(r.skipped.includes('someones-tool.js'));
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
