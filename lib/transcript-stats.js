// transcript-stats.js — shared helpers for reading session transcript JSONL
// and formatting the HH:MM · model · X% status line.
// Used by cah-checkpoint-hint, cah-status, and cah-stamp.

import {
  readFileSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  opendirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { FUTURE_SKEW_TOLERANCE_MS } from './lease-clock.js';
import { lstatMaybe } from './fs-atomic-identity.js';
import {
  removeOwnedRegularFile,
  captureRegularFileSnapshot,
  regularFileIdentity,
  writeFileAtomic,
} from './fsutil.js';

// Transcript files can grow without bound. Scan only a bounded reverse window
// and read it in chunks so a hook never falls back to materialising the file.
// The limits are deliberately explicit: a request with unusually many records
// or a line larger than this window returns the fields observed so far.
const REVERSE_CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_RECORDS = 10_000;

const OPUS_FABLE_LIMIT = 1_000_000;
const SONNET_HAIKU_LIMIT = 200_000;

// rate_limits state captured by cah-status and read by cah-stamp. Quota slots
// are session-scoped so a Codex session cannot inherit another session's 5h cap.
// Stale beyond this many ms — ignored.
const RATE_LIMITS_MAX_AGE_MS = 60 * 60 * 1000;
const STATUSLINE_RATE_FALLBACK_MAX_AGE_MS = 5 * 60 * 1000;
const RATE_CONTEXT_MAX_SESSIONS = 64;
const RATE_CONTEXT_PREFIX = '.context-';
const RATE_CONTEXT_NAMESPACE = 'rate-context';
const RATE_CONTEXT_NAME_RE = /^[a-f0-9]{64}\.json$/;
// The namespace is owned by this cache family. Keep routine status renders
// bounded even if a damaged/shared cache has accumulated many leaves.
const RATE_CONTEXT_VISIT_LIMIT = 256;

// Effort level → short code that matches the slash-command suffix convention
// (/sl, /sm, /sh, /sx, /sxx). Rendered in brackets after the model name:
// "Opus 4.7 [xx]". Unknown levels yield null and are simply omitted.
const EFFORT_SHORT = Object.freeze({
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'x',
  max: 'xx',
});

export function effortCode(level) {
  if (typeof level !== 'string') return null;
  const v = level.toLowerCase();
  return EFFORT_SHORT[v] || null;
}

// ---------------------------------------------------------------------------
// Documented transcript envelope fields
// ---------------------------------------------------------------------------

function contextTokensFromUsage(usage) {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  // Context-window usage per official Anthropic API:
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  // After the first turn most tokens are in cache_read, so input_tokens alone
  // (often 1) is NOT the size of the loaded context.
  // Reference: code.claude.com/docs/en/statusline.
  const hasInput = typeof usage.input_tokens === 'number';
  const hasCacheCreation = typeof usage.cache_creation_input_tokens === 'number';
  const hasCacheRead = typeof usage.cache_read_input_tokens === 'number';
  if (!hasInput && !hasCacheCreation && !hasCacheRead) return null;
  return (hasInput ? usage.input_tokens : 0)
    + (hasCacheCreation ? usage.cache_creation_input_tokens : 0)
    + (hasCacheRead ? usage.cache_read_input_tokens : 0);
}

// Контекст последней message-итерации, а не суммарный расход ответа.
function lastContextIteration(usage) {
  const total = contextTokensFromUsage(usage);
  if (!Number.isFinite(total) || total <= 0 || !Array.isArray(usage.iterations)) return usage;
  for (let i = usage.iterations.length - 1; i >= 0; i--) {
    const iteration = usage.iterations[i];
    if (iteration?.type === 'advisor_message' || iteration?.type === 'compaction') continue;
    if ((iteration?.type === 'message' || iteration?.type === 'fallback_message')
        && ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
          .every((key) => Number.isFinite(iteration[key]) && iteration[key] >= 0)
        && contextTokensFromUsage(iteration) > 0) return iteration;
    return usage;
  }
  return usage;
}

// Нулевой placeholder не заменяет подтверждённый usage; старые ходы не читаем.
export function statusContextUsage(contextWindow) {
  const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const total = contextWindow?.total_input_tokens;
  const usage = lastContextIteration(contextWindow?.current_usage);
  let current = null;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    if (fields.some((key) => valid(usage[key]))
        && fields.every((key) => usage[key] == null || valid(usage[key]))) {
      current = contextTokensFromUsage(usage);
    }
  }
  if (valid(total) && total > 0) return total;
  if (valid(current) && current > 0) return current;
  return null;
}

function modelIdFromValue(model) {
  if (typeof model === 'string' && model) return model;
  // The documented envelope can carry the model descriptor as { id }.
  if (model && typeof model === 'object' && !Array.isArray(model)
    && typeof model.id === 'string' && model.id) {
    return model.id;
  }
  return null;
}

function entryStats(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { usedTokens: null, modelId: null };
  }

  // Claude's transcript envelope uses message.usage/message.model. Older
  // supported transcript records put those same fields at the top level.
  // These are intentionally direct lookups: content, tool_use.input, and any
  // other arbitrary nested JSON are not transcript envelopes.
  const message = obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)
    ? obj.message
    : null;
  const messageTokens = message ? contextTokensFromUsage(message.usage) : null;
  const topLevelTokens = contextTokensFromUsage(obj.usage);
  const messageModel = message ? modelIdFromValue(message.model) : null;
  const topLevelModel = modelIdFromValue(obj.model);

  return {
    usedTokens: messageTokens !== null ? messageTokens : topLevelTokens,
    modelId: messageModel !== null ? messageModel : topLevelModel,
  };
}

// Per-turn API request id. Every assistant entry of the same turn (text +
// tool_use blocks) shares this `req_...` value, so it's the natural key for
// per-message dedup of the chat-stamp audit line. Top-level field only —
// no recursive search needed, no chance of capturing a tool result's req id.
function findRequestId(obj) {
  if (obj && typeof obj === 'object' && typeof obj.requestId === 'string' && obj.requestId) {
    return obj.requestId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a JSONL transcript from the end and return the newest assistant turn's
 * {usedTokens, modelId, requestId}, or null if the file is missing or that
 * assistant boundary has none of those direct envelope fields. Older turns
 * are never used to fill an unidentified content-only assistant entry.
 * requestId is the per-turn API request id, used by cah-stamp to dedupe
 * the chat audit line so the same turn never produces two stamps even when
 * many PostToolUse hooks fire across a long turn.
 */
export function readTranscriptStats(transcriptPath, options = {}) {
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    return scanTranscriptReverse(fd, size, options);
  } catch {
    if (options.diagnostics) options.diagnostics.reason = 'read_error';
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// Последнее измерение для statusLine; никогда не пересекает compaction.
export function readLastMeasuredContext(transcriptPath, modelId = null, diagnostics = null) {
  return readTranscriptStats(transcriptPath, { lastMeasuredContext: true, contextModelId: modelId, diagnostics });
}

// Retain measured envelopes across zero-usage streaming placeholders. Transcript
// checkpoints assume the JSONL writer appends; rotation/truncation is rejected.
export function statusMeasuredContext(cachePath, data, usedTokens, limit, diagnostics = null, nowMs = Date.now()) {
  const report = (reason, value = null) => {
    if (diagnostics) diagnostics.reason = reason;
    return value;
  };
  const sessionHash = rateQuotaSessionHash(data?.session_id);
  if (!sessionHash) return report('session_missing');
  const path = join(rateContextNamespace(cachePath, 'context-measured'), `${sessionHash}.json`);
  let snapshot;
  let cached;
  let fd;
  const publish = (value) => {
    try {
      writeFileAtomic(path, JSON.stringify({ kind: 'cah-measured-context:v1', ...value }) + '\n', {
        expectedDestination: snapshot.expectedDestination, waitForFence: false, mode: 0o600,
      });
    } catch { /* best effort */ }
  };
  const reject = (reason) => {
    if (snapshot?.present && cached?.kind === 'cah-measured-context:v1') {
      publish({ capturedAt: nowMs, usedTokens: null });
    }
    return report(reason);
  };
  try {
    const entry = lstatMaybe(path);
    if (entry && (!entry.isFile() || entry.size > 8192n)) return report('cache_invalid');
    snapshot = captureRegularFileSnapshot(path);
    if (snapshot.present) {
      try { cached = JSON.parse(snapshot.content.toString('utf8')); } catch { return report('cache_invalid'); }
      if (cached?.kind !== 'cah-measured-context:v1') return report('cache_invalid');
    }
    const model = traceModel(data?.model?.id);
    if (!model.hash) return reject('model_missing');
    if (typeof data?.transcript_path !== 'string' || !data.transcript_path) return reject('path_missing');
    if (validContextWindowSize(limit) === null) return reject('window_invalid');
    const transcriptHash = createHash('sha256').update(data.transcript_path).digest('hex');
    const measured = Number.isFinite(usedTokens) && usedTokens > 0;
    if (!measured) {
      if (!cached || !Number.isFinite(cached.usedTokens) || cached.usedTokens <= 0) return report('cache_missing');
      if (cached.sessionHash !== sessionHash) return reject('session_mismatch');
      if (cached.modelHash !== model.hash) return reject('model_mismatch');
      if (cached.transcriptHash !== transcriptHash || cached.limit !== limit) return reject('checkpoint_changed');
      if (!isFresh(cached.capturedAt, nowMs)) return reject('stale');
    }
    fd = openSync(data.transcript_path, 'r');
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return reject('read_error');
    const size = Number(before.size);
    const readAt = (offset, length) => {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, offset + read);
        if (!count) throw new Error('incomplete checkpoint');
        read += count;
      }
      return buffer;
    };
    const anchor = (offset) => {
      const bytes = readAt(Math.max(0, offset - 4096), Math.min(offset, 4096));
      return { hash: createHash('sha256').update(bytes).digest('hex'), complete: !offset || bytes.at(-1) === 10 };
    };
    if (!measured) {
      const checkpoint = cached.checkpoint;
      if (!checkpoint || checkpoint.dev !== String(before.dev) || checkpoint.ino !== String(before.ino)
          || !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0 || checkpoint.offset > size
          || (checkpoint.offset === size && checkpoint.mtimeNs !== String(before.mtimeNs))) return reject('checkpoint_changed');
      if (size - checkpoint.offset > MAX_SCAN_BYTES) return reject('byte_limit');
      if (anchor(checkpoint.offset).hash !== checkpoint.anchor) return reject('checkpoint_changed');
      const appended = readAt(checkpoint.offset, size - checkpoint.offset);
      if (appended.length && appended.at(-1) !== 10) return reject('incomplete_record');
      const lines = appended.toString('utf8').split('\n', MAX_SCAN_RECORDS + 2);
      if (lines.length - 1 > MAX_SCAN_RECORDS) return reject('record_limit');
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { return reject('incomplete_record'); }
        if (record?.isSidechain === true) continue;
        if (record?.type === 'system' && record.subtype === 'compact_boundary') return reject('compaction');
        if (isAssistantEntry(record)) {
          const recordModel = entryStats(record).modelId;
          if (recordModel && traceModel(recordModel).hash !== model.hash) return reject('model_mismatch');
        }
      }
    }
    const endAnchor = anchor(size);
    if (!endAnchor.complete) return reject('incomplete_record');
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return reject('checkpoint_changed');
    const observation = {
      sessionHash, modelHash: model.hash, transcriptHash, limit,
      usedTokens: measured ? usedTokens : cached.usedTokens,
      capturedAt: measured ? nowMs : cached.capturedAt,
      checkpoint: { dev: String(before.dev), ino: String(before.ino), offset: size,
        mtimeNs: String(before.mtimeNs), anchor: endAnchor.hash },
    };
    publish(observation);
    pruneRateContextSidecars(cachePath, nowMs, null, 'context-measured');
    return report(measured ? 'measured' : 'cached_measurement', observation.usedTokens);
  } catch {
    return reject('read_error');
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

const CONTEXT_TRACE_REASONS = new Set([
  'envelope', 'measured', 'window_invalid', 'model_missing', 'path_missing',
  'no_measurement', 'read_error', 'unknown_model', 'model_mismatch',
  'model_conflict', 'compaction', 'record_limit', 'byte_limit', 'render_error',
  'cached_measurement',
]);

const MEASURED_CACHE_REASONS = new Set([
  'session_missing', 'session_mismatch', 'model_missing', 'path_missing', 'window_invalid',
  'cache_invalid', 'cache_missing', 'model_mismatch', 'checkpoint_changed', 'stale',
  'read_error', 'byte_limit', 'record_limit', 'incomplete_record', 'compaction',
  'measured', 'cached_measurement',
]);

function contextTraceType(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function traceModel(modelId) {
  const present = typeof modelId === 'string' && modelId.length > 0;
  return {
    class: !present ? 'missing' : modelId.startsWith('claude-') ? 'claude' : 'other',
    hash: present ? createHash('sha256').update(`model:${modelId}`).digest('hex') : null,
  };
}

const QUOTA_TRACE_REASONS = new Set([
  'not_needed', 'not_attempted', 'cache', 'session_missing', 'model_missing',
  'model_not_claude', 'cache_missing', 'session_mismatch', 'slot_invalid',
  'capture_invalid', 'stale', 'reset_missing', 'reset_invalid', 'reset_elapsed', 'read_error',
]);

// Fixed allowlist: never serialize envelopes, model IDs, paths, or error text.
export function statusContextTraceRecord(data, state, nowMs = Date.now()) {
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const cw = data?.context_window;
  const usage = cw?.current_usage;
  const counters = {};
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
    counters[key] = numeric(usage?.[key]);
  }
  const quota = (key, decision) => {
    const input = data?.rate_limits?.[key];
    const used = numeric(decision?.used);
    const rendered = used !== null && used >= 0 && used <= 100 && state.reason !== 'render_error';
    return {
      inputType: contextTraceType(input),
      reason: state.reason === 'render_error' ? 'render_error'
        : rendered ? (decision?.source === 'cache' ? 'cache' : 'envelope')
          : key === 'five_hour' && QUOTA_TRACE_REASONS.has(decision?.fallback?.reason)
            ? decision.fallback.reason : input == null ? 'input_missing' : 'input_invalid',
      modelAllowed: key !== 'five_hour' || traceModel(data?.model?.id).class === 'claude',
      inputUsedPercentage: numeric(input?.used_percentage),
      inputResetType: contextTraceType(input?.resets_at),
      usedPercentage: used,
      rendered,
      source: ['envelope', 'cache', 'none'].includes(decision?.source) ? decision.source : 'none',
      fallbackReason: QUOTA_TRACE_REASONS.has(decision?.fallback?.reason)
        ? decision.fallback.reason : 'not_attempted',
      cacheAgeMs: numeric(decision?.fallback?.ageMs),
    };
  };
  const transcriptModel = state.scan?.model;
  return {
    kind: 'cah-context-trace:v1',
    version: 1,
    capturedAt: nowMs,
    sessionHash: rateQuotaSessionHash(data?.session_id),
    hasSessionId: typeof data?.session_id === 'string' && data.session_id.length > 0,
    rateLimitsType: contextTraceType(data?.rate_limits),
    rateExtractionFailed: state.rateExtractionFailed === true,
    contextType: contextTraceType(cw),
    usageType: contextTraceType(usage),
    hasModelId: typeof data?.model?.id === 'string' && data.model.id.length > 0,
    envelopeModel: traceModel(data?.model?.id),
    transcriptModel: {
      class: ['missing', 'claude', 'other'].includes(transcriptModel?.class) ? transcriptModel.class : 'missing',
      hash: typeof transcriptModel?.hash === 'string' && /^[a-f0-9]{64}$/.test(transcriptModel.hash)
        ? transcriptModel.hash : null,
    },
    modelsMatch: typeof state.scan?.modelsMatch === 'boolean' ? state.scan.modelsMatch : null,
    fiveHour: quota('five_hour', state.fiveHour),
    sevenDay: quota('seven_day', state.sevenDay),
    hasTranscriptPath: typeof data?.transcript_path === 'string' && data.transcript_path.length > 0,
    windowSize: numeric(cw?.context_window_size),
    totalInputTokens: numeric(cw?.total_input_tokens),
    usedPercentage: numeric(cw?.used_percentage),
    counters,
    usedTokens: numeric(state.usedTokens),
    limit: numeric(state.limit),
    contextRendered: numeric(state.usedTokens) !== null && state.usedTokens > 0
      && numeric(state.limit) !== null && state.limit > 0 && state.reason !== 'render_error',
    source: ['envelope', 'transcript', 'cache', 'none'].includes(state.source) ? state.source : 'none',
    measuredCacheReason: MEASURED_CACHE_REASONS.has(state.measuredCache?.reason)
      ? state.measuredCache.reason : null,
    reason: CONTEXT_TRACE_REASONS.has(state.reason) ? state.reason : 'render_error',
    scanRecords: numeric(state.scan?.records),
    scanBytes: numeric(state.scan?.bytes),
    elapsedMs: numeric(state.elapsedMs),
  };
}

// Eight session buckets of 32 minute slots; collisions remain last-writer-wins.
export function writeStatusContextTrace(directory, data, state, nowMs = Date.now()) {
  if (typeof directory !== 'string' || !directory) return false;
  try {
    const sessionHash = rateQuotaSessionHash(data?.session_id);
    const bucket = sessionHash ? Number.parseInt(sessionHash.slice(0, 2), 16) % 8 : 0;
    const slot = bucket * 32 + Math.floor(nowMs / 60_000) % 32;
    const path = join(directory, `context-${slot}.json`);
    const entry = lstatMaybe(path);
    if (entry && (!entry.isFile() || entry.size > 8192n)) return false;
    const snapshot = captureRegularFileSnapshot(path);
    if (snapshot.present && JSON.parse(snapshot.content.toString('utf8'))?.kind !== 'cah-context-trace:v1') return false;
    writeFileAtomic(path, JSON.stringify(statusContextTraceRecord(data, state, nowMs)) + '\n', {
      expectedDestination: snapshot.expectedDestination,
      waitForFence: false,
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function optionLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function scanTranscriptReverse(fd, size, options) {
  const chunkBytes = optionLimit(options.chunkBytes, REVERSE_CHUNK_BYTES);
  const maxBytes = optionLimit(options.maxBytes, MAX_SCAN_BYTES);
  const maxRecords = optionLimit(options.maxRecords, MAX_SCAN_RECORDS);
  const lowerBound = Math.max(0, size - maxBytes);
  let position = size;
  let partial = Buffer.alloc(0);
  let result = null;
  let measuredRequest = null;
  let records = 0;
  const diagnostics = options.lastMeasuredContext ? options.diagnostics : null;
  if (diagnostics) Object.assign(diagnostics, { reason: 'no_measurement', records: 0, bytes: 0 });
  const stop = (reason) => {
    if (diagnostics) diagnostics.reason = reason;
    return true;
  };
  const readChunk = (at, length) => {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buffer, offset, length - offset, at + offset);
      if (n === 0) break;
      offset += n;
    }
    if (diagnostics) diagnostics.bytes += offset;
    return offset === length ? buffer : buffer.subarray(0, offset);
  };

  const consume = (lineBytes) => {
    if (records >= maxRecords) return stop('record_limit');
    records += 1;
    if (diagnostics) diagnostics.records = records;
    const line = lineBytes.toString('utf8').trim();
    if (!line) return false;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return false;
    }

    if (options.lastMeasuredContext) {
      if (obj?.isSidechain === true) return false;
      if (obj?.type === 'system' && obj.subtype === 'compact_boundary') return stop('compaction');
    }

    // User entries contain tool results and never participate in the assistant
    // request boundary or its stats.
    if (!isAssistantEntry(obj)) return false;

    const entryRequestId = findRequestId(obj);
    const stats = entryStats(obj);
    if (options.lastMeasuredContext) {
      // Не переносим частичные поля через границу запроса.
      if (measuredRequest && entryRequestId !== measuredRequest.requestId) {
        if (!measuredRequest.modelId) return stop('unknown_model');
        measuredRequest = null;
      }
      if (diagnostics && stats.modelId) {
        diagnostics.model = traceModel(stats.modelId);
        diagnostics.modelsMatch = options.contextModelId ? stats.modelId === options.contextModelId : null;
      }
      if (stats.modelId && options.contextModelId && stats.modelId !== options.contextModelId) return stop('model_mismatch');
      const usedTokens = statusContextUsage({ current_usage: obj.message?.usage ?? obj.usage });
      if (entryRequestId === null) {
        if (!stats.modelId) return stop('unknown_model');
        if (usedTokens === null) return false;
        result = { ...stats, usedTokens, requestId: null };
        return stop('measured');
      }
      measuredRequest ??= { usedTokens: null, modelId: null, requestId: entryRequestId };
      if (stats.modelId !== null) {
        if (measuredRequest.modelId !== null && measuredRequest.modelId !== stats.modelId) return stop('model_conflict');
        measuredRequest.modelId = stats.modelId;
      }
      if (measuredRequest.usedTokens === null && usedTokens !== null) measuredRequest.usedTokens = usedTokens;
      if (measuredRequest.usedTokens === null || measuredRequest.modelId === null) return false;
      result = measuredRequest;
      return stop('measured');
    }

    if (result === null) {
      // A recognized assistant envelope is a turn boundary even when it is
      // anonymous and content-only. Non-message service records use distinct
      // top-level types and are filtered by isAssistantEntry; skipping an
      // actual assistant here would leak stale metrics from an older turn.
      if (entryRequestId === null && stats.usedTokens === null && stats.modelId === null) {
        return true;
      }
      result = {
        usedTokens: stats.usedTokens,
        modelId: stats.modelId,
        requestId: entryRequestId,
      };
      // An anonymous record cannot safely merge with any preceding record.
      return entryRequestId === null || (
        result.usedTokens !== null && result.modelId !== null
      );
    }

    // A different or unidentified assistant record proves that the preceding
    // record belongs to another turn. Never mix it into the current request.
    if (entryRequestId !== result.requestId) return true;
    if (result.usedTokens === null && stats.usedTokens !== null) result.usedTokens = stats.usedTokens;
    if (result.modelId === null && stats.modelId !== null) result.modelId = stats.modelId;
    return result.usedTokens !== null && result.modelId !== null;
  };

  while (position > lowerBound && records < maxRecords) {
    const length = Math.min(chunkBytes, position - lowerBound);
    position -= length;
    const chunk = readChunk(position, length);
    if (chunk.length === 0) {
      stop('read_error');
      break;
    }
    const data = partial.length === 0 ? chunk : Buffer.concat([chunk, partial]);
    let end = data.length;

    // Work backwards over complete newline-delimited records. The prefix left
    // before the oldest newline is carried into the next (earlier) chunk.
    while (end > 0 && records < maxRecords) {
      const newline = data.lastIndexOf(0x0a, end - 1);
      if (newline < 0) break;
      if (consume(data.subarray(newline + 1, end))) return result;
      end = newline;
    }
    partial = data.subarray(0, end);
  }

  // Only a scan that reached byte zero may treat the carried prefix as a full
  // line. At the max-byte boundary it is intentionally left unparsed.
  if (position === 0 && partial.length > 0 && records < maxRecords) {
    if (consume(partial)) return result;
  }
  if (diagnostics?.reason === 'read_error') return result;
  if (records >= maxRecords) stop('record_limit');
  else if (lowerBound > 0) stop('byte_limit');
  else if (measuredRequest && !measuredRequest.modelId) stop('unknown_model');
  return result;
}

function isAssistantEntry(obj) {
  if (!obj || typeof obj !== 'object' || obj.type === 'user') return false;
  if (obj.message && typeof obj.message === 'object' && obj.message.role === 'user') return false;
  if (obj.type === 'assistant') return true;
  if (obj.message && typeof obj.message === 'object' && obj.message.role === 'assistant') return true;
  if (obj.type != null) return false;
  const stats = entryStats(obj);
  return stats.usedTokens !== null || stats.modelId !== null;
}

/**
 * Return the context-window token limit for a given model id string.
 * Case-insensitive substring match: opus/fable → 1M, sonnet/haiku → 200k,
 * except the Sonnet 5 generation (claude-sonnet-5, claude-sonnet-5-5) and
 * Haiku 5.5 (claude-haiku-5-5), which are 1M.
 */
export function modelLimit(modelId) {
  const m = (modelId || '').toLowerCase();
  const disable1M = typeof process !== 'undefined'
    && process.env
    && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT !== '0'
    && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT.toLowerCase() !== 'false';
  if (!disable1M && (m.includes('sonnet-5') || m.includes('haiku-5'))) return OPUS_FABLE_LIMIT;
  if (!disable1M && (m.includes('opus') || m.includes('fable'))) return OPUS_FABLE_LIMIT;
  return SONNET_HAIKU_LIMIT;
}

export function validContextWindowSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// Claude Code принимает окно auto-compact только в диапазоне 100k..1M.
export function effectiveContextWindowSize(actualSize, compactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
  const limit = validContextWindowSize(actualSize);
  if (limit === null) return null;
  const raw = typeof compactWindow === 'string' ? compactWindow.trim() : '';
  const window = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(window) || window < 100_000 || window > 1_000_000) return limit;
  return Math.min(limit, window);
}

// An actual context_window_size from a valid Claude Code envelope or matching
// session cache takes precedence over model-name heuristics. The latter is
// only a fallback and therefore honors CLAUDE_CODE_DISABLE_1M_CONTEXT.
export function contextWindowLimit(modelId, actualSize = null) {
  return validContextWindowSize(actualSize) || modelLimit(modelId);
}

/**
 * Return the current time as "HH:MM" (24-hour, zero-padded).
 * Accepts an optional Date for test injection.
 */
export function currentHhMm(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Return the current time as "HH:MM:SS" (24-hour, zero-padded).
 * Used by cah-stamp so chat audit lines are precise enough to debug
 * throttling / hook-cadence issues.
 */
export function currentHhMmSs(date = new Date()) {
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${currentHhMm(date)}:${ss}`;
}

/**
 * Convert a raw model ID (e.g. "claude-opus-4-7") to a short display name
 * (e.g. "Opus 4.7"). Also handles display names that already have "Claude "
 * prefix (e.g. "Claude Opus 4.8" → "Opus 4.8") and plain display names
 * (e.g. "Opus 4.8" → "Opus 4.8").
 *
 * Conversion rules for raw model IDs (lowercase `claude-` prefix):
 *   claude-{family}-{major}-{minor} → {Family} {major}.{minor}
 *   claude-{family}-{major}         → {Family} {major}
 *   claude-{family}                 → {Family}
 * For display names with "Claude " prefix: strip the prefix.
 */
// Claude Code sometimes sends display names like "Opus 4.8 (1M context)" —
// that's redundant once the usage part is already rendering "(Nk/1M)" right
// next to the name, so drop any parenthetical that's purely a context-size
// annotation ("1M", "200k", "1M context", "context 1M", ...). Parens with
// any other content are left alone.
function stripContextSize(s) {
  return s
    .replace(/\s*\(([^()]*)\)/g, (m, inner) => {
      return /^(?:context\s+)?\d+(?:\.\d+)?\s*[kKmM]?\s*(?:context)?$/i.test(inner.trim()) ? '' : m;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function toDisplayName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = stripContextSize(raw.trim());
  if (!trimmed) return null;

  // Strip "Claude " prefix (capital C) — for pre-formatted display names
  if (trimmed.startsWith('Claude ')) return trimmed.slice(7) || null;

  // Convert raw model ID: "claude-opus-4-7" → "Opus 4.7"
  // Pattern: claude-{family}[-{major}[-{minor}]]
  const match = trimmed.match(/^claude-([a-z]+)(?:-(\d+))?(?:-(\d+))?$/i);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    const major = match[2];
    const minor = match[3];
    if (major && minor) return `${family} ${major}.${minor}`;
    if (major) return `${family} ${major}`;
    return family;
  }

  // Fallback: return as-is (may be a plain display name like "Opus 4.8")
  return trimmed;
}

function rateContextHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/**
 * Return the sidecar used for one session's context-window observation.
 * Session IDs never appear in a path: even long/unusual strings are SHA-256
 * hashed to distinct fixed-size names.
 */
export function rateLimitsContextPath(cachePath, sessionId) {
  return join(rateContextNamespace(cachePath), `${rateContextHash(sessionId)}.json`);
}

function rateContextNamespace(cachePath, prefix = RATE_CONTEXT_NAMESPACE) {
  const name = basename(cachePath);
  const key = process.platform === 'win32' ? name.toLowerCase() : name;
  const namespace = key === 'rate-limits.json' ? prefix
    : `${prefix}-${createHash('sha256').update(key).digest('hex')}`;
  return join(dirname(cachePath), namespace);
}

function legacyRateLimitsContextPath(cachePath, sessionId) {
  return `${cachePath}${RATE_CONTEXT_PREFIX}${rateContextHash(sessionId)}.json`;
}

function readJson(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function isFresh(capturedAt, nowMs) {
  return Number.isFinite(capturedAt)
    && capturedAt <= nowMs + FUTURE_SKEW_TOLERANCE_MS
    && nowMs - capturedAt <= RATE_LIMITS_MAX_AGE_MS;
}

function rateQuotaSessionHash(sessionId) {
  return typeof sessionId === 'string' && sessionId
    ? createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex')
    : null;
}

function rateSlotSessionMatches(cache, key, sessionId) {
  if (sessionId == null) return true;
  const expected = rateQuotaSessionHash(sessionId);
  return expected !== null && cache?.[`${key}SessionHash`] === expected;
}

export function rateLimitsQuotaPath(cachePath, sessionId) {
  const hash = rateQuotaSessionHash(sessionId);
  return hash ? join(rateContextNamespace(cachePath, 'rate-quota'), `${hash}.json`) : null;
}

function sessionRateState(cachePath, sessionId, base, nowMs, diagnostics = null) {
  const path = rateLimitsQuotaPath(cachePath, sessionId);
  if (!path) return base;
  const local = readJson(path);
  const result = {};
  for (const key of ['fiveHour', 'sevenDay']) {
    const candidates = [local, base].filter((state) =>
      rateSlotSessionMatches(state, key, sessionId) && usableRateSlot(state?.[key])
      && isFresh(rateSlotCapturedAt(state, key), nowMs));
    candidates.sort((a, b) => (rateSlotCapturedAt(b, key) ?? -Infinity)
      - (rateSlotCapturedAt(a, key) ?? -Infinity));
    const selected = candidates[0];
    if (diagnostics?.key === key) {
      const matching = [local, base].filter((state) => rateSlotSessionMatches(state, key, sessionId));
      matching.sort((a, b) => (rateSlotCapturedAt(b, key) ?? -Infinity)
        - (rateSlotCapturedAt(a, key) ?? -Infinity));
      const observed = selected || matching[0];
      const capturedAt = rateSlotCapturedAt(observed, key);
      diagnostics.ageMs = Number.isFinite(capturedAt) ? nowMs - capturedAt : null;
      diagnostics.reason = ![local, base].some((state) => state?.[key] != null) ? 'cache_missing'
        : !matching.length ? 'session_mismatch'
          : !usableRateSlot(observed?.[key]) ? 'slot_invalid'
            : !Number.isFinite(capturedAt) ? 'capture_invalid'
              : !isFresh(capturedAt, nowMs) ? 'stale' : 'cache';
    }
    result[key] = selected?.[key] ?? null;
    result[`${key}CapturedAt`] = rateSlotCapturedAt(selected, key);
    result[`${key}SessionHash`] = selected?.[`${key}SessionHash`] ?? null;
  }
  return result;
}

function rateSlotCapturedAt(cache, key) {
  const field = `${key}CapturedAt`;
  if (cache && Object.prototype.hasOwnProperty.call(cache, field)) {
    return Number.isFinite(cache[field]) ? cache[field] : null;
  }
  return Number.isFinite(cache?.capturedAt) ? cache.capturedAt : null;
}

function usableRateSlot(slot) {
  return slot && typeof slot === 'object' && !Array.isArray(slot)
    && Number.isFinite(slot.used) && slot.used >= 0 && slot.used <= 100
    && (slot.resetsAt == null || typeof slot.resetsAt === 'string');
}

function validRateState(value) {
  const keys = ['fiveHour', 'sevenDay'];
  return value && keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => {
      const slot = value[key];
      return slot == null || (typeof slot === 'object' && !Array.isArray(slot)
        && ['used', 'resetsAt'].some((field) => Object.prototype.hasOwnProperty.call(slot, field))
        && (slot.used == null || Number.isFinite(slot.used))
        && (slot.resetsAt == null || typeof slot.resetsAt === 'string'));
    });
}

function writeJsonAtomic(path, value) {
  try {
    const entry = lstatMaybe(path);
    if (entry && !entry.isFile()) return false;
    const snapshot = captureRegularFileSnapshot(path);
    let previous = null;
    try { if (snapshot.present) previous = JSON.parse(snapshot.content.toString('utf8')); } catch { /* replace malformed cache */ }
    const validPrevious = value.contextWindowSize !== undefined
      ? validContextWindowSize(previous?.contextWindowSize) !== null
      : validRateState(previous);
    if (validPrevious && Number.isFinite(previous?.capturedAt)
        && previous.capturedAt <= Date.now() + FUTURE_SKEW_TOLERANCE_MS
        && previous.capturedAt > value.capturedAt) return false;
    writeFileAtomic(path, JSON.stringify(value) + '\n', {
      expectedDestination: snapshot.expectedDestination,
      // Кэш не должен задерживать вывод панели при занятом fence.
      waitForFence: false,
    });
    return true;
  } catch {
    // Cache publication is best-effort for hook callers.
    return false;
  }
}

function contextSidecar(path) {
  try {
    if (!regularFileIdentity(path)) return null;
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) return null;
    const raw = snapshot.content;
    let value = null;
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      value = parsed && typeof parsed === 'object' ? parsed : null;
    } catch { /* malformed legacy state remains safely readable as null */ }
    return {
      expectedDestination: snapshot.expectedDestination,
      raw,
      value,
    };
  } catch {
    return null;
  }
}

function contextCapturedAt(sidecar) {
  return typeof sidecar?.value?.capturedAt === 'number'
    && Number.isFinite(sidecar.value.capturedAt)
    ? sidecar.value.capturedAt
    : null;
}

function legacyContextIsNewer(legacy, current) {
  const legacyAt = contextCapturedAt(legacy);
  const currentAt = contextCapturedAt(current);
  if (legacyAt === null) return false;
  if (currentAt === null) return true;
  return legacyAt > currentAt;
}

// Copy into the namespace with an atomic publication, then remove only the
// exact legacy inode that was read. This avoids rename-overwrite races on
// platforms where a legacy file can be refreshed while migration is running.
function publishMigratedContext(sourcePath, targetPath, source, targetExpected) {
  try {
    writeFileAtomic(targetPath, source.raw, {
      expectedDestination: targetExpected || null,
    });
    try { removeOwnedRegularFile(sourcePath, source.expectedDestination); } catch { /* retry next call */ }
    return true;
  } catch {
    return false;
  }
}

function usableContext(sidecar, nowMs) {
  return !!sidecar && isFresh(sidecar.value?.capturedAt, nowMs)
    && validContextWindowSize(sidecar.value?.contextWindowSize) !== null;
}

function migrateLegacyRateContext(cachePath, sessionId, nowMs) {
  const sourcePath = legacyRateLimitsContextPath(cachePath, sessionId);
  const targetPath = rateLimitsContextPath(cachePath, sessionId);
  if (sourcePath === targetPath) return;

  const source = contextSidecar(sourcePath);
  if (!usableContext(source, nowMs)) return;
  const target = contextSidecar(targetPath);
  if (!target) {
    publishMigratedContext(sourcePath, targetPath, source, null);
    return;
  }

  // A collision is resolved by the captured timestamp, not by path age or
  // directory order. Never discard a newer legacy observation merely because
  // the new leaf was published first.
  if (!usableContext(target, nowMs) || legacyContextIsNewer(source, target)) {
    publishMigratedContext(sourcePath, targetPath, source, target.expectedDestination);
  } else {
    try { removeOwnedRegularFile(sourcePath, source.expectedDestination); } catch { /* retry next call */ }
  }
}

function readContextSidecar(cachePath, sessionId, nowMs) {
  migrateLegacyRateContext(cachePath, sessionId, nowMs);
  const current = contextSidecar(rateLimitsContextPath(cachePath, sessionId));
  const legacy = contextSidecar(legacyRateLimitsContextPath(cachePath, sessionId));
  const candidates = [current, legacy].filter((entry) => usableContext(entry, nowMs));
  candidates.sort((a, b) => {
    const left = contextCapturedAt(a) ?? -Infinity;
    const right = contextCapturedAt(b) ?? -Infinity;
    return right - left;
  });
  return validContextWindowSize(candidates[0]?.value?.contextWindowSize);
}

function pruneRateContextSidecars(cachePath, nowMs, testInterlock = null, prefix = RATE_CONTEXT_NAMESPACE) {
  const namespace = rateContextNamespace(cachePath, prefix);
  let handle;
  try {
    handle = opendirSync(namespace);
  } catch (error) {
    return { incomplete: error.code !== 'ENOENT', truncated: false, visits: 0 };
  }
  const candidates = [];
  const nowNs = BigInt(Math.trunc(nowMs)) * 1_000_000n;
  const maxAgeNs = BigInt(RATE_LIMITS_MAX_AGE_MS) * 1_000_000n;
  let visits = 0;
  let incomplete = false;
  let truncated = false;
  try {
    while (visits < RATE_CONTEXT_VISIT_LIMIT) {
      let entry;
      try { entry = handle.readSync(); } catch { incomplete = true; break; }
      if (entry === null) break;
      visits += 1;
      if (!RATE_CONTEXT_NAME_RE.test(entry.name) || !entry.isFile()) continue;
      const sidecar = join(namespace, entry.name);
      try {
        const identity = regularFileIdentity(sidecar);
        if (!identity) continue;
        if (nowNs - identity.mtimeNs > maxAgeNs) {
          // stat/lstat is only an observation. The entry may be atomically
          // replaced by a fresh sidecar before removal, so remove only the
          // exact observed regular file after moving it to quarantine.
          testInterlock?.('prune-rate-context-before-remove');
          try { removeOwnedRegularFile(sidecar, identity, { testInterlock }); } catch { /* best effort */ }
          continue;
        }
        candidates.push({ path: sidecar, identity, mtimeNs: identity.mtimeNs });
      } catch {
        // A concurrent writer or cleanup may have removed it already.
      }
    }
    if (visits >= RATE_CONTEXT_VISIT_LIMIT) {
      try { truncated = handle.readSync() !== null; } catch { incomplete = true; }
    }
  } finally {
    try { handle.closeSync(); } catch { incomplete = true; }
  }
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  for (const entry of candidates.slice(RATE_CONTEXT_MAX_SESSIONS)) {
    testInterlock?.('prune-rate-context-before-remove');
    try { removeOwnedRegularFile(entry.path, entry.identity, { testInterlock }); } catch { /* best effort */ }
  }
  return { incomplete, truncated, visits };
}

/**
 * Persist rate state scoped to this session and its context window.
 *
 * Context and quota observations live in separate hashed sidecars, so another
 * session cannot erase their fallback values. The shared quota file remains
 * readable by older runtimes; each slot still carries its session hash and
 * original observation time. Writes and bounded cleanup are best-effort.
 */
export function persistRateLimitsCache(
  cachePath,
  fiveHour,
  sevenDay,
  effort,
  contextWindowSize,
  sessionId,
  nowMs = Date.now(),
  options = {},
) {
  const contextSize = validContextWindowSize(contextWindowSize);
  const existing = readJson(cachePath);
  const existingRates = sessionRateState(cachePath, sessionId,
    validRateState(existing) ? existing : null, nowMs);
  const sessionHash = rateQuotaSessionHash(sessionId);
  const retainRateSlot = (key, incoming) => {
    if (usableRateSlot(incoming)) return { slot: incoming, capturedAt: nowMs, sessionHash };
    const previous = existingRates?.[key];
    const capturedAt = rateSlotCapturedAt(existingRates, key);
    const sameSession = sessionHash !== null
      && existingRates?.[`${key}SessionHash`] === sessionHash;
    return sameSession && usableRateSlot(previous) && isFresh(capturedAt, nowMs)
      ? { slot: previous, capturedAt, sessionHash }
      : { slot: null, capturedAt: null, sessionHash: null };
  };
  const nextFiveHour = retainRateSlot('fiveHour', fiveHour);
  const nextSevenDay = retainRateSlot('sevenDay', sevenDay);
  const hasRateState = usableRateSlot(fiveHour) || usableRateSlot(sevenDay);

  if (hasRateState || !existing) {
    const global = {
      version: 4,
      // Preserve an omitted window only within its session and with its
      // original observation time; another session cannot inherit its quota.
      fiveHour: nextFiveHour.slot,
      fiveHourCapturedAt: nextFiveHour.capturedAt,
      fiveHourSessionHash: nextFiveHour.sessionHash,
      sevenDay: nextSevenDay.slot,
      sevenDayCapturedAt: nextSevenDay.capturedAt,
      sevenDaySessionHash: nextSevenDay.sessionHash,
      capturedAt: hasRateState
        ? nowMs
        : (existing && typeof existing.capturedAt === 'number' ? existing.capturedAt : nowMs),
    };
    // Keep reading old effort fields for compatibility, but do not claim that
    // cah-stamp renders them; effort is available only in the status envelope.
    if (typeof effort === 'string') global.effort = effort;
    const quotaPath = rateLimitsQuotaPath(cachePath, sessionId);
    if (hasRateState && quotaPath) writeJsonAtomic(quotaPath, global);
    writeJsonAtomic(cachePath, global);
  }

  if (contextSize !== null) {
    writeJsonAtomic(rateLimitsContextPath(cachePath, sessionId), {
      version: 1,
      contextWindowSize: contextSize,
      capturedAt: nowMs,
    });
  }
  migrateLegacyRateContext(cachePath, sessionId, nowMs);
  pruneRateContextSidecars(cachePath, nowMs, options.testInterlock);
  pruneRateContextSidecars(cachePath, nowMs, null, 'rate-quota');
}

/**
 * Read quota slots for the requested session plus its context window.
 * Legacy quota records without a session hash are not reused for a named
 * session; old context entries retain their existing compatibility rules.
 *
 * @param {string} cachePath absolute path to the base cache JSON file
 * @param {number} [nowMs=Date.now()] injected for testability of staleness
 * @param {string|null} [sessionId=null] session whose context may be used
 */
export function readRateLimitsCache(cachePath, nowMs = Date.now(), sessionId = null, options = {}) {
  const base = readJson(cachePath);
  const globalFresh = base && isFresh(base.capturedAt, nowMs);
  let contextWindowSize = readContextSidecar(cachePath, sessionId, nowMs);

  if (contextWindowSize === null && globalFresh) {
    const baseSessionMatches = sessionId == null
      || base.sessionId == null
      || base.sessionId === sessionId;
    if (baseSessionMatches) contextWindowSize = validContextWindowSize(base.contextWindowSize);
  }

  const rates = sessionRateState(cachePath, sessionId, base, nowMs);
  const fiveHourFresh = rates && rateSlotSessionMatches(rates, 'fiveHour', sessionId)
    && isFresh(rateSlotCapturedAt(rates, 'fiveHour'), nowMs);
  const sevenDayFresh = rates && rateSlotSessionMatches(rates, 'sevenDay', sessionId)
    && isFresh(rateSlotCapturedAt(rates, 'sevenDay'), nowMs);
  if (!globalFresh && contextWindowSize === null && !fiveHourFresh && !sevenDayFresh) return null;
  return {
    fiveHour: fiveHourFresh ? (rates.fiveHour || null) : null,
    sevenDay: sevenDayFresh ? (rates.sevenDay || null) : null,
    // Kept for compatibility with older cache readers. cah-stamp deliberately
    // omits effort because the hook payload does not identify its turn's level.
    effort: globalFresh && typeof base.effort === 'string' ? base.effort : null,
    contextWindowSize,
  };
}

// A brief upstream omission must not make the statusLine quota flicker. Reuse
// only a recent same-session Claude observation whose reset is still future.
export function readStatusLineRateFallback(cachePath, key, sessionId, modelId, nowMs = Date.now(), diagnostics = null) {
  const reject = (reason) => {
    if (diagnostics) diagnostics.reason = reason;
    return null;
  };
  if (diagnostics) Object.assign(diagnostics, { reason: 'not_attempted', ageMs: null });
  if (key !== 'fiveHour' && key !== 'sevenDay') return reject('not_attempted');
  if (typeof sessionId !== 'string' || !sessionId) return reject('session_missing');
  if (typeof modelId !== 'string' || !modelId) return reject('model_missing');
  if (!modelId.startsWith('claude-')) return reject('model_not_claude');
  const observation = diagnostics ? { key } : null;
  const cache = sessionRateState(cachePath, sessionId, readJson(cachePath), nowMs, observation);
  if (diagnostics) Object.assign(diagnostics, { reason: observation.reason, ageMs: observation.ageMs });
  if (!rateSlotSessionMatches(cache, key, sessionId)) return null;
  const capturedAt = rateSlotCapturedAt(cache, key);
  const slot = cache?.[key];
  if (!usableRateSlot(slot)) return reject('slot_invalid');
  if (!isFresh(capturedAt, nowMs)
      || nowMs - capturedAt > STATUSLINE_RATE_FALLBACK_MAX_AGE_MS) return reject('stale');
  if (typeof slot.resetsAt !== 'string') return reject('reset_missing');
  const resetAt = Date.parse(slot.resetsAt);
  if (!Number.isFinite(resetAt)) return reject('reset_invalid');
  if (resetAt <= nowMs) return reject('reset_elapsed');
  if (diagnostics) diagnostics.reason = 'cache';
  return slot;
}

// Short weekday in the user's locale. Default ru-RU (matches the original
// preview); override via CAH_WEEKDAY_LOCALE for any other language.
let _weekdayShort = null;
function weekdayShort(date) {
  if (_weekdayShort === null) {
    const locale = (typeof process !== 'undefined' && process.env && process.env.CAH_WEEKDAY_LOCALE)
      || 'ru-RU';
    try {
      const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
      _weekdayShort = (d) => fmt.format(d).replace(/\.$/, '').toLowerCase();
    } catch {
      const ru = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
      _weekdayShort = (d) => ru[d.getDay()];
    }
  }
  return _weekdayShort(date);
}

// 5h reset → compact "remaining time": "1ч 23м" / "23м" / "<1м" / "0м" if
// the moment has already passed. Returns null on malformed/missing input.
export function formatFiveHourReset(resetsAt, now = new Date()) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  let remainingMs = d.getTime() - now.getTime();
  if (remainingMs < 0) remainingMs = 0;
  const totalMin = Math.floor(remainingMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (totalMin === 0 && remainingMs > 0) return '<1м';
  return `${m}м`;
}

// Weekly reset → "wd DD.MM HH:MM" so you can see both the day name and the
// exact wall clock. Returns null on malformed/missing input.
export function formatWeeklyReset(resetsAt /* , now */) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${weekdayShort(d)} ${dd}.${mm} ${currentHhMm(d)}`;
}

// Trim trailing zeros after the decimal but keep the dot if a non-zero
// decimal is present: 12.34 → "12.34", 12.30 → "12.3", 12.00 → "12".
function fmtPct(n) {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// 10-cell Unicode progress bar with two visually distinct styles so a glance
// is enough to tell what's being measured:
//   mode 'limit' — solid █ + 8-level subblock partial (▏▎▍▌▋▊▉), in square
//                  brackets [████▍░░░░░]. This is the "how much used" axis.
//   mode 'time'  — dark-shade ▓ + medium-shade ▒ partial, in round brackets
//                  (▓▓▓▓▒░░░░░). This is the "how much window elapsed" axis.
// Empty cells: ░. The combination of fill character AND bracket shape makes
// the two bars trivially distinguishable when they appear back-to-back.
const BAR_WIDTH = 10;
const SUBBLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function makeBar(pct, mode = 'limit') {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const fullCells = Math.floor(clamped / 10);
  const remainder = clamped - fullCells * 10; // 0..<10
  const isLimit = mode !== 'time';
  const fill = isLimit ? '█' : '▓';
  let bar = fill.repeat(Math.min(fullCells, BAR_WIDTH));
  if (fullCells < BAR_WIDTH && remainder > 0) {
    if (isLimit) {
      const eighths = Math.round((remainder / 10) * 8);
      if (eighths === 8) bar += '█';
      else if (eighths > 0) bar += SUBBLOCKS[eighths];
    } else {
      bar += '▒';
    }
  }
  while (bar.length < BAR_WIDTH) bar += '░';
  bar = bar.slice(0, BAR_WIDTH);
  return isLimit ? `[${bar}]` : `(${bar})`;
}


function rateLimitPart(label, slot, resetFmt, now, bars) {
  if (!slot || !Number.isFinite(slot.used) || slot.used < 0 || slot.used > 100) return null;
  const pct = fmtPct(slot.used);
  const reset = resetFmt(slot.resetsAt, now);
  let out = `${label} `;
  if (bars) out += `${makeBar(slot.used, 'limit')} `;
  out += `${pct}%`;
  if (reset) out += ` →${reset}`;
  return out;
}

/**
 * Format the one-line status string.
 *
 * @param {object} opts
 * @param {string|null} opts.time   - "HH:MM" string, or null to omit the clock
 * @param {string|null} opts.displayName - raw model display name or model ID
 * @param {number|null} opts.usedTokens
 * @param {number|null} opts.limit
 * @param {{used:number|null, resetsAt:string|null}|null} [opts.fiveHour]
 *        Pro/Max 5-hour quota — used = percentage 0..100, resetsAt = ISO.
 * @param {{used:number|null, resetsAt:string|null}|null} [opts.sevenDay]
 *        Pro/Max weekly quota — used = percentage 0..100, resetsAt = ISO.
 * @param {Date} [opts.now=new Date()] - injected for testability of reset formatting.
 * @returns {string}
 *
 * Output shapes (parts joined by " · ", missing parts omitted):
 *   "HH:MM · <name> · X% (Nk/Mk) · 5h 23% (→14:30) · wk 67% (→вс 03:00)"
 *   "<name> · X% (Nk/Mk)"            — no rate_limits (free tier / pre-API)
 *   "<name>"                          — name only
 *   ""                                — nothing at all (caller decides fallback)
 */
export function formatStatusLine({ time, displayName, usedTokens, limit, fiveHour, sevenDay, effort, now, bars = true }) {
  // Convert display name: strip "Claude " prefix or convert raw model ID
  const baseName = toDisplayName(displayName);
  const code = effortCode(effort);
  // Render effort as a one-letter bracketed suffix matching the slash-command
  // shortcut convention (e.g. "Opus 4.7 [xx]" → /oxx). If effort is absent (no
  // envelope value, or the model doesn't support effort) the name stays bare.
  const name = baseName && code ? `${baseName} [${code}]` : baseName;
  const _now = now || new Date();

  let usagePart = null;
  if (
    usedTokens != null &&
    limit != null &&
    typeof usedTokens === 'number' &&
    typeof limit === 'number' &&
    limit > 0
  ) {
    const rawPct = (usedTokens / limit) * 100;
    const pct = fmtPct(rawPct);
    const usedK = Math.round(usedTokens / 1000);
    const limitStr = limit >= 1_000_000
      ? `${Math.round(limit / 1_000_000)}M`
      : `${Math.round(limit / 1000)}k`;
    usagePart = bars
      ? `${makeBar(rawPct, 'limit')} ${pct}% (${usedK}k/${limitStr})`
      : `${pct}% (${usedK}k/${limitStr})`;
  }

  const fiveHourPart = rateLimitPart('5h', fiveHour, formatFiveHourReset, _now, bars);
  const sevenDayPart = rateLimitPart('wk', sevenDay, formatWeeklyReset, _now, bars);

  const parts = [];
  if (time) parts.push(time);
  if (name) parts.push(name);
  if (usagePart) parts.push(usagePart);
  if (fiveHourPart) parts.push(fiveHourPart);
  if (sevenDayPart) parts.push(sevenDayPart);
  return parts.join(' · ');
}
