import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { idPattern } from './spec.mjs';

export const runsRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'cli-run', 'runs');

export function runDirectory(runId) {
  if (!idPattern.test(runId)) throw new Error('invalid run ID');
  return join(runsRoot, runId);
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

export function readStatus(runId) {
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
  const notifications = initial.deliveryMode === 'queue' ? results.map((entry) => entry.delivery).filter(Boolean) : [];
  return {
    runId: basename(dir), startedAt: initial.startedAt, finishedAt,
    total: initial.total, completed: results.length,
    delivered: notifications.filter((entry) => entry.ok).length,
    failedDeliveries: notifications.filter((entry) => !entry.ok).length,
    fatal: existsSync(fatalPath) ? JSON.parse(readFileSync(fatalPath, 'utf8')) : null,
    results,
  };
}
