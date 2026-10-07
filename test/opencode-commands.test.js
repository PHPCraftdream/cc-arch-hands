import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';
import { OpencodeCommands, OpencodeCommandRuntimeFiles, SetForOpencodeCommand, SetForOpencodeRuntime, writeOpencodeCommands, removeOpencodeCommands } from '../lib/opencode-commands.js';
import { OpenCodeScope } from '../lib/opencode-scope.js';
import { embeddedTemplates } from '../lib/templates.js';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const cli = join(worktree, 'bin', 'cah.js');

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'cah-opencode-commands-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function call(home, ...rest) {
  const env = rest.length > 0 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])
    ? rest.shift() : {};
  return spawnSync(process.execPath, [cli, ...rest], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
  });
}

function ok(home, ...args) {
  const result = call(home, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function list(home, ...args) {
  return ok(home, 'list', '--json', '--opencode', ...args).stdout.trim()
    .split('\n').map(JSON.parse);
}

describe('OpenCode command installer', () => {
  it('installs nine commands with frontmatter, $ARGUMENTS and helper substitution', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-commands');
    const dir = join(home, '.config', 'opencode', 'commands');
    assert.deepEqual(readdirSync(dir).sort(),
      OpencodeCommands.map((name) => `${name}.md`).sort());
    for (const name of OpencodeCommands) {
      const body = readFileSync(join(dir, `${name}.md`), 'utf8');
      assert.match(body, /^---\n/, `${name} frontmatter`);
      assert.ok(body.includes('$ARGUMENTS'), `${name} uses $ARGUMENTS`);
      assert.ok(body.includes(SetForOpencodeCommand.current), `${name} sentinel`);
      assert.ok(!body.includes('$@'), `${name} has no raw $@`);
      assert.ok(!body.includes('TaskCreate') && !body.includes('CronCreate'), name);
    }
    const ccheckpoint = readFileSync(join(dir, 'ccheckpoint.md'), 'utf8');
    const helper = JSON.parse(ccheckpoint.match(/helper ("(?:\\.|[^"\\])*")/)[1]);
    assert.ok(helper.endsWith('/.config/opencode/cah-opencode/commit-checkpoint.mjs'),
      `unexpected helper path: ${helper}`);
    assert.ok(!ccheckpoint.includes('{{COMMIT_HELPER}}'));
    for (const rel of OpencodeCommandRuntimeFiles) {
      const runtime = readFileSync(join(home, '.config', 'opencode', rel), 'utf8');
      assert.ok(runtime.includes(SetForOpencodeRuntime.current), rel);
    }
    const plugin = readFileSync(join(home, '.config', 'opencode', OpencodeCommandRuntimeFiles[2]), 'utf8');
    assert.match(plugin, /^import \{ tool \} from '@opencode-ai\/plugin';$/m);
    assert.match(plugin, /tool\.schema\.enum\(\['arm', 'status', 'off'\]\)/);
    assert.match(plugin, /tool\.schema\.string\(\)\.optional\(\)/);
    assert.doesNotMatch(plugin, /tool\.Zod/);
    const scheduler = readFileSync(join(home, '.config', 'opencode', OpencodeCommandRuntimeFiles[0]), 'utf8');
    assert.doesNotMatch(scheduler, /^import\s+[^;]*@opencode-ai/m);
    assert.doesNotMatch(scheduler, /require\(['"]@opencode-ai/m);
  });

  it('keeps OpenCode todos vocabulary, never Claude tools or non-canonical statuses', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-commands');
    const dir = join(home, '.config', 'opencode', 'commands');
    for (const name of OpencodeCommands) {
      const body = readFileSync(join(dir, `${name}.md`), 'utf8');
      if (name === 'ccheckpoint') {
        assert.match(body, /Invoke Node on the installed helper "(?:\\.|[^"\\])*commit-checkpoint\.mjs" with arguments --name/);
        assert.match(body, /Stop without committing if Part 1 refuses or fails/);
        const checkpoint = readFileSync(join(dir, 'checkpoint.md'), 'utf8');
        for (const step of checkpoint.match(/^[1-4]\. .*$/gm)) {
          assert.ok(body.includes(step), `ccheckpoint inlines the checkpoint steps: ${step.slice(0, 40)}`);
        }
      } else {
        assert.ok(body.includes('cah_todos') || body.includes('todowrite')
          || name === 'repo-sight' || name === 'checkpoint-prune', name);
      }
      // OpenCode 1.18.34 has no todoread tool; the plugin's cah_todos replaces it.
      assert.doesNotMatch(body, /todoread/, `${name}: no todoread`);
      assert.doesNotMatch(body, /sibling/, `${name}: no unreachable sibling reference`);
      assert.doesNotMatch(body, /(?<!Never )(?:write|restore|reapply|set|register)\s+(?:the\s+)?(?:status\s*[:=]\s*)?["']?(?:blocked|abandoned)\b/i,
        `${name}: no affirmative non-canonical status instruction`);
      assert.doesNotMatch(body, /status\s*[:=]\s*["'](?:blocked|abandoned)["']/i);
      assert.ok(!body.includes('TaskCreate') && !body.includes('CronCreate'), name);
    }
    const resume = readFileSync(join(dir, 'checkpoint-resume.md'), 'utf8');
    for (const status of ['pending', 'in_progress', 'completed', 'cancelled']) {
      assert.ok(resume.includes(status), `resume documents ${status}`);
    }
    assert.match(resume, /Never write blocked, abandoned/);
    assert.match(resume, /pending tasks whose content carries the blocker annotation/);
  });

  it('blocks reinstall when the runtime is foreign, before deleting anything', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-commands');
    const root = join(home, '.config', 'opencode');
    const command = join(root, 'commands', 'checkpoint.md');
    const installed = readFileSync(command);
    writeFileSync(join(root, 'cah-opencode', 'cah-babysit-scheduler.js'), 'personal scheduler');
    assert.equal(call(home, 'reinstall', '--opencode-commands').status, 1);
    assert.deepEqual(readFileSync(command), installed);
    assert.equal(readFileSync(join(root, 'cah-opencode', 'cah-babysit-scheduler.js'), 'utf8'),
      'personal scheduler');
    const templates = join(home, 'empty-templates');
    mkdirSync(templates);
    assert.equal(call(home, 'reinstall', '--opencode-commands', '--templates', templates).status, 1);
    assert.deepEqual(readFileSync(command), installed);
  });

  it('removes owned commands and runtime, prunes owned orphans, keeps foreign files', (t) => {
    const home = sandbox(t);
    const root = join(home, '.config', 'opencode');
    const dir = join(root, 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'triage.md'), 'personal triage');
    ok(home, 'install', '--opencode-commands');
    const orphan = join(dir, 'obsolete.md');
    writeFileSync(orphan, `${SetForOpencodeCommand.current}\nobsolete`);
    ok(home, 'reinstall', '--opencode-commands');
    assert.equal(existsSync(orphan), false);
    assert.equal(readFileSync(join(dir, 'triage.md'), 'utf8'), 'personal triage');
    ok(home, 'uninstall', '--opencode-commands');
    for (const name of OpencodeCommands.filter((name) => name !== 'triage')) {
      assert.equal(existsSync(join(dir, `${name}.md`)), false);
    }
    for (const rel of OpencodeCommandRuntimeFiles) {
      assert.equal(existsSync(join(root, rel)), false);
    }
    assert.equal(readFileSync(join(dir, 'triage.md'), 'utf8'), 'personal triage');
  });

  it('owner-boundary interlock aborts the owned write (CAS hook)', (t) => {
    const home = sandbox(t);
    const scope = new OpenCodeScope({ global: true, env: { OPENCODE_CONFIG_DIR: join(home, 'cfg') } });
    const templates = embeddedTemplates();
    writeOpencodeCommands(templates, scope);
    const path = join(scope.resolveRuntimeDir(), 'cah-babysit-scheduler.js');
    const foreign = Buffer.from('concurrent user replacement\r\n');
    let reached = false;
    assert.throws(() => writeOpencodeCommands(templates, scope, {
      testInterlock: (phase) => {
        if (phase === 'write-before-final-publication' && !reached) {
          reached = true;
          writeFileSync(path, foreign);
        }
      },
    }), /changed concurrently|refusing/);
    assert.equal(reached, true);
    assert.deepEqual(readFileSync(path), foreign);
  });

  it('a replacement at the real removal boundary survives with an explicit preservation report', (t) => {
    const home = sandbox(t);
    const scope = new OpenCodeScope({ global: true, env: { OPENCODE_CONFIG_DIR: join(home, 'cfg') } });
    writeOpencodeCommands(embeddedTemplates(), scope);
    const path = join(scope.resolveCommandsDir(), 'checkpoint.md');
    const foreign = Buffer.from('foreign checkpoint replacement\r\n');
    let reached = false;
    const result = removeOpencodeCommands(scope, {
      testInterlock: (phase) => {
        if (phase === 'remove-before-rename' && !reached) {
          reached = true;
          writeFileSync(path, foreign);
        }
      },
    });
    assert.equal(reached, true);
    const recoveryPaths = result.recovery.map((rel) => join(scope.opencodeRoot(), rel));
    for (const recoveryPath of recoveryPaths) {
      assert.ok(existsSync(recoveryPath), `surfaced recovery must exist: ${recoveryPath}`);
    }
    if (existsSync(path)) {
      assert.deepEqual(readFileSync(path), foreign);
      assert.ok(result.skipped.includes('command/checkpoint.md'));
    } else {
      assert.ok(recoveryPaths.length > 0, 'displaced foreign bytes require surfaced recovery');
      assert.ok(recoveryPaths.some((recoveryPath) => readFileSync(recoveryPath).equals(foreign)),
        'exact foreign bytes must survive removal and subsequent orphan maintenance');
    }
  });

  it('unpublishes the plugin before removing its scheduler and helper dependencies', (t) => {
    const home = sandbox(t);
    const scope = new OpenCodeScope({ global: true, env: { OPENCODE_CONFIG_DIR: join(home, 'cfg') } });
    writeOpencodeCommands(embeddedTemplates(), scope);
    const root = scope.opencodeRoot();
    const plugin = join(root, 'plugins', 'cah-babysit.js');
    const scheduler = join(root, 'cah-opencode', 'cah-babysit-scheduler.js');
    const helper = join(root, 'cah-opencode', 'commit-checkpoint.mjs');
    let observedPluginRemoval = false;
    const result = removeOpencodeCommands(scope, {
      testInterlock: (phase) => {
        if (phase !== 'remove-after-rename') return;
        if (!existsSync(scheduler) || !existsSync(helper)) {
          assert.equal(existsSync(plugin), false, 'dependencies cannot disappear while plugin is discoverable');
        }
        if (!existsSync(plugin) && !observedPluginRemoval) {
          observedPluginRemoval = true;
          assert.equal(existsSync(scheduler), true);
          assert.equal(existsSync(helper), true);
        }
      },
    });
    assert.equal(observedPluginRemoval, true);
    assert.equal(result.removed, OpencodeCommands.length + OpencodeCommandRuntimeFiles.length);
  });

  it('prunes runtime orphans in each flat namespace but preserves other plugin packages and nested user bytes', (t) => {
    const home = sandbox(t);
    const scope = new OpenCodeScope({ global: true, env: { OPENCODE_CONFIG_DIR: join(home, 'cfg') } });
    const templates = embeddedTemplates();
    writeOpencodeCommands(templates, scope);
    const root = scope.opencodeRoot();
    for (const dir of ['cah-opencode', 'plugin', 'plugins']) {
      mkdirSync(join(root, dir, 'user-tree'), { recursive: true });
      writeFileSync(join(root, dir, 'obsolete.js'), `${SetForOpencodeRuntime.current}\nold`);
      writeFileSync(join(root, dir, 'foreign.js'), '// other-package-runtime:v1\nuser bytes');
      writeFileSync(join(root, dir, 'user-tree', 'owned-looking.js'), SetForOpencodeRuntime.current);
    }
    writeFileSync(join(root, 'cah-opencode', 'cah-babysit-plugin.js'), SetForOpencodeRuntime.current);
    const result = writeOpencodeCommands(templates, scope);
    assert.equal(result.pruned, 4);
    assert.equal(existsSync(join(root, 'cah-opencode', 'cah-babysit-plugin.js')), false);
    for (const dir of ['cah-opencode', 'plugin', 'plugins']) {
      assert.equal(existsSync(join(root, dir, 'obsolete.js')), false);
      assert.equal(readFileSync(join(root, dir, 'foreign.js'), 'utf8'), '// other-package-runtime:v1\nuser bytes');
      assert.equal(existsSync(join(root, dir, 'user-tree', 'owned-looking.js')), true);
      assert.ok(result.skipped.includes(`${dir}/foreign.js`));
    }
  });

  it('exposes runtime leaves in list and doctor health', (t) => {
    const home = sandbox(t);
    ok(home, 'install', '--opencode-commands');
    const rows = list(home);
    for (const rel of OpencodeCommandRuntimeFiles) {
      assert.equal(rows.find((r) => r.kind === 'opencode-command-runtime' && r.name === rel).state, 'mine');
    }
    const doctor = call(home, 'doctor', '--opencode-commands');
    assert.equal(doctor.status, 0, doctor.stdout);
    const schedulerPath = join(home, '.config', 'opencode', OpencodeCommandRuntimeFiles[0]);
    const scheduler = readFileSync(schedulerPath);
    rmSync(schedulerPath);
    const after = call(home, 'doctor', '--opencode-commands');
    assert.equal(after.status, 1);
    writeFileSync(schedulerPath, scheduler);
  });
});
