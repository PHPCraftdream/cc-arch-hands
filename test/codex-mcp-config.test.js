import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scope } from '../lib/scope.js';
import {
  CODEX_MCP_BEGIN, CODEX_MCP_END, classifyCodexMcpConfig, codexMcpServerPath,
  writeCodexMcpConfig, removeCodexMcpConfig,
} from '../lib/codex-mcp-config.js';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-codex-mcp-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.codex'));
  return { scope: new Scope({ cwd: dir }), path: join(dir, '.codex', 'config.toml') };
}

describe('managed Codex config.toml cli-run MCP entry', () => {
  for (const [label, original] of [
    ['LF with trailing newline', 'model = "x"\n\n[projects.\'d:\\\\a\']\ntrust_level = "trusted"\n'],
    ['CRLF with trailing newline', 'model = "x"\r\n[tui]\r\ntheme = "zenburn"\r\n'],
    ['no trailing newline', 'model = "x"'],
  ]) {
    it(`restores the original bytes after install and removal (${label})`, (t) => {
      const { scope, path } = sandbox(t);
      writeFileSync(path, original);
      assert.equal(writeCodexMcpConfig(scope).written, 1);
      const installed = readFileSync(path, 'utf8');
      assert.ok(installed.startsWith(original));
      assert.ok(installed.includes(`${CODEX_MCP_BEGIN}${original.includes('\r\n') ? '\r\n' : '\n'}[mcp_servers.cli-run]`));
      assert.ok(installed.includes(`args = [${JSON.stringify(codexMcpServerPath(scope))}]`));
      if (original.includes('\r\n')) assert.ok(!/[^\r]\n/.test(installed), 'keeps CRLF line endings');
      assert.equal(classifyCodexMcpConfig(scope), 'mine');
      assert.equal(writeCodexMcpConfig(scope).written, 0);
      assert.equal(removeCodexMcpConfig(scope).removed, 1);
      assert.equal(readFileSync(path, 'utf8'), original);
      assert.equal(removeCodexMcpConfig(scope).removed, 0);
      assert.equal(classifyCodexMcpConfig(scope), 'missing');
    });
  }

  it('creates the config when absent and leaves an empty file after removal', (t) => {
    const { scope, path } = sandbox(t);
    assert.equal(writeCodexMcpConfig(scope).written, 1);
    const installed = readFileSync(path, 'utf8');
    assert.ok(installed.startsWith(CODEX_MCP_BEGIN));
    assert.ok(installed.endsWith(`${CODEX_MCP_END}\n`));
    assert.equal(removeCodexMcpConfig(scope).removed, 1);
    assert.equal(readFileSync(path, 'utf8'), '');
  });

  it('rewrites a stale managed block in place and keeps user content after it', (t) => {
    const { scope, path } = sandbox(t);
    const stale = `a = 1\n\n${CODEX_MCP_BEGIN}\n[mcp_servers.cli-run]\ncommand = "old"\n${CODEX_MCP_END}\n\n[tui]\ntheme = "x"\n`;
    writeFileSync(path, stale);
    assert.equal(writeCodexMcpConfig(scope).written, 1);
    const updated = readFileSync(path, 'utf8');
    assert.ok(!updated.includes('command = "old"'));
    assert.ok(updated.includes('command = "node"'));
    assert.ok(updated.startsWith('a = 1\n\n'));
    assert.ok(updated.endsWith('\n\n[tui]\ntheme = "x"\n'));
  });

  for (const foreign of [
    '[mcp_servers.cli-run]\ncommand = "mine"\n',
    '[mcp_servers."cli-run"]\ncommand = "mine"\n',
    '[mcp_servers.cli-run.env]\nA = "1"\n',
    'mcp_servers.cli-run.command = "mine"\n',
  ]) {
    it(`refuses to touch an unmanaged cli-run server: ${foreign.split('\n')[0]}`, (t) => {
      const { scope, path } = sandbox(t);
      writeFileSync(path, foreign);
      assert.throws(() => writeCodexMcpConfig(scope), /unmanaged cli-run MCP server/);
      assert.throws(() => removeCodexMcpConfig(scope), /unmanaged cli-run MCP server/);
      assert.equal(classifyCodexMcpConfig(scope), 'foreign');
      assert.equal(readFileSync(path, 'utf8'), foreign);
    });
  }

  it('does not mistake other servers for cli-run', (t) => {
    const { scope, path } = sandbox(t);
    writeFileSync(path, '[mcp_servers.cli-runner]\ncommand = "x"\n[mcp_servers.node_repl]\ncommand = "y"\n');
    assert.equal(writeCodexMcpConfig(scope).written, 1);
  });

  it('refuses broken markers without writing', (t) => {
    const { scope, path } = sandbox(t);
    const broken = `${CODEX_MCP_BEGIN}\n[mcp_servers.cli-run]\n`;
    writeFileSync(path, broken);
    assert.throws(() => writeCodexMcpConfig(scope), /incomplete or duplicate/);
    assert.equal(classifyCodexMcpConfig(scope), 'foreign');
    assert.equal(readFileSync(path, 'utf8'), broken);
  });
});
