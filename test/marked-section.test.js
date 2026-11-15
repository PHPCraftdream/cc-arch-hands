import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkedSection, markerRange } from '../lib/marked-section.js';
import { OMP_AGENT_TAGS_BEGIN, removeOmpInstructions, writeOmpInstructions } from '../lib/omp-instructions.js';

const BEGIN = '<!-- t:start -->';
const END = '<!-- t:end -->';
const section = createMarkedSection({
  begin: BEGIN, end: END, section: `${BEGIN}\nline one\nline two\n${END}`, label: 'Test file',
});

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-marked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('marked section', () => {
  it('adds after the user text, refreshes in place, and removes back to the original bytes', (t) => {
    const path = join(sandbox(t), 'AGENTS.md');
    const original = '# Mine\n\nKeep this.\n';
    writeFileSync(path, original);
    assert.equal(section.write(path).written, 1);
    assert.equal(section.write(path).written, 0, 'unchanged: nothing is written');
    writeFileSync(path, readFileSync(path, 'utf8').replace('line two', 'old wording'));
    assert.equal(section.write(path).written, 1, 'a changed block is refreshed');
    assert.match(readFileSync(path, 'utf8'), /line two/);
    assert.equal(section.remove(path).removed, 1);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(section.remove(path).removed, 0);
  });

  it('keeps text written after the block', (t) => {
    const path = join(sandbox(t), 'AGENTS.md');
    section.write(path);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n## Later\nKeep me.\n`);
    section.write(path);
    assert.ok(readFileSync(path, 'utf8').endsWith('\n## Later\nKeep me.\n'));
  });

  it('writes CRLF into a CRLF file and restores it byte for byte', (t) => {
    const path = join(sandbox(t), 'AGENTS.md');
    const original = '# Mine\r\n\r\nKeep this.\r\n';
    writeFileSync(path, original);
    section.write(path);
    assert.equal(readFileSync(path, 'utf8').replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
    section.remove(path);
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('creates a missing file and removes a file that held only the block', (t) => {
    const path = join(sandbox(t), 'AGENTS.md');
    section.write(path);
    assert.equal(readFileSync(path, 'utf8'), `${BEGIN}\nline one\nline two\n${END}\n`);
    section.remove(path);
    assert.equal(existsSync(path), false);
  });

  it('refuses broken markers and changes nothing', (t) => {
    const dir = sandbox(t);
    const path = join(dir, 'AGENTS.md');
    const cases = {
      'a begin without an end': `${BEGIN}\ntext\n`,
      'two blocks': `${BEGIN}\n${END}\n${BEGIN}\n${END}\n`,
      'the end before the begin': `${END}\n${BEGIN}\n`,
      'a marker inside a line': `text ${BEGIN}\n${END}\n`,
    };
    for (const [name, content] of Object.entries(cases)) {
      writeFileSync(path, content);
      assert.throws(() => section.write(path), /Test file/, name);
      assert.throws(() => section.remove(path), /Test file/, name);
      assert.equal(readFileSync(path, 'utf8'), content, name);
    }
  });
});

describe('markerRange', () => {
  const begin = Buffer.from(BEGIN);
  const end = Buffer.from(END);
  const range = (text) => markerRange(Buffer.from(text), begin, end, 'Test file');

  it('finds the one block between marker lines, and none when there is no marker', () => {
    assert.equal(range('plain text\n'), null);
    const text = `before\n${BEGIN}\nbody\n${END}\nafter\n`;
    const found = range(text);
    assert.equal(text.slice(found.start, found.end), `${BEGIN}\nbody\n${END}`);
  });

  it('refuses a lone, repeated or reversed marker, naming the file', () => {
    for (const text of [`${BEGIN}\n`, `${END}\n`, `${BEGIN}\n${BEGIN}\n${END}\n`, `${END}\n${BEGIN}\n`]) {
      assert.throws(() => range(text), /Test file has incomplete or duplicate markers/, text);
    }
  });

  it('refuses a marker that shares its line with other text', () => {
    assert.throws(() => range(`text ${BEGIN}\nbody\n${END}\n`),
      /Test file markers must occupy their own lines/);
    assert.throws(() => range(`${BEGIN}\nbody\n${END} text\n`),
      /Test file markers must occupy their own lines/);
  });
});

describe('the OMP rule built on it', () => {
  it('keeps CRLF and removes an APPEND_SYSTEM.md that held only the rule', (t) => {
    const dir = sandbox(t);
    const agentRoot = join(dir, 'agent');
    mkdirSync(agentRoot);
    const scope = { agentRoot: () => agentRoot };
    const path = join(agentRoot, 'APPEND_SYSTEM.md');
    writeFileSync(path, '# Personal\r\n');
    assert.equal(writeOmpInstructions(scope).written, 1);
    const written = readFileSync(path, 'utf8');
    assert.ok(written.includes(OMP_AGENT_TAGS_BEGIN));
    assert.equal(written.replace(/\r\n/g, '').includes('\n'), false);
    removeOmpInstructions(scope);
    assert.equal(readFileSync(path, 'utf8'), '# Personal\r\n');

    rmSync(path);
    writeOmpInstructions(scope);
    removeOmpInstructions(scope);
    assert.equal(existsSync(path), false);
  });
});
