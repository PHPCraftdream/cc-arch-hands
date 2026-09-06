// Keep process races broad while bounding OS child-process fan-out.  The
// helpers in this file are test infrastructure only; the deadlines are here
// so a broken fixture cannot leave a test process (or a batch) alive forever.
export const DEFAULT_CHILD_DEADLINE_MS = 15_000;
// Bin publication workers perform a full dependency capture before their
// interlock becomes observable. Keep that bound separate from lightweight
// companion children so a loaded Windows host does not kill a valid race
// fixture before it reaches its synchronization point.
export const DEFAULT_WORKER_DEADLINE_MS = 60_000;
export const TERMINATION_GRACE_MS = 250;
export const DEFAULT_BATCH_TASK_DEADLINE_MS = DEFAULT_CHILD_DEADLINE_MS + 2_000;

export function timeoutError(label = 'child') {
  const error = new Error(`${label} exceeded its test deadline`);
  error.code = 'ETIMEDOUT';
  return error;
}

export function waitForChildClose(child) {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export function terminateChild(
  child,
  { graceMs = TERMINATION_GRACE_MS, onForce } = {},
) {
  const closed = waitForChildClose(child);
  if (child.exitCode !== null || child.signalCode !== null) return closed;
  try { child.kill('SIGTERM'); } catch { /* close/error reports the outcome */ }
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    onForce?.();
    try { child.kill('SIGKILL'); } catch { /* close/error reports the outcome */ }
  }, graceMs);
  return closed.finally(() => clearTimeout(forceTimer));
}

export function killChild(child) {
  const closed = waitForChildClose(child);
  try { child.kill('SIGKILL'); } catch { /* close/error reports the outcome */ }
  return closed;
}

// Give a child a chance to exit normally before using the hard kill.  The
// close event still belongs to the caller: callers must not settle their
// promise from the timeout callback because stdout/stderr may still be
// draining and the child may still be changing its fixture.
export function armChildDeadline(
  child,
  { timeoutMs = DEFAULT_CHILD_DEADLINE_MS, graceMs = TERMINATION_GRACE_MS, onTimeout } = {},
) {
  let timer = null;
  let terminated = false;
  let terminationPromise = null;

  const terminate = () => {
    if (terminated) return terminationPromise;
    terminated = true;
    onTimeout?.();
    terminationPromise = terminateChild(child, { graceMs });
    return terminationPromise;
  };

  timer = setTimeout(terminate, timeoutMs);

  return {
    terminate,
    clear() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    wait: () => terminationPromise || waitForChildClose(child),
  };
}

export function armWorkerDeadline(
  worker,
  {
    timeoutMs = DEFAULT_CHILD_DEADLINE_MS,
    graceMs = TERMINATION_GRACE_MS,
    onTimeout,
    onForce,
  } = {},
) {
  let timer = null;
  let forceTimer = null;
  let terminated = false;
  let terminationPromise = null;
  const forceTerminate = () => {
    terminationPromise = Promise.resolve(worker.terminate()).then(
      () => onForce?.(),
      () => onForce?.(),
    );
    return terminationPromise;
  };
  const terminate = () => {
    if (terminated) return terminationPromise;
    terminated = true;
    onTimeout?.();
    // A worker can cooperatively leave a test wait; the caller's force
    // termination below is still required for Atomics.wait or a sync loop.
    try { worker.postMessage({ __testShutdown: true }); } catch { /* already closed */ }
    terminationPromise = new Promise((resolve) => {
      forceTimer = setTimeout(() => {
        forceTerminate().then(resolve, resolve);
      }, graceMs);
    });
    return terminationPromise;
  };
  timer = setTimeout(terminate, timeoutMs);
  return {
    terminate,
    clear() {
      if (timer !== null) clearTimeout(timer);
      if (!terminated && forceTimer !== null) clearTimeout(forceTimer);
      timer = null;
      if (!terminated) forceTimer = null;
    },
    wait: () => terminationPromise || Promise.resolve(worker.terminate()),
  };
}

export async function runConcurrentBatches(
  count,
  task,
  batchSize = 6,
  taskDeadlineMs = DEFAULT_BATCH_TASK_DEADLINE_MS,
) {
  if (!Number.isSafeInteger(count) || count < 1
      || !Number.isSafeInteger(batchSize) || batchSize < 1
      || !Number.isSafeInteger(taskDeadlineMs) || taskDeadlineMs < 1) {
    throw new TypeError('runConcurrentBatches requires positive integer limits');
  }
  const results = [];
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const batch = [];
    for (let index = start; index < end; index += 1) {
      batch.push(new Promise((resolve, reject) => {
        let timer;
        const controller = new AbortController();
        let timeoutFailure = null;
        try {
          timer = setTimeout(() => {
            timeoutFailure = timeoutError(`batch task ${index}`);
            controller.abort(timeoutFailure);
          }, taskDeadlineMs);
          Promise.resolve(task(index, { signal: controller.signal }))
            .then((value) => {
              if (timeoutFailure) reject(timeoutFailure);
              else resolve(value);
            }, (error) => {
              reject(timeoutFailure || error);
            })
            .finally(() => clearTimeout(timer));
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      }));
    }
    results.push(...await Promise.all(batch));
  }
  return results;
}
