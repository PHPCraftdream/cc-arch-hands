#!/usr/bin/env node
import { normalizeCommands } from './spec.mjs';
import { readStatus } from './store.mjs';
import { startRun } from './launch.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 2_000_000;

const JOB_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Unique job ID: letters, digits, ".", "_", "-"; max 64 chars.' },
    argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Program and arguments, started without a shell (preferred).' },
    command: { type: 'string', description: 'Platform-shell command string; use for .cmd/.bat wrappers such as npm on Windows.' },
    cwd: { type: 'string', description: 'Absolute working directory. Defaults to the session workspace root when there is exactly one.' },
  },
  required: ['id'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'run',
    description: 'Start CLI commands as background jobs and return immediately with a runId. '
      + 'Each finished job is reported to this Codex thread as a "cli-run <runId>: <id> ..." message '
      + 'with its exit code, the last output lines, and the full log path. Do not wait or poll after launching.',
    inputSchema: {
      type: 'object',
      properties: {
        jobs: { type: 'array', items: JOB_SCHEMA, minItems: 1, maxItems: 64, description: 'Jobs to run; each needs exactly one of argv or command.' },
        maxParallel: { type: 'integer', minimum: 1, maximum: 16, description: 'Concurrent job limit (default 4).' },
      },
      required: ['jobs'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description: 'Read the saved state of a cli-run run: per-job exit codes, log paths, and notification delivery. '
      + 'Use when asked, or when a completion message is missing or reported a delivery failure.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'runId returned by run.' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

function turnMetadata(meta) {
  const value = meta?.['x-codex-turn-metadata'];
  return value && typeof value === 'object' ? value : {};
}

function threadOf(meta) {
  const thread = meta?.threadId ?? turnMetadata(meta).thread_id;
  return typeof thread === 'string' && thread ? thread : null;
}

function defaultCwd(meta) {
  const roots = Object.keys(turnMetadata(meta).workspaces ?? {});
  return roots.length === 1 ? roots[0] : null;
}

async function callTool(name, args, meta) {
  if (name === 'run') {
    const thread = threadOf(meta);
    if (!thread) throw new Error('Codex did not supply a thread ID for this call; completion messages cannot be routed');
    const commands = normalizeCommands(args?.jobs, defaultCwd(meta));
    const run = await startRun({ commands, thread, maxParallel: args?.maxParallel ?? 4 });
    run.child.unref();
    return { runId: run.runId, statusDir: run.statusDir, jobs: run.commands };
  }
  if (name === 'status') return readStatus(String(args?.runId ?? ''));
  const error = new Error(`unknown tool: ${name}`);
  error.code = -32602;
  throw error;
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'cli-run', version: '1.0.0' },
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call':
      try {
        const result = await callTool(params?.name, params?.arguments, params?._meta);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (error.code) throw error;
        return { isError: true, content: [{ type: 'text', text: `cli-run: ${error.message}` }] };
      }
    default: {
      if (id === undefined) return undefined;
      const error = new Error(`method not found: ${method}`);
      error.code = -32601;
      throw error;
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function dispatch(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
  handle(message).then(
    (result) => { if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result }); },
    (error) => {
      if (message.id === undefined) return;
      send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    },
  );
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) dispatch(line);
  }
  if (buffer.length > MAX_LINE_BYTES) {
    buffer = '';
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } });
  }
});
