# Сверка эффектов и учёт наблюдаемых потоков (A3)

Задача [#22](https://github.com/Tarolrr/screeps/issues/22), контракт `A.2` ([CONTRACTS-A](CONTRACTS-A.md) §4.2, §4.3, §5, §10), основание — [ARCHITECTURE](ARCHITECTURE.md) §5, §8, [RUNTIME-CONSTRAINTS](RUNTIME-CONSTRAINTS.md) «События и атрибуция энергии», [DESIGN](DESIGN.md) §3.

| Модуль | Назначение |
| --- | --- |
| `src/bot/observation/EventNormalizer.js` | `normalizeRoomEvents(roomSnapshot, cursor, options?)` → `Result<{events, gaps, cursor}>` |
| `src/bot/observation/EffectMatcher.js` | `matchEffects`, `observeOperations`, а также `applyEffect`, `retirementCheck` |
| `src/bot/models/FlowAccounting.js` | `accountFlows`, `closeWindow`, а также `mergeDelta`, `emptyWindow`, `spawnStarts`, `derivePileTransfers`, `bodyCost` |
| `src/bot/app/Reconciler.js` | `reduce(snapshot, stateView, pendingOps)` → `Result<ReconciliationPatch>` |

Все модули чистые: не обращаются к Game/Memory/глобалам, не используют API, подменяемые `dist2/mapPatch.js`. Тесты — `tests/bot/unit/reconcile/` (тот же набор с mapPatch и без).

## 1. События

- Идентичность — `eventKey(roomName, effectTick = observedAt − 1, originalArrayIndex)`. Индексы не перенумеровываются, одинаковые записи на разных индексах — разные события; переставленный захват сортируется по индексу и даёт тот же результат; повтор индекса — `REJECTED(INVALID_RECORD)`.
- Cursor: `processedThroughTick` = последний обработанный effectTick. Повтор того же тика — no-op (`events = []`, cursor прежний); другой `rawFingerprint` того же тика — `UNKNOWN(AMBIGUOUS_EFFECT)`.
- Пропущенные тики (`effectTick > processedThroughTick + 1`) → `EventGap(EVENT_GAP)`; `NOT_VISIBLE` → gap `NO_VISIBILITY`; `UNAVAILABLE` → gap `EVENT_GAP`. Cursor продвигается через gap: разрыв фиксируется один раз, нули не выдумываются. Первая обработка комнаты (cursor null) истории до себя не придумывает.
- Направление: в engine `transfer` пишет `objectId = creep, targetId = target`, `withdraw` — `objectId = structure, targetId = creep`. Поэтому `sourceId = objectId`, `targetId = data.targetId` всегда; вызывающий не записан, `actorId = null` для TRANSFER.
- `energyAmount`: TRANSFER энергии = amount; HARVEST = amount, если цель — source комнаты; иначе 0 DERIVED (минерал/депозит) — но только при полном списке sources: если A1 выбросил source (`sources.<id>.pos` в `missingFields`), энергия HARVEST — UNKNOWN, не 0; BUILD — `data.energySpent`, если есть, иначе для тела **без бустов** WORK `amount` (DERIVED; engine: `boostedEffect = buildEffect` без бустов), с бустами/без тела — UNKNOWN; REPAIR/UPGRADE — `data.energySpent` (OBSERVED) или UNKNOWN; прочие — 0 DERIVED. Тела берутся из `options.creepBodies` (id → body), которые Reconciler строит из того же снимка.

## 2. EffectMatcher

`matchEffects({operations, receipts, events, coverage, gaps, previous, current, expectations?})` → `EffectResult[]` (по operationKey). Активные состояния — PREPARED/ISSUED/UNKNOWN.

- **Семантика `actorRef`/`targetRef`** (предложение в контракт): значение — **имя собственного крипа** или **id объекта** (крип, EnergyNode, controller, construction site, source, spawn). Перед сопоставлением ссылка разрешается в id объекта по снимкам T−1/T (`ownCreeps[name].id`, затем id крипа, узла, объекта комнаты). `expectations.actorId/targetId` — сырые id объектов, используются как есть (для целей вне снимка: дороги, стены). Неразрешимый исполнитель или обязательная цель (transfer/withdraw/build/repair, либо любая заданная) → `UNKNOWN(MISSING_FIELD)`; исключение — RETURNED с кодом < 0 → NO_EFFECT (intent не принят).
- **Покрытие.** `coverage = [{roomName, effectTick}]` — пары, чей **полный** нормализованный список событий передан в `events` (Reconciler добавляет комнату, только если её cursor продвинулся в этом вызове, gap нет и лог полный; комнаты REJECTED/UNKNOWN/уже обработанные покрытия не дают). Без покрытия нельзя ни NO_EFFECT по отсутствию, ни CONFIRMED: окно кандидатов `[max(issuedAt, lastEffect.evaluatedAt), T−1]` должно быть целиком покрыто в комнате события (комната исполнителя; для withdraw — структуры) и не пересекаться ни с одним `EventGap`, иначе `UNKNOWN(EVENT_GAP|NO_VISIBILITY)` даже при найденном событии.

- **Receipt не подтверждает.** RETURNED с кодом < 0 — единственный receipt-основанный NO_EFFECT (intent не принят); RETURNED OK и THREW — не доказательство ни в одну сторону. Ошибка-receipt при найденном событии — конфликт, `UNKNOWN(AMBIGUOUS_EFFECT)`.
- **Мультимножество.** Строится граф «операция ↔ событие-кандидат» (тип, направление source→target, ресурс, effectTick в окне операции). CONFIRMED — только для компоненты ровно из одной операции и одного события; иначе все операции компоненты `UNKNOWN(AMBIGUOUS_EFFECT)`. Одинаковое событие, поданное дважды (тот же eventKey), — один кандидат.
- **NO_EFFECT по отсутствию** — только если effectTick = `current.tick − 1`, `previous` — соседний снимок (`previous.tick = issuedAt`; устаревший `previous` может показывать исполнителя в другой комнате), покрыты (`coverage`, без gap) **все** комнаты, где могли быть исполнитель или цель: комнаты исполнителя в `previous` и `current`, комнаты цели, ожидаемая комната и комнаты найденных кандидатов; комнаты видимы и исполнитель жив в `current`. То же покрытие всех возможных комнат требуется для CONFIRMED (единственность кандидата). Исполнитель погиб в этот тик → `UNKNOWN(AMBIGUOUS_EFFECT)`: смерть не освобождает спорную доставку. Пропущенное окно → `UNKNOWN(EVENT_GAP)`, невидимость → `UNKNOWN(NO_VISIBILITY)`.
- **Частичный transfer/withdraw/pickup**: `confirmedAmount` накопительный (`op.confirmedAmount + amount`) под тем же ключом; `effect.partial = true`, пока меньше `requestedAmount`; превышение — UNKNOWN. События, уже учтённые в `op.lastEffect` (по eventKeys и `evaluatedAt`), повторно не используются; операция, уже оценённая на этом снимке, возвращает свой `lastEffect` (повторная сверка идемпотентна и не выводит NO_EFFECT).
- **Spawn** (нет EVENT_SPAWN): CONFIRMED, если в `current.ownCreeps` есть крип с ожидаемым именем (`expectations.creepName` или `shortCreepName(operationKey)`), телом `expectations.body`, envelope `{operationKey, homeRoom}` совпадает. Без envelope — orphan, `UNKNOWN(AMBIGUOUS_EFFECT)`; другое тело/ключ — `UNKNOWN(NAME_COLLISION)`; другой home — `UNKNOWN(LEGACY_BINDING_CONFLICT)`. Отсутствие на T+1 при полном списке крипов — NO_EFFECT; после пропущенного окна — `UNKNOWN(EVENT_GAP)` (мог родиться и умереть). Подтверждение по живому/spawning крипу работает и после reset.
- **Pickup** — вывод из соседних снимков (DERIVED, требуется покрытие тика): остаток изменения cargo после событий, ровно одна соседняя куча, уменьшение кучи покрывает все притязания; без кучи рядом изменение остаётся в `unexplained`, а не считается pickup. **Move** — по позиции; NO_EFFECT только при соседнем снимке `previous.tick = issuedAt`, иначе UNKNOWN.
- PREPARED без receipt → `UNKNOWN(MISSING_FIELD)` (вызов мог состояться).
- `applyEffect(operation, effect)` применяет результат по `OPERATION_TRANSITIONS` (частичный — тот же state, растёт `confirmedAmount`; UNKNOWN не переходит в ISSUED; терминальные — `REJECTED(STALE_INPUT)`); повтор того же результата — no-op.
- `retirementCheck(operation, {current, expectation, observedBindings})` → `{retire, blockers}` — шлюз UNKNOWN_RETIRED (§5): состояние UNKNOWN; окно эффекта закрыто (`current.tick > issuedAt + 1`, иначе `LATENT_EFFECT`); комната видима; для spawn — полный список крипов, известный energyAvailable, нет крипа/spawning с ожидаемым именем, нет envelope с этим ключом и нет крипа без envelope и без legacy-роли с тем же телом (`UNRESOLVED_CANDIDATE`); для transfer/withdraw (MOVE/CAPACITY) — оба конца разрешимы и видимы в `current` с известными балансом и ёмкостью (`NODE_UNRESOLVED`, `ACTOR_NOT_VISIBLE`/`NODE_NOT_VISIBLE`, `NODE_BALANCE_UNKNOWN`, `CAPACITY_UNKNOWN`), и нет возможного продолжения: живой исполнитель рядом с целью, у отдающего есть энергия, у принимающего — свободная ёмкость (`CONTINUATION_POSSIBLE`). Погибший исполнитель, которого нельзя разрешить по текущему снимку, блокирует retirement (недоказуемо).

`observeOperations({events, previous, current})` (shadow, legacy): TRANSFER/HARVEST/BUILD/REPAIR/UPGRADE по событиям (`obs:<KIND>:<eventKey>`, CONFIRMED); SPAWN по новому имени в `spawn.spawning` между T−1 и T (`obs:SPAWN:<room>:<spawnId>:<name>:<T−1>`, стоимость тела DERIVED) — ровно один раз на старт; PICKUP/DROP (`OTHER`) по выводу из снимков, неоднозначные — effect UNKNOWN.

## 3. FlowAccounting

`accountFlows({previous, current, events, gaps})` → `READY(FlowDelta[])` по комнатам `current` (без `previous` — `[]`).

- Баланс комнаты — сумма её `energyNodes` (каждая единица один раз), **кроме REMOTE** (`remote:<room>:<sourceId>`, энергия в источнике чужой/нейтральной комнаты): источник — происхождение дохода harvest, а не запас; его убыль — это harvest, регенерация — не доход и не `unexplained`. REMOTE-узлы не бывают концами transfer. `spawnPool:<room>`/`energyAvailable` не добавляется.
- harvest своим крипом — доход; TRANSFER энергии между своими узлами — `internalTransfer` (никогда не доход), свой → чужой/не-узел — `externalOut`, чужой → свой — `externalIn`; переход cargo-узла между комнатами — `externalOut`/`externalIn` текущего груза. Своё = объект — узел снимка T−1/T или собственный крип. С контрактом A.3 tower — узел STORAGE_CONTAINER, transfer в tower станет внутренним без изменения кода (enum не перечисляется в модуле).
- spawnSpend — стоимость тела при первом появлении нового имени в `spawn.spawning` (один раз), только между соседними снимками: после разрыва тик старта неизвестен, интервал и так UNKNOWN.
- build/repair/upgrade — сумма `energyAmount` событий своих исполнителей (repair — и своих узлов-структур, т. е. tower); UNKNOWN остаётся UNKNOWN. Атака/лечение tower (`TOWER_ENERGY_COST = 10`, DERIVED) учитывается как `externalOut`: в `FLOW_FIELDS` нет поля defense.
- decayLoss — `ceil(amount/1000)` сохранившихся куч и потеря link→link `ceil(amount·0.03)` (DERIVED); расхождение не больше числа исчезнувших/подобранных куч и не больше `MAX_PILE_ROUNDING = 3` считается округлением распада (книжится в decayLoss; качество дельты не выше DERIVED).
- `unexplained` = изменение баланса − объяснённое; ≠ 0 → `UNEXPLAINED_BALANCE`, качество ESTIMATED. Отфильтрованный лог → `MISSING_FIELD`, качество ESTIMATED.
- Gap, невидимость, несоседние снимки, лог не за T−1 → дельта со **всеми** потоками UNKNOWN.

`closeWindow(windowStart, deltas, topologies?)`/`mergeDelta(window, delta, topology?)`: окна по 100 тиков; UNKNOWN-дельта делает все потоки окна UNKNOWN и не добавляет покрытых тиков; `complete` ⇔ 100 покрытых тиков и качество не UNKNOWN. Частичная сумма окна с разрывом не публикуется.

`topologyVersion(snapshot, room)` = fingerprint {id/тип/позиция узлов spawn, extension, storage, container, link, tower; id sources; мультимножество собственных крипов (включая spawning) по `legacyRole:тело(+буст)`}. Крипы берутся по всей империи: home на этапе A часто неизвестен, а перевозчик между комнатами не должен «мигать» топологией; любое изменение состава (гибель без замены, новое тело) меняет версию — консервативное направление. Окно хранит версию, только пока у всех сложенных дельт она одна; смена внутри окна или невидимая комната → `null` (A4: не доказано).

## 4. Reconciler

`reduce(snapshot, stateView, pendingOps)`; `pendingOps = {previous?: Snapshot (T−1 из heap), operations?, receipts?, expectations?}` (этап A — только `previous`).

1. `lastClosedTick < T − 1` → все комнаты `UNCERTAIN_FUNDING` (+ `EVENT_GAP`). `lastClosedTick = null` — разрыв, если в `strategyShadow` уже есть данные наблюдения (cursor, окна, bindings, observedOperations): CLOSE-записи потеряны; по-настоящему свежее состояние (данных нет) — не разрыв. `lastClosedTick` пишет шаг CLOSE, который добавляет A5: `state.close(tick)` StateStore — последняя запись тика T. Тик, потерянный из-за CPU-прерывания, поэтому корректно виден как разрыв.
2. События по комнатам с сохранённым cursor; патч `rooms.<room>.eventCursor`.
3. Потоки — только для комнат, чей cursor продвинулся в этом вызове (нет двойного учёта); gaps → UNKNOWN-дельты; если cursor был, а снимка T−1 нет (reset) — тик T−1→T UNKNOWN. Патч `rooms.<room>.flowWindows` (≤ 30, по `windowStart`).
4. Жизненный цикл: `observedBindings` для каждого собственного крипа — home из envelope (`CREEP_MEMORY`, OBSERVED), из spawn.spawning (`SPAWN_ROOM`, DERIVED), из прежней записи, иначе orphan `UNKNOWN`; lifeState SPAWNING/ALIVE; исчезнувший — DEAD при полном списке крипов, иначе UNKNOWN; DEAD удаляется через 100 тиков. `lastSeen` обновляется не чаще раза в 20 тиков без других изменений. Новый крип с envelope без записи операции (missing operation) → `UNCERTAIN_FUNDING`.
5. `observedOperations`: хранятся SPAWN, PICKUP/DROP и любые с effect ≠ CONFIRMED; событийные TRANSFER/HARVEST/BUILD/REPAIR/UPGRADE отражены только в окнах потоков (иначе лимит 1024 исчерпывается за сотни тиков). Хранение (`planObservedOperations`): CONFIRMED удаляются через 300 тиков и первыми при давлении лимита (`1024 − 64`); спорные (effect ≠ CONFIRMED) **не удаляются**, пока не разрешены — «разрешённая» означает лишь, что доказательство **передано закрытому окну потоков** (неопределённость сохранена в окне: AMBIGUOUS_EFFECT, качество ESTIMATED), а **не** что спор урегулирован; разрешённые спорные удаляются после CONFIRMED. Если лимит занят неразрешёнными спорными, новые необязательные (CONFIRMED) записи не добавляются, новые спорные — до жёсткого лимита 1024; потеря отмечается `MISSING_FIELD` (деградация; предлагается отдельный код).
6. Операции этапа B: `matchEffects`; UNKNOWN → reasonCode и `UNCERTAIN_FUNDING` комнаты-домена.
7. `UNEXPLAINED_BALANCE` → `UNCERTAIN_FUNDING`.

**DomainStatus на этапе A — только для текущего тика** (выход reduce, не персистится): `UNCERTAIN_FUNDING` не «залипает» и правило выхода «300 последовательных согласованных тиков» (ARCHITECTURE §5) не реализовано. Владелец хранимого статуса и счётчика — **этап B** (отложено решением координатора).

Идемпотентность: все патчи — `set` полного значения (или `delete`), значения, равные сохранённым, не выпускаются; `patchId = rc:<tick>:<hash(path, op, value)>` детерминирован. Повторный `reduce` на состоянии после применения своего патча с теми же входами даёт пустой список патчей; двукратное применение одного патча даёт то же состояние. Выход проверяется `validateReconciliationPatch`.

## 5. Отклонения и предложения к контракту

1. `normalizeRoomEvents` принимает необязательный третий аргумент `options.creepBodies` (вывод энергии BUILD из тела). Предложение: закрепить в §10.
2. `matchEffects` принимает `expectations` (имя, тело, home, id исполнителя/цели, комната, ресурс, целевая позиция): в `Operation` нет ожидаемого тела/имени/home/resourceType. Предложение: поля в Operation или отдельный DTO `OperationExpectation`.
3. В `ReconciliationPatch` нет места для `EffectResult[]`; путь `strategy.operations` на этапе A не пишется. Предложение (этап B): поле `effects` или путь операций для writer `observation`.
4. Нет поля `defense` в `FLOW_FIELDS` (траты tower на атаку/лечение) — сейчас `externalOut`. Предложение: `defense`.
5. `DomainStatus` не персистится (только выход reduce): правило «300 согласованных тиков» требует хранимого статуса и счётчика — пункт этапа B.
8. Семантика `actorRef/targetRef` (имя крипа или id объекта, разрешение по снимку) и вход `coverage`/`gaps` для `matchEffects` — в §10.
9. Код деградации хранилища наблюдений (сейчас `MISSING_FIELD`).
6. Событийные ObservedOperation не сохраняются (лимит 1024) — см. §4 п. 5.
7. `UNKNOWN` для PREPARED без receipt использует `MISSING_FIELD` (нет кода «receipt отсутствует»).

## 6. Что должен подтвердить A6 на реальном engine

- Направление и amount `EVENT_TRANSFER` для transfer/withdraw/link/tower; отсутствие `energySpent` в BUILD; данные HARVEST (минерал без resourceType).
- Отсутствие EVENT_SPAWN; появление `spawn.spawning` и spawning-крипа в `Game.creeps` на T+1 после `spawnCreep`; задержка `spawnTime` при блокировке выхода.
- Порядок обработки pickup и распада кучи в одном тике (допуск округления); куда падает drop (позиция T−1).
- Происходит ли transfer крипа в тик его смерти по TTL (влияет на «смерть в тик доставки»).
- REMOTE-узлы A1 (`remote:<room>:<sourceId>`) в реальных удалённых комнатах: убыль = harvest, регенерация без `unexplained`.
- Фильтрует ли A1 записи лога (тогда `entries.length < rawLength` и NO_EFFECT по отсутствию невозможен, а окна получают `MISSING_FIELD`/ESTIMATED).
- Потеря видимости и пропуск тиков при реальном CPU-дефиците/reset; `lastClosedTick` от A2.
