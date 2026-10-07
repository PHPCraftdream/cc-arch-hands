import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXPIRY_MS, WAKE_PENDING_DEADLINE_MS, createBabysitScheduler, parseIntervalMs, readTodos } from '../templates/opencode-runtime/scheduler/cah-babysit-scheduler.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  let time = 1000;
  const timers = new Set();
  const calls = [];
  const errors = [];
  const states = new Map();
  const gates = new Map();
  const clock = {
    now: () => time,
    setTimer(fn, ms) { const timer = { fn, at: time + ms }; timers.add(timer); return timer; },
    clearTimer: (timer) => timers.delete(timer),
    pending: () => timers.size,
    async advance(ms) {
      time += ms;
      for (const timer of [...timers].filter((t) => t.at <= time)) {
        if (!timers.delete(timer)) continue;
        await timer.fn();
      }
    },
  };
  function state(id = 's1') {
    if (!states.has(id)) states.set(id, {
      todos: [{ content: 'work', status: 'pending', priority: 'medium' }], type: 'idle',
      messages: [{ info: { id: `user-${id}`, sessionID: id, role: 'user', agent: 'hs',
        model: { providerID: 'openai', modelID: 'gpt-6.1-sol' } }, parts: [] }],
    });
    return states.get(id);
  }
  const client = { session: {} };
  for (const method of ['get', 'todo', 'status', 'messages', 'promptAsync']) {
    client.session[method] = async (args) => {
      calls.push({ method, ...args });
      const gate = gates.get(method);
      if (gate) {
        gates.delete(method);
        gate.args = args;
        gate.reached.resolve(args);
        await gate.release.promise;
      }
      const id = args.path?.id ?? 's1';
      const data = state(id);
      if (data[`${method}Error`]) return { error: data[`${method}Error`] };
      if (method === 'get') return { data: { id, ...(data.parentID ? { parentID: data.parentID } : {}) } };
      if (method === 'todo') return { data: data.todos };
      if (method === 'status') return { data: data.statusMap ?? Object.fromEntries([...states].map(([key, s]) => [key, { type: s.type }])) };
      if (method === 'messages') return { data: data.messages };
      return { data: undefined, response: { status: 204 } };
    };
  }
  const scheduler = createBabysitScheduler({ client, ...clock,
    onError: (id, error) => errors.push({ id, error }) });
  const gate = (method) => {
    const value = { reached: deferred(), release: deferred() };
    gates.set(method, value);
    return value;
  };
  const wakes = (id) => calls.filter((c) => c.method === 'promptAsync' && (!id || c.path.id === id));
  return { scheduler, client, clock, errors, state, calls, gate, wakes };
}

async function arm(f, id = 's1') {
  return f.scheduler.arm({ sessionID: id, interval: '1s' });
}

function boundary(f, id = 's1') {
  const wake = f.wakes(id).at(-1);
  f.state(id).messages.push({ info: { ...f.state(id).messages[0].info, id: wake.body.messageID }, parts: [] });
  return wake.body.messageID;
}

describe('OpenCode babysit scheduler', () => {
  it('readTodos returns canonical todos and rejects error envelopes and malformed state', async () => {
    const f = setup();
    assert.deepEqual(await readTodos({ client: f.client, sessionID: 's1' }), f.state().todos);
    assert.deepEqual(f.calls.at(-1).path, { id: 's1' });
    f.state().todoError = { name: 'NotFoundError' };
    await assert.rejects(() => readTodos({ client: f.client, sessionID: 's1' }), /session.todo failed/);
    delete f.state().todoError;
    f.state().todos = [{ content: 'x', status: 'blocked' }];
    await assert.rejects(() => readTodos({ client: f.client, sessionID: 's1' }), /canonical OpenCode todo/);
    await assert.rejects(() => readTodos({ client: f.client }), /session is required/);
    await assert.rejects(() => readTodos({ client: { session: {} }, sessionID: 's1' }), /session.todo is required/);
  });

  it('status explains why an unarmed session stopped and a re-arm clears it', async () => {
    const f = setup();
    assert.equal(Object.hasOwn(f.scheduler.status('s1'), 'stopped'), false);
    await arm(f);
    f.scheduler.handleEvent({ type: 'session.error', sessionID: 's1', error: { name: 'UnknownError' } });
    const stopped = f.scheduler.status('s1');
    assert.equal(stopped.armed, false);
    assert.match(stopped.stopped, /^error: .*UnknownError/);
    await arm(f);
    assert.equal(Object.hasOwn(f.scheduler.status('s1'), 'stopped'), false);
    f.scheduler.off('s1');
    assert.equal(f.scheduler.status('s1').stopped, 'off');
  });

  it('validates interval bounds and requires a client', () => {
    assert.equal(parseIntervalMs(), 900000);
    assert.equal(parseIntervalMs('1s'), 1000);
    assert.equal(parseIntervalMs('7d'), MAX_EXPIRY_MS);
    for (const bad of ['0s', '8d', '-1m', '999', 'wat']) assert.throws(() => parseIntervalMs(bad));
    assert.throws(() => createBabysitScheduler(), /client is required/);
  });

  it('validates primary session and canonical unfinished todos before arming', async () => {
    for (const [field, value, pattern] of [
      ['parentID', 'parent', /child session/],
      ['todos', [{ content: 'work', status: 'completed' }], /No unfinished/],
      ['todos', [{ content: 'work', status: 'blocked' }], /canonical/],
      ['getError', { name: 'NotFoundError' }, /session.get failed/],
      ['todoError', { name: 'BadRequestError' }, /session.todo failed/],
    ]) {
      const f = setup(); f.state()[field] = value;
      await assert.rejects(() => arm(f), pattern);
      assert.equal(f.scheduler.status('s1').armed, false);
      assert.equal(f.clock.pending(), 0);
    }
  });

  it('concurrent arms await the same validation and provisional status is not armed', async () => {
    const f = setup(); const gate = f.gate('todo');
    const first = arm(f); await gate.reached.promise;
    const second = arm(f);
    assert.equal(f.scheduler.status('s1').armed, false);
    assert.deepEqual(f.scheduler.state().armed, []);
    f.state().todos = [];
    gate.release.resolve();
    await assert.rejects(first, /No unfinished/);
    await assert.rejects(second, /No unfinished/);
    assert.equal(f.calls.filter((c) => c.method === 'get').length, 1);
  });

  it('rejects aborted/disposed arms before requests and conflicting intervals preserve the timer', async () => {
    const f = setup(); const abort = new AbortController(); abort.abort();
    await assert.rejects(() => f.scheduler.arm({ sessionID: 's1', signal: abort.signal }), /aborted/);
    assert.equal(f.calls.length, 0);
    await arm(f);
    await assert.rejects(() => f.scheduler.arm({ sessionID: 's1', interval: '1h' }), /already armed/);
    assert.equal(f.clock.pending(), 1);
    f.scheduler.dispose();
    await assert.rejects(() => arm(f), /disposed/);
  });

  for (const method of ['get', 'todo']) {
    it(`off during arm ${method} invalidates validation and aborts the SDK signal`, async () => {
      const f = setup(); const gate = f.gate(method); const arming = arm(f);
      const args = await gate.reached.promise;
      f.scheduler.off('s1'); assert.equal(args.signal.aborted, true);
      gate.release.resolve(); await assert.rejects(arming, /stale/);
      assert.equal(f.clock.pending(), 0);
    });
  }

  for (const method of ['get', 'todo', 'status', 'messages', 'promptAsync']) {
    it(`off at the actual pending tick ${method} boundary fences the operation`, async () => {
      const f = setup(); await arm(f); const gate = f.gate(method);
      const ticking = f.clock.advance(1000); const args = await gate.reached.promise;
      f.scheduler.off('s1'); assert.equal(args.signal.aborted, true);
      gate.release.resolve(); await ticking;
      assert.equal(f.wakes().length, method === 'promptAsync' ? 1 : 0);
      assert.equal(f.scheduler.status('s1').armed, false);
      assert.equal(f.clock.pending(), 0);
      assert.equal(f.errors.length, 0);
    });
  }

  it('dispose during a genuinely pending arm cannot resurrect a timer', async () => {
    const f = setup(); const gate = f.gate('todo'); const arming = arm(f);
    const args = await gate.reached.promise; f.scheduler.dispose();
    assert.equal(args.signal.aborted, true);
    gate.release.resolve(); await assert.rejects(arming, /stale/);
    assert.equal(f.clock.pending(), 0);
  });

  it('overlapping timer callbacks never release another tick or duplicate requests', async () => {
    const f = setup(); await arm(f); const gate = f.gate('messages');
    const ticking = f.clock.advance(1000); await gate.reached.promise;
    await f.clock.advance(1000); await f.clock.advance(1000);
    assert.equal(f.calls.filter((c) => c.method === 'messages').length, 1);
    assert.equal(f.wakes().length, 0);
    gate.release.resolve(); await ticking;
    assert.equal(f.wakes().length, 1);
    await f.clock.advance(1000); assert.equal(f.wakes().length, 1);
  });

  it('late rejected old requests cannot stop or release a newer rearm', async () => {
    const f = setup(); await arm(f); const gate = f.gate('get');
    const oldTick = f.clock.advance(1000); await gate.reached.promise;
    f.scheduler.off('s1'); await arm(f);
    gate.release.reject(new Error('old provider error')); await oldTick;
    assert.equal(f.scheduler.status('s1').armed, true);
    assert.equal(f.errors.length, 0);
    await f.clock.advance(1000); assert.equal(f.wakes().length, 1);
  });

  it('one scheduler routes independent wakes to two sessions and preserves exact object models', async () => {
    const f = setup(); f.state('s2').messages[0].info.agent = 'xxa';
    f.state('s2').messages[0].info.model = { providerID: 'custom-provider', modelID: 'literal-model', variant: 'ultra' };
    await arm(f, 's1'); await arm(f, 's2'); await f.clock.advance(1000);
    assert.equal(f.wakes('s1').length, 1); assert.equal(f.wakes('s2').length, 1);
    assert.deepEqual(f.wakes('s1')[0].body.model, { providerID: 'openai', modelID: 'gpt-6.1-sol' });
    const body = f.wakes('s2')[0].body;
    assert.deepEqual(body.model, { providerID: 'custom-provider', modelID: 'literal-model' });
    assert.equal(body.agent, 'xxa'); assert.equal(body.variant, 'ultra');
    assert.match(body.messageID, /^msg_[a-f0-9]+$/);
    assert.notEqual(body.messageID, f.wakes('s1')[0].body.messageID);
    f.scheduler.dispose();
  });

  it('absence in the real status map is idle; busy and retry never wake', async () => {
    const f = setup(); await arm(f);
    for (const type of ['busy', 'retry']) { f.state().type = type; await f.clock.advance(1000); }
    assert.equal(f.wakes().length, 0);
    f.state().statusMap = {}; await f.clock.advance(1000); assert.equal(f.wakes().length, 1);
  });

  for (const malformed of [null, [], 'idle', { s1: null }, { s1: {} }, { s1: { type: 'unknown' } }]) {
    it(`fails loudly on malformed status ${JSON.stringify(malformed)}`, async () => {
      const f = setup(); await arm(f);
      f.client.session.status = async () => ({ data: malformed });
      await f.clock.advance(1000);
      assert.equal(f.scheduler.status('s1').armed, false); assert.equal(f.errors.length, 1);
      assert.equal(f.wakes().length, 0);
    });
  }

  for (const method of ['get', 'todo', 'status', 'messages', 'promptAsync']) {
    it(`an actual tick surfaces session.${method} error envelopes`, async () => {
      const f = setup(); await arm(f); f.state()[`${method}Error`] = { name: 'SDKError' };
      await f.clock.advance(1000);
      assert.equal(f.scheduler.status('s1').armed, false);
      assert.match(f.errors[0].error.message, new RegExp(`session.${method} failed`));
    });
  }

  it('requires messages and never falls back to default agent/model on malformed metadata', async () => {
    for (const info of [null, { role: 'user', id: 'u', agent: 'hs', model: 'openai/model' },
      { role: 'user', id: 'u', model: { providerID: 'openai', modelID: 'm' } }]) {
      const f = setup(); await arm(f); f.state().messages = info ? [{ info, parts: [] }] : [];
      await f.clock.advance(1000); assert.equal(f.wakes().length, 0);
      assert.equal(f.scheduler.status('s1').armed, false); assert.equal(f.errors.length, 1);
    }
    const f = setup(); await arm(f); delete f.client.session.messages;
    await f.clock.advance(1000); assert.match(f.errors[0].error.message, /messages is required/);
  });

  it('acceptance and unrelated idle events cannot release an unresolved wake', async () => {
    const f = setup(); await arm(f); await f.clock.advance(1000);
    f.scheduler.handleEvent({ type: 'session.idle', sessionID: 's1' });
    f.scheduler.handleEvent({ type: 'session.status', sessionID: 's1', status: { type: 'busy' } });
    f.scheduler.handleEvent({ type: 'session.idle', sessionID: 's1' });
    await f.clock.advance(1000); await f.clock.advance(1000);
    assert.equal(f.wakes().length, 1); assert.equal(f.scheduler.status('s1').wakePending, true);
  });

  it('releases only after the wake message boundary is observed busy then idle', async () => {
    const f = setup(); await arm(f); await f.clock.advance(1000); boundary(f);
    f.state().type = 'busy'; await f.clock.advance(1000);
    f.state().type = 'idle'; await f.clock.advance(1000);
    assert.equal(f.scheduler.status('s1').wakePending, false);
    assert.equal(f.wakes().length, 1);
    await f.clock.advance(1000); assert.equal(f.wakes().length, 2);
  });

  it('a verified finished assistant must belong to the newly assigned wake message', async () => {
    const f = setup(); await arm(f); await f.clock.advance(1000); const id = boundary(f);
    const info = { id: 'assistant', role: 'assistant', parentID: 'old-user', time: { completed: 2000 }, finish: 'stop' };
    f.state().messages.push({ info, parts: [] });
    await f.clock.advance(1000); assert.equal(f.scheduler.status('s1').wakePending, true);
    info.parentID = id; await f.clock.advance(1000);
    assert.equal(f.scheduler.status('s1').wakePending, false);
  });

  it('polls canonical todos while accepted wake is pending and stops completed/cancelled work', async () => {
    for (const status of ['completed', 'cancelled']) {
      const f = setup(); await arm(f); await f.clock.advance(1000);
      const signal = f.wakes()[0].signal; f.state().todos[0].status = status;
      await f.clock.advance(1000); assert.equal(signal.aborted, true);
      assert.equal(f.scheduler.status('s1').armed, false); assert.equal(f.wakes().length, 1);
    }
  });

  it('pending acceptance timeout fails closed, reports and never requeues', async () => {
    const f = setup(); await arm(f); await f.clock.advance(1000);
    await f.clock.advance(WAKE_PENDING_DEADLINE_MS);
    assert.equal(f.scheduler.status('s1').armed, false);
    assert.match(f.errors[0].error.message, /fail-closed/);
    await f.clock.advance(1000); assert.equal(f.wakes().length, 1);
  });

  it('a pending prompt request also has a fail-closed deadline', async () => {
    const f = setup(); await arm(f); const gate = f.gate('promptAsync');
    const tick = f.clock.advance(1000); const args = await gate.reached.promise;
    await f.clock.advance(WAKE_PENDING_DEADLINE_MS);
    assert.equal(args.signal.aborted, true); assert.equal(f.scheduler.status('s1').armed, false);
    gate.release.resolve(); await tick; assert.equal(f.wakes().length, 1);
  });

  for (const reason of ['off', 'dispose', 'session.deleted', 'session.error', 'message.updated', 'todo.updated', 'expiry']) {
    it(`${reason} aborts all owned pending SDK requests`, async () => {
      const f = setup(); await arm(f); const gate = f.gate('promptAsync');
      const tick = f.clock.advance(1000); const args = await gate.reached.promise;
      if (reason === 'off') f.scheduler.off('s1');
      else if (reason === 'dispose') f.scheduler.dispose();
      else if (reason === 'expiry') await f.clock.advance(MAX_EXPIRY_MS);
      else f.scheduler.handleEvent({ type: reason, sessionID: 's1',
        info: { role: 'assistant', error: { name: 'MessageAbortedError' } },
        error: { name: 'ProviderAuthError' }, todos: [] });
      assert.equal(args.signal.aborted, true);
      gate.release.resolve(); await tick;
      assert.equal(f.scheduler.status('s1').armed, false); assert.equal(f.clock.pending(), 0);
    });
  }
});
