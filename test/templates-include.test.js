import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { diskTemplates, embeddedTemplates, SHARED_KIND } from '../lib/templates.js';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-templates-include-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => {
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  return { root, put };
}

function tree(templates, name, kind) {
  return Object.fromEntries(templates.skillTree(name, kind)
    .map((file) => [file.relPath, file.bytes.toString('utf8')]));
}

describe('shared template fragments', () => {
  it('expands a whole-line include in every harness kind from one fragment', (t) => {
    const { root, put } = sandbox(t);
    put('shared/rule.md', 'Shared rule.\n- one\n');
    for (const kind of ['skills', 'codex-skills', 'opencode-commands']) {
      put(`${kind}/demo/SKILL.md`, '# demo\n\n{{include:rule}}\n\nTail.\n');
    }
    const templates = diskTemplates(root);
    for (const kind of ['skills', 'codex-skills', 'opencode-commands']) {
      assert.equal(tree(templates, 'demo', kind)['SKILL.md'], '# demo\n\nShared rule.\n- one\n\nTail.\n');
    }
  });

  it('keeps CRLF line endings around the expanded fragment', (t) => {
    const { root, put } = sandbox(t);
    put('shared/rule.md', 'Shared rule.\r\n');
    put('skills/demo/SKILL.md', 'a\r\n{{include:rule}}\r\nb\r\n');
    assert.equal(tree(diskTemplates(root), 'demo', 'skills')['SKILL.md'], 'a\r\nShared rule.\r\nb\r\n');
  });

  it('leaves non-Markdown files and include-free templates byte-identical', (t) => {
    const { root, put } = sandbox(t);
    put('skills/demo/SKILL.md', 'plain\n');
    put('skills/demo/scripts/tool.mjs', "const s = '{{include:rule}}';\n");
    const files = tree(diskTemplates(root), 'demo', 'skills');
    assert.equal(files['SKILL.md'], 'plain\n');
    assert.equal(files['scripts/tool.mjs'], "const s = '{{include:rule}}';\n");
  });

  it('refuses a missing fragment, an inline include, and nested includes', (t) => {
    const { root, put } = sandbox(t);
    put('skills/missing/SKILL.md', '{{include:absent}}\n');
    put('skills/inline/SKILL.md', 'see {{include:rule}} here\n');
    put('skills/nested/SKILL.md', '{{include:outer}}\n');
    put('shared/rule.md', 'rule\n');
    put('shared/outer.md', '{{include:rule}}\n');
    const templates = diskTemplates(root);
    assert.throws(() => templates.skillTree('missing', 'skills'), /missing shared fragment shared\/absent\.md/);
    assert.throws(() => templates.skillTree('inline', 'skills'), /an include must be a whole line/);
    assert.throws(() => templates.skillTree('nested', 'skills'), /shared fragments cannot include other fragments/);
  });

  it('every bundled template resolves its includes and every fragment is used', () => {
    const templates = embeddedTemplates();
    const root = fileURLToPath(new URL('../templates', import.meta.url));
    const used = new Set();
    for (const kind of readdirSync(root, { withFileTypes: true })) {
      if (!kind.isDirectory() || kind.name === SHARED_KIND) continue;
      for (const entry of readdirSync(join(root, kind.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const file of templates.skillTree(entry.name, kind.name)) {
          assert.ok(!file.bytes.toString('utf8').includes('{{include:'), `${kind.name}/${entry.name}/${file.relPath}`);
        }
        for (const raw of walkRaw(join(root, kind.name, entry.name))) {
          for (const match of raw.matchAll(/^\{\{include:([a-z0-9-]+)\}\}\r?$/gm)) used.add(match[1]);
        }
      }
    }
    const fragments = readdirSync(join(root, SHARED_KIND)).map((name) => name.replace(/\.md$/, ''));
    assert.deepEqual([...used].sort(), fragments.sort(), 'no unused or undeclared shared fragment');
  });
});

function walkRaw(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRaw(full));
    else if (entry.name.endsWith('.md')) out.push(readFileSync(full, 'utf8'));
  }
  return out;
}
