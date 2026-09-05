import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmdirSync, mkdtempSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';

export const FABLE_ORACLE = [
  ['fl', 'claude-fable-5-1', 'low'],
  ['fm', 'claude-fable-5-1', 'medium'],
  ['fh', 'claude-fable-5-1', 'high'],
  ['fx', 'claude-fable-5-1', 'xhigh'],
  ['fxx', 'claude-fable-5-1', 'max'],
  ['f1l', 'claude-fable-5', 'low'],
  ['f1m', 'claude-fable-5', 'medium'],
  ['f1h', 'claude-fable-5', 'high'],
  ['f1x', 'claude-fable-5', 'xhigh'],
  ['f1xx', 'claude-fable-5', 'max'],
];

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cah-test-'));
}

export function waitForWorker(worker) {
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`atomic-write worker exited with code ${code}`));
    });
  });
}

export function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

export function runSkillWorker(action, dir, interlock, phase, subset = undefined) {
  const skillsUrl = new URL('../lib/skills.js', import.meta.url).href;
  const templatesUrl = new URL('../lib/templates.js', import.meta.url).href;
  const scopeUrl = new URL('../lib/scope.js', import.meta.url).href;
    const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = workerData.phase;
      const skills = await import(workerData.skillsUrl);
      const templates = await import(workerData.templatesUrl);
      const { Scope } = await import(workerData.scopeUrl);
      const scope = new Scope({ cwd: workerData.dir });
      const result = workerData.action === 'write'
        ? skills.writeSkills(templates.embeddedTemplates(), scope, workerData.subset
          ? { subset: workerData.subset } : {})
        : skills.removeSkills(templates.embeddedTemplates(), scope, workerData.subset
          ? { subset: workerData.subset } : {});
      parentPort.postMessage(result);
    })().catch((error) => {
      setImmediate(() => { throw error; });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { action, dir, interlock, phase, subset, skillsUrl, templatesUrl, scopeUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`skill worker exited with code ${code}`));
    });
  });
}

export function runOwnedRemovalWorker(dest, interlock, phase, failures = undefined) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = workerData.phase;
      if (workerData.failures !== undefined) {
        process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = String(workerData.failures);
      }
      const fsutil = await import(workerData.fsutilUrl);
      const expected = fsutil.regularFileIdentity(workerData.dest);
      const result = fsutil.removeOwnedRegularFile(workerData.dest, expected);
      parentPort.postMessage(result);
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dest, interlock, phase, failures, fsutilUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`owned removal worker exited with code ${code}`));
    });
  });
}

export function runLeafWriterWorker(kind, dir, interlock) {
  const moduleUrls = {
    commands: new URL('../lib/commands.js', import.meta.url).href,
    agents: new URL('../lib/agents.js', import.meta.url).href,
    codex: new URL('../lib/codex-agents.js', import.meta.url).href,
    scope: new URL('../lib/scope.js', import.meta.url).href,
  };
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = 'write-before-rename';
      const scopeModule = await import(workerData.scopeUrl);
      const scope = new scopeModule.Scope({ cwd: workerData.dir });
      const module = await import(workerData.writerUrl);
      const result = workerData.kind === 'commands'
        ? module.writeModelCommands(null, scope)
        : workerData.kind === 'agents'
          ? module.writeModelAgents(null, scope)
          : module.writeCodexAgents(null, scope);
      parentPort.postMessage(result);
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        kind,
        dir,
        interlock,
        writerUrl: moduleUrls[kind],
        scopeUrl: moduleUrls.scope,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`${kind} worker exited with code ${code}`));
    });
  });
}

export function runAtomicRetryWorker(dest, interlock) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_RENAME_TRANSIENT_FAILURES = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = 'rename-retry';
      const fsutil = await import(workerData.fsutilUrl);
      const snapshot = fsutil.captureRegularFileSnapshot(workerData.dest);
      fsutil.writeFileAtomic(workerData.dest, 'new managed body\\n', {
        expectedDestination: snapshot.expectedDestination,
      });
      parentPort.postMessage('published');
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dest, interlock, fsutilUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`retry worker exited with code ${code}`));
    });
  });
}

