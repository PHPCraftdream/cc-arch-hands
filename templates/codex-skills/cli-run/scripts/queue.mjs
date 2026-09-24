import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';

function codexCommand() {
  if (process.env.CLI_RUN_CODEX_CLI) {
    const path = process.env.CLI_RUN_CODEX_CLI;
    if (!isAbsolute(path) || !existsSync(path)) throw new Error('CLI_RUN_CODEX_CLI must name an existing absolute path');
    return ['.js', '.mjs'].includes(extname(path)) ? [process.execPath, path] : [path];
  }
  if (process.platform !== 'win32') return ['codex'];
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    const executable = join(dir, 'codex.exe');
    if (existsSync(executable)) return [executable];
    const script = join(dir, 'codex.ps1');
    if (existsSync(script)) return ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', script];
  }
  throw new Error('codex executable not found on PATH');
}

export function queueCompletion(thread, message) {
  return new Promise((resolve) => {
    let command;
    try { command = codexCommand(); } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    const [file, ...prefix] = command;
    const child = spawn(file, [...prefix, 'queue', '--thread', thread, '--message', message], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 20_000);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code === 0 && !timedOut
        ? { ok: true }
        : { ok: false, error: timedOut ? 'queue timed out' : stderr.trim() || `queue exited ${code ?? signal}` });
    });
  });
}
