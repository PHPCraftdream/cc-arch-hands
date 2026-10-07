# План установщика OpenCode

Дата исследования: 2026-10-06. Основа: cc-arch-hands 0.15.1, commit `1118642`.

## Статус реализации

Установщик реализован: все 39 `AllCodexAgents`, девять workflow-команд и девять native skills в plural-каталогах `agents/`, `commands/`, `skills/`, правило точного делегирования в `AGENTS.md` и babysit plugin/runtime. Модели задаются как `openai/<model>`, effort — буквальным `options.reasoningEffort`, без `variant` и capability filtering.

Ревью 2026-10-07 нашло и закрыло: в OpenCode 1.18.34 нет инструмента `todoread` (строки нет в бинарнике, в списке tools агента только `todowrite`), поэтому plugin получил инструмент `cah_todos` поверх `session.todo`, а шаблоны и tick prompt читают план через него; остановка babysit теперь видна (toast и `stopped` в `status`); `ccheckpoint` самодостаточна, skills без буквального `$ARGUMENTS`, тест держит тексты команды и skill одинаковыми; runtime публикуется раньше skills; `AGENTS.md`, созданный только нашим разделом, удаляется при uninstall.

Настоящий OpenCode 1.18.34 в изолированном sandbox подтвердил регистрацию агентов (`xl`: `openai/gpt-6-luna`, `xhigh`), обнаружение девяти skills и девяти команд, загрузку plugin и прямые вызовы `cah_todos` и `cah_babysit`. Inference и поддержка моделей/effort удалённым провайдером не проверялись. Ниже сохранён исходный план; фактический состав и интерфейс описаны в README.

## Решение

Добавить OpenCode как opt-in интеграцию существующего `cah`: три класса `opencode-agents`, `opencode-commands`, `opencode-skills` и объединяющий флаг `--opencode`. Переиспользовать файловые транзакции и установщик деревьев skills. Форматы, пути, модельные привязки и инструкции сделать OpenCode-специфичными.

Уточнение пользователя: образец состава и поведения — OMP-интеграция. Устанавливать все 39 агентов из `AllCodexAgents`, без Claude-моделей из `AllModelCommands`, с буквальным effort, включая `max` и `ultra`. Установку не фильтровать по доступности моделей у текущего провайдера. Ошибки использования сообщать без подмены модели, агента или effort. Девять OMP workflow-возможностей, включая babysit/babygoal и их runtime, входят в целевую поставку OpenCode. Отдельные skills оформлять для native OpenCode discovery.

Критерий результата: пользователь устанавливает артефакты глобально или в проект; после перезапуска OpenCode видит skills, вызывает команды и выбранных subagents; update/reinstall/uninstall сохраняют пользовательские файлы. Установка работает без установленного OpenCode и без сетевых запросов.

## 1. Что уже есть в проекте

| Интеграция | Артефакты | Реализация | Особенности |
|---|---|---|---|
| Claude Code | 54 модельные команды, 54 агента, 11 skills, companion bins | `commands.js`, `agents.js`, `skills.js`, `binstall.js` | Markdown с `model`/`effort`; `.claude`; skills могут требовать Claude tools/hooks |
| Codex | 39 TOML-агентов, 4 skills | `codex-agents.js`, `codex-skills.js` | `.codex`; skills используют общий tree installer; cli-run также управляет блоками в глобальном AGENTS.md и scope config.toml |
| OMP | 39 Markdown-агентов, 9 workflow-команд, runtime helpers | `omp-scope.js`, `omp-agents.js`, `omp-commands.js` | Глобальные профили `.omp`; собственные `thinking-level`, todo и extension API |

Общий контракт:

- `lib/manifest.js` — реестры и зависимости Claude skills.
- `lib/cli.js` — выбор классов, preflight, install/reinstall/uninstall/list/doctor/version.
- `lib/templates.js` уже поддерживает произвольный `templateKind`.
- `writeSkills`/`removeSkills` уже принимают `root`, `catalog`, `templateKind`, `subset`: новый filesystem installer для skills не нужен.
- Запись: snapshot → ownership → `writeFileAtomic` с `expectedDestination`.
- Удаление: `removeOwnedRegularFile`; pruning только принадлежащих установщику файлов; результаты `skipped`, `preserved`, `recovery`, `maintenance` выводятся пользователю.
- Reinstall сначала проверяет установочную сторону, затем выполняет uninstall/install. Это preflight, а не общая транзакция с rollback всех классов.
- Bare install сохраняет текущий набор Claude-классов. Codex и OMP выбираются явно.

## 2. Подтверждённый контракт OpenCode

| Артефакт | Глобально по умолчанию | В проекте | Формат |
|---|---|---|---|
| Skills | `~/.config/opencode/skills/<name>/SKILL.md` | `.opencode/skills/<name>/SKILL.md` | YAML `name`, `description`, Markdown body |
| Agents | `~/.config/opencode/agents/<name>.md` | `.opencode/agents/<name>.md` | YAML `description`, `mode`, `model`, опционально `variant`/`options`, body как prompt |
| Commands | `~/.config/opencode/commands/<name>.md` | `.opencode/commands/<name>.md` | YAML `description`, опционально `agent`, `model`, `variant`, `subtask`, body как template |

Использовать plural-каталоги. Singular тоже поддерживаются, но это второй namespace с возможными коллизиями, а не основание писать две копии.

- Глобальный стандартный root определяется XDG: `<XDG_CONFIG_HOME>/opencode`, fallback `~/.config/opencode`. Не подменять его Windows `%APPDATA%` без проверки целевой версии.
- `OPENCODE_CONFIG_DIR` добавляет custom directory; `OPENCODE_CONFIG` задаёт JSON-конфиг, а не каталог установки Markdown.
- Model ID имеет вид `provider/model`. Один model ID может быть доступен через разные providers.
- Agent: `mode: subagent` для делегируемых работников; не менять built-in build/plan.
- Command: `$ARGUMENTS`; `subtask: false` предотвращает автоматическое делегирование при привязке к subagent.
- Схема команд содержит `variant`, но не Claude-поле `effort`. Agent допускает model options, например OpenAI `reasoningEffort`.
- Skills требуют корректных `name` и `description`; имя совпадает с каталогом, 1–64 символа, `^[a-z0-9]+(-[a-z0-9]+)*$`; description 1–1024 символа.
- OpenCode также обнаруживает `.claude/skills` и `.agents/skills`. Обнаружение файла не означает совместимость его инструкций.
- Inline config и другие источники способны переопределить файловые определения. Файловый doctor не доказывает фактическое исполнение нужной модели.

Документация сейчас рекламирует OpenCode v2; изученные исходники `dev` содержат также слой совместимости v1. До реализации закрепить поддерживаемую release-версию и сверить загрузчики этой версии. Не считать moving `dev` гарантией совместимости всех релизов.

## 3. Предлагаемый интерфейс

```sh
cah install --opencode
cah install --opencode-agents
cah install --opencode-commands
cah install --opencode-skills
cah install --only opencode-agents,opencode-skills
cah install --opencode --cwd ./project
cah reinstall --opencode
cah uninstall --opencode
cah list --opencode --json
cah doctor --opencode
```

Правила:

1. Флаги классов и `--opencode` зарегистрировать в `OPT_IN_FLAG_CLASSES`: отдельно заменяют default selection; с `--only` добавляют классы.
2. `--global` — стандартный XDG root; при заданном `OPENCODE_CONFIG_DIR` глобальная OpenCode-установка явно выбирает custom root и сообщает его в отчёте. Это выбранная политика установщика: OpenCode сам может читать оба каталога.
3. `--cwd PATH` — `PATH/.opencode`, с созданием; `--local` — strict-guard существующего `.opencode`. OpenCode-only операция не требует `.claude`.
4. Для смешанной операции guard применяется к каждому выбранному target. Custom directory не перенаправляет явно локальную установку.
5. `list`/`doctor --opencode` проверяют только OpenCode; без флага сохраняют существующую семантику и добавляют OpenCode rows/opt-in gating по аналогии с OMP. Классовые флаги в этих subcommands должны позволять проверять отдельно установленный класс.
6. Bare `--only checkpoint` остаётся Claude-selector. Точечный OpenCode skill-selector можно добавить отдельным этапом; не переопределять существующее значение имени.

## 4. Состав первой поставки

### Skills

| Skill | Основа | Адаптация |
|---|---|---|
| `repo-sight` | Claude-версия | Убрать предположения о конкретных tools/harness; оставить диагностику репозитория |
| `checkpoint` | Codex-версия | Сохранять видимый контекст и OpenCode todo; не обещать недоступные task IDs/blockedBy |
| `ccheckpoint` | Codex-версия и commit helper | Явный запрос пользователя; локальный commit только checkpoint через существующий изолированный index |
| `resume` | Codex-версия | Восстановить незавершённые задачи через доступные todo tools; зависимости записывать в тексте |
| `checkpoint-prune` | Claude-версия | Сохранить project scope, выбор и подтверждение удаления; использовать доступные файловые инструменты |
| `task` | Семантика Claude/OMP | `todowrite` вместо TaskCreate; зависимости в формулировках; только планирование |
| `triage` | Семантика Claude/OMP | Работать с доступным todo state; сохранять актуальные задачи при обновлении списка |

Реестр `AllOpenCodeSkills` включает только реально адаптированные templates. Проверено: `todoread` в 1.18.34 отсутствует, live todo читаются через `cah_todos` плагина.

### Agents и правило делегирования

- Использовать только `AllCodexAgents` как источник alias/model/effort/display, по образцу `OmpAgents = AllCodexAgents`. Установить все 39 определений; Claude model commands не переносить.
- Не копировать Claude `effort`, Codex `model_reasoning_effort` или OMP `thinking-level` как OpenCode-поля.
- Для каждой пары model/effort сохранить исходное значение в OpenCode model options и проверить путь передачи в запрос. Не полагаться на наличие одноимённого built-in variant, который может отсутствовать или задавать другие options. `max` и `ultra` не заменять на меньший effort.
- Установить определения даже при недоступной модели или неподдерживаемом effort, как OMP. Compatibility table объясняет ошибки использования, а не исключает aliases из установки. Недоступный provider/model/effort должен дать явную ошибку без fallback.
- Agent body: автономное выполнение, git-safety и ограничение test scope по действующим контрактам проекта. `$ARGUMENTS` не использовать в agent prompt как будто это command template.
- Добавить managed rule по образцу `omp-instructions.js`: «используй агента xl» означает вызов subagent `xl` по точному имени, не смену модели основной сессии. Упоминание alias в обсуждении не запускает агента. Без явного поручения пользователя не делегировать.
- Определить реально загружаемое OpenCode место для rule. Не считать `APPEND_SYSTEM.md` переносимым: проверить OpenCode AGENTS.md/instructions discovery, сохранить чужие bytes и учитывать локальное переопределение глобальных правил.
- Критерий: после установки и перезапуска OpenCode `xl` доступен через `@xl` и native task delegation; запрос идёт к `gpt-6-luna` с `xhigh`. Недоступность провайдера не должна приводить к вызову `general` вместо `xl`.

### Workflow-команды

Перенести все девять OMP workflow-команд: `checkpoint`, `ccheckpoint`, `checkpoint-resume`, `checkpoint-prune`, `babysit`, `babygoal`, `task`, `triage`, `repo-sight`. Адаптировать `$@` к `$ARGUMENTS`, OMP todo к OpenCode todo и extension к OpenCode plugin API. Wrapper над skill допустим, если действительно загружает его через native `skill`. Проверить коллизии команд со skills и built-ins; не устанавливать конфликтующий wrapper, полагаясь на случайный порядок загрузки. Основная модель сессии наследуется: workflow-команды не переключают её.

### Runtime-зависимые возможности

`babysit`, `babygoal`, `clock`, `checkpoint-watch`, Codex `cli-run` требуют отдельного исследования OpenCode runtime. Для них обычного SKILL.md недостаточно:

- babysit/babygoal: session-scoped scheduler, idle/busy/error events, восстановление продолжения, отмена и отсутствие дублей;
- clock/checkpoint-watch: OpenCode session usage/events, свой формат уведомлений, границы compaction; Claude hook payload и bins не являются готовым backend;
- cli-run: OpenCode session routing и уведомления вместо Codex thread/MCP protocol.

Babysit/babygoal runtime — обязательный этап OMP-паритета, а не опциональное продолжение первой поставки. Clock/checkpoint-watch и Codex cli-run отсутствуют в текущем OMP install bundle; их перенос остаётся отдельным расширением и не блокирует OMP-паритет. Не публиковать runtime-возможности как поддерживаемые до end-to-end проверки.

## 5. Этапы реализации и зависимости

### P0. Зафиксировать совместимость

1. Закрепить поддерживаемый OpenCode release и provider/model mapping.
2. В workspace sandbox проверить загрузку Markdown, skill/command collisions, `variant`, `subtask: false`, aliases в singular/plural каталогах.
3. Подтвердить модель/effort основного turn и subagent через наблюдаемые request metadata либо mock provider.

Выход: контракт регистрации всех 39 aliases, точного делегирования и буквальной передачи effort; compatibility matrix для диагностики provider errors. Доступность модели не является условием включения alias в каталог.

### P1. Scope и реестры — после P0

- Новый `lib/opencode-scope.js`: независимый `OpenCodeScope`, global/local/strict, XDG/custom root, `resolveAgentsDir`, `resolveCommandsDir`, `resolveSkillsDir`, `describe`.
- Новый `lib/opencode-instructions.js`: managed rule точного делегирования с preflight marker validation, write/remove/classify; загрузку rule подтвердить настоящим OpenCode.
- `lib/manifest.js`: OpenCode registries и необходимые зависимости, не изменения существующих model aliases.
- `lib/sentinel.js`: отдельные agent/command sentinel sets. Для skills использовать действующий skill sentinel и отдельный root.
- Проверки scope: несовместимые флаги, root-файл вместо root-каталога, корректное разрешение относительных путей, пути с пробелами и Windows paths.

### P2. Установочные модули — после P1

- `lib/opencode-agents.js`: renderer, write/remove, owned orphan pruning, полный result contract.
- `lib/opencode-skills.js`: тонкий adapter к `writeSkills`/`removeSkills`; `templates/opencode-skills/`.
- `lib/opencode-commands.js`: девять workflow-команд и их runtime dependencies, write/remove/pruning; `templates/opencode-commands/` для статических prompt templates. Claude-модельные slash commands не добавлять.
- Валидация всего выбранного набора до первой записи: templates, frontmatter, catalog uniqueness, required dependencies.
- Сохранить snapshot/CAS semantics и concurrency interlocks; не заменять их обычным `writeFileSync`/`unlinkSync`.
- Не добавлять собственный parser произвольного YAML/JSONC ради копирования файлов. Для bundled generated frontmatter использовать ограниченный проверяемый формат; upstream acceptance проверять настоящим OpenCode loader.

### P3. CLI lifecycle — после P2

Обновить `VALID_CLASSES`, `OPT_IN_FLAG_CLASSES`, parsing во всех subcommands, preflight, install/uninstall dispatch, enumerate, doctor gating и version counts в `lib/cli.js`; примеры и help в `lib/cli-usage.js`.

Зависимости расширять на install/reinstall, не на uninstall. `reinstall` с неверным template/mapping/root отказывает до удаления. OpenCode-only операция пишет только выбранный OpenCode root. Базовая поставка файлов не требует изменений `opencode.json`, providers, credentials или пользовательских permissions.

### P4. Проверки и документация — после P3

Предлагаемые тестовые файлы: `test/opencode-scope.test.js`, `test/opencode-agents.test.js`, `test/opencode-skills.test.js`, `test/opencode-commands.test.js`; CLI cases в существующем test layout.

Минимальная матрица:

1. Global default, XDG root, custom root, local strict, `--cwd`, Windows paths.
2. Install → повторный install → update → reinstall → uninstall; owned orphans удалены.
3. Foreign same-name file, foreign skill, пользовательский extra-файл внутри managed skill сохраняются byte-for-byte.
4. Concurrent replacement между snapshot и write/delete не теряется; surfaced recovery сохранён.
5. OpenCode-only не создаёт Claude/Codex/OMP files; mixed selectors и standalone флаги имеют существующую семантику.
6. CLI preflight защищает reinstall от потери данных при плохом шаблоне или root.
7. `list --json` выдаёт новые kinds и правильный ownership; выбранный `doctor`: 0 healthy, 1 missing, 2 foreign. Отсутствующая opt-in интеграция не ухудшает baseline health.
8. Настоящий loader принимает все templates; supported model/effort действительно достигает provider, command не делегирует неожиданно.
9. Checkpoint/resume/triage используют реальные todo tools; ccheckpoint сохраняет чужие staged changes; workflow wrapper загружает свой skill.
10. Установка из packaged contents работает после удаления исходного checkout; `--templates` использует соответствующий templateKind.

Во время разработки — только связанные тесты; перед завершением реализации — `npm test` и `npm run gen:docs:check`. Полную suite запускать через доступный background-механизм среды, не ручным polling.

Обновить README: все три классовых примера и `--opencode`, пути, supported aliases/efforts, scope rules, перезапуск OpenCode, отличие skill discovery от slash commands. Если появляются generated counts/tables, расширить `scripts/gen-docs.js`, затем выполнить `npm run gen:docs`. Добавить CHANGELOG entry без самостоятельного повышения версии.

### P5. Babysit runtime parity — обязательный этап перед финальной P4-проверкой

Спроектировать собственный OpenCode plugin/runtime для scheduler и уведомлений, определить его зависимости и ownership. Установщик сначала публикует runtime dependencies, затем потребляющие templates. Для babysit обязательны проверки нескольких сессий, busy-state, stop/error, повторного включения и завершения todo. Сохранить OMP-семантику arm/status/off, один timer на сессию, отсутствие лишних wakeups и честное ограничение: закрытый процесс не возрождается. Реализовать после P2 и до окончательного завершения P4.

## 6. Что требует решения перед реализацией

1. Состав агентов решён пользователем: все `AllCodexAgents`, как OMP; Anthropic aliases не добавлять.
2. Подтвердить OpenCode provider binding для этих OpenAI-моделей, включая возможность Codex subscription authentication. Имя `openai-codex` из OMP нельзя автоматически считать OpenCode provider ID.
3. Состав workflow решён: все девять OMP-команд, включая работающий babysit/babygoal runtime. Clock/checkpoint-watch/cli-run — отдельное расширение.

## Приложение: Repo map — cc-arch-hands

### Identity

Node.js ESM CLI-установщик с нулевыми runtime dependencies. Исследованная версия 0.15.1. Первый commit 2026-06-15. В `lib`, `test`, `templates`, `scripts` — 122 tracked files; это не общий размер репозитория и не подсчёт LOC.

### How to run / test / build

CI workflows в `.github/workflows` не обнаружены. Команды ниже подтверждены package.json и executable, а не CI:

- start: `node bin/cah.js --help`, `node bin/cah.js version`;
- test: `npm test` → `node --test --test-concurrency=1`;
- docs gate: `npm run gen:docs:check`;
- отдельного build/lint script нет.

### Read these files first, in this order

1. `lib/cli.js`: все lifecycle entry points и селекторы; churn #3, bug-keyword rank #8 по commits в `lib`; покрытие CLI/OMP tests.
2. `lib/skills.js`: повторно используемый безопасный tree installer; churn #9, bug-keyword rank #11; installer и Codex skill cases.
3. `lib/manifest.js`: model aliases и catalog contracts; churn #4; installer и generated-docs checks.
4. `lib/codex-skills.js`: минимальный пример adapter над tree installer; одна историческая правка; Codex skill tests.
5. `lib/omp-commands.js`: последний пример новой интеграции с preflight и runtime dependencies; одна историческая правка; OMP command tests.

`lib/binstall.js` — первый по churn и bug-keyword hits, но это shared Claude runtime, не основной путь нового файлового установщика. Высокие показатели сами по себе не доказывают дефектность.

### Team & process signal

- 193 commits: Marat K — 192 (99.48%), Ruslan Musakalimov — 1. Commit-author concentration указывает на bus factor 1, но не доказывает отсутствие других участников.
- История короткая: июнь 24, июль 11, август 8, сентябрь 148, октябрь пока 2 commits. Сентябрь — всплеск; по неполному октябрю тренд не выводить.
- Merge commits не обнаружены; squash/rebase по этому факту не различить.
- Regex `revert|hotfix|emergency|rollback` дал 10 совпадений, включая обычные fix/feat с этими словами. Это не 10 аварийных откатов.

### Caveats — what this report could NOT see

- Clone не shallow; working tree до исследования чистый. Commit messages содержательны.
- Выполнены help/version и один настоящий OMP lifecycle test: 1 passed, 0 failed. Sandbox находился внутри workspace и удалён test cleanup.
- Полная suite, coverage/LOC и per-file author silos не измерялись: это исследование интеграции, не readiness audit.
- Локальная пользовательская OpenCode-конфигурация не исследовалась. Настоящий OpenCode loader/model runtime не запускался; сведения о форматах получены из опубликованных docs/schema и upstream source.

### Open questions for the team

Поддерживаемый OpenCode release, provider coverage и обязательность полного runtime parity перечислены в разделе 6.

## Источники OpenCode

- https://opencode.ai/docs/config/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/commands/
- https://opencode.ai/docs/skills/
- https://opencode.ai/docs/models/
- https://opencode.ai/config.json
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/global.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/config.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/agent.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/command.ts
