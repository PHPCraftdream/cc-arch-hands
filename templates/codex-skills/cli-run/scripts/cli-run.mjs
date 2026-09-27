#!/usr/bin/env node
// Internal worker entry started by the MCP `run` tool; not a user-facing CLI.
import { join } from 'node:path';
import { writeJson } from './store.mjs';
import { runWorker } from './runner.mjs';

try {
  const [action, dir] = process.argv.slice(2);
  if (action !== 'worker' || !dir) throw new Error('internal worker entry; use the cli-run MCP tools');
  await runWorker(dir);
} catch (error) {
  if (process.connected) process.send({ type: 'error', error: error.message });
  else {
    if (process.argv[2] === 'worker' && process.argv[3]) {
      try {
        writeJson(join(process.argv[3], 'fatal.json'), { error: error.message, at: new Date().toISOString() });
      } catch {}
    }
    console.error(`cli-run: ${error.message}`);
  }
  process.exitCode = 1;
}
