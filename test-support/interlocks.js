import { lstatSync, writeFileSync } from 'node:fs';

// Test-only synchronization. Production modules receive this callback as an
// explicit option; no hook protocol or test environment variables are part of
// the installed runtime.
export function makeInterlock(env = process.env) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const wait = (base, configured, candidates, suffix = '') => {
    const phase = candidates.find((candidate) => candidate === configured);
    if (!base || !phase) return;
    const stem = `${base}${suffix}`;
    try { writeFileSync(`${stem}.ready`, 'ready', { flag: 'wx' }); } catch { /* stale-ready is harmless */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { lstatSync(`${stem}.go`); return; } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        Atomics.wait(signal, 0, 0, Math.min(25, deadline - Date.now()));
      }
    }
    throw new Error(`test interlock timed out for ${phase}`);
  };
  const interlock = (...args) => {
    if (env.CAH_TEST_ONLY !== '1') return;
    const phase = args[0];
    const stage = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'before';
    const aliases = args.slice(2);
    const candidates = [phase, ...aliases];
    const fsPhases = String(env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE || '')
      .split(',').filter(Boolean);
    const fsPhase = fsPhases.find((candidate) => candidates.includes(candidate));
    wait(env.CAH_TEST_ONLY_FSUTIL_INTERLOCK, fsPhase, candidates,
      fsPhases.length > 1 ? `.${phase}` : '');

    const ownerBase = env.CAH_TEST_ONLY_OWNER_INTERLOCK
      || env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK;
    const ownerPhase = env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE
      || env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK_PHASE;
    const staged = ownerPhase === `${phase}-three-party`;
    if (staged || ownerPhase === phase) {
      wait(ownerBase, ownerPhase, [ownerPhase], staged ? `.${stage}` : '');
    }

    const probeBase = env.CAH_TEST_ONLY_PROBE_INTERLOCK;
    const probePhase = env.CAH_TEST_ONLY_PROBE_INTERLOCK_PHASE;
    wait(probeBase, probePhase, candidates);
  };
  interlock.protectMarker = env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE === 'marker-remove';
  return interlock;
}
