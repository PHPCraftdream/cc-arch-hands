# Релизное ревью cc-arch-hands — раунд 5, 2026-09-09

## Вердикт

**Выпуск пока не рекомендую.** Подтверждены два P1: lifecycle нового
`settings.json.lock` и запись устаревшей probe-операции после утраты lease.
Оба сценария могут привести к восстановлению не той пользовательской настройки
либо к потере взаимного исключения.

Итого: **P0 — 0, P1 — 2, P2 — 3, P3 — 1.** CI и параллельная работа с ним
исключены из приоритетов и решения этого раунда по ранее полученному указанию.

## Объём и состояние проверки

- Проверенный product baseline после раунда 4: `8f4c05b`.
- HEAD на завершении: `408c397e2e9a21f527331838cc6c062f58e3c7bc`.
- История: 3–9 сентября; диапазон `35dfd3e..408c397`.
- После `8f4c05b` изменялись `.gitignore` и тесты/тестовые helpers; product
  пути `lib/`, `bin/`, `templates/` и `package.json` не менялись. Поэтому
  незакрытые product finding раунда 4 не могут считаться исправленными только
  по новым тестам или комментариям.
- Ревью выполнено лично, без под-агентов. Продуктовый код, версии и
  существующие тесты не изменялись; коммит раунда содержит только отчёт.
- Среда: Windows, Node `v24.12.0`, npm `11.13.0`. Дополнительные child process,
  временные файлы и установки создавались только вне репозитория. Искусственная
  CPU-нагрузка и изменение системных часов не использовались.

## Проверки

| Проверка | Результат |
|---|---|
| Targeted product suites: probe, fs-atomic, skill settings, doctor/preflight | 94 passed, 2 skipped, 0 failed |
| `npm run gen:docs:check` | Passed |
| Production `node --check` | 30 файлов, passed |
| Production source-size | Максимум 996 строк, лимит 1000 соблюдён |
| Фактический `npm pack --json` | 47 файлов; 175 439 байт архив, 676 768 байт распакованный пакет |
| Lifecycle из распакованного tarball | Default install, opt-in классы, doctor/list, reinstall и uninstall — passed |
| Установленные артефакты | 140 записей `mine`, 18 runtime-файлов соответствуют исходникам с учётом sentinel |
| Четыре установленные companion bin | Status, stamp, checkpoint-hint и probe: exit 0 и ожидаемый непустой вывод |

Полный bare `npm test` и эквивалентный явный список основных `test/*.test.js`
в текущем checkout завершаются ошибкой contract discovery: параллельная работа
создала вложенный `worktrees/fix-release-review-round-4-2026-09-09`, а
`test/discovery-contract.test.js` намеренно сканирует весь checkout и видит
копии тестов внутри этого worktree. Это не использовано как product finding и
не исправлялось в этом раунде. После запуска появился отдельный commit,
исправляющий worktree-root test; CI и связанные изменения находятся вне scope.

Отсутствие полного зелёного прогона на одном зафиксированном HEAD — само по
себе причина не объявлять выпуск принятым. Шесть skipped не приравниваются к
passed; Linux/macOS и удалённые CI jobs данным отчётом не подтверждены.

## P1-1 — Stale probe-операция перезаписывает backup успешного преемника

**Где:** `lib/probe.js:260`, `:417`, `:441`, `:512`.

`withProbeLease()` получает directory lease, но не передаёт её поколение и
ownership assertion в операции с log, backup и settings. После reclaim старая
операция продолжает выполнять публикации так, словно всё ещё владеет
переходом. CAS защищает от неподходящего destination snapshot, но не отличает
backup преемника от backup старого владельца: старая операция читает свежий
backup и затем легитимно с точки зрения собственного нового snapshot заменяет
его старым значением.

**Детерминированное двухпроцессное воспроизведение:**

1. A вызывает `enableProbe()` для `original-before-edit` и останавливается на
   штатной test boundary после чтения settings.
2. Владелец A намеренно состарен в fixture вместо ожидания пяти минут. Внешний
   редактор записывает новую пользовательскую `statusLine: new-user-command`.
3. Отдельный Node child B выполняет реальный `enableProbe()` и успешно пишет
   backup с `previous = new-user-command`.
4. A возобновляется, обнаруживает изменившийся settings, но уже успевает
   опубликовать свой backup. Затем `disableProbe()` выполняется штатно.

Результат:

```text
B: exit 0, CHILD_ENABLED
backup до возобновления A: new-user-command
backup после A: original-before-edit
disableProbe().restored: original-before-edit
settings.editorSetting: keep
```

То есть независимый editor key сохранился, но более свежая user statusLine
была заменена старой при `stop`. Воспроизведение использует отдельный child,
а не повторный вызов в том же процессе; ускорено только протухание timestamp.

**Исправление:** каждая мутирующая стадия probe-перехода, включая rollback и
удаление backup, должна проверять то же exact lease generation, которое было
получено на старте. При утрате lease A прекращает commit и не удаляет/переписывает
артефакты B. Лучше представлять многолистовой переход одной транзакцией с
поколением, а не независимыми snapshot-capture перед каждой записью.

**Критерий закрытия:** two-process stale-owner regression с A/B и внешним
editor; после успешного B последующее продолжение A не может изменить settings,
backup или log B. `disableProbe()` обязан восстановить именно
`new-user-command` и сохранить независимые editor keys.

## P1-2 — Published settings-lock небезопасно reclaim/release-ит чужие состояния

**Где:** `templates/skills/clock/SKILL.md:272`–`:290`,
`templates/skills/checkpoint-watch/SKILL.md:157`–`:175`; исполняемая модель
этого текста — `test/skill-settings-contract.test.js:59`, `:84`.

Это незакрытое P1 раунда 4: после него product templates не менялись.
Поставляемый алгоритм считает любой ownerless/unreadable lock abandoned,
переименовывает и рекурсивно удаляет его. Между `mkdir(settings.json.lock)`
и owner.json существует нормальное окно инициализации. Release без generation
проверки удаляет канонический lock, даже если его уже получил преемник.

Подтверждены три случая на точной исполняемой модели опубликованного текста:

- свежий ownerless lock удаляется и save сообщает success;
- ownerless lock с `user-recovery.txt` удаляется вместе с этими чужими данными;
- A делает mkdir и приостанавливается; B reclaim-ит lock и записывает owner,
  после чего A перезаписывает owner B;
- после expiry A B получает свежий lock, но старый release A удаляет lock
  живого B (`successorLockSurvived = false`).

**Исправление:** убрать самостоятельную неполную lease-реализацию из prose.
Нужен общий исполняемый settings mutator с generation/token, ownerless grace,
безопасной обработкой unreadable/foreign lock и release только своего поколения.
Потерявший lease writer не делает commit или cleanup преемника.

**Критерий закрытия:** tests на fresh ownerless reservation, unreadable owner,
чужое содержимое, pause/reclaim/resume и release старого владельца. Нельзя
удалять чужие данные; одновременно существует максимум один действительный
владелец.

## P2-1 — Валидный JSON-массив приводит к ложному успеху enableProbe

**Где:** `lib/probe.js:417`, `:441`, `:626`.

`readSettingsSnapshot()` успешно возвращает любой JSON. `enableProbe()` требует
объект только неявно: для `[]` присваивает `settings.statusLine = probeEntry`,
а `JSON.stringify([])` отбрасывает такое named property. Команда успешно
завершается, settings остаётся массивом, backup создан, но probe не активен.
После этого `disableProbe()` отвечает `ProbeNotActiveError`, и штатно убрать
backup нельзя.

**Воспроизведение:** `settings.json` содержит ровно `[]\n`.

```text
enableProbe(): returned successfully
settings: []
probeStatus: active=false, backupExists=true
disableProbe(): ProbeNotActiveError
```

Это не malformed JSON. Документированный контракт говорит о неверном JSON,
но не валидирует корневой тип валидного документа.

**Исправление:** до любых log/backup/settings изменений требовать plain object
для settings в enable, disable и status; сообщать path-specific
`MalformedSettingsError` или отдельную ошибку схемы. Не создавать backup/log
при отказе.

**Критерий закрытия:** arrays, строки, числа и booleans возвращают controlled
ошибку, не меняя три пути. Обычный `{}` по-прежнему поддерживается.

## P2-2 — Probe и навыки продолжают писать один settings через разные lock-и

**Где:** `lib/probe.js:30`, `:240`; templates используют
`settings.json.lock`, а probe — `settings.json.probe-lock`.

Это незакрытое P2 раунда 4. Даже корректный lifecycle lock в skills не
сериализует `enableProbe()`/`disableProbe()`, поэтому один собственный
settings writer может пройти после final bytes-check другого.

Ранее подтверждённая модель: clock удерживает `settings.json.lock` после
проверки и до rename; в этот момент реальный `enableProbe()` завершился с
успехом. Затем clock опубликовал старую statusLine; финальный файл содержит
clock, а probe backup остаётся. Два action сообщили success, одно потеряно.

**Исправление:** после исправления P1-2 использовать единый исполняемый
settings lock namespace и формат owner во всех mutator-ах — skills и probe.
Внешние writers, которые этого lock не принимают, всё ещё ограниченно
защищаются pre-commit проверкой, но это не заменяет общую сериализацию.

**Критерий закрытия:** реальный probe + settings mutator skill на общей
commit boundary: либо оба применяются последовательно к свежему JSON, либо
один получает busy/conflict; два success не могут потерять действие.

## P2-3 — Transient EPERM при создании publication fence выходит наружу

**Где:** `lib/fs-atomic-publication.js:796`–`:808`.

Это незакрытое P2 раунда 4: product source после него не менялся. beginFence
повторяет только `EEXIST`; единичный `EPERM`, `EACCES` или `EBUSY` от
`mkdirSync(path.cah-owned-publish)` сразу бросается наверх, несмотря на
RETRY_CODES в том же модуле.

В полном прогоне раунда 4 был raw EPERM от конкурентного publisher. Отдельный
повтор тогда прошёл, поэтому в этом раунде механизм дополнительно изолирован:
в child process один вызов mkdir нужного fence возвращал `EPERM`, следующая
попытка могла бы пройти.

```text
первый writeFileAtomic: raw EPERM, destination отсутствует
второй вызов без инъекции: payload успешно опубликован
```

**Исправление:** добавить bounded retry transient ошибок именно для acquire
fence, с повторной ownership/identity проверкой и ожидающим backoff. Постоянный
permission error должен завершаться ограниченно и без изменения чужого fence.

## P3-1 — Publication retry использует busy-wait

**Где:** `lib/fs-atomic-publication.js:81`, `:808`, `:909`.

`sleepSync()` — цикл `while (Date.now() < end)`. При конкуренции на fence
до 100 попыток тратят процессор вместо ожидания; active pauses усугубляют
взаимное влияние timing-sensitive publishers. Это статическое наблюдение,
не искусственный нагрузочный эксперимент и не замер процента CPU.

**Улучшение:** использовать ожидающий backoff (`Atomics.wait`, как в
lease-lock) или асинхронный таймер на подходящем API. Общий deadline и
ограничение попыток сохранить.

## Готовность и следующий порядок работ

Пакет собирается и обычный installed runtime работает. Но текущие P1 относятся
к сохранности пользовательских settings и не должны обходиться как flaky
тесты:

1. Закрыть lease generation ownership во всех probe side effects.
2. Заменить published settings-lock единым безопасным mutator-ом и подключить
   к нему probe.
3. Добавить transient fence retry, затем повторить полный прогон на одном
   зафиксированном HEAD и tarball smoke.
4. Исправить schema validation settings и active wait.

CI и его параллельные worktree-изменения намеренно не входят в этот вердикт.
Публикация, push, version bump и product changes этим отчётом не выполняются.
