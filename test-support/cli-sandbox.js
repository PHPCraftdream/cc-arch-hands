import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from './process-batches.js';

const CLI = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

// A temp directory that is removed when the test ends.
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// `call(home, [env], ...args)` runs `cah` with HOME and USERPROFILE set to
// `home`; `baseEnv` and the optional leading `env` object are added to the
// inherited environment. `ok` is `call` plus an exit-code-0 assertion.
export function cliCaller(baseEnv = {}) {
  const call = (home, ...rest) => {
    const extra = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    return spawnSync(process.execPath, [CLI, ...rest], {
      env: { ...process.env, ...baseEnv, HOME: home, USERPROFILE: home, ...extra },
      encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
    });
  };
  const ok = (home, ...args) => {
    const result = call(home, ...args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  return { call, ok };
}

// Environment that keeps OpenCode (and the shared XDG root) out of the real home.
export const OPENCODE_ENV = { OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' };
