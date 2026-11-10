# Replay: формат и запуск (STRAT-A1)

Основание: [CONTRACTS-A](CONTRACTS-A.md) §4.6, §10; [ARCHITECTURE](ARCHITECTURE.md) §9. Код: `src/bot/telemetry/ReplayExporter.js`, `tools/replay.js`, тесты `tests/bot/replay/**`.

## Что внутри фикстуры

`ReplayFixture {header, body}` (валидатор `validateReplayFixture` + `ReplayExporter.validateFixture`):

- `header`: версии (fixture/contract/build/schema/policy), `seed?`, `tickFrom..tickTo`, `rooms`, `contentFingerprint = fingerprint(body)`, `expectedReasonCodes`.
- `body`: `snapshots` (Snapshot DTO по tick, не больше 50), `state` (revision, control, `shadowRooms.{eventCursor, flowWindows}` — выбранные поля StateView), `events` (нормализованные), `expectedReasonCodes`, `expectedForecast`.

Не попадают: credentials, чужая Memory (`creeps`, `rooms`, `spawns`, ... — лишние поля отвергает схема как `UNKNOWN_FIELD`), ссылки на Game. `validateFixture` дополнительно: fingerprint каждого снимка, ключи вида password/token/secret/credential/apikey/authorization/cookie (`CREDENTIAL_LIKE_KEY`), размер canonical JSON ≤ `MAX_FIXTURE_CHARS` (262144), ≤ `MAX_SNAPSHOTS` (50).

## Экспорт (только по явной команде)

`exportFixture({snapshots, stateView, events, expectedReasonCodes, expectedForecast, buildId, policyVersion, seed})` — чистая функция; вне границ бросает `RangeError('FIXTURE_TOO_LARGE')`/`TypeError` с `.errors`. `serializeFixture(fixture)` — ограниченный canonical JSON для локального артефакта.

Триггер: `evaluateExportRequest(request, tick) -> {export, ticks, reason}`; экспорт выполняется только при `request.requested === true` (опционально `tickFrom`, `ticks ≤ 50`). Флаг — `Memory.strategyShadow.exportRequest` (контракт A.4; пишет только оператор), результат — ограниченный `Memory.strategyShadow.replayExport` (writer planning); порядок действий оператора и извлечение — в [SHADOW-A](SHADOW-A.md). Фикстура публикуется только в локальный тестовый артефакт; публичные отчёты не копируют приватный мир.

## Запуск

```text
node tools/replay.js [--pipeline <name>] [--require <module.js>] <fixture.json>
```

Раннер валидирует фикстуру (изменённый вход → `INVALID`, `FINGERPRINT_MISMATCH`), прогоняет pipeline **дважды** над deep-frozen копией (разные результаты → `MISMATCH`/`determinism`), сравнивает с ожиданием. Код выхода: 0 воспроизведено, 1 расхождение, 2 неверная фикстура/использование. Печатает canonical JSON `{status, pipeline, reasonCodes, outputFingerprint, mismatches, errors}`.

Pipeline по умолчанию `snapshot-summary`: энергия по классам узлов, число крипов (всего/spawning), неизвестные поля, hostiles; reason codes: `MISSING_FIELD` (есть `missingFields`), `NO_VISIBILITY` (комната NOT_VISIBLE), `EVENT_GAP` (журнал не CAPTURED у видимой комнаты или пропуск тика между снимками). Сравнивается только `reasonCodes`.

## Как подключается A5

Pipeline — чистая функция `run(fixture) -> {reasonCodes: string[], forecast?: {[room]: ForecastSummary}, summary?: object}`; вход deep-frozen, без Game/Memory/портов. A5 регистрирует её из модуля, который передаётся в `--require` (или из своего теста):

```js
const { registerPipeline } = require('tools/replay');
registerPipeline({ name: 'shadow-a5', compare: ['reasonCodes', 'forecast'], run: function (fixture) { /* StateView-часть + снимки -> компоненты A3/A4/A5 */ } });
```

`compare` выбирает, что сверяется с `body.expectedReasonCodes` / `body.expectedForecast`. Имя занято → ошибка регистрации.

## Reader и снимок (кратко)

`createReader({gameRead, cpu}).capture(tick, {rooms: 'ALL_VISIBLE'|string[], stage: 'FULL'}, observationBudget)` читает только через GameReadPort, ничего не пишет и не трогает геттер `creep.memory` (он создаёт `Memory.creeps[name]`). `legacyRole` читается только через опциональный метод порта `gameRead.creepMemory(name)` (его в `ports.js` пока нет — предложение контракту), иначе `null`. Бюджет: `admit` перед блоком крипов и перед каждой видимой комнатой; ответ не-READY возвращается как есть, без частичного снимка (курсор содержит `deferredRooms`); тик без снимка — разрыв наблюдения (`EVENT_GAP` в A3), не нулевой поток. Неизвестное число — `Measured` UNKNOWN + `MISSING_FIELD` и запись в `missingFields`. Журнал событий снимается сырым с `originalArrayIndex`.

## `missingFields` и «неприменимо» (STRAT-A1, ревью)

`missingFields` содержит только действительно пропавшие наблюдения. Отсутствие, определённое API движка, остаётся `Measured` UNKNOWN/null (`MISSING_FIELD`, как требует контракт), но **не** попадает в `missingFields`:

| Поле | Правило |
| --- | --- |
| `controller.safeModeTicks` | `Controller.safeMode` undefined = безопасный режим не активен: `measured(0)`, quality OBSERVED |
| `controller.progress/progressTotal/ticksToDowngrade` | неприменимо у нейтрального/ничьего контроллера (нет владельца и не `my`); у своего/чужого владельца отсутствие — реальный пробел |
| `source.ticksToRegeneration` | undefined, пока источник не восстанавливается; не пробел, если `energy` известна |
| `energyAvailable/energyCapacityAvailable` | существуют только в комнате с собственным контроллером |
| `creep.ticksToLive` | у spawning-крипа ещё нет TTL |
| `energyNodes[PILE].capacity` | ёмкость кучи/могильника/руин не определена |

Поля, где DTO требует целое (`controller.level`, `spawning.needTime/remainingTime`, hostile `hits/hitsMax`, `constructionSite.progress/progressTotal`, `body[i].hits/type`), не получают тихий 0: при невалидном значении подставляется запасное, а путь поля добавляется в `missingFields`. Отсутствующее `remainingTime` заменяется на `max(1, needTime)` — «не завершено», никогда не 0.

## Классификация энергетических узлов

`EnergyObjectType` контракта: spawn, extension, storage, container, link, terminal, creep, resource, tombstone, ruin, remote. Классы: spawn/extension → SPAWN_EXTENSION; storage/container/link/terminal → STORAGE_CONTAINER (link и terminal включены, так как контракт их допускает); creep → CARGO; energy resource/tombstone/ruin → PILE; источники чужих/ничьих комнат → REMOTE.

**Башни (tower)** входят в снимок как узел класса STORAGE_CONTAINER с `objectType: tower` (контракт A.3): иначе доставка в башню выглядела бы необъяснённым расходом. Labs, power spawn и nuker в стадии A опущены (не участвуют в энергетическом контуре этапа A); перенос энергии в них учитывается A3 как внешний расход с пометкой качества.

## Оговорки

- Частичный `scope.rooms`: cargo-узлы крипов вне перечисленных комнат в снимок не попадают (сами крипы остаются в `ownCreeps`).
- `tools/replay.js --require <module>` выполняет локальный модуль, выбранный оператором (регистрация pipeline); не передавайте непроверенные файлы.
- `ESTIMATE_ROOM_CPU = 0.3` (и 0.02 на крипа) в Reader не калиброваны; A6 измерит реальную стоимость на одноразовом сервере.
