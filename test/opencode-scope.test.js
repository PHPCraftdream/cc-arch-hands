import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeScope, StrictMissingOpencodeRootError } from '../lib/opencode-scope.js';

const worktree = fileURLToPath(new URL('..', import.meta.url));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-opencode-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('OpenCodeScope', () => {
  it('defaults to ~/.config/opencode', () => {
    const scope = new OpenCodeScope({ global: true, env: {} });
    assert.match(scope.configRoot(), /[\\/]\.config[\\/]opencode$/);
    assert.equal(scope.configRootSource(), 'default');
  });

  it('prefers XDG_CONFIG_HOME/opencode', (t) => {
    const home = sandbox(t);
    const xdg = join(home, 'xdg');
    const scope = new OpenCodeScope({ global: true, env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(scope.configRoot(), join(xdg, 'opencode'));
    assert.equal(scope.resolveAgentsDir(), join(xdg, 'opencode', 'agents'));
    assert.equal(scope.resolveCommandsDir(), join(xdg, 'opencode', 'commands'));
    assert.equal(scope.resolveSkillsDir(), join(xdg, 'opencode', 'skills'));
    assert.equal(scope.resolvePluginDir(), join(xdg, 'opencode', 'plugin'));
    assert.equal(scope.resolveRuntimeDir(), join(xdg, 'opencode', 'cah-opencode'));
    assert.equal(scope.instructionsPath(), join(xdg, 'opencode', 'AGENTS.md'));
  });

  it('OPENCODE_CONFIG_DIR overrides XDG and is reported', (t) => {
    const home = sandbox(t);
    const override = join(home, 'custom-cfg');
    const scope = new OpenCodeScope({
      global: true,
      env: { XDG_CONFIG_HOME: join(home, 'xdg'), OPENCODE_CONFIG_DIR: override },
    });
    assert.equal(scope.configRoot(), override);
    assert.equal(scope.configRootSource(), 'OPENCODE_CONFIG_DIR');
    assert.match(scope.describe(), /OPENCODE_CONFIG_DIR/);
  });

  it('resolves relative OPENCODE_CONFIG_DIR against the process cwd', () => {
    const scope = new OpenCodeScope({ global: true, env: { OPENCODE_CONFIG_DIR: 'rel-cfg' } });
    assert.ok(scope.configRoot().endsWith(join('rel-cfg')));
  });

  it('--cwd targets PATH/.opencode', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    const scope = new OpenCodeScope({ global: false, strict: false, cwd: project, env: { OPENCODE_CONFIG_DIR: join(home, 'cfg') } });
    assert.equal(scope.opencodeRoot(), join(project, '.opencode'));
    // local rules live at the project root, not inside .opencode
    assert.equal(scope.instructionsPath(), join(project, 'AGENTS.md'));
  });

  it('strict local refuses to create a missing .opencode', (t) => {
    const home = sandbox(t);
    const project = join(home, 'project');
    mkdirSync(project, { recursive: true });
    const strict = new OpenCodeScope({ global: false, strict: true, cwd: project, env: {} });
    assert.throws(() => strict.opencodeRoot(), StrictMissingOpencodeRootError);
    mkdirSync(join(project, '.opencode'));
    assert.equal(strict.opencodeRoot(), join(project, '.opencode'));
  });
});
