import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmdirSync, mkdtempSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { tmpDir, waitForPath, runLeafWriterWorker } from './installer-test-helpers.js';
import {
  SentinelBin, SentinelModelCommand, SentinelModelAgent, SentinelCodexAgent, SentinelSkill,
  LegacyModelCommand, LegacyModelAgent,
  SetForModelCommand, SetForModelAgent, SetForCodexAgent, SetForSkill,
} from '../lib/sentinel.js';
import { AllCodexAgents, AllSkills } from '../lib/manifest.js';
import { Scope, SKILL_MANIFEST_LEAF } from '../lib/scope.js';
import { writeModelCommands, removeModelCommands } from '../lib/commands.js';
import { writeModelAgents, removeModelAgents } from '../lib/agents.js';
import { writeCodexAgents, removeCodexAgents } from '../lib/codex-agents.js';
import { removeBins } from '../lib/binstall.js';
import { writeSkills, removeSkills } from '../lib/skills.js';
import { embeddedTemplates } from '../lib/templates.js';

// ---------------------------------------------------------------------------
// WriteCodexAgents
// ---------------------------------------------------------------------------

describe('writeCodexAgents', { concurrency: false }, () => {
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

    const foreignPath = join(agentsDir, 'ha.toml');
    const foreignBody = 'someone else owns this';
    writeFileSync(foreignPath, foreignBody);

    const { written, skipped } = writeCodexAgents(null, scope);
    assert.equal(written, AllCodexAgents.length - 1);
    assert.deepEqual(skipped, ['ha.toml']);
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

describe('removeCodexAgents', { concurrency: false }, () => {
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

    const minePath = join(agentsDir, 'ha.toml');
    writeFileSync(minePath, `x\n${SentinelCodexAgent}\n`);
    const foreignPath = join(agentsDir, 'ma.toml');
    const foreignBody = 'not yours';
    writeFileSync(foreignPath, foreignBody);

    const { removed, skipped } = removeCodexAgents(scope);
    assert.equal(removed, 1);
    assert.deepEqual(skipped, ['ma.toml']);
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

describe('truthful deterministic quarantine reporting', { concurrency: false }, () => {
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
      const canonical = entry.bin ? 'bin/orphan.js' : entry.leaf;
      const recoveryPath = entry.bin ? 'bin/orphan.js.cah-owned-remove/payload' : preserved;
      assert.deepEqual(result.skipped.filter((value) => value === canonical), [canonical], entry.label);
      assert.deepEqual(result.recovery.filter((value) => value === recoveryPath), [recoveryPath], entry.label);
      assert.equal(readFileSync(join(quarantine, 'payload'), 'utf8'), `preserved ${entry.label}\n${entry.sentinel}\n`);
      assert.equal(readFileSync(orphan, 'utf8'), `${entry.sentinel}\n`);
      assert.equal(
        result.skipped.filter((value) => value.includes('orphan')).length,
        1,
        `${entry.label} must report the canonical survivor once`,
      );
      assert.equal(
        result.recovery.filter((value) => value.includes('orphan')).length,
        1,
        `${entry.label} must report the bounded slot once`,
      );
      assert.equal(new Set(result.skipped).size, result.skipped.length, `${entry.label} skipped dedupe`);
      assert.equal(new Set(result.recovery).size, result.recovery.length, `${entry.label} recovery dedupe`);
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

describe('shared leaf publication', { concurrency: false }, () => {
  for (const [kind, install, leaf] of [
    ['commands', (scope) => writeModelCommands(null, scope), ['.claude', 'commands', 'fl.md']],
    ['agents', (scope) => writeModelAgents(null, scope), ['.claude', 'agents', 'fl.md']],
    ['codex', (scope) => writeCodexAgents(null, scope), ['.codex', 'agents', 'lt.toml']],
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
