import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';

export function codexCommand(env = process.env, platform = process.platform) {
  if (env.CLI_RUN_CODEX_CLI) {
    const path = env.CLI_RUN_CODEX_CLI;
    if (!isAbsolute(path) || !existsSync(path)) throw new Error('CLI_RUN_CODEX_CLI must name an existing absolute path');
    return ['.js', '.mjs'].includes(extname(path)) ? [process.execPath, path] : [path];
  }
  if (platform !== 'win32') return ['codex'];
  // Never go through the npm codex.ps1/codex.cmd shims: PowerShell 5.1 and cmd.exe
  // re-split arguments containing quotes, which corrupts the message.
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    const executable = join(dir, 'codex.exe');
    if (existsSync(executable)) return [executable];
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return [process.execPath, script];
  }
  throw new Error('codex not found on PATH (need codex.exe or the npm @openai/codex package)');
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
