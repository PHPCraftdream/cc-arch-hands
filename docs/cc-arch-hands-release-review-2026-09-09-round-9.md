# Релизное ревью cc-arch-hands — раунд 9, 2026-09-09

## Вердикт

**После исправлений релизный кандидат готов по проверенному локальному контуру.**
Финальный полный набор: **755 tests, 749 passed, 0 failed, 6 skipped**.
Установка из npm-архива и новые регрессии на установленном runtime прошли.
Это не безусловное подтверждение кроссплатформенного выпуска: CI и другие
платформы остаются вне выполненных проверок.

В этом раунде подтверждены и исправлены **три P2 и один P3**.
Новых P0/P1 не подтверждено. Исправления выполнены сразу вместе с регрессиями,
а не оставлены рекомендациями на следующий раунд. Открытых замечаний этого
раунда не осталось.

## Объём и границы

- Исходная ревизия: `07ef217b77a67258320aeb596e8e45aea1529533`.
- Ретроспектива 3–9 сентября: `35dfd3e..07ef217`, 108 коммитов.
  Основной фокус — последние изменения cache/inspection API, их вызовы
  из migration/removal и тестовые контракты; дополнительно рассмотрены
  template/skill removal, файловый recovery и релизная упаковка.
- Это целевое ревью текущих механизмов и истории, не построчная сертификация
  всех исторических коммитов.
- Работа выполнена лично, без под-агентов, в отдельном detached worktree.
  Финальные проверки относятся к указанной базе с сопровождающими отчёт
  исправлениями, а не к неизменённой базе.
- Полный набор запускается командой из `npm test`
  (`node --test --test-concurrency=1`) с временным HOME/USERPROFILE.
  Пакетные установки и mutation fixtures тоже изолированы от реального HOME.
- Windows, Node `v24.12.0`, npm `11.13.0`.
- CI остаётся вне оценки по прежнему указанию пользователя. Linux/macOS,
  минимальная версия Node и реальный Claude Code в этом раунде не запускались.
- Версии, зависимости и CI-конфигурация не менялись; push и публикация
  не выполнялись. Системные часы не менялись. Ненужные 64-МБ наполнители
  из проверяемых orphan-race tests удалены до полного прогона.

## Реестр

| Приоритет | Замечание | Статус |
|---|---|---|
| P2-1 | Context migration теряет digest при публикации и cleanup | Закрыто |
| P2-2 | Ошибка первой inspection оставляет собственную пустую reservation | Закрыто |
| P2-3 | Orphan-race tests допускают несработавшую гонку и зависят от нагрузки | Закрыто |
| P3-1 | Несогласованный snapshot вызывает hash TypeError вместо conflict | Закрыто |

## P2-1 — Миграция передаёт metadata-only ожидание вместо полного snapshot

**Где:** `lib/transcript-stats.js:contextSidecar`,
`publishMigratedContext`, cleanup в `migrateLegacyRateContext`;
`lib/fs-atomic.js:removeOwnedRegularFile`.

Context reader сохранял только stat identity и прочитанные bytes отдельно.
В atomic publication передавалась одна identity, а в cleanup — снова только
identity. Поэтому условие операции не связывалось с конкретным содержимым.

**Воспроизведение:** native in-place write меняет содержимое с сохранением
размера и inode; utimes возвращает заранее заданный whole-second mtime.
Тесты строго проверяют равенство BigInt dev/ino/size/mtimeNs, то есть не
подменяют metadata и не рассчитывают на неточное округление timestamps.

- После чтения target более свежий C меняет его bytes. Мигратор всё равно
  заменял C более старым legacy-содержимым.
- После публикации target более свежий C меняет legacy source перед cleanup.
  Мигратор удалял C по совпавшей metadata identity.

До исправления оба теста возвращали старый contextWindowSize 300 000 вместо
400 000 и теряли соответствующую новую запись.

**Исправление:** `contextSidecar()` использует стабильный
`captureRegularFileSnapshot()`; полный expectedDestination с digest и размером
передаётся в публикацию target и оба пути удаления legacy source.

Кроме того, `removeOwnedRegularFile()` сравнивает прочитанные digest/bytes
с ожиданием **до rename в quarantine**. Уже известное несовпадение сохраняется
по исходному canonical path. Проверки после rename остаются: более поздняя
гонка по-прежнему может потребовать сохранения displaced payload в quarantine.

**Проверка закрытия:** `test/rate-context-cas.test.js`, два сценария;
дополнительная проверка known mismatch в
`test/atomic-snapshot-lifecycle.test.js`. Проверяются точные bytes,
возвращённая статистика и отсутствие ненужного displacement.
Те же тесты прошли против установленного из tarball runtime.

Первый полный набор выявил один существующий oracle, ожидавший payload именно
в quarantine. Он обновлён в
`test-support/installer-data-loss-scope.cases.js`: теперь требуется
`preserved: [canonical]`, пустой recovery, отсутствие quarantine payload
и точные bytes successor на исходном месте. Проверка сохранности не ослаблена.

Приоритет P2: сценарии затрагивают восстановимый context cache и корректность
условного удаления, а не подтверждённую потерю пользовательского settings.json.

## P2-2 — Reservation создаётся до inspection, но не освобождается при её ошибке

**Где:** `lib/fs-atomic.js:removeOwnedRegularFile`, начальный
`captureRegularFileSnapshot(path)`.

Функция сначала резервировала `<path>.cah-owned-remove`, затем читала файл
вне блока cleanup. При исключении оставалась собственная пустая reservation.
Немедленная повторная операция видела occupied/fresh slot вместо возможности
завершить удаление; приходилось ждать recovery freshness window.

**Воспроизведение:** постоянный EACCES только на чтении конкретного leaf
исчерпывает существующие bounded retries. Исходные bytes сохраняются,
но пустая reservation остаётся. Это fault injection чтения, а не утверждение
о фактическом отказе ACL на всех операциях этой директории.

**Исправление:** при ошибке initial inspection вызывается identity-checked
освобождение собственной пустой reservation, затем выбрасывается исходная
ошибка. Непустая или изменённая reservation не удаляется; ошибка cleanup
не маскирует исходный inspection error.

**Проверка закрытия:** regression проверяет исходные bytes, отсутствие пустого
slot и успешный немедленный retry. Второй negative guard создаёт чужой файл
в reservation во время отказа чтения: он должен сохраниться вместе с
исходным leaf. Оба проходят также на установленном runtime.

## P2-3 — Нагрузочные orphan-тесты не доказывают нужное чередование операций

**Где:** первые три сценария `test/fsutil-prune-orphans.test.js`.

Тесты создавали 64-МБ manifest, чтобы растянуть чтение, и запускали remover
с таймером либо проверкой появления reservation. Их успех зависел от того,
успеет ли дочерний процесс попасть в нужное окно. Один oracle принимал
`pruned === 1`, то есть зелёный результат допускал обычный prune без
сработавшего concurrent unlink. После `kill()` завершение child не ожидалось.

**Исправление:** использованы маленькие fixtures и управляемая граница native
read: filesystem mutation выполняется после чтения bytes, перед последующим
stat. Для mid-removal сценариев дополнительно требуется уже созданная
reservation. Каждый тест утверждает, что нужная граница действительно
сработала, и проверяет один точный результат операции.

Теперь отдельно покрываются исчезновение директории внутри initial snapshot,
исчезновение manifest после reservation и исчезновение обычного orphan-file
после reservation. Убраны 64-МБ наполнители, таймерные догадки и дочерние
remover-процессы; fixtures очищаются через test cleanup.
Два существующих final-unlink ENOENT-сценария сохранены.

**Проверка закрытия:** все пять orphan-тестов проходят. Новый oracle уже не
принимает обычный успешный prune вместо требуемой гонки.

## P3-1 — Совпадения stat недостаточно, если read сообщил отсутствие

**Где:** `lib/fs-atomic-identity.js:captureRegularFileSnapshot`.

Файл можно переименовать в sibling, получить настоящий ENOENT на read,
а затем вернуть тот же inode до второго stat. Metadata snapshots совпадали,
поэтому функция принимала сочетание present=false и существующей identity
за стабильный snapshot и вызывала `contentDigest(null)`.
Наружу выходил `ERR_INVALID_ARG_TYPE` из hash API вместо файлового conflict.

**Исправление:** stable-проверка учитывает present. Присутствующее содержимое
требует совпавших regular-file identities; отсутствие требует отсутствия
обеих identities. Несогласованное наблюдение отклоняется стандартным
managed-destination conflict до вычисления digest.

**Проверка закрытия:** native rename/read/restore в
`test/atomic-snapshot-lifecycle.test.js`; проверяются конфликт и исходные
bytes после восстановления имени. Приоритет P3: это корректность диагностики
и error contract; данный сценарий не публиковал и не терял пользовательские bytes.

## Проверки

| Проверка | Результат |
|---|---|
| Целевые новые и обновлённые тесты | 11 passed, 0 failed, 0 skipped |
| Первый полный набор | 755 tests: 748 passed, 1 failed, 6 skipped; устаревший quarantine oracle исправлен |
| Повторный полный набор | 755 tests: 749 passed, 0 failed, 6 skipped; 279,09 секунды |
| README / manifest | `npm run gen:docs:check` — passed |
| Production syntax | 31 файл, `node --check` — passed |
| Production source-size | Passed; максимум 992 строки при лимите 1000 |
| Фактический npm pack | 48 файлов, 179 923 байта архив, 692 333 байта распаковано |
| Пакетная установка | Default/opt-in install, doctor/list, reinstall/uninstall — passed |
| Runtime parity | 140 записей mine; 18 runtime-файлов соответствуют source с учётом sentinel |
| Companion-bin и probe CLI | Все четыре bin и start/status/stop — passed |
| Новые регрессии на установленном runtime | 6 passed, 0 failed, 0 skipped |

Добавлено шесть regression tests; три прежних race tests переписаны.
Skipped не приравниваются к passed. Пакет собран из финальных production bytes;
после пакетной проверки изменялся только существующий test oracle.

## Итог

В проверенном Windows-контуре блокирующих замечаний после исправлений
не осталось. Общий выпуск требует отдельного подтверждения исключённых
из scope платформенных/CI-проверок.

Сохраняемые улучшения раунда: digest проходит через весь цикл migration, known CAS mismatch
не перемещает canonical file, cleanup охватывает initial inspection,
а тесты доказывают срабатывание нужной файловой границы без искусственного
расширения окна нагрузки.
