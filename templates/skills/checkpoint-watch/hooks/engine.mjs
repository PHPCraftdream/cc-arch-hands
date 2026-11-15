// checkpoint-watch engine: once the main loop's context reaches the threshold
// in a project that enabled it, stop the agent, run /checkpoint, compact the
// session, then /resume the checkpoint. Every prompt that would wake the
// session meanwhile is held (dropped) and written into the checkpoint.
// The agent is stopped by refusing its further tool calls until its turn ends,
// not by $.turn.abort: after a plugin's abort Claude Code refuses the plugin's
// next $.command.run until someone types. The cycle in flight is kept in
// $.state, so a hot reload of the mod picks it up again.
// The same cycle also starts after N minutes of silence (`cahCheckpointIdle`,
// local file over user file) once the context holds at least 200k tokens.
// Pure logic: all I/O goes through the `$` each hook receives. Claude Code's
// validator follows `$` only into top-level functions, so the engine state `w`
// is passed explicitly instead of closed over.

export const SETTINGS_KEY = 'cahCheckpointWatch';
export const MODES = Object.freeze(['checkpoint', 'commit']);
export const THRESHOLD = 90;
export const CANCEL_COMMAND = 'checkpoint-watch-cancel';
// The mod's slash commands that run the cycle on demand, whatever the on/off settings say.
export const NOW_COMMANDS = Object.freeze({ 'checkpoint-now': 'checkpoint', 'ccheckpoint-now': 'commit' });
export const CYCLE_LIMIT_MS = 20 * 60_000;
export const COMPACT_TRIES = 10;
export const COMPACT_RETRY_MS = 2000;
export const HELD_TEXT_LIMIT = 50_000;
// A failed cycle is tried again at the next check after RETRY_MS, up to MAX_FAILS
// failures in a row; then it waits for the context to drop below the threshold.
export const RETRY_MS = 60_000;
export const MAX_FAILS = 3;
// Claude Code refuses a plugin's $.command.run after a stop (the user's Esc, an abort).
const NO_INPUT = /nobody has sent input|session was stopped/i;
// Refused tool calls of a turn that should end; past this, the turn is aborted.
export const MAX_DENIES = 8;
// The watch mode is read at most this often on tool calls.
const MODE_TTL_MS = 30_000;
// A plain literal: the validator reads $.state references from the source.
const CYCLE_STATE = { plugin: 'cah-checkpoint-watch', key: 'cycle' };
const PHASES = Object.freeze(['stopping', 'queued', 'checkpointing', 'compacting', 'resuming']);
// A context below this share of its size at the start of the compaction means it happened.
const COMPACTED_RATIO = 0.6;
const ACTIVITY_STATE = { plugin: 'cah-checkpoint-watch', key: 'activity' };
export const HOLD_REASON = 'checkpoint-watch: this message arrived while a checkpoint is being saved; it is '
  + 'recorded and comes back after the compaction. Do not act on it now: reply with one short line and end the turn.';
export function stopReason(threshold) {
  return `checkpoint-watch: the context reached ${threshold}%. Do not call more tools: end this turn now with `
    + 'a one-line status of what you were doing. The session then saves a checkpoint, compacts and resumes from it.';
}
const REFUSED = 'was refused as a command and as a prompt';
// The user's own prompt: it lifts the stop that made Claude Code refuse the mod's commands.
const PERSON = Object.freeze(['composer', 'bridge']);
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

export function checkpointName(ms, prefix = 'watch') {
  const d = new Date(ms);
  return `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-`
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
    // After a cancelled cycle, wait for the context to drop below the threshold.
    suppressed: false,
    // Failures in a row; MAX_FAILS of them wait for a smaller context too.
    failures: 0,
    retryAt: 0,
    // The last failure was the host refusing to run the command: the user's next prompt lifts that.
    refused: false,
    // Held events whose prompt the host refused: they go with the next prompt, as its context.
    undelivered: [],
    // The watch mode as last read ({ mode, at }).
    modeCache: null,
  };
}

function newCycle(fields) {
  // `drain`: a cycle picked up after a reload asked for /checkpoint while a turn may still run;
  // that turn's tool calls stay refused until the host runs the command.
  return { held: [], ownTurn: null, waitTurn: null, denies: 0, stray: new Set(), file: null, drain: false, ...fields };
}

// The cycle as $.state keeps it: JSON only, no timers. `savedAt` is when it was
// written, `tokens` the context size when its compaction began (a reload tells
// from it whether that compaction already happened).
function snapshot(c) {
  return {
    name: c.name, mode: c.mode, trigger: c.trigger, phase: c.phase, held: c.held,
    tokens: c.tokens ?? null, savedAt: Date.now(),
  };
}

function persist(w, $) {
  try { $.state.set(CYCLE_STATE, w.cycle ? snapshot(w.cycle) : null).catch(() => {}); } catch { /* no state on this host */ }
}

// The running main turn and when the last one ended: without them a reload
// would take Claude Code's idle compaction for a threshold one and let it pass.
function persistActivity(w, $) {
  try {
    $.state.set(ACTIVITY_STATE, { mainTurn: w.mainTurn, lastTurnEnd: w.lastTurnEnd }).catch(() => {});
  } catch { /* no state on this host */ }
}

export async function restoreActivity(w, $) {
  let saved;
  try { saved = (await $.state.get(ACTIVITY_STATE)).value; } catch { return; }
  if (!saved || w.mainTurn !== null || w.lastTurnEnd !== null) return;
  w.mainTurn = typeof saved.mainTurn === 'string' ? saved.mainTurn : null;
  w.lastTurnEnd = Number.isFinite(saved.lastTurnEnd) ? saved.lastTurnEnd : null;
  if (w.mainTurn === null && w.lastTurnEnd !== null) await armIdle(w, $, Date.now() - w.lastTurnEnd);
}

async function savedCycle($) {
  try { return (await $.state.get(CYCLE_STATE)).value ?? null; } catch { return null; }
}

// After a hot reload the module starts over: take the cycle up where it was.
export async function restoreCycle(w, $) {
  const saved = await savedCycle($);
  if (!saved || w.cycle) return;
  const fresh = Number.isFinite(saved.savedAt) && Date.now() - saved.savedAt < w.limitMs;
  const valid = typeof saved.name === 'string' && MODES.includes(saved.mode) && PHASES.includes(saved.phase);
  if (!fresh || !valid) {
    // Left over from a session that ended, or not ours: forget it.
    await $.state.set(CYCLE_STATE, null).catch(() => {});
    return;
  }
  const c = newCycle({
    name: saved.name, mode: saved.mode, trigger: saved.trigger ?? 'threshold', phase: saved.phase,
    held: Array.isArray(saved.held) ? saved.held : [],
    tokens: Number.isFinite(saved.tokens) ? saved.tokens : null,
  });
  w.cycle = c;
  armLimit(w, $, c);
  say($, `reloaded during checkpoint ${c.name} (${c.phase}); picking it up`);
  // The host does not run the older instance's pending waits: a step it had queued is ours to redo,
  // unless the world shows it already happened.
  if (c.phase === 'queued' || c.phase === 'compacting' || c.phase === 'resuming') {
    c.file = await findCheckpoint($, c.name);
    if (w.cycle !== c) return;
    if (!c.file) {
      // /checkpoint may not have run yet (queued): ask again; any other phase cannot go on without it.
      if (c.phase === 'queued') later(w, $, 0, c, () => slash($, 'checkpoint', c.name));
      else fail(w, $, `the checkpoint ${c.name}.md was not written`, c);
      persist(w, $);
      return;
    }
    if (c.phase === 'queued') c.phase = 'compacting';
    if (c.phase === 'compacting' && await compactionDone(w, $, c)) c.phase = 'resuming';
    if (w.cycle !== c) return;
    if (c.phase === 'compacting') later(w, $, 0, c, () => compact(w, $, c, 1));
    else later(w, $, 0, c, () => slash($, 'resume', c.name));
  }
  if (c.phase === 'stopping') {
    // The turn it waited for may have ended in the gap, and its end would never be seen. The
    // host runs a command once the session is idle, so ask for /checkpoint now: it waits for
    // that turn if it still runs (whose tool calls stay refused), and runs at once if not.
    c.phase = 'queued';
    c.drain = true;
    later(w, $, 0, c, () => slash($, 'checkpoint', c.name));
  }
  // 'checkpointing' waits for the turn that is running; its id is unknown now.
  persist(w, $);
}

// A compaction that began before a reload has happened if the context is now well below its size then.
async function compactionDone(w, $, c) {
  if (!Number.isFinite(c.tokens)) return false;
  try {
    const tokens = (await $.session.usage()).context?.tokens;
    return typeof tokens === 'number' && tokens < c.tokens * COMPACTED_RATIO;
  } catch { return false; }
}

function armLimit(w, $, c) {
  const minutes = Math.round(w.limitMs / 60_000);
  c.timer = $.clock.after(w.limitMs, () => fail(w, $, `no result after ${minutes} minutes`, c));
}

// The answer to a main-loop tool call while a cycle waits for a turn to end, or null.
export function denyFor(w, $) {
  const c = w.cycle;
  if (!c) return null;
  const turn = w.mainTurn;
  let reason = null;
  if (c.phase === 'stopping' && (c.waitTurn === null || turn === c.waitTurn)) reason = stopReason(w.threshold);
  else if (turn !== null && c.stray.has(turn)) reason = HOLD_REASON;
  else if (c.drain && c.phase === 'queued' && turn !== null) reason = stopReason(w.threshold);
  if (!reason) return null;
  c.denies += 1;
  if (c.denies === MAX_DENIES && turn !== null) $.turn.abort({ turnId: turn }).catch(() => {});
  return { deny: reason };
}

async function watchMode(w, $) {
  const now = Date.now();
  if (w.modeCache && now - w.modeCache.at < MODE_TTL_MS) return w.modeCache.mode;
  const mode = modeOf(await $.settings.read({ source: 'local' }));
  w.modeCache = { mode, at: now };
  return mode;
}

// Runs a slash command; a host that refuses it after a stop (Esc, an abort) gets the same text as a prompt.
async function slash($, command, args) {
  try {
    return await $.command.run({ command, args });
  } catch (error) {
    if (!NO_INPUT.test(String(error?.message ?? error))) throw error;
    const sent = await $.prompt.submit({ text: `/${command} ${args}` });
    if (sent?.drop) throw new Error(`/${command} ${REFUSED}: ${sent.drop}`);
    return sent;
  }
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

function fail(w, $, reason, c, cancelled = false) {
  if (!c || w.cycle !== c) return;
  w.cycle = null;
  c.timer?.cancel?.();
  persist(w, $);
  let after = '';
  if (c.trigger !== 'manual') {
    w.failures += 1;
    w.refused = !cancelled && reason.includes(REFUSED);
    if (cancelled) w.suppressed = true;
    if (cancelled || w.failures >= MAX_FAILS) {
      after = `; not trying again until the context drops below ${w.threshold}%`
        + (w.refused ? ' or you send a message' : '');
    } else {
      w.retryAt = Date.now() + RETRY_MS;
      after = `; trying again in ${Math.round(RETRY_MS / 1000)} s`;
    }
  }
  if (c.trigger === 'idle') w.idleBlocked = true;
  say($, `stopped: ${reason}${after}`);
  if (c.held.length === 0) return;
  const text = `checkpoint-watch stopped (${reason}). These events arrived while it ran and `
    + `never reached you; act on them now:\n\n${renderEvents(c.held)}`;
  $.prompt.submit({ text }).then(
    (sent) => { if (sent?.drop) keep(w, $, text, sent.drop); },
    (error) => keep(w, $, text, describe(error)),
  );
}

// The host refused the prompt that carries the held events: nothing sends them again but us.
function keep(w, $, text, why) {
  w.undelivered.push(text);
  say($, `the held events were not delivered (${firstLine(why)}); they go with the next prompt`);
}

// `waitTurn`: the running main turn ends first (its tool calls are refused meanwhile).
function start(w, $, mode, waitTurn, why = `context reached ${w.threshold}%`, trigger = 'threshold') {
  disarmIdle(w);
  const waiting = waitTurn && w.mainTurn !== null;
  const c = newCycle({
    phase: waiting ? 'stopping' : 'queued',
    name: checkpointName(Date.now(), trigger === 'manual' ? 'now' : 'watch'),
    mode,
    trigger,
    waitTurn: waiting ? w.mainTurn : null,
  });
  w.cycle = c;
  armLimit(w, $, c);
  say($, waiting ? `${why}: ending this turn, then saving checkpoint ${c.name} and compacting`
    : `${why}: saving checkpoint ${c.name}, then compacting`);
  if (!waiting) later(w, $, 0, c, () => slash($, 'checkpoint', c.name));
  persist(w, $);
}

// `inTurn`: called from a tool call of a running main turn.
export async function check(w, $, inTurn) {
  if (w.cycle) return;
  let mode;
  try { mode = await watchMode(w, $); } catch { return; }
  if (!mode) return;
  let percent;
  try { percent = (await $.session.usage()).context?.percent; } catch { return; }
  if (typeof percent !== 'number') return;
  if (percent < w.threshold) { w.suppressed = false; w.failures = 0; w.refused = false; return; }
  if (w.suppressed || w.failures >= MAX_FAILS || w.cycle || Date.now() < w.retryAt) return;
  start(w, $, mode, inTurn);
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

// /checkpoint-now and /ccheckpoint-now: the whole cycle at once, whatever the
// context size, inside a Git repository; a running cycle is left alone.
export async function runNow(w, $, mode) {
  const busy = { text: 'checkpoint-watch: a cycle is already running' };
  if (w.cycle) return busy;
  if (!(await inGitRepo($))) return { text: 'checkpoint-watch: not a Git repository, nothing to checkpoint into' };
  if (w.cycle) return busy;
  start(w, $, mode, false, 'asked by the user', 'manual');
  return { text: `checkpoint-watch: saving checkpoint ${w.cycle.name}, then compacting and resuming` };
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
// `silentMs`: silence already passed (a reload re-arms it for the rest).
export async function armIdle(w, $, silentMs = 0) {
  disarmIdle(w);
  const seq = w.idleSeq;
  const config = await idleConfig($);
  if (!config || seq !== w.idleSeq || w.cycle || w.mainTurn !== null) return;
  const timer = $.clock.after(Math.max(0, config.minutes * 60_000 - silentMs), () => {
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
    // The size before the compaction: a reload uses it to tell whether the compaction happened
    // (a cycle picked up after a reload keeps the size saved before it).
    if (!Number.isFinite(c.tokens)) {
      try { c.tokens = (await $.session.usage()).context?.tokens ?? null; } catch { c.tokens = null; }
    }
    if (w.cycle !== c) return;
    persist(w, $);
  } else if (await compactionDone(w, $, c)) {
    // A retry after a refusal: the first compaction may have finished meanwhile. (Whether a host
    // still compacting refuses or queues a second call is not documented: a queued one is not caught.)
    if (w.cycle !== c) return;
    c.phase = 'resuming';
    persist(w, $);
    later(w, $, 0, c, () => slash($, 'resume', c.name));
    return;
  }
  if (w.cycle !== c) return;
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
    persist(w, $);
    later(w, $, 0, c, () => slash($, 'compact', COMPACT_INSTRUCTIONS));
    later(w, $, 0, c, () => slash($, 'resume', c.name));
    return;
  }
  if (w.cycle !== c) return;
  if (result?.skip) { fail(w, $, `compaction skipped: ${result.skip}`, c); return; }
  c.phase = 'resuming';
  persist(w, $);
  later(w, $, 0, c, () => slash($, 'resume', c.name));
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
  w.failures = 0;
  c.timer?.cancel?.();
  persist(w, $);
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
// least the command with no other argument, should the turn text leave the
// arguments out. `/checkpoint other-name` typed by the user is not ours.
export function ownTurn(c, text, command) {
  if (typeof text !== 'string') return false;
  if (text.includes(c.name)) return true;
  if (!text.includes(`<command-name>/${command}</command-name>`)) return false;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  return !args || args[1].trim() === '';
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
    for (const [name, mode] of Object.entries(NOW_COMMANDS)) {
      await $.command.register({
        name,
        description: mode === 'commit'
          ? 'checkpoint, compact and resume now, then commit the checkpoint file (checkpoint-watch mod)'
          : 'checkpoint, compact and resume now (checkpoint-watch mod)',
      }).catch(() => {});
    }
    await restoreActivity(w, $).catch(() => {});
    await restoreCycle(w, $).catch(() => {});
    return next(e);
  });

  on('command.run', { command: 'checkpoint-now' }, ($) => runNow(w, $, NOW_COMMANDS['checkpoint-now']));
  on('command.run', { command: 'ccheckpoint-now' }, ($) => runNow(w, $, NOW_COMMANDS['ccheckpoint-now']));

  on('command.run', { command: 'checkpoint-watch-cancel' }, async ($) => {
    if (!w.cycle) return { text: 'checkpoint-watch: no cycle is running' };
    fail(w, $, `cancelled by /${CANCEL_COMMAND}`, w.cycle, true);
    return { text: 'checkpoint-watch: cycle cancelled' };
  });

  on('prompt.submit', async ($, e, next) => {
    const c = w.cycle;
    if (!c) {
      rememberQueued(w, e);
      if (w.refused && PERSON.includes(e.origin?.kind)) { w.refused = false; w.failures = 0; w.retryAt = 0; }
      if (w.undelivered.length === 0) return next(e);
      const kept = w.undelivered.splice(0);
      const result = await next({ ...e, context: [...(e.context ?? []), ...kept] });
      if (result?.drop) w.undelivered.unshift(...kept);
      return result;
    }
    if (e.command?.name === CANCEL_COMMAND) return next(e);
    if (e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name) return next(e);
    hold(c, e.origin?.kind, e.text, e.origin?.name);
    persist(w, $);
    return { drop: DROP_REASON };
  });

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    w.mainTurn = e.turnId;
    persistActivity(w, $);
    disarmIdle(w);
    const c = w.cycle;
    if (c) {
      if (ownTurn(c, e.text, 'checkpoint') && (c.phase === 'stopping' || c.phase === 'queued')) {
        c.phase = 'checkpointing';
        c.ownTurn = e.turnId;
      } else if (ownTurn(c, e.text, 'resume') && c.phase === 'resuming') {
        await finish(w, $, c);
      } else if (c.phase !== 'checkpointing' && c.phase !== 'stopping') {
        // A prompt queued before the hold began starts its own turn: recorded,
        // and its tool calls are refused so it ends at once.
        const origin = w.queued.get(e.text);
        hold(c, origin?.kind ?? 'queued', e.text, origin?.name);
        c.stray.add(e.turnId);
      }
      persist(w, $);
    }
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const refused = denyFor(w, $);
      if (refused) return refused;
    }
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
    persistActivity(w, $);
    const c = w.cycle;
    // After a reload the turn ids are unknown (null): the next main turn to end is the one.
    const isTurn = (id) => id === null || e.turnId === id;
    if (c) c.stray.delete(e.turnId);
    if (c && c.phase === 'stopping' && isTurn(c.waitTurn)) {
      // The turn that reached the threshold ended (an answer, the user's Esc, our fallback abort).
      c.phase = 'queued';
      persist(w, $);
      later(w, $, 0, c, () => slash($, 'checkpoint', c.name));
    } else if (c && c.phase === 'checkpointing' && isTurn(c.ownTurn)) {
      if (e.reason !== 'answer') fail(w, $, `the checkpoint turn ended: ${e.reason}`, c);
      else {
        c.phase = 'compacting';
        persist(w, $);
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
