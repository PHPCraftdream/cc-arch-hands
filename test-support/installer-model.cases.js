import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './installer-test-helpers.js';
import { FABLE_ORACLE } from './installer-test-helpers.js';
import { SentinelModelCommand, SentinelModelAgent, LegacyModelCommand, LegacyModelAgent, SetForModelCommand, Ownership, classifyContent } from '../lib/sentinel.js';
import { AllModelCommands, AllCodexAgents } from '../lib/manifest.js';
import { Scope } from '../lib/scope.js';
import { writeModelCommands, removeModelCommands } from '../lib/commands.js';
import { writeModelAgents, removeModelAgents } from '../lib/agents.js';

// ---------------------------------------------------------------------------
// Fable model contract (fixed oracle, independent of manifest values)
// ---------------------------------------------------------------------------

describe('Fable model contract', { concurrency: false }, () => {
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

describe('classifyContent', { concurrency: false }, () => {
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

describe('writeModelCommands', { concurrency: false }, () => {
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
    assert.deepEqual(skipped, ['someone-else.md']);
    assert.equal(pruned, 2, 'mine + legacy orphans removed, foreign preserved');

    assert.throws(() => statSync(orphanMine), { code: 'ENOENT' });
    assert.throws(() => statSync(orphanLegacy), { code: 'ENOENT' });
    assert.equal(readFileSync(orphanForeign, 'utf8'), 'not yours');
  });
});

// ---------------------------------------------------------------------------
// RemoveModelCommands
// ---------------------------------------------------------------------------

describe('removeModelCommands', { concurrency: false }, () => {
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

const NL = String.fromCharCode(10);

describe('Haiku aliases', { concurrency: false }, () => {
  it('maps the top and N-back Haiku sets and keeps Codex hl untouched', () => {
    const haiku = AllModelCommands.filter((entry) => entry.model.includes('haiku'));
    assert.deepEqual(haiku.map((entry) => [entry.name, entry.model, entry.effort]), [
      ['hl', 'claude-haiku-5-5', 'low'],
      ['hm', 'claude-haiku-5-5', 'medium'],
      ['hh', 'claude-haiku-5-5', 'high'],
      ['hx', 'claude-haiku-5-5', 'xhigh'],
      ['hxx', 'claude-haiku-5-5', 'max'],
      ['h1l', 'claude-haiku-4-5', 'low'],
      ['h1m', 'claude-haiku-4-5', 'medium'],
      ['h1h', 'claude-haiku-4-5', 'high'],
      ['h1x', 'claude-haiku-4-5', 'xhigh'],
      ['h1xx', 'claude-haiku-4-5', 'max'],
    ]);
    // The Codex registry has its own hl/hl1; the Claude set must not alter it.
    assert.equal(AllCodexAgents.find((entry) => entry.name === 'hl').model, 'gpt-6-luna');
    assert.equal(AllCodexAgents.find((entry) => entry.name === 'hl1').model, 'gpt-5.6-luna');
    for (const legacy of ['h', 'h45', 'h45l', 'h45m', 'h45h']) {
      assert.equal(AllModelCommands.some((entry) => entry.name === legacy), false, `${legacy} is a retired Haiku alias`);
    }
  });

  it('renders effort frontmatter for every Haiku variant', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    writeModelCommands(null, scope);
    writeModelAgents(null, scope);
    const read = (kind, name) => readFileSync(join(dir, '.claude', kind, `${name}.md`), 'utf8');
    const has = (kind, name, ...frontmatter) => read(kind, name).includes(frontmatter.join(NL) + NL + '---');
    assert.ok(has('commands', 'hm', 'model: claude-haiku-5-5', 'effort: medium'));
    assert.ok(read('agents', 'hxx').includes('description: claude-haiku-5-5 effort=max (Haiku (top, 1M) – max)'));
    assert.ok(has('agents', 'hxx', 'model: claude-haiku-5-5', 'effort: max'));
    assert.ok(has('commands', 'h1x', 'model: claude-haiku-4-5', 'effort: xhigh'));
  });

  it('prunes previously installed owned h and h45 files and keeps foreign ones', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const commands = join(dir, '.claude', 'commands');
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(commands, 'h.md'), `old body${NL}${SentinelModelCommand}${NL}`);
    writeFileSync(join(commands, 'h45.md'), `old body${NL}${SentinelModelCommand}${NL}`);
    writeFileSync(join(commands, 'h2.md'), 'foreign command' + NL);
    const result = writeModelCommands(null, scope);
    assert.equal(existsSync(join(commands, 'h.md')), false);
    assert.equal(existsSync(join(commands, 'h45.md')), false);
    assert.equal(readFileSync(join(commands, 'h2.md'), 'utf8'), 'foreign command' + NL);
    assert.equal(result.pruned, 2);
  });
});

// ---------------------------------------------------------------------------
// WriteModelAgents
// ---------------------------------------------------------------------------

describe('writeModelAgents', { concurrency: false }, () => {
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
    assert.deepEqual(skipped, ['someone-else.md']);
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

describe('removeModelAgents', { concurrency: false }, () => {
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

  it('reports a stable symlink removed-alias as the canonical survivor without following it', (t) => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const target = join(dir, 'outside-agent.md');
    const alias = join(agentsDir, 'a-removed-agent.md');
    writeFileSync(target, 'outside user data\n');
    try {
      symlinkSync(target, alias, 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('symlinks are unavailable on this host');
        return;
      }
      throw error;
    }

    const result = removeModelAgents(scope);
    assert.deepEqual(result.skipped, ['a-removed-agent.md']);
    assert.deepEqual(result.recovery, []);
    assert.ok(lstatSync(alias).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), 'outside user data\n');
  });

  it('reports a stable non-regular orphan entry without descending into it', () => {
    const dir = tmpDir();
    const scope = new Scope({ cwd: dir });
    const agentsDir = join(dir, '.claude', 'agents');
    const orphanDir = join(agentsDir, 'foreign-orphan-dir');
    mkdirSync(join(orphanDir, 'nested'), { recursive: true });
    writeFileSync(join(orphanDir, 'nested', 'not-a-leaf.md'), 'user data\n');

    const result = removeModelAgents(scope);
    assert.deepEqual(result.skipped, ['foreign-orphan-dir']);
    assert.deepEqual(result.recovery, []);
    assert.ok(existsSync(join(orphanDir, 'nested', 'not-a-leaf.md')));
  });
});
