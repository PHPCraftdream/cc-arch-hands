import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerCheckpointWatch, checkpointName, renderEvents, heldSection, findCheckpoint, ownTurn,
  COMPACT_INSTRUCTIONS, COMPACT_TRIES, COMPACT_RETRY_MS, DROP_REASON, HELD_TEXT_LIMIT,
  IDLE_MIN_MS, IDLE_SKIP_REASON, IDLE_MIN_TOKENS, idleOf,
} from '../templates/skills/checkpoint-watch/hooks/engine.mjs';
import { readWatchState, updateWatch, WatchSettingsError } from '../lib/checkpoint-watch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, '..', 'bin', 'cah.js');
const PLUGIN = 'cah-checkpoint-watch';
const LIMIT_MS = 60_000;

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

function defaultGit(argv) {
  const args = argv.slice(1);
  if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
    return { exitCode: 0, stdout: '/repo\n/repo/.git\n/repo/.git\n', stderr: '' };
  }
  if (args.includes('check-ignore')) return { exitCode: 1, stdout: '', stderr: '' };
  if (args.includes('--short')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
}

// A fake `$` and `on`: hooks are kept by event, timers run only on flush().
function harness({ mode = 'checkpoint', percent = 95, git = defaultGit } = {}) {
  const hooks = {};
  const timers = [];
  const files = {};
  const calls = { abort: [], command: [], compact: [], submit: [], log: [], process: [], engineCompact: [] };
  const h = {
    percent,
    tokens: 300_000,
    // Per-source settings (local, user); a source not listed here reads `settings`.
    bySource: null,
    settings: mode ? { cahCheckpointWatch: { mode } } : {},
    compact: async () => ({ messages: [], tokensBefore: 900_000, tokensAfter: 20_000 }),
    files, calls, timers,
  };
  const $ = {
    plugin: { name: PLUGIN },
    session: {
      usage: async () => ({ context: { percent: h.percent, tokens: h.tokens } }),
      compact: async (args) => { calls.compact.push(args); return h.compact(args); },
    },
    settings: { read: async (args) => h.bySource?.[args?.source] ?? h.settings },
    turn: { abort: async ({ turnId }) => { calls.abort.push(turnId); } },
    command: {
      run: async (args) => { calls.command.push(args); return { text: '' }; },
      register: async (spec) => ({ command: spec.name }),
    },
    prompt: { submit: async ({ text }) => { calls.submit.push(text); return { text }; } },
    clock: {
      after: (ms, fn) => {
        const timer = { ms, fn, done: false, cancel() { this.done = true; } };
        timers.push(timer);
        return timer;
      },
    },
    ui: { log: (text) => calls.log.push(text), toast: () => {} },
    fs: {
      exists: async (path) => path in files,
      read: async (path) => { if (!(path in files)) throw new Error(`ENOENT ${path}`); return files[path]; },
      write: async (path, text) => { files[path] = text; },
    },
    process: { run: async (argv) => { calls.process.push(argv); return git(argv); } },
  };
  const on = (event, matcher, hook) => {
    (hooks[event] ??= []).push(hook ? { matcher, hook } : { matcher: null, hook: matcher });
  };
  h.w = registerCheckpointWatch(on, { threshold: 90, limitMs: LIMIT_MS });
  h.emit = async (event, e) => {
    const list = (hooks[event] ?? []).filter(({ matcher }) => !matcher
      || Object.entries(matcher).every(([key, value]) => e[key] === value));
    const next = async (x) => {
      if (event === 'prompt.submit') return { text: x.text };
      if (event === 'session.compact') { calls.engineCompact.push(x.trigger); return { messages: [] }; }
      return x;
    };
    return list.length ? list[0].hook($, e, next) : next(e);
  };
  // Runs every due timer (ms <= upTo), including the ones they schedule.
  h.flush = async (upTo = 0) => {
    for (let guard = 0; guard < 200; guard++) {
      await settle();
      const timer = timers.find((t) => !t.done && t.ms <= upTo);
      if (!timer) return;
      timer.done = true;
      timer.fn();
    }
    throw new Error('timers never settled');
  };
  // The silence timer of `minutes`: fires it by hand (flush(upTo) would also fire the cycle's limit timer).
  h.silenceTimers = (minutes) => timers.filter((t) => t.ms === minutes * 60_000);
  h.fireSilence = async (minutes) => {
    const timer = h.silenceTimers(minutes).find((t) => !t.done);
    assert.ok(timer, `no live ${minutes}-minute silence timer`);
    timer.done = true;
    timer.fn();
    await h.flush(0);
  };
  return h;
}

async function startCycle(h) {
  await h.emit('turn.start', { turnId: 'T1', text: 'work' });
  await h.emit('tool.call', { tool: 'Bash' });
  await h.flush(0);
  return h.w.cycle.name;
}

async function runCheckpointTurn(h, name, { write = true } = {}) {
  await h.emit('turn.start', { turnId: 'T3', text: `<command-name>/checkpoint</command-name>\n<command-args>${name}</command-args>` });
  if (write) h.files[`/repo/docs/checkpoints/${name}.md`] = '# Checkpoint\n\n## Session summary\nwork\n';
  await h.emit('turn.complete', { turnId: 'T3', reason: 'answer' });
  await h.flush(500);
}

describe('checkpoint-watch engine: trigger', () => {
  it('does nothing in a project that did not turn it on', async () => {
    const h = harness({ mode: null });
    await h.emit('turn.start', { turnId: 'T1', text: 'work' });
    await h.emit('tool.call', { tool: 'Bash' });
    await h.flush(0);
    assert.equal(h.w.cycle, null);
    assert.deepEqual(h.calls.abort, []);
    assert.deepEqual(h.calls.command, []);
  });

  it('does nothing below the threshold, and ignores subagent tool calls', async () => {
    const h = harness({ percent: 89 });
    await h.emit('turn.start', { turnId: 'T1', text: 'work' });
    await h.emit('tool.call', { tool: 'Bash' });
    assert.equal(h.w.cycle, null);
    h.percent = 95;
    await h.emit('tool.call', { tool: 'Bash', agentId: 'sub-1' });
    assert.equal(h.w.cycle, null);
  });

  it('at the threshold stops the running turn and runs /checkpoint with a fresh name', async () => {
    const h = harness();
    const name = await startCycle(h);
    assert.match(name, /^watch-\d{4}-\d{2}-\d{2}-\d{6}$/);
    assert.deepEqual(h.calls.abort, ['T1']);
    assert.deepEqual(h.calls.command, [{ command: 'checkpoint', args: name }]);
  });

  it('an answer that ends at the threshold starts the cycle without an abort', async () => {
    const h = harness();
    await h.emit('turn.start', { turnId: 'T1', text: 'explain' });
    await h.emit('turn.complete', { turnId: 'T1', reason: 'answer' });
    await h.flush(0);
    assert.deepEqual(h.calls.abort, []);
    assert.equal(h.calls.command[0].command, 'checkpoint');
  });
});

describe('checkpoint-watch engine: idle compaction', () => {
  // A finished answer below the threshold, then the session sits idle.
  async function idle(h, idleMs = IDLE_MIN_MS) {
    h.percent = 50;
    await h.emit('turn.start', { turnId: 'T1', text: 'explain' });
    await h.emit('turn.complete', { turnId: 'T1', reason: 'answer' });
    await h.flush(0);
    h.w.lastTurnEnd = Date.now() - idleMs;
  }

  it('vetoes the idle auto compaction and runs checkpoint, compact, resume instead', async () => {
    const h = harness({ mode: 'commit' });
    await idle(h);
    assert.equal(h.w.cycle, null);
    const out = await h.emit('session.compact', { trigger: 'auto', messages: [] });
    assert.deepEqual(out, { skip: IDLE_SKIP_REASON });
    assert.deepEqual(h.calls.engineCompact, []);
    const name = h.w.cycle.name;
    await h.flush(0);
    assert.deepEqual(h.calls.abort, []);
    assert.deepEqual(h.calls.command, [{ command: 'checkpoint', args: name }]);
    await runCheckpointTurn(h, name);
    assert.deepEqual(h.calls.compact, [{ instructions: COMPACT_INSTRUCTIONS }]);
    assert.deepEqual(h.calls.command.at(-1), { command: 'resume', args: name });
    await h.emit('turn.start', { turnId: 'T4', text: `/resume ${name}` });
    await h.flush(0);
    assert.equal(h.w.cycle, null);
    assert.ok(h.calls.process.some((argv) => argv.includes('commit')));
  });

  it('lets the compaction through when the project did not turn the watch on', async () => {
    const h = harness({ mode: null });
    await idle(h);
    const out = await h.emit('session.compact', { trigger: 'auto', messages: [] });
    assert.deepEqual(out, { messages: [] });
    assert.deepEqual(h.calls.engineCompact, ['auto']);
    assert.equal(h.w.cycle, null);
  });

  it('lets a threshold compaction inside a turn, a short pause and a subagent\'s through', async () => {
    const h = harness();
    await idle(h, IDLE_MIN_MS - 60_000);
    await h.emit('session.compact', { trigger: 'auto', messages: [] });
    h.w.lastTurnEnd = Date.now() - IDLE_MIN_MS;
    await h.emit('session.compact', { trigger: 'auto', agentId: 'sub-1', messages: [] });
    await h.emit('turn.start', { turnId: 'T2', text: 'more' });
    await h.emit('session.compact', { trigger: 'auto', messages: [] });
    assert.deepEqual(h.calls.engineCompact, ['auto', 'auto', 'auto']);
    assert.equal(h.w.cycle, null);
  });

  it('never touches manual, plugin or precompute compactions', async () => {
    const h = harness();
    await idle(h);
    for (const trigger of ['manual', 'plugin', 'precompute']) {
      await h.emit('session.compact', { trigger, messages: [] });
    }
    assert.deepEqual(h.calls.engineCompact, ['manual', 'plugin', 'precompute']);
    assert.equal(h.w.cycle, null);
  });

  it('lets the compaction through before any turn ended in this process', async () => {
    const h = harness();
    await h.emit('session.compact', { trigger: 'auto', messages: [] });
    assert.deepEqual(h.calls.engineCompact, ['auto']);
    assert.equal(h.w.cycle, null);
  });
});

describe('checkpoint-watch engine: silence timer', () => {
  const idleOn = (mode = 'checkpoint', minutes = 30) => ({ cahCheckpointIdle: { mode, minutes } });
  // One finished answer; the context is below the 90% threshold.
  async function answer(h, turnId = 'T1') {
    h.percent = 40;
    await h.emit('turn.start', { turnId, text: 'explain' });
    await h.emit('turn.complete', { turnId, reason: 'answer' });
    await h.flush(0);
  }

  it('starts the cycle after the configured minutes of silence, then resumes and commits', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn('commit', 20), user: {} };
    await answer(h);
    assert.equal(h.silenceTimers(20).length, 1);
    await h.fireSilence(20);
    const name = h.w.cycle.name;
    assert.equal(h.w.cycle.trigger, 'idle');
    assert.deepEqual(h.calls.abort, []);
    assert.deepEqual(h.calls.command, [{ command: 'checkpoint', args: name }]);
    await runCheckpointTurn(h, name);
    assert.deepEqual(h.calls.compact, [{ instructions: COMPACT_INSTRUCTIONS }]);
    assert.deepEqual(h.calls.command.at(-1), { command: 'resume', args: name });
    await h.emit('turn.start', { turnId: 'T4', text: `/resume ${name}` });
    await h.flush(0);
    assert.equal(h.w.cycle, null);
    assert.ok(h.calls.process.some((argv) => argv.includes('commit')));
    await h.emit('turn.complete', { turnId: 'T4', reason: 'answer' });
    await h.flush(0);
    assert.equal(h.silenceTimers(20).filter((t) => !t.done).length, 1, 'it is armed again after /resume');
  });

  it('arms nothing without a setting', async () => {
    const h = harness({ mode: 'checkpoint' });
    await answer(h);
    assert.deepEqual(h.silenceTimers(30), []);
    assert.equal(h.w.idleTimer, null);
  });

  it('a new turn resets the timer, and a stale timer does nothing', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn(), user: {} };
    await answer(h);
    const first = h.silenceTimers(30)[0];
    await h.emit('turn.start', { turnId: 'T2', text: 'more' });
    assert.equal(first.done, true, 'the new turn cancels it');
    first.fn();
    await h.flush(0);
    assert.equal(h.w.cycle, null, 'a cancelled timer that still runs is ignored');
    await h.emit('turn.complete', { turnId: 'T2', reason: 'answer' });
    await h.flush(0);
    assert.equal(h.silenceTimers(30).filter((t) => !t.done).length, 1);
  });

  it('needs 200k tokens (inclusive) and no running turn', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn(), user: {} };
    await answer(h);
    h.tokens = IDLE_MIN_TOKENS - 1;
    await h.fireSilence(30);
    assert.equal(h.w.cycle, null, 'one token short');
    await answer(h, 'T2');
    h.tokens = IDLE_MIN_TOKENS;
    h.w.mainTurn = 'T9';
    await h.fireSilence(30);
    assert.equal(h.w.cycle, null, 'a turn is running');
    h.w.mainTurn = null;
    await answer(h, 'T3');
    await h.fireSilence(30);
    assert.equal(h.w.cycle.trigger, 'idle', 'exactly 200k is enough');
  });

  it('does nothing outside a Git repository', async () => {
    const h = harness({
      mode: null,
      git: (argv) => (argv.includes('--show-toplevel') && !argv.includes('--git-common-dir')
        ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : defaultGit(argv)),
    });
    h.bySource = { local: {}, user: idleOn() };
    await answer(h);
    await h.fireSilence(30);
    assert.equal(h.w.cycle, null);
    assert.deepEqual(h.calls.command, []);
  });

  it('the project setting wins over the user one, and a project off mutes it', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn('checkpoint', 15), user: idleOn('commit', 40) };
    await answer(h);
    assert.equal(h.silenceTimers(15).length, 1);
    assert.deepEqual(h.silenceTimers(40), []);

    const g = harness({ mode: null });
    g.bySource = { local: {}, user: idleOn('commit', 40) };
    await answer(g);
    assert.equal(g.silenceTimers(40).length, 1, 'the user setting applies where the project says nothing');

    const m = harness({ mode: null });
    m.bySource = { local: { cahCheckpointIdle: { mode: 'off' } }, user: idleOn('commit', 40) };
    await answer(m);
    assert.deepEqual(m.silenceTimers(40), []);
    assert.equal(m.w.idleTimer, null);
  });

  it('reads the setting again when the timer runs out', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn(), user: {} };
    await answer(h);
    h.bySource = { local: { cahCheckpointIdle: { mode: 'off' } }, user: {} };
    await h.fireSilence(30);
    assert.equal(h.w.cycle, null);
  });

  it('a failed silence cycle blocks the next one until the context shrinks', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn(), user: {} };
    await answer(h);
    await h.fireSilence(30);
    assert.equal(h.w.cycle.trigger, 'idle');
    await h.emit('command.run', { command: 'checkpoint-watch-cancel', args: '' });
    assert.equal(h.w.cycle, null);
    assert.equal(h.w.idleBlocked, true);
    const commands = h.calls.command.length;
    await answer(h, 'T5');
    await h.fireSilence(30);
    assert.equal(h.calls.command.length, commands, 'blocked: no second cycle');
    h.tokens = 10_000;
    await answer(h, 'T6');
    await h.fireSilence(30);
    assert.equal(h.w.idleBlocked, false, 'a small context lifts the block');
    h.tokens = 300_000;
    await answer(h, 'T7');
    await h.fireSilence(30);
    assert.equal(h.calls.command.length, commands + 1);
  });

  it('the threshold cycle keeps working beside it and disarms the timer', async () => {
    const h = harness({ mode: 'checkpoint' });
    h.bySource = { local: { ...h.settings, ...idleOn() }, user: {} };
    await answer(h);
    const timer = h.silenceTimers(30)[0];
    h.percent = 95;
    await h.emit('turn.start', { turnId: 'T2', text: 'work' });
    await h.emit('tool.call', { tool: 'Bash' });
    await h.flush(0);
    assert.equal(h.w.cycle.trigger, 'threshold');
    assert.equal(timer.done, true);
  });

  it('vetoes Claude Code\'s idle compaction for a project that only has the silence setting', async () => {
    const h = harness({ mode: null });
    h.bySource = { local: idleOn('commit'), user: {} };
    await answer(h);
    h.w.lastTurnEnd = Date.now() - IDLE_MIN_MS;
    const out = await h.emit('session.compact', { trigger: 'auto', messages: [] });
    assert.deepEqual(out, { skip: IDLE_SKIP_REASON });
    assert.equal(h.w.cycle.mode, 'commit');
    assert.equal(h.w.cycle.trigger, 'idle');
  });

  it('idleOf: nothing, off, a mode, clamped minutes', () => {
    assert.equal(idleOf({}), undefined);
    assert.equal(idleOf({ cahCheckpointIdle: 'yes' }), undefined);
    assert.equal(idleOf({ cahCheckpointIdle: { mode: 'sometimes' } }), undefined);
    assert.equal(idleOf({ cahCheckpointIdle: { mode: 'off', minutes: 10 } }), null);
    assert.deepEqual(idleOf({ cahCheckpointIdle: { mode: 'commit' } }), { mode: 'commit', minutes: 30 });
    assert.deepEqual(idleOf({ cahCheckpointIdle: { mode: 'checkpoint', minutes: 2 } }), { mode: 'checkpoint', minutes: 5 });
    assert.deepEqual(idleOf({ cahCheckpointIdle: { mode: 'checkpoint', minutes: 99 } }), { mode: 'checkpoint', minutes: 50 });
    assert.deepEqual(idleOf({ cahCheckpointIdle: { mode: 'checkpoint', minutes: '25' } }), { mode: 'checkpoint', minutes: 25 });
  });
});

describe('checkpoint-watch engine: the full cycle', () => {
  it('holds wake-ups, compacts, writes Held events, commits and resumes', async () => {
    const h = harness({ mode: 'commit' });
    await h.emit('turn.start', { turnId: 'T1', text: 'work' });
    // Typed while T1 runs: queued before the hold began.
    await h.emit('prompt.submit', { text: 'typed mid-turn', turnId: 'T1', origin: { kind: 'composer' }, wait: false });
    await h.emit('tool.call', { tool: 'Bash' });
    await h.flush(0);
    const name = h.w.cycle.name;

    const dropped = await h.emit('prompt.submit', { text: 'background task done', origin: { kind: 'task-notification' }, wait: false });
    assert.deepEqual(dropped, { drop: DROP_REASON });
    const own = await h.emit('prompt.submit', {
      text: `/checkpoint ${name}`, origin: { kind: 'plugin', name: PLUGIN }, command: { name: 'checkpoint', args: name }, wait: false,
    });
    assert.equal(own.text, `/checkpoint ${name}`);

    // The queued prompt starts a turn of its own: stopped and recorded.
    await h.emit('turn.start', { turnId: 'T2', text: 'typed mid-turn' });
    assert.deepEqual(h.calls.abort, ['T1', 'T2']);
    await h.emit('turn.complete', { turnId: 'T2', reason: 'aborted' });

    await runCheckpointTurn(h, name);
    assert.deepEqual(h.calls.compact, [{ instructions: COMPACT_INSTRUCTIONS }]);
    assert.deepEqual(h.calls.command.at(-1), { command: 'resume', args: name });

    const late = await h.emit('prompt.submit', { text: 'late tick', origin: { kind: 'scheduled-trigger' }, isMeta: true, wait: false });
    assert.deepEqual(late, { drop: DROP_REASON });

    await h.emit('turn.start', { turnId: 'T4', text: `<command-name>/resume</command-name>\n<command-args>${name}</command-args>` });
    assert.equal(h.w.cycle, null);
    const saved = h.files[`/repo/docs/checkpoints/${name}.md`];
    assert.match(saved, /^# Checkpoint\n\n## Session summary\nwork\n\n## Held events\n/);
    assert.match(saved, /### 1\. \d{2}:\d{2}:\d{2} · task notification\n\n```text\nbackground task done\n```/);
    assert.match(saved, /### 2\. \d{2}:\d{2}:\d{2} · user message\n\n```text\ntyped mid-turn\n```/);
    assert.match(saved, /### 3\. \d{2}:\d{2}:\d{2} · scheduled trigger\n\n```text\nlate tick\n```/);

    await h.flush(0);
    const spec = `:(top)docs/checkpoints/${name}.md`;
    assert.deepEqual(h.calls.process.find((argv) => argv.includes('commit')),
      ['git', '-C', '/repo', 'commit', '--only', '-m', `checkpoint: ${name}`, '--', spec]);
    assert.ok(h.calls.log.some((line) => line.includes(`checkpoint ${name}: committed abc1234`)));

    const after = await h.emit('prompt.submit', { text: 'hello', origin: { kind: 'composer' }, wait: false });
    assert.equal(after.text, 'hello');
    assert.ok(h.timers[0].done, 'the cycle time limit is cancelled');
  });

  it('checkpoint mode never runs git commit, and no held events leave the file alone', async () => {
    const h = harness();
    const name = await startCycle(h);
    await runCheckpointTurn(h, name);
    await h.emit('turn.start', { turnId: 'T4', text: `/resume ${name}` });
    await h.flush(0);
    assert.equal(h.files[`/repo/docs/checkpoints/${name}.md`], '# Checkpoint\n\n## Session summary\nwork\n');
    assert.equal(h.calls.process.some((argv) => argv.includes('commit')), false);
  });

  it('an ignored docs/checkpoints/ is reported, never force-added', async () => {
    const git = (argv) => (argv.includes('check-ignore') ? { exitCode: 0, stdout: '', stderr: '' } : defaultGit(argv));
    const h = harness({ mode: 'commit', git });
    const name = await startCycle(h);
    await runCheckpointTurn(h, name);
    await h.emit('turn.start', { turnId: 'T4', text: `/resume ${name}` });
    await h.flush(0);
    assert.equal(h.calls.process.some((argv) => argv.includes('add')), false);
    assert.ok(h.calls.log.some((line) => line.includes('not committed: docs/checkpoints/ is ignored')));
  });

  it('a host that keeps refusing $.session.compact gets the /compact command, then /resume', async () => {
    const h = harness();
    h.compact = async () => { throw new Error('not supported here'); };
    const name = await startCycle(h);
    await runCheckpointTurn(h, name);
    await h.flush(COMPACT_RETRY_MS);
    assert.equal(h.calls.compact.length, COMPACT_TRIES);
    assert.deepEqual(h.calls.command.slice(-2), [
      { command: 'compact', args: COMPACT_INSTRUCTIONS },
      { command: 'resume', args: name },
    ]);
  });
});

describe('checkpoint-watch engine: a cycle that stops', () => {
  it('an interrupted checkpoint turn stops the hold and sends the held events back', async () => {
    const h = harness();
    const name = await startCycle(h);
    await h.emit('prompt.submit', { text: 'are you there?', origin: { kind: 'composer' }, wait: false });
    await h.emit('turn.start', { turnId: 'T3', text: `/checkpoint ${name}` });
    await h.emit('turn.complete', { turnId: 'T3', reason: 'aborted' });
    assert.equal(h.w.cycle, null);
    assert.equal(h.calls.submit.length, 1);
    assert.match(h.calls.submit[0], /^checkpoint-watch stopped \(the checkpoint turn ended: aborted\)/);
    assert.match(h.calls.submit[0], /user message\n\n```text\nare you there\?\n```/);
    assert.equal(h.calls.compact.length, 0);
  });

  it('after a stop it waits for the context to drop below the threshold', async () => {
    const h = harness();
    const name = await startCycle(h);
    await h.emit('command.run', { command: 'checkpoint-watch-cancel', args: '' });
    assert.equal(h.w.cycle, null);
    await h.emit('turn.start', { turnId: 'T5', text: 'more' });
    await h.emit('tool.call', { tool: 'Bash' });
    assert.equal(h.w.cycle, null, 'no new cycle at the same fill');
    h.percent = 40;
    await h.emit('tool.call', { tool: 'Bash' });
    h.percent = 95;
    await h.emit('tool.call', { tool: 'Bash' });
    assert.ok(h.w.cycle && h.w.cycle.name >= name);
  });

  it('a checkpoint that was not written stops the cycle before any compaction', async () => {
    const h = harness();
    const name = await startCycle(h);
    await runCheckpointTurn(h, name, { write: false });
    assert.equal(h.w.cycle, null);
    assert.equal(h.calls.compact.length, 0);
    assert.ok(h.calls.log.some((line) => line.includes(`the checkpoint ${name}.md was not written`)));
  });

  it('a skipped compaction stops the cycle', async () => {
    const h = harness();
    h.compact = async () => ({ skip: 'blocked by a PreCompact hook' });
    const name = await startCycle(h);
    await runCheckpointTurn(h, name);
    assert.equal(h.w.cycle, null);
    assert.ok(h.calls.log.some((line) => line.includes('compaction skipped: blocked by a PreCompact hook')));
  });

  it('the time limit stops a cycle that never finishes', async () => {
    const h = harness();
    await startCycle(h);
    await h.flush(LIMIT_MS);
    assert.equal(h.w.cycle, null);
    assert.ok(h.calls.log.some((line) => line.includes('no result after 1 minutes')));
  });

  it('the cancel command answers when no cycle runs', async () => {
    const h = harness();
    const out = await h.emit('command.run', { command: 'checkpoint-watch-cancel', args: '' });
    assert.deepEqual(out, { text: 'checkpoint-watch: no cycle is running' });
  });
});

describe('checkpoint-watch engine: /checkpoint-now', () => {
  it('registers both commands when the session starts', async () => {
    const registered = [];
    const hooks = {};
    registerCheckpointWatch((event, matcher, hook) => { hooks[event] ??= hook ?? matcher; });
    const $ = { command: { register: async (spec) => registered.push(spec.name) } };
    await hooks['session.start']($, {}, async (x) => x);
    assert.deepEqual(registered, ['checkpoint-watch-cancel', 'checkpoint-now', 'ccheckpoint-now']);
  });

  it('runs checkpoint, compact, resume at once, with the watch off and a small context', async () => {
    const h = harness({ mode: null, percent: 5 });
    const out = await h.emit('command.run', { command: 'checkpoint-now', args: '' });
    const name = h.w.cycle.name;
    assert.match(name, /^now-\d{4}-\d{2}-\d{2}-\d{6}$/);
    assert.match(out.text, new RegExp(name));
    await h.flush(0);
    assert.deepEqual(h.calls.abort, []);
    assert.deepEqual(h.calls.command, [{ command: 'checkpoint', args: name }]);
    await runCheckpointTurn(h, name);
    assert.deepEqual(h.calls.compact, [{ instructions: COMPACT_INSTRUCTIONS }]);
    assert.deepEqual(h.calls.command.at(-1), { command: 'resume', args: name });
    await h.emit('turn.start', { turnId: 'T4', text: `/resume ${name}` });
    await h.flush(0);
    assert.equal(h.w.cycle, null);
    assert.equal(h.calls.process.some((argv) => argv.includes('commit')), false, 'no commit step');
  });

  it('/ccheckpoint-now commits the checkpoint file after the compaction', async () => {
    const h = harness({ mode: null, percent: 5 });
    await h.emit('command.run', { command: 'ccheckpoint-now', args: '' });
    const name = h.w.cycle.name;
    await h.flush(0);
    await runCheckpointTurn(h, name);
    await h.emit('turn.start', { turnId: 'T4', text: `/resume ${name}` });
    await h.flush(0);
    assert.ok(h.calls.process.some((argv) => argv.includes('commit')));
    assert.ok(h.calls.log.some((line) => line.includes(`checkpoint ${name}: committed abc1234`)));
  });

  it('holds prompts that arrive while it runs, like the other cycles', async () => {
    const h = harness({ mode: null, percent: 5 });
    await h.emit('command.run', { command: 'checkpoint-now', args: '' });
    const out = await h.emit('prompt.submit', { text: 'and also this', origin: { kind: 'composer' } });
    assert.deepEqual(out, { drop: DROP_REASON });
    assert.equal(h.w.cycle.held.length, 1);
  });

  it('refuses outside a Git repository and while a cycle runs', async () => {
    const h = harness({ mode: null, git: () => ({ exitCode: 128, stdout: '', stderr: 'fatal' }) });
    const outside = await h.emit('command.run', { command: 'checkpoint-now', args: '' });
    assert.match(outside.text, /not a Git repository/);
    assert.equal(h.w.cycle, null);
    const g = harness({ mode: null });
    await g.emit('command.run', { command: 'checkpoint-now', args: '' });
    const again = await g.emit('command.run', { command: 'ccheckpoint-now', args: '' });
    assert.match(again.text, /already running/);
  });

  it('a failed run does not hold back the 90% cycle', async () => {
    const h = harness({ percent: 5 });
    await h.emit('command.run', { command: 'checkpoint-now', args: '' });
    await h.flush(LIMIT_MS);
    assert.equal(h.w.cycle, null);
    assert.equal(h.w.suppressed, false);
  });
});

describe('checkpoint-watch engine: helpers', () => {
  it('names checkpoints by local date and time', () => {
    assert.equal(checkpointName(new Date(2026, 10, 11, 9, 5, 7).getTime()), 'watch-2026-11-11-090507');
  });

  it('fences each event longer than any backtick run inside it and cuts huge texts', () => {
    const out = renderEvents([{ time: '10:00:00', label: 'user message', text: 'run ````js x````' }]);
    assert.match(out, /^### 1\. 10:00:00 · user message\n\n`{5}text\nrun ````js x````\n`{5}\n/);
    const big = renderEvents([{ time: 't', label: 'l', text: 'x'.repeat(HELD_TEXT_LIMIT + 7) }]);
    assert.match(big, /\[7 more characters cut\]/);
    assert.match(heldSection([]), /^## Held events\n/);
  });

  it('takes a turn for the cycle\'s own by the checkpoint name, or by the command tag', () => {
    const c = { name: 'watch-2026-11-11-090507' };
    assert.equal(ownTurn(c, '/checkpoint watch-2026-11-11-090507', 'checkpoint'), true);
    assert.equal(ownTurn(c, '<command-name>/checkpoint</command-name>', 'checkpoint'), true);
    assert.equal(ownTurn(c, '<command-name>/checkpoint</command-name>', 'resume'), false);
    assert.equal(ownTurn(c, 'something else', 'resume'), false);
    assert.equal(ownTurn(c, undefined, 'resume'), false);
  });

  it('finds the checkpoint in the main folder, or in the worktree', async () => {
    const files = {};
    const $ = {
      process: { run: async () => ({ exitCode: 0, stdout: '/wt\n/repo/.git/worktrees/wt\n/repo/.git\n' }) },
      fs: { exists: async (path) => path in files },
    };
    assert.equal(await findCheckpoint($, 'n'), null);
    files['/wt/docs/checkpoints/n.md'] = '';
    assert.deepEqual(await findCheckpoint($, 'n'), { folder: '/wt', path: '/wt/docs/checkpoints/n.md' });
    files['/repo/docs/checkpoints/n.md'] = '';
    assert.deepEqual(await findCheckpoint($, 'n'), { folder: '/repo', path: '/repo/docs/checkpoints/n.md' });
  });
});

describe('checkpoint-watch settings (lib/checkpoint-watch.js)', () => {
  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'cah-watch-'));
    return {
      dir,
      paths: { localPath: join(dir, '.claude', 'settings.local.json'), projectPath: join(dir, '.claude', 'settings.json') },
    };
  }
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

  it('enables, switches mode, and disables in settings.local.json only', () => {
    const { paths } = project();
    assert.deepEqual(updateWatch(paths, 'enable', { mode: 'checkpoint' }), { local: 'enabled', legacy: null });
    assert.deepEqual(read(paths.localPath), { cahCheckpointWatch: { mode: 'checkpoint' } });
    assert.equal(existsSync(paths.projectPath), false);
    assert.equal(updateWatch(paths, 'enable', { mode: 'checkpoint' }).local, 'already-enabled');
    assert.equal(updateWatch(paths, 'enable', { mode: 'commit' }).local, 'updated');
    assert.deepEqual(readWatchState(paths), { mode: 'commit', legacyHook: false });
    assert.equal(updateWatch(paths, 'disable').local, 'disabled');
    assert.deepEqual(read(paths.localPath), {});
    assert.equal(updateWatch(paths, 'disable').local, 'not-enabled');
  });

  it('keeps other keys and never creates a file to disable', () => {
    const { paths } = project();
    assert.equal(updateWatch(paths, 'disable').local, 'not-enabled');
    assert.equal(existsSync(paths.localPath), false);
    mkdirSync(dirname(paths.localPath), { recursive: true });
    writeFileSync(paths.localPath, '{\n    "permissions": { "allow": ["Bash(ls)"] }\n}\n');
    updateWatch(paths, 'enable', { mode: 'commit' });
    const text = readFileSync(paths.localPath, 'utf8');
    assert.match(text, /^\{\n {4}"permissions"/, 'the file keeps its indent');
    assert.deepEqual(JSON.parse(text).permissions, { allow: ['Bash(ls)'] });
  });

  it('removes the legacy Stop hint hook and leaves foreign hooks alone', () => {
    const { paths } = project();
    mkdirSync(dirname(paths.projectPath), { recursive: true });
    const foreign = { type: 'command', command: 'echo hi' };
    const legacy = { type: 'command', command: 'node hint.js', 'cah-sentinel': 'cah-hook:v1', 'cah-name': 'checkpoint-watch' };
    writeFileSync(paths.projectPath, JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [foreign, legacy] }, { matcher: '', hooks: [legacy] }] },
    }));
    assert.equal(readWatchState(paths).legacyHook, true);
    assert.deepEqual(updateWatch(paths, 'enable', { mode: 'checkpoint' }), { local: 'enabled', legacy: 'removed' });
    assert.deepEqual(read(paths.projectPath), { hooks: { Stop: [{ matcher: '', hooks: [foreign] }] } });
    assert.equal(updateWatch(paths, 'disable').legacy, null);
  });

  it('refuses invalid JSON and writes nothing', () => {
    const { paths } = project();
    mkdirSync(dirname(paths.localPath), { recursive: true });
    writeFileSync(paths.localPath, '{ broken');
    assert.throws(() => updateWatch(paths, 'enable', { mode: 'checkpoint' }), WatchSettingsError);
    assert.equal(readFileSync(paths.localPath, 'utf8'), '{ broken');
    assert.throws(() => updateWatch(paths, 'enable', { mode: 'sometimes' }), /unknown checkpoint-watch mode/);
  });
});

describe('cah checkpoint-watch', () => {
  function run(home, ...args) {
    return spawnSync(process.execPath, [cli, 'checkpoint-watch', ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  }

  it('refuses a folder outside a Git repository', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-watch-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'cah-watch-nogit-'));
    const r = run(home, 'on', '--cwd', dir);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not inside a Git repository/);
    assert.equal(existsSync(join(dir, '.claude')), false);
  });

  it('turns the cycle on with --commit, reports status, and turns it off', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-watch-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'cah-watch-repo-'));
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    const on = run(home, 'on', '--commit', '--cwd', dir);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /: enabled \(mode commit\)/);
    assert.match(on.stdout, /the mod is missing; run `cah install --only checkpoint-watch`/);
    const status = run(home, 'status', '--cwd', dir);
    assert.match(status.stdout, /enabled, mode commit/);
    assert.match(status.stdout, /mod: missing/);
    assert.equal(run(home, 'off', '--commit', '--cwd', dir).status, 2);
    const off = run(home, 'off', '--cwd', dir);
    assert.match(off.stdout, /: disabled/);
  });
});
