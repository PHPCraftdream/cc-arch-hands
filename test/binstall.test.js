import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
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
