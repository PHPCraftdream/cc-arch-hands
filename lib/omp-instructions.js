import { join } from 'node:path';
import { createMarkedSection } from './marked-section.js';

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

const marked = createMarkedSection({
  begin: OMP_AGENT_TAGS_BEGIN, end: OMP_AGENT_TAGS_END, section: SECTION, label: 'OMP APPEND_SYSTEM.md agent-tag',
});

export function ompInstructionsPath(scope) {
  return join(scope.agentRoot(), 'APPEND_SYSTEM.md');
}

export function inspectOmpInstructions(scope) {
  return marked.inspect(ompInstructionsPath(scope));
}

export function writeOmpInstructions(scope) {
  return marked.write(ompInstructionsPath(scope));
}

export function removeOmpInstructions(scope) {
  return marked.remove(ompInstructionsPath(scope));
}

export function classifyOmpInstructions(scope) {
  try {
    return inspectOmpInstructions(scope).range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
