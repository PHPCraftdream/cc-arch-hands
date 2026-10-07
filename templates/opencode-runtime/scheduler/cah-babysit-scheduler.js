// cah-opencode-runtime:v1
import { randomBytes } from 'node:crypto';
export const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const WAKE_PENDING_DEADLINE_MS = 30 * 60 * 1000;

export const BABYSIT_TICK_PROMPT = `# babysit tick — resume the current todo plan

Call cah_todos. The live todo list is the source of truth. If it has no pending or in_progress tasks, report the blockers or completion and do not invent work. Never unblock user, agent or service waits without new evidence. Otherwise resume the current in_progress task, or the earliest ready pending task, identified by verbatim content. Read its strategy and blockers from session context. Respect the user's limits and agent choices; do not launch subagents without an explicit user request. Mark finished work done and continue immediately with the next ready task in this same turn. Do not wait for another babysit tick to advance ordinary work. If the plan is exhausted, call cah_babysit with action: off. Report only concrete results or blockers.`;

const CANONICAL = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
export function parseIntervalMs(value = '15m') {
  const match = /^(\d+)([smhd])$/.exec(String(value));
  if (!match) throw new Error('Interval must be a positive integer followed by s, m, h or d');
  const ms = Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > MAX_EXPIRY_MS) {
    throw new Error('Interval must be between 1 second and 7 days');
  }
  return ms;
}

export function canonicalTodos(todos) {
  if (!Array.isArray(todos) || todos.some((task) => !task
      || typeof task.content !== 'string' || !CANONICAL.has(task.status))) {
    throw new Error('Cannot read canonical OpenCode todo state');
  }
  return todos;
}

function unfinished(todos) {
  return canonicalTodos(todos).some((task) => task.status === 'pending' || task.status === 'in_progress');
}

function statusType(data, sessionID) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Malformed session.status response');
  }
  if (!Object.hasOwn(data, sessionID)) return 'idle';
  const type = data[sessionID]?.type;
  if (!['idle', 'busy', 'retry'].includes(type)) throw new Error('Malformed session.status entry');
  return type;
}

function messageList(data) {
  if (!Array.isArray(data) || data.some((entry) => !entry?.info
      || typeof entry.info.id !== 'string' || !Array.isArray(entry.parts)
      || !['user', 'assistant'].includes(entry.info.role))) {
    throw new Error('Malformed session.messages response');
  }
  return data;
}

function metadataOf(messages) {
  const info = messages.findLast((entry) => entry.info.role === 'user')?.info;
  if (!info || !info.id || typeof info.agent !== 'string' || !info.agent
      || typeof info.model?.providerID !== 'string' || !info.model.providerID
      || typeof info.model?.modelID !== 'string' || !info.model.modelID) {
    throw new Error('Missing or malformed primary agent/model metadata; babysit stopped');
  }
  const variant = info.model.variant ?? info.variant;
  if (variant !== undefined && typeof variant !== 'string') throw new Error('Malformed model variant');
  return { originID: info.id, agent: info.agent,
    model: { providerID: info.model.providerID, modelID: info.model.modelID },
    ...(variant === undefined ? {} : { variant }) };
}

// OpenCode has no todoread tool: the plugin exposes this read-only view of
// the SDK's session.todo through the cah_todos tool.
export async function readTodos({ client, sessionID, signal } = {}) {
  if (!client?.session || typeof client.session.todo !== 'function') throw new Error('session.todo is required');
  if (!sessionID) throw new Error('A session is required to read todos');
  const response = await client.session.todo({ path: { id: sessionID }, ...(signal ? { signal } : {}) });
  if (response?.error !== undefined) throw new Error(`session.todo failed: ${JSON.stringify(response.error)}`);
  if (!response || !Object.hasOwn(response, 'data')) throw new Error('Malformed session.todo response');
  return canonicalTodos(response.data);
}

class StaleTickError extends Error {
  constructor() { super('stale babysit tick'); }
}

export function createBabysitScheduler(deps = {}) {
  const client = deps.client;
  if (!client) throw new Error('createBabysitScheduler: client is required');
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id));
  const sessions = new Map();
  const stopped = new Map();
  let disposed = false;

  function current(handle) {
    return !disposed && sessions.get(handle.sessionID) === handle && !handle.off;
  }

  function assertCurrent(handle) {
    if (!current(handle)) throw new StaleTickError();
  }

  function report(handle, error) {
    try { deps.onError?.(handle.sessionID, error); } catch {}
  }

  function stopSession(handle, reason) {
    if (sessions.get(handle.sessionID) !== handle) return;
    handle.off = true;
    handle.abort.abort();
    if (handle.timer !== null) clearTimer(handle.timer);
    handle.timer = null;
    sessions.delete(handle.sessionID);
    stopped.set(handle.sessionID, reason);
  }

  function fail(handle, error) {
    if (!current(handle)) return;
    stopSession(handle, `error: ${error?.message ?? String(error)}`);
    report(handle, error);
  }

  async function request(handle, method, body) {
    if (!current(handle)) throw new StaleTickError();
    if (typeof client.session[method] !== 'function') throw new Error(`session.${method} is required`);
    let response;
    try {
      response = await client.session[method]({
        ...(method === 'status' ? {} : { path: { id: handle.sessionID } }),
        ...(body === undefined ? {} : { body }), signal: handle.abort.signal,
      });
    } catch (error) {
      if (!current(handle)) throw new StaleTickError();
      throw error;
    }
    if (!current(handle)) throw new StaleTickError();
    if (response?.error !== undefined) throw new Error(`session.${method} failed: ${JSON.stringify(response.error)}`);
    if (!response || (method !== 'promptAsync' && !Object.hasOwn(response, 'data'))) {
      throw new Error(`Malformed session.${method} response`);
    }
    return response.data;
  }

  async function primary(handle) {
    const data = await request(handle, 'get');
    assertCurrent(handle);
    if (!data || data.id !== handle.sessionID) throw new Error('Malformed session.get response');
    if (data.parentID != null) throw new Error(`Babysit cannot run in a child session (${handle.sessionID}); arm it in the main session`);
  }

  function snapshot(handle) {
    return { armed: handle.validated, interval: handle.interval, sessionID: handle.sessionID,
      expiresAt: handle.expiresAt, wakePending: Boolean(handle.pending), durable: false };
  }

  function timer(handle, fn, delay) {
    if (handle.timer !== null) clearTimer(handle.timer);
    handle.timer = setTimer(fn, Math.max(0, delay));
  }

  function schedule(handle) {
    if (!current(handle)) return;
    timer(handle, () => {
      handle.timer = null;
      if (!current(handle) || handle.processing) return;
      return tick(handle);
    }, Math.min(handle.intervalMs, handle.expiresAt - now(),
      handle.pending ? WAKE_PENDING_DEADLINE_MS - (now() - handle.pending.since) : Infinity));
  }

  async function tick(handle) {
    if (!current(handle) || handle.processing) return;
    if (now() >= handle.expiresAt) { stopSession(handle, 'expired'); return; }
    handle.processing = true;
    timer(handle, () => {
      if (now() >= handle.expiresAt) stopSession(handle, 'expired');
      else fail(handle, new Error('Babysit wake unresolved at pending deadline; stopped fail-closed'));
    }, Math.min(handle.expiresAt - now(),
      handle.pending ? WAKE_PENDING_DEADLINE_MS - (now() - handle.pending.since) : Infinity));
    try {
      await primary(handle);
      assertCurrent(handle);
      const todos = await request(handle, 'todo');
      assertCurrent(handle);
      if (!unfinished(todos)) { stopSession(handle, 'completed'); return; }
      const type = statusType(await request(handle, 'status'), handle.sessionID);
      assertCurrent(handle);
      if (handle.pending) {
        const messages = messageList(await request(handle, 'messages'));
        assertCurrent(handle);
        const pending = handle.pending;
        const boundary = messages.find((entry) => entry.info.id === pending.messageID)?.info;
        const assistants = messages.filter((entry) => entry.info.role === 'assistant'
          && entry.info.parentID === pending.messageID).map((entry) => entry.info);
        const failed = assistants.find((info) => info.error);
        if (failed) throw new Error(`Babysit wake failed: ${JSON.stringify(failed.error)}`);
        if (boundary?.role === 'user' && type !== 'idle') pending.seenBusy = true;
        const finished = assistants.some((info) => Number.isFinite(info.time?.completed)
          && typeof info.finish === 'string' && !['tool-calls', 'unknown'].includes(info.finish));
        if (type === 'idle' && boundary?.role === 'user' && (pending.seenBusy || finished)) {
          handle.pending = null;
        } else if (now() - pending.since >= WAKE_PENDING_DEADLINE_MS) {
          throw new Error('Babysit wake unresolved at pending deadline; stopped fail-closed');
        }
        return;
      }
      if (type !== 'idle') return;
      const metadata = metadataOf(messageList(await request(handle, 'messages')));
      assertCurrent(handle);
      const messageID = `msg_${(BigInt(Math.max(0, Math.floor(now()))) * 4096n).toString(16).padStart(12, '0')}${randomBytes(7).toString('hex')}`;
      handle.pending = { messageID, originID: metadata.originID, since: now(), seenBusy: false };
      timer(handle, () => {
        if (now() >= handle.expiresAt) stopSession(handle, 'expired');
        else fail(handle, new Error('Babysit wake unresolved at pending deadline; stopped fail-closed'));
      }, Math.min(WAKE_PENDING_DEADLINE_MS, handle.expiresAt - now()));
      const { originID, ...body } = metadata;
      await request(handle, 'promptAsync', { ...body, messageID,
        parts: [{ type: 'text', text: BABYSIT_TICK_PROMPT }] });
      assertCurrent(handle);
    } catch (error) {
      if (!(error instanceof StaleTickError)) fail(handle, error);
    } finally {
      handle.processing = false;
      if (current(handle)) schedule(handle);
    }
  }

  async function arm({ sessionID, interval = '15m', signal } = {}) {
    if (disposed) throw new Error('Babysit scheduler is disposed');
    if (signal?.aborted) throw new Error('Babysit arm aborted');
    if (!sessionID) throw new Error('Babysit arm requires a session');
    const intervalMs = parseIntervalMs(interval);
    const existing = sessions.get(sessionID);
    if (existing) {
      if (existing.interval !== interval) throw new Error(`Babysit already armed every ${existing.interval}; use action: off before changing the interval`);
      const onAbort = () => stopSession(existing, 'cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (existing.validated) return snapshot(existing);
        const result = await existing.armPromise;
        assertCurrent(existing);
        return result;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    stopped.delete(sessionID);
    const handle = { sessionID, interval, intervalMs, expiresAt: now() + MAX_EXPIRY_MS,
      abort: new AbortController(), off: false, validated: false, processing: false,
      pending: null, timer: null, armPromise: null };
    sessions.set(sessionID, handle);
    const onAbort = () => stopSession(handle, 'cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer(handle, () => stopSession(handle, 'expired'), MAX_EXPIRY_MS);
    handle.armPromise = (async () => {
      try {
        await primary(handle);
        assertCurrent(handle);
        const todos = await request(handle, 'todo');
        assertCurrent(handle);
        if (!unfinished(todos)) throw new Error('No unfinished todo tasks: create the plan before arming babysit');
        if (!current(handle)) throw new StaleTickError();
        handle.validated = true;
        schedule(handle);
        return snapshot(handle);
      } catch (error) {
        if (current(handle)) stopSession(handle, 'error');
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    })();
    return handle.armPromise;
  }

  function status(sessionID) {
    const handle = sessions.get(sessionID);
    if (handle) return snapshot(handle);
    return { armed: false, sessionID, durable: false,
      ...(stopped.has(sessionID) ? { stopped: stopped.get(sessionID) } : {}) };
  }

  function off(sessionID) {
    const handle = sessions.get(sessionID);
    if (handle) stopSession(handle, 'off');
    return { armed: false, sessionID, durable: false };
  }

  function handleEvent(event = {}) {
    const handle = sessions.get(event.sessionID);
    if (!handle) return;
    if (event.type === 'session.deleted') stopSession(handle, 'deleted');
    else if (event.type === 'session.error' || (event.type === 'message.updated' && event.info?.error)) {
      fail(handle, new Error(`Babysit stopped: ${JSON.stringify(event.error ?? event.info?.error)}`));
    } else if (event.type === 'todo.updated' && event.todos !== undefined) {
      try { if (!unfinished(event.todos)) stopSession(handle, 'completed'); }
      catch (error) { fail(handle, error); }
    }
  }

  function dispose() {
    for (const handle of [...sessions.values()]) stopSession(handle, 'disposed');
    disposed = true;
  }

  function state() {
    return { armed: [...sessions.values()].filter((h) => h.validated).map((h) => h.sessionID).sort(),
      stopped: Object.fromEntries([...stopped.entries()].sort()) };
  }
  return { arm, status, off, handleEvent, dispose, state };
}
