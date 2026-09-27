import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} needs a value`);
  return args[index + 1];
}

async function readInput(source) {
  if (!source) throw new Error('launch requires --spec <file|->');
  if (source !== '-') {
    if (statSync(source).size > 1_000_000) throw new Error('spec exceeds 1 MB');
    return readFileSync(source, 'utf8');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('spec exceeds 1 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readCommands(source) {
  return normalizeCommands(JSON.parse((await readInput(source)).replace(/^\uFEFF/, '')), process.cwd());
}

export function normalizeCommands(commands, defaultCwd) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 64) {
    throw new Error('spec must be an array of 1-64 commands');
  }
  const ids = new Set();
  return commands.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`command ${index + 1} must be an object`);
    }
    if (Object.keys(item).some((key) => !['id', 'argv', 'command', 'cwd'].includes(key))) {
      throw new Error(`command ${index + 1} has unknown fields`);
    }
    const id = item.id ?? `command-${index + 1}`;
    if (typeof id !== 'string' || !idPattern.test(id) || ids.has(id)) {
      throw new Error(`invalid or duplicate command id: ${id}`);
    }
    ids.add(id);
    const hasArgv = Array.isArray(item.argv);
    const hasCommand = typeof item.command === 'string';
    if (hasArgv === hasCommand) throw new Error(`${id}: provide exactly one of argv or command`);
    if (hasArgv && (!item.argv.length || item.argv.some((arg) => typeof arg !== 'string' || !arg))) {
      throw new Error(`${id}: argv must be nonempty strings`);
    }
    if (hasCommand && !item.command.trim()) throw new Error(`${id}: command must be nonempty`);
    if (item.cwd !== undefined && (typeof item.cwd !== 'string' || !item.cwd)) {
      throw new Error(`${id}: cwd must be a nonempty string`);
    }
    if (!defaultCwd && !(item.cwd && isAbsolute(item.cwd))) {
      throw new Error(`${id}: cwd must be an absolute path`);
    }
    const cwd = defaultCwd ? resolve(defaultCwd, item.cwd ?? '') : resolve(item.cwd);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${id}: cwd is not a directory`);
    }
    return hasArgv ? { id, argv: item.argv, cwd } : { id, command: item.command, cwd };
  });
}
