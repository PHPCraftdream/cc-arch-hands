import { join } from 'node:path';
import { captureRegularFileSnapshot, writeFileAtomic } from './fsutil.js';

export const OMP_AGENT_TAGS_BEGIN = '<!-- cah-omp-agent-tags:start -->';
export const OMP_AGENT_TAGS_END = '<!-- cah-omp-agent-tags:end -->';

const SECTION = `${OMP_AGENT_TAGS_BEGIN}
## Теги агентов

Короткие имена ls, ms, hs, xs, xxs и остальные имена зарегистрированных
агентов обозначают конкретных исполнителей, а не модели основной сессии.

Если пользователь явно просит поручить работу агенту или агентам
и указывает их имена, вызывай соответствующих агентов по точному имени.
Например: «hs проверь код», «поручи xxa исследование».

Упоминание имени при обсуждении конфигурации не является просьбой запуска.
Без явной просьбы пользователя подагентов не запускай.
Не подменяй выбранного агента другим и не меняй основную модель сессии.

Ultra должен оставаться буквальным ultra в определении и запросе.
Не заменяй его на max, xhigh, другой режим или другого исполнителя.
Отсутствие поддержки и ошибки использования не скрывай: сообщай их пользователю.
Не меняй основную модель сессии и не запускай подагентов без явной просьбы.
${OMP_AGENT_TAGS_END}`;

const beginBytes = Buffer.from(OMP_AGENT_TAGS_BEGIN);
const endBytes = Buffer.from(OMP_AGENT_TAGS_END);
const sectionBytes = Buffer.from(SECTION);

function positions(content, marker) {
  const found = [];
  for (let from = 0; ; ) {
    const at = content.indexOf(marker, from);
    if (at < 0) return found;
    found.push(at);
    from = at + marker.length;
  }
}

function sectionRange(content) {
  const starts = positions(content, beginBytes);
  const ends = positions(content, endBytes);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0] + beginBytes.length) {
    throw new Error('OMP APPEND_SYSTEM.md has incomplete or duplicate agent-tag markers');
  }
  const start = starts[0];
  const end = ends[0] + endBytes.length;
  if ((start > 0 && content[start - 1] !== 10)
      || (end < content.length && content[end] !== 10 && content[end] !== 13)) {
    throw new Error('OMP APPEND_SYSTEM.md agent-tag markers must occupy their own lines');
  }
  return { start, end };
}

export function ompInstructionsPath(scope) {
  return join(scope.agentRoot(), 'APPEND_SYSTEM.md');
}

export function inspectOmpInstructions(scope) {
  const path = ompInstructionsPath(scope);
  const snapshot = captureRegularFileSnapshot(path);
  return { path, snapshot, range: sectionRange(snapshot.content ?? Buffer.alloc(0)) };
}

export function writeOmpInstructions(scope) {
  const { path, snapshot, range } = inspectOmpInstructions(scope);
  const original = snapshot.content ?? Buffer.alloc(0);
  const updated = range
    ? Buffer.concat([original.subarray(0, range.start), sectionBytes, original.subarray(range.end)])
    : Buffer.concat([original, original.length ? Buffer.from('\n\n') : Buffer.alloc(0),
      sectionBytes, Buffer.from('\n')]);
  if (updated.equals(original)) return { written: 0, skipped: [] };
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { written: 1, skipped: [] };
}

export function removeOmpInstructions(scope) {
  const { path, snapshot, range } = inspectOmpInstructions(scope);
  if (!range) return { removed: 0, skipped: [] };
  const original = snapshot.content;
  const prefixStart = range.start >= 2 && original[range.start - 2] === 10
    && original[range.start - 1] === 10 ? range.start - 2 : range.start;
  let suffixStart = range.end;
  if (suffixStart + 1 === original.length && original[suffixStart] === 10) suffixStart++;
  const updated = Buffer.concat([original.subarray(0, prefixStart), original.subarray(suffixStart)]);
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { removed: 1, skipped: [] };
}

export function classifyOmpInstructions(scope) {
  try {
    const { range } = inspectOmpInstructions(scope);
    return range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
