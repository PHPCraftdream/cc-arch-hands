import { join } from 'node:path';
import { captureRegularFileSnapshot, writeFileAtomic } from './fsutil.js';

export const CODEX_MCP_BEGIN = '# cah-cli-run-mcp:start';
export const CODEX_MCP_END = '# cah-cli-run-mcp:end';

const beginBytes = Buffer.from(CODEX_MCP_BEGIN);
const endBytes = Buffer.from(CODEX_MCP_END);
// A second cli-run server definition would be a duplicate TOML table and break Codex's config.
const FOREIGN_SERVER = /^[ \t]*(?:\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:cli-run|"cli-run"|'cli-run')[ \t]*[.\]]|mcp_servers[ \t]*\.[ \t]*(?:cli-run|"cli-run"|'cli-run')[ \t]*[.=])/m;

export function codexMcpConfigPath(scope) {
  return join(scope.codexRoot(), 'config.toml');
}

export function codexMcpServerPath(scope) {
  return join(scope.resolveCodexSkillsDir(), 'cli-run', 'scripts', 'mcp-server.mjs');
}

function positions(content, marker) {
  const found = [];
  for (let from = 0; ; ) {
    const at = content.indexOf(marker, from);
    if (at < 0) return found;
    found.push(at);
    from = at + marker.length;
  }
}

function sectionRange(content) {
  const starts = positions(content, beginBytes);
  const ends = positions(content, endBytes);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0] + beginBytes.length) {
    throw new Error('Codex config.toml has incomplete or duplicate cli-run MCP markers');
  }
  const start = starts[0];
  const end = ends[0] + endBytes.length;
  if ((start > 0 && content[start - 1] !== 10)
      || (end < content.length && content[end] !== 10 && content[end] !== 13)) {
    throw new Error('Codex config.toml cli-run MCP markers must occupy their own lines');
  }
  return { start, end };
}

function assertNoForeignServer(content, range) {
  const outside = range
    ? Buffer.concat([content.subarray(0, range.start), content.subarray(range.end)])
    : content;
  if (FOREIGN_SERVER.test(outside.toString('utf8'))) {
    throw new Error('Codex config.toml already defines an unmanaged cli-run MCP server');
  }
}

export function inspectCodexMcpConfig(scope) {
  const path = codexMcpConfigPath(scope);
  const snapshot = captureRegularFileSnapshot(path);
  const content = snapshot.content ?? Buffer.alloc(0);
  const range = sectionRange(content);
  assertNoForeignServer(content, range);
  return { path, snapshot, range };
}

function sectionBytes(scope, eol, runApprovalLines) {
  return Buffer.from([
    CODEX_MCP_BEGIN,
    '[mcp_servers.cli-run]',
    'command = "node"',
    // JSON string escapes are valid TOML basic-string escapes.
    `args = [${JSON.stringify(codexMcpServerPath(scope))}]`,
    ...runApprovalLines,
    CODEX_MCP_END,
  ].join(eol));
}

export function writeCodexMcpConfig(scope) {
  const { path, snapshot, range } = inspectCodexMcpConfig(scope);
  const original = snapshot.content ?? Buffer.alloc(0);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const runApprovalLines = [];
  if (range) {
    let serverTable = false;
    for (const line of original.subarray(range.start, range.end).toString('utf8').split(/\r?\n/)) {
      if (/^[ \t]*\[/.test(line)) serverTable = /^[ \t]*\[mcp_servers\.cli-run\][ \t]*(?:#.*)?$/.test(line);
      else if (serverTable && /^[ \t]*tools\.run\.approval_mode[ \t]*=/.test(line)) runApprovalLines.push(line);
    }
  }
  const section = sectionBytes(scope, eol, runApprovalLines);
  let updated;
  if (range) {
    updated = Buffer.concat([original.subarray(0, range.start), section, original.subarray(range.end)]);
  } else {
    const separator = original.length === 0 ? '' : eol + eol;
    updated = Buffer.concat([original, Buffer.from(separator), section, Buffer.from(eol)]);
  }
  if (updated.equals(original)) return { written: 0, skipped: [] };
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { written: 1, skipped: [] };
}

export function removeCodexMcpConfig(scope) {
  const { path, snapshot, range } = inspectCodexMcpConfig(scope);
  if (!range) return { removed: 0, skipped: [] };
  const original = snapshot.content;
  let prefixStart = range.start;
  for (const blank of ['\r\n\r\n', '\n\n']) {
    if (original.subarray(Math.max(0, range.start - blank.length), range.start).toString() === blank) {
      prefixStart = range.start - blank.length;
      break;
    }
  }
  let suffixStart = range.end;
  for (const eol of ['\r\n', '\n']) {
    if (original.subarray(suffixStart, suffixStart + eol.length).toString() === eol) {
      suffixStart += eol.length;
      break;
    }
  }
  const updated = Buffer.concat([original.subarray(0, prefixStart), original.subarray(suffixStart)]);
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { removed: 1, skipped: [] };
}

export function classifyCodexMcpConfig(scope) {
  try {
    return inspectCodexMcpConfig(scope).range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
