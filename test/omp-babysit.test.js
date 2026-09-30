import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import babysitExtension, { intervalMilliseconds, latestTodo } from '../templates/omp-commands/runtime/babysit.js';

function snapshot(tasks, extra = {}) {
  return { type: 'message', message: { role: 'toolResult', toolName: 'todo',
    details: { op: 'init', phases: [{ name: 'Work', tasks }] }, ...extra } };
}
function harness() {
  const handlers = new Map();
  const timers = new Map();
  const wakes = [];
  let tool;
  let nextId = 0;
  const state = { entries: [], idle: true, queued: false, sessionId: 'one', kind: 'main' };
  const ctx = {
    agent: { get kind() { return state.kind; } },
    sessionManager: { getBranch: () => state.entries, getSessionId: () => state.sessionId },
    isIdle: () => state.idle, hasPendingMessages: () => state.queued,
    setInterval: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  };
  babysitExtension({
    arktype: (schema) => schema,
    registerTool: (definition) => { tool = definition; },
    on: (event, handler) => { handlers.set(event, handler); },
    sendMessage: (message, options) => { wakes.push({ message, options }); },
  });
  return { state, timers, wakes,
    call: (params) => tool.execute('test-call', params, undefined, undefined, ctx),
    event: (name) => handlers.get(name)?.({}, ctx),
    tick: () => { for (const timer of [...timers.values()]) timer.callback(); },
  };
}

describe('OMP babysit heartbeat', () => {
  it('parses bounded intervals and rejects zero, overflow and ambiguous units', () => {
    assert.equal(intervalMilliseconds('1s'), 1000);
    assert.equal(intervalMilliseconds('5m'), 300000);
    assert.equal(intervalMilliseconds('168h'), 604800000);
    for (const value of ['0m', '169h', '999999999999999999h', '-1m', '1.5m', '5', '5d']) {
      assert.throws(() => intervalMilliseconds(value));
    }
  });

  it('uses canonical committed todo state, not failed/view results or old branches', () => {
    const active = { content: 'Implement feature', status: 'in_progress' };
    assert.deepEqual(latestTodo([snapshot([active]), snapshot([], { isError: true }),
      { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { op: 'view', phases: [] } } }]), [active]);
    const blocked = { content: 'Await user', status: 'blocked', blocker: 'user decision' };
    assert.deepEqual(latestTodo([snapshot([active]),
      { type: 'custom', customType: 'user_todo_edit', data: { phases: [{ name: 'Work', tasks: [blocked] }] } }]), [blocked]);
    assert.throws(() => latestTodo([snapshot([{ content: 'Bad', status: 'unknown' }])]));
  });

  it('arms one timer, wakes idle actionable work once and self-stops on completion', async () => {
    const h = harness();
    h.state.entries = [snapshot([{ content: 'Implement feature', status: 'in_progress' }])];
    assert.equal((await h.call({ action: 'arm', interval: '5m' })).details.armed, true);
    await h.call({ action: 'arm', interval: '5m' });
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, 300000);
    await assert.rejects(h.call({ action: 'arm', interval: '1h' }), /already armed/);
    h.tick();
    h.tick();
    assert.equal(h.wakes.length, 1);
    assert.equal(h.wakes[0].options.triggerTurn, true);
    h.state.idle = false;
    h.event('agent_start');
    h.tick();
    assert.equal(h.wakes.length, 1);
    h.state.entries.push(snapshot([{ content: 'Implement feature', status: 'completed' }]));
    h.state.idle = true;
    h.event('agent_end');
    assert.equal(h.timers.size, 0);
    assert.equal((await h.call({ action: 'status' })).details.armed, false);
  });

  it('does not interrupt active work or queued messages and never unblocks external waits', async () => {
    const h = harness();
    h.state.entries = [snapshot([{ content: 'Await user', status: 'blocked', blocker: 'user decision' }])];
    await h.call({ action: 'arm' });
    h.tick();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.timers.size, 1);
    h.state.entries.push(snapshot([{ content: 'Await user', status: 'pending' }]));
    h.state.idle = false;
    h.tick();
    h.state.idle = true;
    h.state.queued = true;
    h.tick();
    assert.equal(h.wakes.length, 0);
    h.state.queued = false;
    h.tick();
    assert.equal(h.wakes.length, 1);
    await h.call({ action: 'off' });
    assert.equal(h.timers.size, 0);
  });

  it('does not arm for empty/completed plans or spawned agents', async () => {
    const h = harness();
    await assert.rejects(h.call({ action: 'arm' }), /No unfinished/);
    h.state.entries = [snapshot([{ content: 'Done', status: 'abandoned' }])];
    await assert.rejects(h.call({ action: 'arm' }), /No unfinished/);
    h.state.entries = [snapshot([{ content: 'Work', status: 'pending' }])];
    h.state.kind = 'sub';
    await assert.rejects(h.call({ action: 'arm' }), /main session/);
    assert.equal(h.timers.size, 0);
  });

  it('cleans up timers on session/branch changes, expiry and unreadable todo state', async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    for (const event of ['session_switch', 'session_tree', 'session_shutdown']) {
      const h = harness();
      h.state.entries = [snapshot([{ content: 'Work', status: 'pending' }])];
      await h.call({ action: 'arm' });
      h.event(event);
      assert.equal(h.timers.size, 0);
    }
    const h = harness();
    h.state.entries = [snapshot([{ content: 'Work', status: 'pending' }])];
    await h.call({ action: 'arm' });
    h.state.sessionId = 'two';
    h.tick();
    assert.equal(h.timers.size, 0);
    await h.call({ action: 'arm' });
    now += 604800000;
    h.tick();
    assert.equal(h.timers.size, 0);
    await h.call({ action: 'arm' });
    h.state.entries.push(snapshot([{ content: 'Work', status: 'unsupported' }]));
    assert.throws(h.tick, /Cannot read canonical/);
    assert.equal(h.timers.size, 0);
    assert.equal(h.wakes.length, 0);
  });
});
