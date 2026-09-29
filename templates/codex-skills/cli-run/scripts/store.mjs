import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { idPattern } from './spec.mjs';

export const runsRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'cli-run', 'runs');

export function runDirectory(runId) {
  if (!idPattern.test(runId)) throw new Error('invalid run ID');
  return join(runsRoot, runId);
}

export function resolveRun(query) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('task name or UID is required');
  const value = query.trim();
  if (idPattern.test(value) && existsSync(join(runsRoot, value, 'status.json'))) return value;
  if (!existsSync(runsRoot)) throw new Error(`task not found: ${value}`);
  const matches = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
    .flatMap((entry) => {
      try {
        const status = JSON.parse(readFileSync(join(runsRoot, entry.name, 'status.json'), 'utf8'));
        return status.taskName === value ? [{ uid: entry.name, startedAt: status.startedAt }] : [];
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    });
  if (!matches.length) throw new Error(`task not found: ${value}`);
  matches.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.uid.localeCompare(a.uid));
  return matches[0].uid;
}

export function createRun(runId, spec) {
  mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const dir = runDirectory(runId);
  mkdirSync(dir, { mode: 0o700 });
  writeJson(join(dir, 'spec.json'), spec);
  return dir;
}

export function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

export function readStatus(query) {
  const runId = resolveRun(query);
  const dir = runDirectory(runId);
  const initial = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  const results = readdirSync(dir).filter((name) => name.endsWith('.result.json'))
    .map((name) => {
      const result = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const deliveryPath = join(dir, `${result.id}.delivery.json`);
      if (existsSync(deliveryPath)) result.delivery = JSON.parse(readFileSync(deliveryPath, 'utf8'));
      return result;
    });
  const finishedPath = join(dir, 'finished.json');
  const fatalPath = join(dir, 'fatal.json');
  const finishedAt = existsSync(finishedPath)
    ? JSON.parse(readFileSync(finishedPath, 'utf8')).finishedAt : null;
  const notifications = results.map((entry) => entry.delivery).filter(Boolean);
  const completionPath = join(dir, 'completion.delivery.json');
  const completionDelivery = existsSync(completionPath)
    ? JSON.parse(readFileSync(completionPath, 'utf8')) : null;
  if (completionDelivery) notifications.push(completionDelivery);
  return {
    uid: basename(dir), runId: basename(dir), taskName: initial.taskName ?? null,
    startedAt: initial.startedAt, finishedAt,
    deliveryMode: initial.deliveryMode ?? 'queue',
    total: initial.total, completed: results.length,
    delivered: notifications.filter((entry) => entry.ok).length,
    failedDeliveries: notifications.filter((entry) => !entry.ok).length,
    completionDelivery,
    fatal: existsSync(fatalPath) ? JSON.parse(readFileSync(fatalPath, 'utf8')) : null,
    results,
  };
}
