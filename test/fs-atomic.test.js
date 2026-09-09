import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  captureRegularFileSnapshot, enumerateRecoveryArtifacts, isQuarantineName, isQuarantinePath,
  maintainRecoveryArtifacts, removeOwnedRegularFile, writeFileAtomic,
} from '../lib/fs-atomic.js';
import { recoverPublicationFence } from '../lib/fs-atomic-publication.js';
import { renewLease } from '../lib/lease-lock.js';

describe('empty atomic-removal reservations', () => {
  it('reclaims an identity-stable empty reservation before removing its leaf', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-empty-quarantine-'));
    const dest = join(dir, 'leaf');
    const reservation = `${dest}.cah-owned-remove`;
    writeFileSync(dest, 'owned\n');
    const snapshot = captureRegularFileSnapshot(dest);
    mkdirSync(reservation);

    assert.equal(removeOwnedRegularFile(dest, snapshot.expectedDestination), true);
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(reservation), false);
  });

  it('maintenance reclaims only an empty reservation and preserves successors and payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-empty-quarantine-'));
    const emptyLeaf = join(dir, 'empty');
    const successor = join(dir, 'successor');
    const emptyReservation = `${emptyLeaf}.cah-owned-remove`;
    writeFileSync(successor, 'successor\n');
    mkdirSync(emptyReservation);
    // The reservation models crashed state: maintenance defers a fresh one
    // because it may belong to a live removeOwnedRegularFile().
    utimesSync(emptyReservation, new Date(Date.now() - 5000), new Date(Date.now() - 5000));

    const swept = maintainRecoveryArtifacts(dir);
    assert.ok(swept.swept.includes(emptyReservation));
    assert.equal(readFileSync(successor, 'utf8'), 'successor\n');

    const occupied = join(dir, 'occupied.cah-owned-remove');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'foreign'), 'keep\n');
    const second = maintainRecoveryArtifacts(dir);
    assert.equal(second.swept.includes(occupied), false);
    assert.equal(readFileSync(join(occupied, 'foreign'), 'utf8'), 'keep\n');
  });

  it('maintenance defers a fresh empty reservation and reclaims it once stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-empty-quarantine-'));
    const reservation = join(dir, 'leaf.cah-owned-remove');
    mkdirSync(reservation);

    const fresh = maintainRecoveryArtifacts(dir);
    assert.equal(fresh.swept.includes(reservation), false,
      'a fresh empty reservation may belong to a live removeOwnedRegularFile()');
    assert.ok(existsSync(reservation));

    const past = new Date(Date.now() - 5000);
    utimesSync(reservation, past, past);
    const stale = maintainRecoveryArtifacts(dir);
    assert.ok(stale.swept.includes(reservation), 'a stale reservation is genuinely crashed state');
  });
});

describe('empty proof-less publication fences', () => {
  it('maintenance defers a fresh empty publication fence and reclaims it once stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-empty-publish-fence-'));
    const dest = join(dir, 'leaf.json');
    const fence = `${dest}.cah-owned-publish`;
    writeFileSync(dest, 'owned\n');
    mkdirSync(fence);

    const fresh = maintainRecoveryArtifacts(dir);
    assert.equal(fresh.swept.includes(fence), false,
      'a fresh empty fence may belong to a live publisher pre-proof or a beginFence() unwind');
    assert.ok(fresh.preserved.includes(fence), 'the refused artifact must be reported');
    assert.ok(existsSync(fence));

    const past = new Date(Date.now() - 5000);
    utimesSync(fence, past, past);
    const stale = maintainRecoveryArtifacts(dir);
    assert.ok(stale.swept.includes(fence), 'a stale empty fence is genuinely crashed state');
    assert.equal(existsSync(fence), false);
    assert.equal(readFileSync(dest, 'utf8'), 'owned\n', 'sweeping the fence must not touch the leaf');
  });

  it('an unproved publication fence with content is preserved, not swept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-occupied-publish-fence-'));
    const dest = join(dir, 'leaf.json');
    const fence = `${dest}.cah-owned-publish`;
    writeFileSync(dest, 'owned\n');
    mkdirSync(fence);
    writeFileSync(join(fence, 'foreign'), 'keep\n');
    utimesSync(fence, new Date(Date.now() - 5000), new Date(Date.now() - 5000));

    const report = maintainRecoveryArtifacts(dir);
    assert.equal(report.swept.includes(fence), false,
      'a non-empty unproved fence has no reclaim authority');
    assert.equal(readFileSync(join(fence, 'foreign'), 'utf8'), 'keep\n');
  });
});

describe('lease-quarantine recovery artifacts', () => {
  it('classifies lease-quarantine roots as displaced, empty, or regular-file', () => {
    const base = mkdtempSync(join(tmpdir(), 'cah-lease-quarantine-'));
    const displaced = join(base, 'displaced', '.cah-lease-quarantine');
    mkdirSync(join(displaced, 'claim.taken-1-a'), { recursive: true });
    writeFileSync(join(displaced, 'claim.taken-1-a', 'stray'), 'stray');
    mkdirSync(join(base, 'empty', '.cah-lease-quarantine'), { recursive: true });
    mkdirSync(join(base, 'plain'), { recursive: true });
    writeFileSync(join(base, 'plain', '.cah-lease-quarantine'), 'not a directory');

    const expected = new Map([
      ['displaced', true],
      ['empty', false],
      ['plain', false],
    ]);
    for (const [name, expectDisplaced] of expected) {
      const artifacts = enumerateRecoveryArtifacts(join(base, name));
      const found = artifacts.filter((artifact) => artifact.kind === 'lease-quarantine');
      assert.equal(found.length, 1, `${name}: exactly one lease-quarantine artifact expected`);
      assert.equal(found[0].path, join(base, name, '.cah-lease-quarantine'));
      assert.equal(found[0].displacedData, expectDisplaced, `${name}: unexpected displacedData`);
      assert.equal(found[0].inspectionIncomplete, false, `${name}: must be fully inspected`);
    }

    const report = maintainRecoveryArtifacts(join(base, 'displaced'));
    assert.deepEqual(report.swept, [], 'a lease-quarantine namespace is never swept');
    assert.ok(report.recovery.includes(displaced), 'a displaced quarantine root must be reported as recovery');
    assert.equal(report.incomplete, false);
  });

  it('reports an uninspectable quarantine root as inspection-incomplete instead of dropping it', () => {
    const base = mkdtempSync(join(tmpdir(), 'cah-lease-quarantine-eacces-'));
    const root = join(base, '.cah-lease-quarantine');
    mkdirSync(root);
    const priorTest = process.env.CAH_TEST_ONLY;
    const priorFailure = process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = 'empty';
    try {
      const artifacts = enumerateRecoveryArtifacts(base);
      const found = artifacts.filter((artifact) => artifact.kind === 'lease-quarantine');
      assert.equal(found.length, 1, 'the artifact must be reported, not dropped');
      assert.equal(found[0].inspectionIncomplete, true);
      assert.equal(found[0].displacedData, false);
      assert.equal(artifacts.incomplete, true);
      assert.ok(artifacts.failures.some((failure) => failure.path === root));

      const report = maintainRecoveryArtifacts(base);
      assert.ok(report.recovery.includes(root), 'an inspection-incomplete root stays in the recovery report');
      assert.equal(report.incomplete, true);
    } finally {
      if (priorTest === undefined) delete process.env.CAH_TEST_ONLY;
      else process.env.CAH_TEST_ONLY = priorTest;
      if (priorFailure === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE;
      else process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE = priorFailure;
    }
  });

  it('recognizes the lease-quarantine namespace as a recovery marker', () => {
    // The predicates and describeRecoveryArtifact() must agree about what
    // the string means, or orphan sweeps treat a recovery namespace as user
    // data.
    assert.equal(isQuarantineName('.cah-lease-quarantine'), true);
    assert.equal(isQuarantinePath(join('x', '.cah-lease-quarantine', 'claim.taken-1-a')), true);
    assert.equal(isQuarantineName('plain-name'), false);
  });
});

describe('committed predecessor publication fences', () => {
  it('a same-process re-publication finishes its own committed predecessor fence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-committed-predecessor-'));
    const dest = join(dir, 'leaf.json');
    writeFileSync(dest, 'v1\n');
    assert.throws(
      () => writeFileAtomic(dest, 'v2\n', {
        testInterlock: (phase) => {
          if (phase === 'write-after-final-rename') {
            throw new Error('test-only post-commit failure');
          }
        },
      }),
      /test-only post-commit failure/,
    );
    assert.equal(readFileSync(dest, 'utf8'), 'v2\n',
      'the interrupted publication must have committed its payload');
    assert.ok(existsSync(`${dest}.cah-owned-publish`),
      'the committed predecessor fence must remain for a successor');
    writeFileAtomic(dest, 'v3\n');
    assert.equal(readFileSync(dest, 'utf8'), 'v3\n');
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false,
      'beginFence() must finish a committed predecessor fence unconditionally, never defer to it');
  });
});

// A real second publisher: a child process running the product's own
// writeFileAtomic(), so a racing acquirer goes through beginFence() exactly
// as production does — never through the maintenance path.
function publisherChildScript() {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  return `
    import { writeFileAtomic, captureRegularFileSnapshot } from ${JSON.stringify(fsutilUrl)};
    import { makeInterlock } from ${JSON.stringify(interlocksUrl)};
    const dest = process.env.CAH_TEST_PUBLISHER_DEST;
    try {
      writeFileAtomic(dest, process.env.CAH_TEST_PUBLISHER_PAYLOAD + '\\n', {
        expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,
        testInterlock: makeInterlock(),
      });
      process.stdout.write('PUBLISHED\\n');
    } catch (error) {
      process.stdout.write('FAILED:' + (error.code || '') + ':' + error.message + '\\n');
      process.exit(3);
    }
  `;
}

function spawnPublisher(dest, payload, interlockBase, phase) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', publisherChildScript()], {
    env: {
      ...process.env,
      HOME: dirname(dest), USERPROFILE: dirname(dest),
      CAH_TEST_ONLY: '1',
      CAH_TEST_PUBLISHER_DEST: dest,
      CAH_TEST_PUBLISHER_PAYLOAD: payload,
      CAH_TEST_ONLY_FSUTIL_INTERLOCK: interlockBase,
      CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: phase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout })));
  return { child, exited };
}

async function waitForPath(path, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message || `timed out waiting for ${path}`);
}

// A real publisher holding a lifecycle lease across its publication, the way
// bin/cah-stamp.js does: the proof records the lease identity, so committed-
// fence recovery consults the lease instead of only the pid/proof age.
function leasedPublisherChildScript() {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const leaseUrl = new URL('../lib/lease-lock.js', import.meta.url).href;
  const interlocksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  const nl = String.fromCharCode(10);
  return [
    'import { writeFileAtomic, captureRegularFileSnapshot } from ' + JSON.stringify(fsutilUrl) + ';',
    'import { acquireLease, renewLease, releaseLease } from ' + JSON.stringify(leaseUrl) + ';',
    'import { makeInterlock } from ' + JSON.stringify(interlocksUrl) + ';',
    'const dest = process.env.CAH_TEST_PUBLISHER_DEST;',
    'const leasePath = process.env.CAH_TEST_PUBLISHER_LEASE;',
    'const nl = String.fromCharCode(10);',
    'try {',
    '  const lease = acquireLease(leasePath, { kind: ', JSON.stringify('test-leased-publisher'), ' });',
    '  if (!lease) { process.stdout.write(', JSON.stringify('FAILED:lease' + nl), '); process.exit(4); }',
    '  renewLease(lease);',
    '  writeFileAtomic(dest, process.env.CAH_TEST_PUBLISHER_PAYLOAD + nl, {',
    '    expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,',
    '    testInterlock: makeInterlock(),',
    '    lifecycleLease: { path: lease.path, token: lease.token, generation: lease.generation },',
    '  });',
    '  releaseLease(lease);',
    '  process.stdout.write(', JSON.stringify('PUBLISHED' + nl), ');',
    '} catch (error) {',
    '  process.stdout.write(', JSON.stringify('FAILED:' + nl), ' + (error.code || ', JSON.stringify(''), ') + ', JSON.stringify(':'), ' + error.message);',
    '  process.exit(3);',
    '}',
  ].join(nl);
}

function spawnLeasedPublisher(dest, leasePath, payload, interlockBase, phase) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', leasedPublisherChildScript()], {
    env: {
      ...process.env,
      HOME: dirname(dest), USERPROFILE: dirname(dest),
      CAH_TEST_ONLY: '1',
      CAH_TEST_PUBLISHER_DEST: dest,
      CAH_TEST_PUBLISHER_PAYLOAD: payload,
      CAH_TEST_PUBLISHER_LEASE: leasePath,
      CAH_TEST_ONLY_FSUTIL_INTERLOCK: interlockBase,
      CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: phase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout })));
  return { child, exited };
}

describe('a foreign acquirer racing a live committed fence', () => {
  it('defers to a foreign live publisher and both publishers succeed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-windowb-acquirer-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      writeFileSync(dest, 'ORIGINAL\n');

      // Victim: a real publisher paused inside window B — its payload is
      // already renamed to the canonical destination and its fence not yet
      // cleaned up.
      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnPublisher(dest, 'victim-payload', victimBase, 'write-after-rename-before-sync');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);

      // Acquirer: a genuinely separate process publishing to the same leaf.
      // It must defer the victim's committed fence (foreign, live owner),
      // not reap it — reaping used to turn the victim's own cleanup into a
      // spurious ERR_ATOMIC_RECOVERY_REQUIRED.
      const acquirerBase = join(dir, 'acquirer-interlock');
      const acquirer = spawnPublisher(dest, 'acquirer-payload', acquirerBase, 'publication-fence-wait');
      children.push(acquirer.child);
      await waitForPath(`${acquirerBase}.ready`, 60000,
        'the acquirer never observed the occupied fence; a reaping acquirer '
        + 'publishes without ever waiting, so the deferral regression fired');

      writeFileSync(`${victimBase}.go`, 'go');
      const victimResult = await victim.exited;
      assert.equal(victimResult.code, 0,
        `the paused publisher must finish its own cleanup: ${victimResult.stdout}`);
      assert.equal(victimResult.stdout, 'PUBLISHED\n');

      writeFileSync(`${acquirerBase}.go`, 'go');
      const acquirerResult = await acquirer.exited;
      assert.equal(acquirerResult.code, 0,
        `the second publisher must complete: ${acquirerResult.stdout}`);
      assert.equal(acquirerResult.stdout, 'PUBLISHED\n');
      assert.equal(readFileSync(dest, 'utf8'), 'acquirer-payload\n',
        'both publications must have committed, in fence order');
      assert.equal(existsSync(`${dest}.cah-owned-publish`), false,
        'both publishers must have cleaned their fences');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a recycled-pid committed fence', () => {
  it('is recovered by a foreign acquirer once stale instead of wedging the leaf forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-recycled-pid-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      writeFileSync(dest, 'ORIGINAL\n');

      // Victim: parks AFTER its payload was renamed to the canonical
      // destination but BEFORE fence cleanup, then is SIGKILLed — its
      // committed fence is genuinely crashed state.
      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnPublisher(dest, 'victim-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);
      victim.child.kill('SIGKILL');
      await victim.exited;
      const fence = `${dest}.cah-owned-publish`;
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n',
        'the killed publisher must have committed its payload');
      assert.ok(existsSync(fence), 'the crashed publisher must leave its committed fence');
      const proofPath = join(fence, 'publication.json');
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      assert.equal(proof.ownerState, 'active');

      // Simulate pid recycling: point the proof at an unrelated live process
      // so proofOwnerIsAlive() keeps answering true for a dead publisher.
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
        { stdio: 'ignore' });
      children.push(sleeper);
      proof.ownerPid = sleeper.pid;
      proof.createdAtMs = Date.now() - 3_600_000;
      writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
      assert.equal(JSON.parse(readFileSync(proofPath, 'utf8')).ownerPid, sleeper.pid,
        'the patched recycled pid must have taken effect');

      // Acquirer: a foreign publisher with no interlock pause. It must
      // recover the stale recycled-pid fence, not defer to it forever.
      const acquirerBase = join(dir, 'acquirer-interlock');
      const acquirer = spawnPublisher(dest, 'successor-payload', acquirerBase, 'no-such-phase');
      children.push(acquirer.child);
      const acquirerResult = await acquirer.exited;
      assert.equal(acquirerResult.code, 0,
        `the acquirer must recover the stale recycled-pid fence: ${acquirerResult.stdout}`);
      assert.equal(acquirerResult.stdout, 'PUBLISHED\n');
      assert.equal(readFileSync(dest, 'utf8'), 'successor-payload\n');
      assert.equal(existsSync(fence), false,
        'the acquirer must have recovered the stale recycled-pid fence, not deferred to it');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A racing publisher loop: many real publications against one shared leaf,
// each iteration with a fresh expectedDestination snapshot. Only the module's
// three documented failure shapes are acceptable; anything else (especially a
// raw ENOENT naming an internal .cah-owned-publish fence path) is reported
// as RAW and exits 7 so the parent can fail the test.
function racingPublisherChildScript() {
  const fsutilUrl = new URL('../lib/fs-atomic.js', import.meta.url).href;
  return `
    import { writeFileAtomic, captureRegularFileSnapshot } from ${JSON.stringify(fsutilUrl)};
    const dest = process.env.CAH_TEST_PUBLISHER_DEST;
    const iterations = Number(process.env.CAH_TEST_PUBLISHER_ITERATIONS);
    let published = 0, refused = 0;
    try {
      for (let i = 0; i < iterations; i += 1) {
        try {
          writeFileAtomic(dest, process.pid + ':' + i + '\\n', {
            expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,
          });
          published += 1;
        } catch (error) {
          const acceptable = (error.message || '').includes('managed destination leaf changed concurrently')
            || error.code === 'ERR_ATOMIC_OWNERSHIP_LOST'
            || error.code === 'ERR_ATOMIC_RECOVERY_REQUIRED';
          if (!acceptable) {
            process.stdout.write('RAW:' + (error.code || '') + ':' + error.message + '\\n');
            process.exit(7);
          }
          refused += 1;
        }
      }
      process.stdout.write('DONE published=' + published + ' refused=' + refused + '\\n');
      process.exit(0);
    } catch (error) {
      process.stdout.write('RAW:' + (error.code || '') + ':' + error.message + '\\n');
      process.exit(7);
    }
  `;
}

function spawnRacingPublisher(dest, iterations) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', racingPublisherChildScript()], {
    env: {
      ...process.env,
      HOME: dirname(dest), USERPROFILE: dirname(dest),
      CAH_TEST_ONLY: '1',
      CAH_TEST_PUBLISHER_DEST: dest,
      CAH_TEST_PUBLISHER_ITERATIONS: String(iterations),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout })));
  return { child, exited };
}

describe('concurrent publishers racing one leaf', () => {
  it('never surfaces a raw ENOENT from the publication-fence proof race', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-racing-publishers-'));
    const children = [];
    const publishers = 6;
    const iterations = 120;
    try {
      const dest = join(dir, 'leaf.json');
      writeFileSync(dest, 'seed\n');
      const runners = [];
      for (let i = 0; i < publishers; i += 1) {
        const runner = spawnRacingPublisher(dest, iterations);
        children.push(runner.child);
        runners.push(runner.exited);
      }
      const results = await Promise.all(runners);
      for (const [index, result] of results.entries()) {
        assert.equal(result.code, 0,
          `publisher ${index} hit a raw failure (exit ${result.code}):\n${result.stdout}`);
      }
      let totalPublished = 0;
      for (const result of results) {
        const done = result.stdout.split('\n').find((line) => line.startsWith('DONE '));
        assert.ok(done, `publisher produced no DONE summary:\n${result.stdout}`);
        totalPublished += Number(/published=(\d+)/.exec(done)[1]);
      }
      assert.ok(totalPublished > publishers * iterations * 0.25,
        `expected real concurrent publishing, got ${totalPublished} of ${publishers * iterations}`);
      assert.ok(existsSync(dest), 'the destination leaf must still exist');
      const leftovers = readdirSync(dir).filter((name) => name.startsWith('.cah-tmp-'));
      assert.deepEqual(leftovers, [], 'no temp leftovers may remain');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lease displacement and capacity quarantine recovery artifacts', () => {
  it('reports .abandoned- and .cah-capacity-quarantine namespaces instead of ignoring them', () => {
    const base = mkdtempSync(join(tmpdir(), 'cah-abandoned-report-'));
    try {
      const abandoned = join(base, 'claim.lock.abandoned-4321-6bed1c9e');
      mkdirSync(abandoned);
      writeFileSync(join(abandoned, 'owner.json'), '{"pid":4321,"token":"t","generation":"g"}\n');
      const capacity = join(base, '.cah-capacity-quarantine');
      mkdirSync(capacity);
      writeFileSync(join(capacity, 'victim'), '{"pid":4321}\n');

      // The predicates and describeRecoveryArtifact() must agree about what
      // these strings mean, or orphan sweeps treat recovery state as user data.
      assert.equal(isQuarantineName('claim.lock.abandoned-4321-6bed1c9e'), true);
      assert.equal(isQuarantinePath(join('x', '.cah-capacity-quarantine', 'victim')), true);

      const report = maintainRecoveryArtifacts(base);
      assert.ok(report.recovery.includes(abandoned),
        `a displacement quarantine holding a claim must be reported: ${JSON.stringify(report.recovery)}`);
      assert.ok(report.recovery.includes(capacity),
        `an occupied capacity victim slot must be reported: ${JSON.stringify(report.recovery)}`);
      assert.deepEqual(report.swept, [], 'neither namespace may ever be auto-swept');
      assert.ok(existsSync(join(abandoned, 'owner.json')), 'reporting must not consume the displaced claim');
      assert.ok(existsSync(join(capacity, 'victim')), 'reporting must not consume the victim slot');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('a future-dated committed fence proof', () => {
  it('does not pin a recycled-pid fence fresh: the acquirer recovers instead of wedging the leaf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-future-proof-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      writeFileSync(dest, 'ORIGINAL\n');

      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnPublisher(dest, 'victim-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);
      victim.child.kill('SIGKILL');
      await victim.exited;
      const fence = `${dest}.cah-owned-publish`;
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n',
        'the killed publisher must have committed its payload');
      assert.ok(existsSync(fence), 'the crashed publisher must leave its committed fence');
      const proofPath = join(fence, 'publication.json');
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));

      // Simulate pid recycling AND a backward clock step: the proof points at
      // a live unrelated process and is dated an hour in the future. A
      // wall-clock-only staleness check would answer "fresh" for the whole
      // skew and wedge the leaf behind a ~30 s busy-wait and a hard EEXIST.
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
        { stdio: 'ignore' });
      children.push(sleeper);
      proof.ownerPid = sleeper.pid;
      proof.createdAtMs = Date.now() + 3_600_000;
      writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);

      const acquirerBase = join(dir, 'acquirer-interlock');
      const acquirer = spawnPublisher(dest, 'successor-payload', acquirerBase, 'no-such-phase');
      children.push(acquirer.child);
      const acquirerResult = await acquirer.exited;
      assert.equal(acquirerResult.code, 0,
        `the acquirer must recover the future-dated recycled-pid fence, not burn the 30 s wait: ${acquirerResult.stdout}`);
      assert.equal(acquirerResult.stdout, 'PUBLISHED\n');
      assert.equal(readFileSync(dest, 'utf8'), 'successor-payload\n');
      assert.equal(existsSync(fence), false,
        'the acquirer must have recovered the future-dated fence, not deferred to it');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a recycled-pid committed fence under maintenance', () => {
  it('is swept by a stale-proof maintenance pass instead of being deferred forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-recycled-maintenance-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      writeFileSync(dest, 'ORIGINAL\n');

      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnPublisher(dest, 'victim-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);
      victim.child.kill('SIGKILL');
      await victim.exited;
      const fence = `${dest}.cah-owned-publish`;
      assert.ok(existsSync(fence), 'the crashed publisher must leave its committed fence');
      const proofPath = join(fence, 'publication.json');
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));

      // Recycle the pid onto a live unrelated process and age the proof well
      // past the fence freshness window. Maintenance must treat this as
      // crashed state, exactly like a foreign acquirer already does.
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
        { stdio: 'ignore' });
      children.push(sleeper);
      proof.ownerPid = sleeper.pid;
      proof.createdAtMs = Date.now() - 3_600_000;
      writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);

      const report = maintainRecoveryArtifacts(dir);
      assert.ok(report.swept.includes(fence),
        `maintenance must recover a stale recycled-pid committed fence: swept=${JSON.stringify(report.swept)} preserved=${JSON.stringify(report.preserved)}`);
      assert.equal(existsSync(fence), false);
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n',
        'sweeping the fence must never touch the committed payload');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a leased committed publisher', () => {
  it('keeps deferring to a live publisher whose lease heartbeat is fresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-leased-live-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      const leasePath = join(dir, 'lifecycle.lock');
      writeFileSync(dest, 'ORIGINAL\n');

      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnLeasedPublisher(
        dest, leasePath, 'leased-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);

      assert.equal(recoverPublicationFence(dest, { deferCommitted: true }), false,
        'a live publisher with a fresh lease heartbeat must still be deferred to');
      assert.ok(existsSync(`${dest}.cah-owned-publish`),
        'the live publisher committed fence must not be reclaimed');

      writeFileSync(`${victimBase}.go`, 'go');
      const { code, stdout } = await victim.exited;
      assert.equal(code, 0, `the parked publisher must finish its own cleanup: ${stdout}`);
      assert.equal(stdout, 'PUBLISHED\n');
      assert.equal(readFileSync(dest, 'utf8'), 'leased-payload\n');
      assert.equal(existsSync(`${dest}.cah-owned-publish`), false);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops deferring once the lease heartbeat expires even when token and generation still match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-leased-expired-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      const leasePath = join(dir, 'lifecycle.lock');
      writeFileSync(dest, 'ORIGINAL\n');

      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnLeasedPublisher(
        dest, leasePath, 'victim-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);
      victim.child.kill('SIGKILL');
      await victim.exited;
      const fence = `${dest}.cah-owned-publish`;
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n',
        'the killed publisher must have committed its payload');
      assert.ok(existsSync(fence), 'the crashed publisher must leave its committed fence');

      // Simulate pid recycling AND abandonment: the proof and the lease owner
      // point at a live unrelated process, but nobody renews the lease
      // anymore, so its heartbeat ages past the lease period while token and
      // generation stay exactly what the proof recorded.
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
        { stdio: 'ignore' });
      children.push(sleeper);
      const owner = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8'));
      const agedOwner = { ...owner, pid: sleeper.pid, timestamp: Date.now() - 86_400_000 };
      writeFileSync(join(leasePath, 'owner.json'), JSON.stringify(agedOwner) + '\n');
      const proofPath = join(fence, 'publication.json');
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      proof.ownerPid = sleeper.pid;
      proof.createdAtMs = Date.now() - 3_600_000;
      writeFileSync(proofPath, JSON.stringify(proof) + '\n');

      // The lease subsystem itself already answers expired: renewLease()
      // refuses a lease whose heartbeat is older than the lease period even
      // when token and generation match, so the publication deferral must not
      // trust what renewal itself refuses.
      assert.equal(renewLease({ path: leasePath, owner: agedOwner, options: {} }), false,
        'renewLease must treat the abandoned lease as expired');

      assert.equal(recoverPublicationFence(dest, { deferCommitted: true }), true,
        'maintenance must converge: an abandoned lease must not pin the fence forever');
      assert.equal(existsSync(fence), false, 'the expired lease must not keep the fence');
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n',
        'recovery must never touch the committed payload');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is swept by maintenance once its lease expires instead of being deferred forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-leased-maintenance-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      const leasePath = join(dir, 'lifecycle.lock');
      writeFileSync(dest, 'ORIGINAL\n');

      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnLeasedPublisher(
        dest, leasePath, 'victim-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);
      victim.child.kill('SIGKILL');
      await victim.exited;
      const fence = `${dest}.cah-owned-publish`;
      assert.ok(existsSync(fence), 'the crashed publisher must leave its committed fence');

      // Recycle the pid onto a live process and age both the proof and the
      // lease heartbeat. Maintenance must treat this as crashed state, not as
      // a live transaction that happens to hold a lease.
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
        { stdio: 'ignore' });
      children.push(sleeper);
      const owner = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8'));
      writeFileSync(join(leasePath, 'owner.json'), JSON.stringify({
        ...owner, pid: sleeper.pid, timestamp: Date.now() - 86_400_000,
      }) + '\n');
      const proofPath = join(fence, 'publication.json');
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      proof.ownerPid = sleeper.pid;
      proof.createdAtMs = Date.now() - 3_600_000;
      writeFileSync(proofPath, JSON.stringify(proof) + '\n');

      const report = maintainRecoveryArtifacts(dir);
      assert.ok(report.swept.includes(fence),
        `maintenance must recover an expired-lease committed fence: swept=${JSON.stringify(report.swept)} preserved=${JSON.stringify(report.preserved)}`);
      assert.equal(existsSync(fence), false);
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n',
        'sweeping the fence must never touch the committed payload');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dead leased publisher is recovered without requiring any lease takeover', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-leased-dead-'));
    const children = [];
    try {
      const dest = join(dir, 'leaf.json');
      const leasePath = join(dir, 'lifecycle.lock');
      writeFileSync(dest, 'ORIGINAL\n');

      const victimBase = join(dir, 'victim-interlock');
      const victim = spawnLeasedPublisher(
        dest, leasePath, 'victim-payload', victimBase, 'write-after-final-rename');
      children.push(victim.child);
      await waitForPath(`${victimBase}.ready`, 60000);
      victim.child.kill('SIGKILL');
      await victim.exited;
      const fence = `${dest}.cah-owned-publish`;
      assert.ok(existsSync(fence), 'the crashed publisher must leave its committed fence');

      // The owner.json record survives with the dead publisher pid and a
      // fresh heartbeat. The dead proof pid makes the fence reclaimable: no
      // successor ever has to reopen the abandoned lease first.
      assert.equal(recoverPublicationFence(dest, { deferCommitted: true }), true,
        'a dead leased publisher must be recoverable without a takeover');
      assert.equal(existsSync(fence), false);
      assert.equal(readFileSync(dest, 'utf8'), 'victim-payload\n');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transient publication-fence mkdir failures', () => {
  function setEnv(values) {
    const prior = {};
    for (const [key, value] of Object.entries(values)) {
      prior[key] = process.env[key];
      process.env[key] = value;
    }
    return prior;
  }
  function restoreEnv(prior) {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  function assertNoFenceResidue(dir, dest) {
    const residue = readdirSync(dir).filter((name) => name.startsWith(`${dest}.cah-owned-publish`));
    assert.deepEqual(residue, []);
  }

  it('survives exactly one transient EPERM on the publication-fence mkdir and still publishes', () => {
    // Structural guard: without the new bounded retry, the very first
    // synthesized EPERM would propagate out of beginFence() and fail this
    // test at the writeFileAtomic call below (demonstrated by reverting the
    // lib change; not re-run here by design).
    const dir = mkdtempSync(join(tmpdir(), 'cah-fence-eparm-'));
    const dest = join(dir, 'leaf');
    const payload = 'fence-retry-payload\n';
    writeFileSync(dest, 'seed\n');
    const prior = setEnv({
      CAH_TEST_ONLY: '1',
      CAH_TEST_ONLY_PUBLICATION_FENCE_MKDIR_TRANSIENT_FAILURES: '1',
    });
    try {
      writeFileAtomic(dest, payload, {
        expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,
      });
      assert.equal(readFileSync(dest, 'utf8'), payload);
      // Normal call immediately after, no injection active.
      delete process.env.CAH_TEST_ONLY;
      delete process.env.CAH_TEST_ONLY_PUBLICATION_FENCE_MKDIR_TRANSIENT_FAILURES;
      writeFileAtomic(dest, `${payload}again\n`, {
        expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,
      });
      assert.equal(readFileSync(dest, 'utf8'), `${payload}again\n`);
      assertNoFenceResidue(dir, dest);
    } finally {
      restoreEnv(prior);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a persistent EPERM on the publication-fence mkdir fails bounded with the original error and no residue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-fence-eparm-'));
    const dest = join(dir, 'leaf');
    writeFileSync(dest, 'untouched\n');
    const prior = setEnv({
      CAH_TEST_ONLY: '1',
      CAH_TEST_ONLY_PUBLICATION_FENCE_MKDIR_TRANSIENT_FAILURES: '999',
    });
    try {
      const startedAt = Date.now();
      assert.throws(() => writeFileAtomic(dest, 'replaced\n', {
        expectedDestination: captureRegularFileSnapshot(dest).expectedDestination,
      }), (error) => error.code === 'EPERM');
      assert.ok(Date.now() - startedAt >= 1500,
        'the persistent EPERM must surface only after the bounded transient window, not immediately');
      assert.equal(readFileSync(dest, 'utf8'), 'untouched\n');
      assertNoFenceResidue(dir, dest);
    } finally {
      restoreEnv(prior);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
