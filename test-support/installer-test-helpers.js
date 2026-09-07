import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { runWorker } from './process-batches.js';

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
  return runWorker(worker, { label: 'atomic-write worker', requireMessage: false }).then(() => undefined);
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
  const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
    const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: workerData.phase,
      });
      const skills = await import(workerData.skillsUrl);
      const templates = await import(workerData.templatesUrl);
      const { Scope } = await import(workerData.scopeUrl);
      const scope = new Scope({ cwd: workerData.dir });
      const result = workerData.action === 'write'
        ? skills.writeSkills(templates.embeddedTemplates(), scope, workerData.subset
          ? { subset: workerData.subset, testInterlock } : { testInterlock })
        : skills.removeSkills(templates.embeddedTemplates(), scope, workerData.subset
          ? { subset: workerData.subset, testInterlock } : { testInterlock });
      parentPort.postMessage(result);
    })().catch((error) => {
      setImmediate(() => { throw error; });
    });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { action, dir, interlock, phase, subset, skillsUrl, templatesUrl, scopeUrl, hooksUrl },
  });
  return runWorker(worker, { label: 'skill worker' });
}

export function runOwnedRemovalWorker(
  dest, interlock, phase, failures = undefined, ownershipLossPath = undefined,
) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { existsSync } = require('node:fs');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: workerData.phase,
      });
      if (workerData.failures !== undefined) {
        process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = String(workerData.failures);
      }
      const fsutil = await import(workerData.fsutilUrl);
      const expected = fsutil.regularFileIdentity(workerData.dest);
      const options = workerData.ownershipLossPath === undefined ? {} : {
        assertOwnership: () => !existsSync(workerData.ownershipLossPath),
      };
      options.testInterlock = testInterlock;
      const result = fsutil.removeOwnedRegularFile(workerData.dest, expected, options);
      parentPort.postMessage(result);
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { dest, interlock, phase, failures, ownershipLossPath, fsutilUrl, hooksUrl },
  });
  return runWorker(worker, { label: 'owned removal worker' });
}

export function runLeafWriterWorker(kind, dir, interlock) {
  const moduleUrls = {
    commands: new URL('../lib/commands.js', import.meta.url).href,
    agents: new URL('../lib/agents.js', import.meta.url).href,
    codex: new URL('../lib/codex-agents.js', import.meta.url).href,
    scope: new URL('../lib/scope.js', import.meta.url).href,
  };
  const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'write-before-rename',
      });
      const scopeModule = await import(workerData.scopeUrl);
      const scope = new scopeModule.Scope({ cwd: workerData.dir });
      const module = await import(workerData.writerUrl);
      const result = workerData.kind === 'commands'
        ? module.writeModelCommands(null, scope, { testInterlock })
        : workerData.kind === 'agents'
          ? module.writeModelAgents(null, scope, { testInterlock })
          : module.writeCodexAgents(null, scope, { testInterlock });
      parentPort.postMessage(result);
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      kind,
      dir,
      interlock,
      writerUrl: moduleUrls[kind],
      scopeUrl: moduleUrls.scope,
      hooksUrl,
    },
  });
  return runWorker(worker, { label: `${kind} worker` });
}

export function runAtomicRetryWorker(dest, interlock) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'rename-retry',
      });
      const fsutil = await import(workerData.fsutilUrl);
      const snapshot = fsutil.captureRegularFileSnapshot(workerData.dest);
      fsutil.writeFileAtomic(workerData.dest, 'new managed body\\n', {
        expectedDestination: snapshot.expectedDestination,
        testInterlock,
      });
      parentPort.postMessage('published');
    })().catch((error) => { setImmediate(() => { throw error; }); });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { dest, interlock, fsutilUrl, hooksUrl },
  });
  return runWorker(worker, { label: 'retry worker' });
}
