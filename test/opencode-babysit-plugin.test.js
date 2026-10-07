import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const SCHEDULER_SRC = join(worktree, 'templates', 'opencode-runtime', 'scheduler', 'cah-babysit-scheduler.js');
const PLUGIN_SRC = join(worktree, 'templates', 'opencode-runtime', 'plugin', 'cah-babysit.js');

// Build a sandbox that mimics the published layout: <root>/plugins/cah-babysit.js
// importing ../cah-opencode/cah-babysit-scheduler.js, plus a stub
// @opencode-ai/plugin package exposing the documented tool.schema surface.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-opencode-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Node < 20.19 does not sniff ESM syntax in a .js file (OpenCode's Bun does).
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(root, 'cah-opencode'), { recursive: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  copyFileSync(SCHEDULER_SRC, join(root, 'cah-opencode', 'cah-babysit-scheduler.js'));
  copyFileSync(PLUGIN_SRC, join(root, 'plugins', 'cah-babysit.js'));
  const pkgDir = join(root, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@opencode-ai/plugin', type: 'module', main: 'index.js' }));
  writeFileSync(join(pkgDir, 'index.js'), `
const registered = [];
export const tool = (definition) => { registered.push(definition); return definition; };
tool.schema = {
  enum: (values) => ({ type: 'enum', values }),
  string: () => ({ type: 'string', optional() { return { ...this, isOptional: true }; } }),
};
export const __registered = registered;
`);
  return { root, registryModule: join(pkgDir, 'index.js') };
}

async function loadPlugin(t, client) {
  const { root, registryModule } = sandbox(t);
  const pluginModule = await import(pathToFileURL(join(root, 'plugins', 'cah-babysit.js')));
  const stub = await import(pathToFileURL(registryModule));
  const hooks = await pluginModule.default({ client });
  return { hooks, stub, root };
}

function baseClient() {
  const calls = [];
  const logs = [];
  const toasts = [];
  const client = {
    calls,
    app: { log: (args) => { logs.push(args); return { ok: true }; } },
    tui: { showToast: (args) => { toasts.push(args); return { data: true }; } },
    session: {
      async get({ path }) { calls.push(['get', path.id]); return { data: { id: path.id } }; },
      async todo() { calls.push(['todo']); return { data: [{ content: 'a', status: 'pending' }] }; },
      async status() { calls.push(['status']); return { data: {} }; },
      async messages({ path }) { return { data: [{ info: { id: 'user-1', sessionID: path.id,
        role: 'user', agent: 'hs', model: { providerID: 'openai', modelID: 'gpt-6.1-sol' } }, parts: [] }] }; },
      async promptAsync({ path, body }) { calls.push(['promptAsync', path.id, body]); return { data: undefined, response: { status: 204 } }; },
    },
  };
  return { client, calls, logs, toasts };
}

describe('cah-babysit plugin adapter contract', () => {
  it('publishes the plugin to the plural plugins/ directory importing the sibling scheduler', () => {
    const plugin = readFileSync(PLUGIN_SRC, 'utf8');
    assert.match(plugin, /from '\.\.\/cah-opencode\/cah-babysit-scheduler\.js'/);
    assert.match(plugin, /^\/\/ cah-opencode-runtime:v1/m);
    // single canonical export shape: default export only
    assert.match(plugin, /export default/);
    assert.doesNotMatch(plugin, /export (const|let|class|function) plugin\b/);
  });

  it('registers cah_babysit with a proper schema via tool.schema', async (t) => {
    const { hooks, stub } = await loadPlugin(t, baseClient().client);
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks.dispose, 'function');
    assert.ok(stub.__registered.length >= 1, 'tool() factory invoked');
    const definition = stub.__registered.at(-1);
    assert.match(definition.description, /session-only todo heartbeat/);
    assert.deepEqual(definition.args.action, { type: 'enum', values: ['arm', 'status', 'off'] });
    assert.equal(definition.args.interval.type, 'string');
  });

  it('registers cah_todos as a read-only view of session.todo', async (t) => {
    const { client, calls } = baseClient();
    const { stub } = await loadPlugin(t, client);
    const definition = stub.__registered.find((d) => /no todoread tool/.test(d.description));
    assert.ok(definition, 'cah_todos registered');
    assert.deepEqual(definition.args, {});
    const signal = new AbortController().signal;
    assert.deepEqual(JSON.parse(await definition.execute({}, { sessionID: 's9', abort: signal })),
      [{ content: 'a', status: 'pending' }]);
    assert.deepEqual(calls.at(-1), ['todo']);
    client.session.todo = async () => ({ error: { name: 'NotFoundError' } });
    await assert.rejects(() => definition.execute({}, { sessionID: 's9' }), /session.todo failed/);
    client.session.todo = async () => ({ data: [{ content: 'a', status: 'blocked' }] });
    await assert.rejects(() => definition.execute({}, { sessionID: 's9' }), /canonical OpenCode todo/);
    const abort = new AbortController(); abort.abort();
    client.session.todo = async () => ({ data: [] });
    await assert.rejects(() => definition.execute({}, { sessionID: 's9', abort: abort.signal }), /aborted/);
  });

  it('execute drives the scheduler: status, arm, off; events forward; dispose cleans up', async (t) => {
    const { client, calls } = baseClient();
    const { hooks, stub } = await loadPlugin(t, client);
    const definition = stub.__registered.at(-1);
    const ctx = { sessionID: 's1', abort: new AbortController().signal };
    const status = JSON.parse(await definition.execute({ action: 'status' }, ctx));
    assert.equal(status.armed, false);
    const armed = JSON.parse(await definition.execute({ action: 'arm', interval: '1m' }, ctx));
    assert.equal(armed.armed, true);
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 's1' } } } });
    assert.equal(JSON.parse(await definition.execute({ action: 'status' }, ctx)).armed, false,
      'session.deleted event stopped the armed scheduler');
    await definition.execute({ action: 'arm', interval: '1m' }, ctx);
    const off = JSON.parse(await definition.execute({ action: 'off' }, ctx));
    assert.equal(off.armed, false);
    await assert.rejects(() => definition.execute({ action: 'bogus' }, ctx), /Unknown babysit action/);
    hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    hooks.event({ event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } } });
    hooks.event({ event: { type: 'session.deleted', properties: { sessionID: 's1' } } });
    assert.equal(JSON.parse(await definition.execute({ action: 'status' }, ctx)).armed, false,
      'session.deleted event stopped the scheduler');
    hooks.dispose();
    assert.ok(calls.length >= 2);
  });

  it('scheduler errors are surfaced through client.app.log and a TUI toast', async (t) => {
    const { client, logs, toasts } = baseClient();
    const { hooks, stub } = await loadPlugin(t, client);
    t.after(() => hooks.dispose());
    const definition = stub.__registered.at(-1);
    await definition.execute({ action: 'arm', interval: '1m' }, { sessionID: 's1' });
    await hooks.event({ event: { type: 'session.error', properties: {
      sessionID: 's1', error: { name: 'UnknownError', data: { message: 'provider down' } },
    } } });
    assert.equal(JSON.parse(await definition.execute({ action: 'status' }, { sessionID: 's1' })).armed, false);
    assert.ok(logs.length >= 1, 'error reported via app.log');
    assert.equal(logs.at(-1).body.service, 'cah-babysit');
    assert.match(logs.at(-1).body.message, /provider down/);
    assert.equal(toasts.length, 1, 'the user is told in the TUI');
    assert.equal(toasts[0].body.variant, 'error');
    assert.match(toasts[0].body.message, /provider down/);
    const status = JSON.parse(await definition.execute({ action: 'status' }, { sessionID: 's1' }));
    assert.match(status.stopped, /^error: .*provider down/, 'status explains why it stopped');
    // A missing or throwing toast API never breaks the heartbeat.
    client.tui.showToast = () => { throw new Error('no tui'); };
    await definition.execute({ action: 'arm', interval: '1m' }, { sessionID: 's2' });
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 's2', error: { name: 'X' } } } });
    assert.equal(JSON.parse(await definition.execute({ action: 'status' }, { sessionID: 's2' })).armed, false);
    hooks.dispose();
  });

  it('ctx.abort during tool execution stops the heartbeat; normal completion does not', async (t) => {
    const { client } = baseClient();
    const { hooks, stub } = await loadPlugin(t, client);
    const definition = stub.__registered.at(-1);
    const ctx = { sessionID: 's1', abort: new AbortController().signal };
    await definition.execute({ action: 'arm', interval: '1m' }, ctx);
    assert.equal(JSON.parse(await definition.execute({ action: 'status' }, ctx)).armed, true,
      'abort listener removed after successful completion');
    // Abort DURING a tool execution: pause the arm path mid-await.
    await definition.execute({ action: 'off' }, ctx);
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    let reached;
    const entered = new Promise((resolve) => { reached = resolve; });
    client.session.get = async ({ path }) => {
      reached();
      return gate.then(() => ({ data: { id: path.id } }));
    };
    const abort2 = new AbortController();
    const arming = definition.execute({ action: 'arm', interval: '1m' },
      { sessionID: 's1', abort: abort2.signal });
    await entered;
    abort2.abort();
    resume();
    await assert.rejects(arming, /stale/);
    assert.equal(JSON.parse(await definition.execute({ action: 'status' },
      { sessionID: 's1' })).armed, false,
      'an abort during tool execution stops the heartbeat');
    hooks.dispose();
  });

  it('rejects already aborted and disposed arms and forwards MessageAbortedError info', async (t) => {
    const { client, calls, logs } = baseClient();
    const { hooks, stub } = await loadPlugin(t, client);
    t.after(() => hooks.dispose());
    const definition = stub.__registered.at(-1);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(() => definition.execute({ action: 'arm' },
      { sessionID: 's1', abort: abort.signal }), /aborted/);
    assert.equal(calls.length, 0);
    await definition.execute({ action: 'arm' }, { sessionID: 's1' });
    await hooks.event({ event: { type: 'message.updated', properties: { info: {
      id: 'assistant-1', sessionID: 's1', role: 'assistant', error: { name: 'MessageAbortedError', data: {} },
    } } } });
    assert.equal(JSON.parse(await definition.execute({ action: 'status' }, { sessionID: 's1' })).armed, false);
    assert.match(logs.at(-1).body.message, /MessageAbortedError/);
    await hooks.dispose();
    await assert.rejects(() => definition.execute({ action: 'arm' }, { sessionID: 's2' }), /disposed/);
  });
});
