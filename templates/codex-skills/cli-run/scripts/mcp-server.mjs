#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCommands } from './spec.mjs';
import { readStatus, runDirectory } from './store.mjs';
import { startRun } from './launch.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 2_000_000;
const INLINE_OUTPUT_PER_JOB_BYTES = 64 * 1024;
const INLINE_OUTPUT_TOTAL_BYTES = 256 * 1024;
const LOG_TAIL_DEFAULT_BYTES = 8 * 1024;

function readOutput(path, limit, tail = false) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const start = tail ? size - buffer.length : 0;
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: size > bytesRead,
      bytesRead,
    };
  } finally {
    closeSync(fd);
  }
}

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
    title: 'Запустить задачу',
    description: 'Run potentially long CLI jobs such as tests, builds, compilation, copies, and CI watches. Use native tools directly for quick git, search, and source-reading commands. '
      + 'Give each run a taskName; the immediate queue acknowledgment contains only that name and the assigned UID. Queue delivery reports one concise completion for the whole task; inline delivery returns results directly for native spawned agents.',
    inputSchema: {
      type: 'object',
      properties: {
        taskName: { type: 'string', minLength: 1, maxLength: 120, description: 'Required human-readable name for this run. The server assigns its UID.' },
        jobs: { type: 'array', items: JOB_SCHEMA, minItems: 1, maxItems: 64, description: 'Jobs to run; each needs exactly one of argv or command.' },
        maxParallel: { type: 'integer', minimum: 1, maximum: 16, description: 'Concurrent job limit (default 4).' },
        showOutput: { type: 'boolean', description: 'Include output in inline results (default false, up to 64 KiB per job). Queue notifications stay brief; use logs for output.' },
        delivery: { type: 'string', enum: ['queue', 'inline'], description: 'queue (default) posts completion to the calling thread; inline returns completed jobs through this tool call for native spawned agents.' },
      },
      required: ['taskName', 'jobs'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    title: 'Статус задачи',
    description: 'Read task status by UID or exact task name. A reused name selects its most recent run.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Task UID or exact task name.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'logs',
    title: 'Логи задачи',
    description: 'Read saved job output by task UID or exact name (most recent run for repeated names). Returns bounded tails, never full unbounded logs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task UID or exact task name.' },
        jobId: { type: 'string', description: 'Optional job ID; omit to view all available job logs.' },
        tailBytes: { type: 'integer', minimum: 1, maximum: 65536, description: 'Max bytes from each log tail (default 8192); total returned log text capped at 256 KiB.' },
      },
      required: ['query'],
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
    const taskName = args?.taskName;
    const delivery = args?.delivery ?? 'queue';
    const thread = threadOf(meta);
    if (delivery === 'queue' && !thread) {
      throw new Error('Codex did not supply a thread ID for this call; completion messages cannot be routed');
    }
    const commands = normalizeCommands(args?.jobs, defaultCwd(meta));
    const showOutput = args?.showOutput ?? false;
    const run = await startRun({ taskName, commands, thread, maxParallel: args?.maxParallel ?? 4, showOutput, delivery });
    if (delivery === 'queue') return { taskName: run.taskName, uid: run.uid };

    const order = new Map(commands.map((command, index) => [command.id, index]));
    let remaining = INLINE_OUTPUT_TOTAL_BYTES;
    const results = run.status.results.sort((a, b) => order.get(a.id) - order.get(b.id)).map((result) => {
      if (!showOutput) return result;
      const { bytesRead, ...output } = readOutput(result.log, Math.min(remaining, INLINE_OUTPUT_PER_JOB_BYTES));
      remaining -= bytesRead;
      return { ...result, output };
    });
    return {
      uid: run.uid, taskName: run.taskName, runId: run.runId, statusDir: run.statusDir, jobs: run.commands,
      completed: run.status.completed, finishedAt: run.status.finishedAt,
      fatal: run.status.fatal, results,
    };
  }
  if (name === 'status') return readStatus(args?.query ?? args?.runId);
  if (name === 'logs') {
    const status = readStatus(args?.query);
    const limit = args?.tailBytes ?? LOG_TAIL_DEFAULT_BYTES;
    if (!Number.isInteger(limit) || limit < 1 || limit > INLINE_OUTPUT_PER_JOB_BYTES) {
      throw new Error('tailBytes must be 1-65536');
    }
    const jobId = args?.jobId;
    if (jobId !== undefined && (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(jobId))) {
      throw new Error('invalid jobId');
    }
    const dir = runDirectory(status.uid);
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log')
        && (jobId === undefined || entry.name === `${jobId}.log`))
      .map((entry) => entry.name);
    if (jobId !== undefined && names.length === 0) throw new Error(`log not found: ${jobId}`);
    let remaining = INLINE_OUTPUT_TOTAL_BYTES;
    const logs = names.map((entry) => {
      const log = join(dir, entry);
      const { bytesRead, ...output } = readOutput(log, Math.min(limit, remaining), true);
      remaining -= bytesRead;
      return { jobId: entry.slice(0, -4), log, ...output };
    });
    return { uid: status.uid, taskName: status.taskName, completed: status.completed, total: status.total, logs };
  }
  const error = new Error(`unknown tool: ${name}`);
  error.rpcCode = -32602;
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
        if (error.rpcCode) throw error;
        return { isError: true, content: [{ type: 'text', text: `cli-run: ${error.message}` }] };
      }
    default: {
      if (id === undefined) return undefined;
      const error = new Error(`method not found: ${method}`);
      error.rpcCode = -32601;
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
      send({ jsonrpc: '2.0', id: message.id, error: { code: error.rpcCode ?? -32603, message: error.message } });
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
