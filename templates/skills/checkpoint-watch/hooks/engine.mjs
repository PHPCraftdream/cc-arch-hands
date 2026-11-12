// checkpoint-watch engine: once the main loop's context reaches the threshold
// in a project that enabled it, stop the agent, run /checkpoint, compact the
// session, then /resume the checkpoint. Every prompt that would wake the
// session meanwhile is held (dropped) and written into the checkpoint.
// The same cycle also starts after N minutes of silence (`cahCheckpointIdle`,
// local file over user file) once the context holds at least 200k tokens.
// Pure logic: all I/O goes through the `$` each hook receives. Claude Code's
// validator follows `$` only into top-level functions, so the engine state `w`
// is passed explicitly instead of closed over.

export const SETTINGS_KEY = 'cahCheckpointWatch';
export const MODES = Object.freeze(['checkpoint', 'commit']);
export const THRESHOLD = 90;
export const CANCEL_COMMAND = 'checkpoint-watch-cancel';
export const CYCLE_LIMIT_MS = 20 * 60_000;
export const COMPACT_TRIES = 10;
export const COMPACT_RETRY_MS = 2000;
export const HELD_TEXT_LIMIT = 50_000;
// Claude Code's idle compaction fires ~54 min after the last turn (90% of the
// 1 h cache TTL) and reaches mods as trigger `auto`, like the threshold one.
export const IDLE_MIN_MS = 30 * 60_000;
export const IDLE_SKIP_REASON = 'checkpoint-watch: saving a checkpoint first; the session compacts right after it';
export const IDLE_KEY = 'cahCheckpointIdle';
export const IDLE_DEFAULT_MINUTES = 30;
export const IDLE_MIN_MINUTES = 5;
// Under Claude Code's own idle compaction (~54 min), so the checkpoint comes first.
export const IDLE_MAX_MINUTES = 50;
// Claude Code's own floor for compacting an idle session.
export const IDLE_MIN_TOKENS = 200_000;
const QUEUED_MEMORY = 50;
// No checkpoint name in here: a turn that names it is taken for the cycle's own.
export const COMPACT_INSTRUCTIONS = 'cah checkpoint-watch: the session state was just saved to a checkpoint '
  + 'that is restored right after this compaction; keep the summary brief.';
export const DROP_REASON = 'checkpoint-watch: held while the checkpoint is saved; it is written into the checkpoint';

const ORIGIN_LABELS = Object.freeze({
  composer: 'user message',
  bridge: 'user message (remote)',
  'task-notification': 'task notification',
  'scheduled-trigger': 'scheduled trigger',
  peer: 'peer message',
  'peer-send-message': 'peer message',
  channel: 'channel message',
  queued: 'queued prompt',
});

export function modeOf(settings) {
  const mode = settings?.[SETTINGS_KEY]?.mode;
  return MODES.includes(mode) ? mode : null;
}

// undefined: the file says nothing about it (the next one decides);
// null: switched off; else { mode, minutes }.
export function idleOf(settings) {
  const value = settings?.[IDLE_KEY];
  if (!value || typeof value !== 'object') return undefined;
  if (value.mode === 'off') return null;
  if (!MODES.includes(value.mode)) return undefined;
  const asked = value.minutes === null || value.minutes === '' ? NaN : Math.round(Number(value.minutes));
  const minutes = Number.isFinite(asked)
    ? Math.min(IDLE_MAX_MINUTES, Math.max(IDLE_MIN_MINUTES, asked)) : IDLE_DEFAULT_MINUTES;
  return { mode: value.mode, minutes };
}

// The project's local file wins over the user's: a local `off` switches a global setting off.
export async function idleConfig($) {
  for (const source of ['local', 'user']) {
    let settings;
    try { settings = await $.settings.read({ source }); } catch { continue; }
    const found = idleOf(settings);
    if (found !== undefined) return found;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

export function checkpointName(ms) {
  const d = new Date(ms);
  return `watch-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function originLabel(kind, name) {
  if (kind === 'plugin') return `plugin ${name ?? '?'}`;
  return ORIGIN_LABELS[kind] ?? kind ?? 'unclassified';
}

function longestBacktickRun(text) {
  let best = 0;
  for (const run of text.match(/`+/g) ?? []) best = Math.max(best, run.length);
  return best;
}

export function renderEvents(events) {
  const lines = [];
  events.forEach((event, i) => {
    let text = event.text;
    if (text.length > HELD_TEXT_LIMIT) {
      text = `${text.slice(0, HELD_TEXT_LIMIT)}\n[${text.length - HELD_TEXT_LIMIT} more characters cut]`;
    }
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
    lines.push(`### ${i + 1}. ${event.time} · ${event.label}`, '', `${fence}text`, text, fence, '');
  });
  return lines.join('\n');
}

export function heldSection(events) {
  return ['## Held events', '',
    'checkpoint-watch held these while it saved this checkpoint and compacted the session; '
      + 'none of them reached the session.', '',
    renderEvents(events)].join('\n');
}

function describe(error) {
  return String(error?.message ?? error).split('\n')[0];
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] || 'unknown error';
}

function parentDir(path) {
  return path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
}

// The checkpoint skill writes into the repository's main folder, or into the
// worktree when the session is confined to it.
export async function findCheckpoint($, name) {
  const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute',
    '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (r.exitCode !== 0) return null;
  const [top, gitDir, common] = r.stdout.trim().split(/\r?\n/);
  if (!top || !gitDir || !common) return null;
  const main = gitDir === common ? top : parentDir(common);
  for (const folder of [...new Set([main, top])]) {
    const path = `${folder}/docs/checkpoints/${name}.md`;
    if (await $.fs.exists(path)) return { folder, path };
  }
  return null;
}

export async function commitCheckpoint($, folder, name) {
  const rel = `docs/checkpoints/${name}.md`;
  const ignored = await $.process.run(['git', '-C', folder, 'check-ignore', '-q', '--', rel]);
  if (ignored.exitCode === 0) return 'not committed: docs/checkpoints/ is ignored';
  const spec = `:(top)${rel}`;
  const add = await $.process.run(['git', '-C', folder, 'add', '--', spec]);
  if (add.exitCode !== 0) return `not committed: ${firstLine(add.stderr)}`;
  const commit = await $.process.run(['git', '-C', folder, 'commit', '--only', '-m', `checkpoint: ${name}`, '--', spec]);
  if (commit.exitCode !== 0) return `not committed: ${firstLine(commit.stderr || commit.stdout)}`;
  const head = await $.process.run(['git', '-C', folder, 'rev-parse', '--short', 'HEAD']);
  return `committed ${head.stdout.trim()}`;
}

export function createWatchState({ threshold = THRESHOLD, limitMs = CYCLE_LIMIT_MS, idleMs = IDLE_MIN_MS } = {}) {
  return {
    threshold,
    limitMs,
    idleMs,
    mainTurn: null,
    // When the last main-loop turn ended; null until one ends in this process.
    lastTurnEnd: null,
    // The silence timer; idleSeq voids a timer whose settings read is still pending.
    idleTimer: null,
    idleSeq: 0,
    // A cycle that the silence timer started failed: no new one until the context shrinks.
    idleBlocked: false,
    cycle: null,
    // Prompts queued behind a running turn, by text: a held turn they start gets their origin.
    queued: new Map(),
    // After a stopped cycle, wait for the context to drop below the threshold.
    suppressed: false,
  };
}

function say($, text) {
  try { $.ui.log(`checkpoint-watch: ${text}`); } catch { /* no transcript */ }
  try { $.ui.toast(`checkpoint-watch: ${text}`); } catch { /* no surface */ }
}

function later(w, $, ms, c, fn) {
  $.clock.after(ms, () => {
    if (w.cycle !== c) return;
    Promise.resolve().then(fn).catch((error) => fail(w, $, describe(error), c));
  });
}

function hold(c, kind, text, name) {
  if (!text || !text.trim()) return;
  c.held.push({ time: clock(Date.now()), label: originLabel(kind, name), text });
}

function fail(w, $, reason, c) {
  if (!c || w.cycle !== c) return;
  w.cycle = null;
  c.timer?.cancel?.();
  w.suppressed = true;
  if (c.trigger === 'idle') w.idleBlocked = true;
  say($, `stopped: ${reason}`);
  if (c.held.length === 0) return;
  const text = `checkpoint-watch stopped (${reason}). These events arrived while it ran and `
    + `never reached you; act on them now:\n\n${renderEvents(c.held)}`;
  $.prompt.submit({ text }).catch(() => {});
}

function start(w, $, mode, abortTurn, why = `context reached ${w.threshold}%`, trigger = 'threshold') {
  disarmIdle(w);
  const c = {
    phase: abortTurn ? 'stopping' : 'queued',
    name: checkpointName(Date.now()),
    mode,
    trigger,
    held: [],
    ownTurn: null,
    file: null,
  };
  w.cycle = c;
  const minutes = Math.round(w.limitMs / 60_000);
  c.timer = $.clock.after(w.limitMs, () => fail(w, $, `no result after ${minutes} minutes`, c));
  say($, `${why}: saving checkpoint ${c.name}, then compacting`);
  if (abortTurn && w.mainTurn) $.turn.abort({ turnId: w.mainTurn }).catch(() => {});
  later(w, $, 0, c, () => $.command.run({ command: 'checkpoint', args: c.name }));
}

export async function check(w, $, abortTurn) {
  if (w.cycle) return;
  let percent;
  try { percent = (await $.session.usage()).context?.percent; } catch { return; }
  if (typeof percent !== 'number') return;
  if (percent < w.threshold) { w.suppressed = false; return; }
  if (w.suppressed || w.cycle) return;
  let mode;
  try { mode = modeOf(await $.settings.read({ source: 'local' })); } catch { return; }
  if (!mode || w.cycle) return;
  start(w, $, mode, abortTurn);
}

// The session sat idle with no turn running: an `auto` compaction now is
// Claude Code's idle one, not the threshold one that runs inside a turn.
export function idleNow(w, now = Date.now()) {
  return w.mainTurn === null && w.lastTurnEnd !== null && now - w.lastTurnEnd >= w.idleMs;
}

// Idle compaction in a project that turned the watch on: veto it and run the
// cycle instead, whose own compaction (trigger `plugin`) follows the checkpoint.
export async function idleCompact(w, $, e, next) {
  if (e.agentId !== undefined || w.cycle || w.idleBlocked || !idleNow(w)) return next(e);
  let mode;
  try {
    mode = modeOf(await $.settings.read({ source: 'local' })) ?? (await idleConfig($))?.mode ?? null;
  } catch { return next(e); }
  if (!mode || w.cycle || !idleNow(w)) return next(e);
  start(w, $, mode, false, 'idle compaction is due', 'idle');
  return { skip: IDLE_SKIP_REASON };
}

function disarmIdle(w) {
  w.idleSeq += 1;
  w.idleTimer?.cancel?.();
  w.idleTimer = null;
}

async function inGitRepo($) {
  try { return (await $.process.run(['git', 'rev-parse', '--show-toplevel'])).exitCode === 0; } catch { return false; }
}

// Armed when a main-loop turn ends; the next turn or a cycle disarms it.
export async function armIdle(w, $) {
  disarmIdle(w);
  const seq = w.idleSeq;
  const config = await idleConfig($);
  if (!config || seq !== w.idleSeq || w.cycle || w.mainTurn !== null) return;
  const timer = $.clock.after(config.minutes * 60_000, () => {
    Promise.resolve().then(() => idleFire(w, $, timer)).catch(() => {});
  });
  w.idleTimer = timer;
}

async function idleFire(w, $, timer) {
  if (w.idleTimer !== timer) return;
  w.idleTimer = null;
  const config = await idleConfig($);
  if (!config || w.cycle || w.mainTurn !== null) return;
  let tokens;
  try { tokens = (await $.session.usage()).context?.tokens; } catch { return; }
  if (typeof tokens !== 'number' || tokens < IDLE_MIN_TOKENS) { w.idleBlocked = false; return; }
  if (w.idleBlocked || !(await inGitRepo($))) return;
  if (w.cycle || w.mainTurn !== null) return;
  start(w, $, config.mode, false, `silent for ${config.minutes} min`, 'idle');
}

async function compact(w, $, c, attempt) {
  if (attempt === 1) {
    c.file = await findCheckpoint($, c.name);
    if (w.cycle !== c) return;
    if (!c.file) { fail(w, $, `the checkpoint ${c.name}.md was not written`, c); return; }
  }
  let result;
  try {
    result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS });
  } catch {
    if (w.cycle !== c) return;
    if (attempt < COMPACT_TRIES) {
      later(w, $, COMPACT_RETRY_MS, c, () => compact(w, $, c, attempt + 1));
      return;
    }
    // A host that refuses the call (desktop, SDK) still runs the command.
    c.phase = 'resuming';
    later(w, $, 0, c, () => $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS }));
    later(w, $, 0, c, () => $.command.run({ command: 'resume', args: c.name }));
    return;
  }
  if (w.cycle !== c) return;
  if (result?.skip) { fail(w, $, `compaction skipped: ${result.skip}`, c); return; }
  c.phase = 'resuming';
  later(w, $, 0, c, () => $.command.run({ command: 'resume', args: c.name }));
}

function commitLater($, c) {
  $.clock.after(0, () => {
    commitCheckpoint($, c.file.folder, c.name)
      .catch((error) => `not committed: ${describe(error)}`)
      .then((outcome) => say($, `checkpoint ${c.name}: ${outcome}`));
  });
}

// Runs as the /resume turn starts, before the model reads the checkpoint.
async function finish(w, $, c) {
  w.cycle = null;
  w.idleBlocked = false;
  c.timer?.cancel?.();
  const notes = [];
  if (c.held.length) {
    try {
      const text = await $.fs.read(c.file.path);
      await $.fs.write(c.file.path, `${text.replace(/\s*$/, '')}\n\n${heldSection(c.held)}`);
      notes.push(`${c.held.length} held event(s) written into it`);
    } catch (error) {
      notes.push(`held events not written: ${describe(error)}`);
    }
  }
  if (c.mode === 'commit') commitLater($, c);
  say($, `checkpoint ${c.name} saved${notes.length ? `; ${notes.join('; ')}` : ''}`);
}

// The cycle's own /checkpoint or /resume turn: it names the checkpoint, or at
// least the command, should the turn text leave the arguments out.
export function ownTurn(c, text, command) {
  if (typeof text !== 'string') return false;
  return text.includes(c.name) || text.includes(`<command-name>/${command}</command-name>`);
}

function rememberQueued(w, e) {
  if (!e.turnId || typeof e.text !== 'string') return;
  w.queued.delete(e.text);
  w.queued.set(e.text, { kind: e.origin?.kind, name: e.origin?.name });
  if (w.queued.size > QUEUED_MEMORY) w.queued.delete(w.queued.keys().next().value);
}

// Registers the hooks on `on`; returns the state, so tests can inspect it.
export function registerCheckpointWatch(on, options = {}) {
  const w = createWatchState(options);

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checkpoint-watch-cancel',
      description: 'checkpoint-watch: stop a running checkpoint/compact cycle and deliver what it held',
      immediate: true,
    }).catch(() => {});
    return next(e);
  });

  on('command.run', { command: 'checkpoint-watch-cancel' }, async ($) => {
    if (!w.cycle) return { text: 'checkpoint-watch: no cycle is running' };
    fail(w, $, `cancelled by /${CANCEL_COMMAND}`, w.cycle);
    return { text: 'checkpoint-watch: cycle cancelled' };
  });

  on('prompt.submit', async ($, e, next) => {
    const c = w.cycle;
    if (!c) rememberQueued(w, e);
    if (!c || e.command?.name === CANCEL_COMMAND) return next(e);
    if (e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name) return next(e);
    hold(c, e.origin?.kind, e.text, e.origin?.name);
    return { drop: DROP_REASON };
  });

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    w.mainTurn = e.turnId;
    disarmIdle(w);
    const c = w.cycle;
    let stray = false;
    if (c) {
      if (ownTurn(c, e.text, 'checkpoint') && (c.phase === 'stopping' || c.phase === 'queued')) {
        c.phase = 'checkpointing';
        c.ownTurn = e.turnId;
      } else if (ownTurn(c, e.text, 'resume') && c.phase === 'resuming') {
        await finish(w, $, c);
      } else if (c.phase !== 'checkpointing') {
        // A prompt queued before the hold began starts its own turn.
        const origin = w.queued.get(e.text);
        hold(c, origin?.kind ?? 'queued', e.text, origin?.name);
        stray = true;
      }
    }
    const result = await next(e);
    if (stray) $.turn.abort({ turnId: e.turnId }).catch(() => {});
    return result;
  });

  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && !w.cycle) await check(w, $, true).catch(() => {});
    return result;
  });

  on('session.compact', { trigger: 'auto' }, ($, e, next) => idleCompact(w, $, e, next));

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    if (e.turnId === w.mainTurn) w.mainTurn = null;
    w.lastTurnEnd = Date.now();
    const c = w.cycle;
    if (c && c.phase === 'checkpointing' && e.turnId === c.ownTurn) {
      if (e.reason !== 'answer') fail(w, $, `the checkpoint turn ended: ${e.reason}`, c);
      else {
        c.phase = 'compacting';
        later(w, $, 500, c, () => compact(w, $, c, 1));
      }
    } else if (!c && e.reason === 'answer') {
      check(w, $, false).catch(() => {});
    }
    if (!w.cycle) armIdle(w, $).catch(() => {});
    return result;
  });

  return w;
}
