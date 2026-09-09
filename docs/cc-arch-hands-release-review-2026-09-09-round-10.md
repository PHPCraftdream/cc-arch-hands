# Релизное ревью cc-arch-hands — раунд 10, 2026-09-09

## Вердикт

**После исправлений релизный кандидат готов по проверенному локальному контуру.**
Полный набор: **768 tests, 762 passed, 0 failed, 6 skipped**.
Пакетная установка, companion-bin, probe и offline-запуск CLI из tarball прошли.

Подтверждены и исправлены **два P2 и один P3**. Новых P0/P1 не подтверждено.
Открытых замечаний этого раунда не осталось.
CI и другие платформы не оценивались, поэтому безусловную кроссплатформенную
готовность этот отчёт не заявляет.

## Объём

- Исходная ревизия: `2b798f9e95f74ca621c3f2028f2856cb7e20ddcf`.
- Ретроспектива 3–9 сентября: `35dfd3e..2b798f9`, 109 коммитов.
  Проверены текущие потребители последних filesystem/cache изменений,
  диагностика CLI, связь doctor с installer, пользовательские команды
  и релизный состав пакета.
- Дополнительно рассмотрены scope/template handling, optional install classes,
  README/CONTRIBUTING, generated-doc contracts и update notice.
  Это целевой аудит рисков, не построчная сертификация всей истории.
- Работа выполнена лично, без под-агентов, в отдельном detached worktree.
  Проверки относятся к базе с сопровождающими этот отчёт исправлениями.
- Полный набор выполнялся командой из `npm test`
  (`node --test --test-concurrency=1`) с временным HOME/USERPROFILE.
  Пакетные проверки использовали отдельные установки и npm-cache.
- Windows, Node `v24.12.0`, npm `11.13.0`.
- CI остаётся вне оценки по прежнему указанию пользователя. Linux/macOS,
  минимальная версия Node и реальный Claude Code не запускались.
- Версии, зависимости и CI-конфигурация не менялись; push и публикация
  не выполнялись. Системные часы не менялись, искусственная CPU-нагрузка
  не создавалась.

## Реестр

| Приоритет | Замечание | Статус |
|---|---|---|
| P2-1 | Doctor считает agent/command/skill-ссылки пригодными для установки | Закрыто |
| P2-2 | Одноразовые npx-примеры используют bin alias вместо package name | Закрыто |
| P3-1 | Некорректная версия закрепляется в update-cache или возвращается как объект | Закрыто |

## P2-1 — Health gate расходится с действительным installer

**Где:** `lib/cli.js:classifyPath` и использующие его doctor/list.

Структурная проверка leaf выполнялась только для runtime bins. Остальные
классы читались через readFileSync: ссылка на файл с нашим sentinel получала
state=mine, dangling symlink — state=missing.

В то же время mutating filesystem API отвергает symlink leaf. В результате
полностью установленное дерево с одной agent-ссылкой давало doctor exit 0,
хотя `install --only agents` завершался с exit 1. Это ложный положительный
результат health gate, а не только неточная подпись в таблице.

**Воспроизведение:** реальная установка в отдельный HOME сначала проходит
doctor. Первый managed agent заменяется symlink на те же bytes; installer
отказывает, исходный doctor продолжает сообщать здоровое состояние.
Дополнительные случаи проверяют valid и dangling symlink через classifyPath.

**Исправление:** все non-runtime leaves проверяются через lstat до чтения.
Нерегулярные entries классифицируются как foreign. Для runtime сохранён
его более строгий structural preflight, включая hardlink policy.
Проверяется сам leaf; поддержка настроенных ссылочных ancestors не отменяется.

**Проверка:** `test/doctor-leaf-types.test.js`, три теста.
Проверяются согласованные exit codes, сохранение symlink и точные bytes target.
Все три воспроизводили дефект до изменения и проходят после.
Те же проверки прошли против CLI распакованного npm-пакета.

## P2-2 — README подменяет имя пакета его коротким executable alias

**Где:** примеры в `README.md`, соответствующее правило в `CLAUDE.md`;
для единообразия также обновлены команды в `bin/cah-stamp.js`.

Package name — `cc-arch-hands`, тогда как `cah` — одно из имён bin.
Quick start обещает одноразовый запуск без npm-установки, но многие следующие
примеры использовали `npx cah ...`.

По [документации npm](https://docs.npmjs.com/cli/v11/commands/npx/#description),
при отсутствии явного --package первый positional argument используется как
package specifier; executable выбирается из bin этого пакета. Следовательно,
без заранее доступной локальной/глобальной команды короткое имя не гарантирует
запуск нашего пакета. Вывод не зависит от того, существует ли сейчас отдельный
пакет с именем cah; такой пакет не устанавливался и не исполнялся.

**Исправление:** одноразовые примеры используют `npx cc-arch-hands`.
README явно различает package name и executable alias.
Обычная команда `cah` после npm-установки остаётся поддержанной.
Актуализированы инструкция для добавления примеров и update notice;
проверки README inventory и текста notice обновлены на правильное имя.

**Проверка:** новый `test/npx-package-contract.test.js` связывает npx-примеры
с package.json.name, проверяет примеры для всех навыков/классов и отсутствие
ошибочного alias в README, CLAUDE и notice. До исправления тест падал.
Дополнительно выполнен offline `npm exec` с явным локальным tarball, отдельным
cache и изолированными user/global npm-config paths. Команда
`cc-arch-hands version` успешно выдала ожидаемые version и registry counts.

## P3-1 — Update-cache проверяет freshness, но не пригодность latestVersion

**Где:** `lib/update-check.js:cacheIsFresh`, fetch/fallback paths
и ветка выбора concurrent cache record.

Свежая запись с latestVersion=42, объектом либо невалидной строкой считалась
достаточной для TTL и не обновлялась. Refresh с ошибочным строковым ответом
мог заменить последнюю корректную версию. При неуспешном fetch fallback
возвращал cached object вместо string|null.
Это могло подавить уведомления об обновлении до истечения TTL.

**Исправление:** добавлена единая проверка версии через существующий SemVer
parser. Она применяется к cache, результату fetch, concurrent winner и fallback.
Корректный `latestVersion: null` по-прежнему означает negative cache и
подавляет повторные запросы в пределах TTL. Недопустимые записи ремонтируются,
невалидный fetch сохраняет последнюю корректную версию.
Допустимые whitespace/v-prefix нормализуются перед отображением.

**Проверка:** девять тестов в `test/update-cache-validation.test.js`:
неправильные типы и строка, invalid fetch, ошибочный fallback, negative-cache
TTL, concurrent malformed record, cached/fetched normalization.
Основные отрицательные сценарии падали до изменения; после исправления
весь набор проходит, включая запуск против установленного runtime.
Проверки lease ownership и destination CAS сохранены.

Приоритет P3: это восстановление некорректного advisory cache и error/data
contract; основная работа installer и hooks не зависела от успешного update check.

## Проверки

| Проверка | Результат |
|---|---|
| Новые регрессии | 13 passed, 0 failed, 0 skipped |
| Полный набор | 768 tests: 762 passed, 0 failed, 6 skipped; 254,43 секунды |
| README / manifest | `npm run gen:docs:check` — passed |
| Production syntax | 31 файл, `node --check` — passed |
| Production source-size | Passed; максимум 992 строки при лимите 1000 |
| Фактический npm pack | 48 файлов; 179 834 байта архив, 692 784 байта распаковано |
| Пакетная установка | Default/opt-in install, doctor/list, reinstall/uninstall — passed |
| Runtime parity | 140 записей mine; 18 runtime-файлов соответствуют source с учётом sentinel |
| Companion-bin / probe | Четыре bin и start/status/stop — passed |
| Регрессии против упакованного CLI / установленного runtime | 12 passed, 0 failed, 0 skipped |
| Offline npm exec с локальным tarball | Exit 0, ожидаемый CLI banner |

Skipped не считаются passed. Все CLI install tests и пакетные установки
изолированы от реального HOME. После полного прогона добавлен только отчёт;
при переносе в основную ветку проверяется побайтовое совпадение с tested tree.

## Итог

Обнаруженные проблемы исправлены на месте. Проверенный Windows-кандидат
готов к релизу; общий кроссплатформенный выпуск требует отдельного подтверждения
исключённых из scope платформенных/CI-проверок.

Сохраняемые улучшения: doctor применяет ту же структурную границу, что и
installer; одноразовые команды называют пакет однозначно; пригодность cache
проверяется до применения TTL и выбора fallback.
