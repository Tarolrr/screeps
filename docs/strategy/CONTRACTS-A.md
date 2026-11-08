# Контракты этапа A (`contract A.3`)

Статус: **зафиксировано задачей [#19](https://github.com/Tarolrr/screeps/issues/19) (STRAT-A0)**, версия `A.2` после независимого ревью. Основание — [ARCHITECTURE](ARCHITECTURE.md) §1–§9, [INTEGRATION](INTEGRATION.md), [RUNTIME-CONSTRAINTS](RUNTIME-CONSTRAINTS.md), [DESIGN](DESIGN.md) §3. Код контракта: `src/bot/domain/**` (версия — `src/bot/domain/version.js`: `CONTRACT_VERSION = 'A.2'`, `SCHEMA_VERSION = 1`), раскладка состояния — `src/bot/domain/stateLayout.js`, порты и каркас — `src/bot/app/**`, `src/bot/integration/LegacyAdapter.js`, `src/bot/main.js`, `src/bot/stageA.js`, сборка — `tools/build-strategy.js`.

Параллельные задачи A1–A6 опираются на этот документ и **не меняют** перечисленные здесь имена, поля, enum, пути и инварианты.

## 0. Правила изменения

1. Изменение контракта (поле DTO, enum-значение, reason code, путь/владелец в Memory, сигнатура из §10, порядок фаз, формат ключей/fingerprint) — **только через координатора**: решение фиксируется, `CONTRACT_VERSION` повышается, запись добавляется в «Историю».
2. Делегату не хватает поля — он не расширяет DTO сам, а сообщает в отчёте; временно данные живут во внутренних структурах его модуля (не в общих DTO и не в Memory).
3. Новая функция внутри **своего** write scope (§10) без изменения общих DTO контрактом не считается.
4. Fingerprint (`fnv1a64` над canonical JSON) и форматы ключей — persisted-формат: менять только с миграцией.

## 1. Слои и кто кого вызывает

| Слой / модуль | Может вызывать / получает | Не может |
| --- | --- | --- |
| `domain/**` | только `domain/**` | Game, Memory, RawMemory, PathFinder, console, `dist2`, порты |
| `models/**`, `planning/**`, расчётная часть `scheduling/**` | `domain/**`; значения на вход, Result на выход | то же, что domain |
| `observation/ScreepsReader` (A1) | `GameReadPort`, `CpuPort`, бюджет наблюдения, `WorldSnapshotBuilder` | MemoryPort, изменяющие методы Game |
| `state/**` (A2) | `MemoryPort` (strategy-namespaces), `domain/**` | Game, legacy namespaces Memory |
| Shadow-компоненты A3–A5 (`ComponentSpec`) | `frame.result(name)`, `frame.services = {clock, cpu, log, state}` (`state` — API StateStore без MemoryPort) | GameReadPort, MemoryPort, gateway, Game/Memory, функции legacy |
| `app/**` | порты clock/cpu/log, все слои | изменяющие методы Game, MemoryPort |
| `integration/LegacyAdapter` | dist2-модули, глобальный `Game` (временное исключение ARCHITECTURE §1) | новые namespaces Memory |
| `main.js`, `stageA.js` (composition root) | создают порты и раздают: GameReadPort → только Reader, MemoryPort → только StateStore | top-level побочные эффекты |

Gateway на этапе A не существует. `TickRunner.register` отвергает в `ComponentSpec` любые ключи, кроме `name, phase, budgetClass, estimateCpu, bypassCooldown, inputFingerprint, run`: зависимости компонента — замыкание (без портов) и `frame.services`.

## 2. Результаты и reason codes

`src/bot/domain/results.js`. Все результаты — простые JSON-объекты (shallow frozen), различимые после `JSON.parse(JSON.stringify(x))`:

| Конструктор | Объект |
| --- | --- |
| `READY(value, inputFingerprint)` | `{kind:'READY', value, inputFingerprint}`; value ≠ undefined/function |
| `DEFERRED(cursor, reason)` | `{kind:'DEFERRED', cursor, reason}`; cursor JSON-safe или null |
| `UNKNOWN(reason, missingFields)` | `{kind:'UNKNOWN', reason, missingFields}`; список отсортирован, уникален; поля `value` нет |
| `REJECTED(reasonCode, evidence)` | `{kind:'REJECTED', reasonCode, evidence}`; evidence — plain JSON-объект или null |

Также `ResultKind`, `isReady/isDeferred/isUnknown/isRejected/isResult`, `validateResult(r)`. READY не проверяет value глубоко (CPU). Отказ — `REJECTED`, не исключение.

`ReasonCode` (frozen; `REASON_CODE_LIST`, `isReasonCode`, `assertReasonCode`):

| Код | Источник / зачем |
| --- | --- |
| `STALE_OWNER`, `STALE_INPUT`, `NO_VISIBILITY`, `INSUFFICIENT_LIQUIDITY`, `CRITICAL_DEADLINE`, `BUDGET_DEFERRED`, `AMBIGUOUS_EFFECT`, `INCOMPATIBLE_SCHEMA`, `UNSUPPORTED_CAPABILITY`, `LEGACY_BINDING_CONFLICT` | минимум ARCHITECTURE §4 |
| `EVENT_GAP` | §5: потерянный интервал событий, не заполняется нулями |
| `UNEXPLAINED_BALANCE` | DESIGN §3: необъяснённая разница баланса |
| `UNCERTAIN_FUNDING` | §5: домен потерял доказательства |
| `SHADOW_ONLY` | решение shadow, не исполнялось |
| `NO_HISTORY` | DESIGN §3: меньше 3 завершённых окон |
| `MISSING_FIELD` | обязательное наблюдение отсутствует → UNKNOWN, не 0 |
| `INVALID_RECORD` | DTO/persisted record не прошёл валидацию → карантин |
| `NAME_COLLISION` | §5: короткое имя совпало для другого полного ключа |
| `COMPONENT_FAULT`, `RETRY_COOLDOWN`, `CIRCUIT_OPEN` | §7: FaultBoundary |

## 3. Enum (`src/bot/domain/enums.js`)

| Enum | Значения |
| --- | --- |
| `Phase` | `BOOT, OBSERVE, RECONCILE, CRITICAL, FORECAST, PLAN, ADMIT, EXECUTE, CLOSE` |
| `RoomMode` | `legacy`, `shadow`, `adaptive-v1` |
| `EffectiveOwner` | `legacy`, `adaptive-v1`, `unconfirmed` |
| `NewSystemStatus` | `OFF`, `SHADOW`, `SUSPENDED` |
| `Quality` | `OBSERVED, DERIVED, ESTIMATED, STALE, UNKNOWN` |
| `Visibility` | `VISIBLE, NOT_VISIBLE` |
| `EnergyNodeClass` → `ENERGY_NODE_OBJECT_TYPES` | `SPAWN_EXTENSION`→spawn/extension; `STORAGE_CONTAINER`→storage/container/link/terminal; `CARGO`→creep; `PILE`→resource/tombstone/ruin; `REMOTE`→remote |
| `EventLogStatus` | `CAPTURED, NOT_VISIBLE, UNAVAILABLE` |
| `NormalizedEventType` | `ATTACK, OBJECT_DESTROYED, ATTACK_CONTROLLER, BUILD, HARVEST, HEAL, REPAIR, RESERVE_CONTROLLER, UPGRADE_CONTROLLER, EXIT, POWER, TRANSFER, OTHER` |
| `OperationState` + `OPERATION_TRANSITIONS` | `PREPARED→{ISSUED, NO_EFFECT, UNKNOWN}`; `ISSUED→{ISSUED, CONFIRMED, NO_EFFECT, UNKNOWN}`; `UNKNOWN→{UNKNOWN, CONFIRMED, NO_EFFECT, UNKNOWN_RETIRED}`; `NO_EFFECT→{ISSUED}`; `CONFIRMED`, `UNKNOWN_RETIRED` терминальны |
| `ReservationKind` | `SPEND, MOVE, CAPACITY` |
| `ReservationState` + `RESERVATION_TRANSITIONS` | `RESERVED→{ISSUED, RELEASED}`; `ISSUED→{ISSUED, SETTLED, PARTIAL, RELEASED, RETIRED}`; `PARTIAL→{PARTIAL, SETTLED, RELEASED, RETIRED}`; `SETTLED`, `RELEASED`, `RETIRED` терминальны |
| `LifeState` | `SPAWNING, ALIVE, DEAD, MISSING, UNKNOWN` |
| `HomeSource` | `LEGACY_ORDER, CREEP_MEMORY, SPAWN_ROOM, CURRENT_ROOM, UNKNOWN` |
| `ObservedOperationKind` | `SPAWN, TRANSFER, PICKUP, BUILD, REPAIR, UPGRADE, HARVEST, OTHER` |
| `CalendarEntryKind` | `INCOME, PAYMENT, DEADLINE` |
| `DomainStatus` | `OK, UNCERTAIN_FUNDING` |
| `MigrationStatus` | `NONE, RUNNING, CANCELLED, DONE` |
| `PatchOp` | `set`, `delete` |
| `StateWriter` | `state` (A2), `observation` (A3), `finance` (A4), `planning` (A5) |
| `MeasurementUnit` | `energy/tick`, `work/tick`, `coverage` |
| `Criticality` | `CRITICAL, REQUIRED, OPTIONAL` |
| `CallReceiptKind` | `RETURNED, THREW` |
| `EffectKind` | `CONFIRMED, NO_EFFECT, UNKNOWN` |
| `StateStatus` | `OPEN, READ_ONLY, SUSPENDED` |
| `BudgetClass` | `exempt, critical, optional` |

Переходы операции: `ISSUED→ISSUED` и `UNKNOWN→UNKNOWN` — рост `confirmedAmount` при частичном подтверждении; `NO_EFFECT→ISSUED` — повтор **того же** `operationKey` с **новым** `commandId` после повторной проверки предпосылок; `UNKNOWN→ISSUED` запрещён (возможно исполненная операция не повторяется по предположению); `PREPARED→UNKNOWN` — reset/CPU-срыв между записью намерения и receipt; `PREPARED→NO_EFFECT` — только если доказано, что вызова не было. Помощники `isEnumValue`, `canTransition`.

## 4. DTO (`src/bot/domain/dtos.js`, типы — `src/bot/domain/types.js`)

Правила валидаторов (`validateX(value) → {ok:true} | {ok:false, errors:[{path, code}]}`, ≤20 ошибок):

- объекты и массивы только plain: Game-объекты, `RoomPosition`, Map, экземпляры классов → `NON_PLAIN_PROTOTYPE`; массив с дополнительными свойствами → `ARRAY_EXTRA_PROPERTY`; числа конечные (`NAN`, `INFINITY`); обязательное поле отсутствует/undefined → `REQUIRED`/`UNDEFINED`; лишнее поле → `UNKNOWN_FIELD`; превышение лимита длины → `TOO_LONG`/`TOO_MANY_KEYS`;
- неизвестное измеримое значение — `Measured = {value: number|null, quality, reason: ReasonCode|null}`; `value === null ⇔ quality === 'UNKNOWN'`, при UNKNOWN `reason` обязателен (`measured(value, quality='OBSERVED')`, `unknownMeasure(reason)`);
- коллекции — массивы, отсортированные по стабильному id (`NOT_SORTED_UNIQUE`), или records по ключу; позиции `{roomName, x, y}`; тики — целые ≥ 0.

Обозначения: `M` — Measured, `?` — допускает null, `fp` — fingerprint.

### 4.1 Snapshot (A1)

**Snapshot** (`validateSnapshot(s, {checkFingerprint})`, `snapshotFingerprint(s)`): `dtoType:'Snapshot'`, `contractVersion:'A.2'`, `tick`, `shard?`, `captureStage: CRITICAL|FULL`, `cpu: {used, limit, tickLimit, bucket: M}`, `rooms: {[room]: RoomSnapshot}`, `ownCreeps: {[name]: CreepSnapshot}`, `missingFields`, `fingerprint`. Fingerprint считается по всем полям, **кроме** `SNAPSHOT_FINGERPRINT_EXCLUDED = ['fingerprint', 'cpu']`: показания CPU меняются при каждом снятии и не должны делать тот же мир «изменившимся». Инварианты: ключи совпадают с `roomName`/`name`; `room.tick == tick`; `nodeId` энергии уникален по всему снимку.

**RoomSnapshot**: `roomName`, `tick`, `visibility`, `controller?`, `energyAvailable: M`, `energyCapacityAvailable: M`, `energyNodes` (по nodeId), `spawns`, `sources`, `hostiles`, `constructionSites` (по id), `eventLog`, `missingFields`. `NOT_VISIBLE` ⇒ пустые списки, controller null, eventLog не CAPTURED.

- **EnergyNode**: `nodeId` (id объекта; `creep:<name>` для CARGO; `remote:<room>:<sourceId>` для REMOTE), `nodeClass`, `objectType` ∈ классу, `roomName`, `pos?`, `amount: M`, `capacity: M`.
- **CreepSnapshot**: `name`, `id?`, `roomName?`, `pos?`, `spawning`, `body: BodyPart[]`, `ticksToLive: M`, `store: {energy, capacity: M}`, `legacyRole?`, `strategyEnvelope: {operationKey, homeRoom, ownerEpoch}?`. **BodyPart**: `type`, `boost?`, `hits 0..100`.
- **SpawnSnapshot** `{id, name, roomName, pos, spawning: {name, needTime, remainingTime}?}`; **SourceSnapshot** `{id, pos, energy, energyCapacity, ticksToRegeneration: M}`; **ControllerSnapshot** `{id, my, ownerName?, reservationOwner?, level 0..8, progress, progressTotal, ticksToDowngrade, safeModeTicks: M}`; **HostileSnapshot** `{id, ownerName?, pos, body, hits, hitsMax}`; **ConstructionSiteSnapshot** `{id, structureType, pos, my, progress, progressTotal}`.
- **EventLogCapture**: `effectTick = observedAt − 1`, `observedAt == room.tick`, `status`, `rawLength?`, `rawFingerprint?`, `entries: RawEventEntry[]?` (CAPTURED ⇔ все три не null). **RawEventEntry** `{originalArrayIndex, event, objectId?, data: json?}`; фильтрация не перенумеровывает индексы.

### 4.2 События и потоки (A3)

**NormalizedEvent**: `eventKey` (= `eventKey(roomName, effectTick, originalArrayIndex)`), `roomName`, `effectTick = observedAt − 1`, `observedAt`, `originalArrayIndex`, `type`, `rawEvent`, `actorId?`, `sourceId?`, `targetId?`, `resourceType?`, `amount: M`, `energyAmount: M`, `rawFingerprint`.

| type | `amount` (эффект/прогресс) | `energyAmount` (энергия перемещена/израсходована) |
| --- | --- | --- |
| TRANSFER (в т. ч. withdraw) | фактически перенесённое количество `resourceType`; направление `sourceId → targetId` (для withdraw развёрнуто: источник — структура) | = amount при `resourceType='energy'` (валидатор проверяет), иначе 0 (DERIVED) |
| HARVEST | добытое количество | = amount для энергии; для минералов 0 (DERIVED) |
| BUILD | прирост прогресса (boosted effect, `data.amount`) | `data.energySpent`, если есть (OBSERVED); иначе выводится из тела без бустов (DERIVED) или UNKNOWN — **не** равен amount |
| REPAIR | восстановленные hits | `data.energySpent` (OBSERVED) или UNKNOWN |
| UPGRADE_CONTROLLER | прогресс контроллера | `data.energySpent` (OBSERVED) или UNKNOWN |
| прочие (ATTACK, HEAL, EXIT, …) | значение события или UNKNOWN | 0 (DERIVED) |

Withdraw и transfer в событии не различаются (нет признака вызывающего) — тип один, `TRANSFER`. Pickup/drop событий не имеют (нет `EVENT_PICKUP`): A3 выводит их из соседних снимков (качество не выше DERIVED) в `FlowDelta.flows.internalTransfer` и `ObservedOperation{kind:'PICKUP'}`.

**EventGap** `{roomName, fromTick ≤ toTick, reasonCode}`. **EventCursor** `{roomName, processedThroughTick < lastObservedAt, lastObservedAt, lastRawFingerprint?}` (processedThroughTick — последний обработанный effectTick).

**FlowDelta** `{roomName, fromTick < toTick, flows: Flows, quality, reasonCodes}`; **FlowWindow** `{roomName, windowStart (кратно 100), windowEnd = windowStart+100, ticksCovered 0..100, complete (⇒ ticksCovered=100), topologyVersion?, flows, quality, reasonCodes}`. `Flows` — все `FLOW_FIELDS` как M: `harvest, externalIn, externalOut, spawnSpend, build, repair, upgrade, decayLoss, internalTransfer, unexplained`. `internalTransfer` (transfer/withdraw/pickup/drop между своими узлами) **никогда** не доход.

**ObservedBinding** (только наблюдение, никаких прав): `homeRoom?`, `homeSource` (null ⇔ UNKNOWN), `homeQuality`, `legacyRole?`, `legacyOrderId?`, `body: string[]`, `bodyCost`, `firstSeen ≤ lastSeen`, `lifeState`. **Binding** (ARCHITECTURE §6, на этапе A не записывается): `homeRoom, ownerEpoch, originEpoch, legacyOrderId?, operationKey?, demandKey?, generation?, assignmentId?, observedLifeState`.

**ObservedOperation** (действие мира/legacy, наблюдённое в shadow, без нашего operationKey): `observationKey`, `kind`, `roomName`, `actorRef?`, `targetRef?`, `firstSeen ≤ lastSeen`, `effect: EffectKind`, `amount: M`, `energyAmount: M`, `eventKeys` (отсортированы).

### 4.3 Операции, receipts, эффекты

**CallReceipt**: `kind: RETURNED|THREW`, `commandId`, `operationKey`, `action`, `actorRef`, `targetRef?`, `tick`, `code?`, `errorCode?` (RETURNED ⇒ только code; THREW ⇒ только errorCode). Не подтверждение эффекта.

**EffectResult**: `kind`, `operationKey`, `commandId?`, `evaluatedAt`, `confirmedAmount?`, `effect?` (обязателен для CONFIRMED), `evidence?` (для NO_EFFECT), `reason?` (для UNKNOWN), `eventKeys`.

**Operation**: `operationKey`, `state`, `createdAt ≤ updatedAt`, `issuedAt?` (обязателен для ISSUED), `lastCommandId?`, `actorRef?`, `targetRef?`, `requestedAmount?`, `confirmedAmount ≤ requestedAmount`, `reservationIds`, `lastReceipt?`, `lastEffect?` (CONFIRMED ⇒ effect CONFIRMED), `reasonCode?` (обязателен для UNKNOWN/UNKNOWN_RETIRED).

### 4.4 Финансы (A4)

**Reservation**: `reservationId`, `kind`, `state`, `missionId?`, `operationKey?`, `roomName`, `nodeId`, `targetNodeId?` (обязателен для MOVE), `resourceType`, `amount`, `settledAmount`, `releasedAmount`, `unknownAmount`, `dueAt?`, `createdAt ≤ updatedAt`. Инварианты: `settled + released + unknown ≤ amount`; терминальные состояния ⇒ сумма = amount; SETTLED/RELEASED ⇒ `unknownAmount = 0`; RETIRED ⇒ `unknownAmount > 0`; RESERVED ⇒ `unknownAmount = 0`; PARTIAL ⇒ `settled > 0`.

- **Спорное резервирование** (`isDisputedReservation`): не терминально и `unknownAmount > 0`. Пока оно спорное, необязательные траты узла закрыты.
- **RETIRED** = UNKNOWN_RETIRED из ARCHITECTURE §5: спорная часть больше не удерживается на узле (физическая база — новый наблюдаемый остаток), но **верхняя граница `unknownAmount` продолжает учитываться против лимита миссии/экспозиции**; доход не начисляется.
- **SPEND на spawn** резервируется на узле пула `spawnPoolNodeId(room) = 'spawnPool:<room>'` (`spawnPoolRoom(id)` — обратное): spawnCreep тратит из всех spawn+extensions. Пул — только узел ledger, не EnergyNode снимка; его observed = `RoomSnapshot.energyAvailable`.

**LedgerView** `{roomName, tick, nodes: LedgerNodeView[] (по nodeId)}`, **LedgerNodeView** `{nodeId, observed: M, reserved ≥ 0, disputed ≥ 0, free: M}`: `free = observed − reserved − disputed` (может быть < 0 — перерасход), observed UNKNOWN ⇒ free UNKNOWN.

**CalendarEntry** `{tick, roomName, kind, amount: M, stableKey, reasonCode?}`; **Calendar** `{roomName, fromTick, horizon ≥ 1, entries (по (tick, kind, stableKey), уникальны, в [fromTick, fromTick+horizon]), quality, reasonCodes}`.

**ReplacementPlanEntry** `{stableKey, roomName, currentCreepName?, ticksToLive: M, body, bodyCost, spawnTime, travelTime: M, startBy?, deadline?, criticality, reasonCode?, quality}`; **ReplacementPlan** `{roomName, tick, horizon, entries (по stableKey)}`.

**ForecastSummary** (persisted): `{roomName, computedAt, horizon, freeEnergyNow: M, incomeLowerPerTick: M, committedPayments: M, nextDeficitTick?, calendarFingerprint?, quality, reasonCodes}`.

### 4.5 Планирование и журнал (A5)

**Demand**: `stableKey`, `generation`, `missionId?`, `roomName`, `capability`, `measurementUnit`, `amount`, `location?`, `requiredBy?`, `earliestStart?`, `criticality`, `options: DemandOption[]`, `createdAt`. **DemandOption** `{body: string[], cost, spawnTime, provides (в measurementUnit потребности), travelTime: M}`.

**Proposal**: `proposalId`, `mode: shadow|adaptive-v1`, `roomName?`, `missionId?`, `tick`, `inputFingerprint`, `expectedRevision?`, `reasonCode`, `demands`, `missionPatches` (**на этапе A всегда `[]`**: миссии — этап B; валидатор отвергает непустой), `reservationRequests: [{kind, nodeId, targetNodeId?, resourceType, amount, dueAt?}]`, `dependencies`.

**DecisionRecord**: `decisionId`, `tick`, `roomName?`, `mode`, `reasonCode`, `inputFingerprint`, `inputs: object`, `alternatives: [{label, proposalId?, reasonCode, accepted}]`, `selectedProposalId?`, `expectedNextFact?`, `resultKind`, `executed` (в shadow всегда false).

### 4.6 Replay (A1) и прочее

**ReplayFixture** `{header, body}` (`validateReplayFixture`): `header.contentFingerprint = fingerprint(body)`, `header.tickFrom/tickTo` = первый/последний снимок, `header.expectedReasonCodes = body.expectedReasonCodes`.

- **ReplayFixtureHeader**: `fixtureType:'ReplayFixture'`, `fixtureVersion: 1`, `contractVersion`, `buildId`, `schemaVersion`, `policyVersion?`, `seed?`, `tickFrom ≤ tickTo`, `rooms` (отсортированы), `contentFingerprint`, `expectedReasonCodes`.
- **body**: `snapshots: Snapshot[]` (по tick, ≥1), `state: {revision, control: {rooms}, shadowRooms: {[room]: {eventCursor?, flowWindows}}}` (выбранные поля StateView, без чужой Memory и credentials), `events: NormalizedEvent[]` (по (effectTick, roomName, originalArrayIndex)), `expectedReasonCodes`, `expectedForecast: {[room]: ForecastSummary}`.

**ControlRecord** `{requestedMode, effectiveOwner, epoch, transitionPhase?, transitionId?, previousOwner?, blockedReason?}`; **FaultStatus** `{component, consecutiveFailures, totalFailures, lastFailureTick?, lastInputFingerprint?, lastErrorCode?, breakerUntil?, halfOpen}`.

Схемы — `SCHEMAS.<Имя>` и `LAYOUT_SCHEMAS.<Имя>`; валидные образцы всех DTO — `tests/bot/support/fixtures.js`.

## 5. Раскладка состояния и владельцы путей (`src/bot/domain/stateLayout.js`)

**`Memory.strategy`** (schema1, `emptyStrategyRoot(meta)`, `validateStrategyRoot(root, {stage:'A'})`):

```text
strategy = {
  schemaVersion: 1, policyVersion?, buildId?, revision, lastClosedTick?, recentPatchIds[≤256],   // meta: StateStore внутри
  control: { rooms: { [room]: ControlRecord } },
  faults: { [component]: FaultStatus },
  migrations: { version, cursor?, sourceRevision?, status: MigrationStatus },
  // существуют, на этапе A пусты (validateStrategyRoot {stage:'A'} -> STAGE_A_NOT_EMPTY):
  rooms: {}, missions: {}, demands: {[stableKey]: Demand}, bindings: {[creepName]: Binding},
  assignments: {}, ledger: { reservations: {}, funds: {}, missionExposure: {} }, operations: {[operationKey]: Operation}
}
```

**`Memory.strategyShadow`** (`emptyShadowRoot()`, `emptyShadowRoom()`, `validateShadowRoot`):

```text
strategyShadow = {
  schemaVersion: 1,
  rooms: { [room]: {
    eventCursor: EventCursor?, flowWindows: FlowWindow[≤30], observedBindings: { [creepName]: ObservedBinding },
    forecast: ForecastSummary?, decisionRing: DecisionRecord[≤100]
  }},
  ledger: { reservations: { [reservationId]: Reservation } },      // гипотетический ledger, ≤512
  observedOperations: { [observationKey]: ObservedOperation },     // ≤1024
  proposals: { [proposalId]: Proposal }                            // ≤200
}
```

**StateView** (`validateStateView`): `{dtoType:'StateView', status, sessionTick, blockedReason?, quarantine: [{namespace, key, reasonCode}], strategy: StrategyRoot, shadow: ShadowRoot?}`; StateStore отдаёт его deep-frozen. Ревизия — `strategy.revision` (общая для патчей обоих namespaces).

**Запись — только `StateStore.apply(expectedRevision, patches)`.** `StatePatch = {patchId, writer: StateWriter, namespace: 'strategy'|'strategyShadow', path: string[], op: 'set'|'delete', value?}` (`set` ⇒ value; `delete` ⇒ без value). `validateStatePatch(patch)` проверяет форму, владельца пути (`PATCH_RULES`, `patchOwner(namespace, path)`), схему значения и совпадение ключа/комнаты.

| namespace | path | writer (задача) | значение | ключ/комната | delete |
| --- | --- | --- | --- | --- | --- |
| strategy | `control.rooms.<room>` | `state` (A2) | ControlRecord | — | нет |
| strategy | `faults.<component>` | `state` (A2) | FaultStatus | `component` = ключ | да |
| strategy | `migrations` | `state` (A2) | Migrations | — | нет |
| strategy | meta (`schemaVersion, policyVersion, buildId, revision, lastClosedTick, recentPatchIds`) | StateStore внутри, не патчится | — | — | — |
| strategy | `rooms, missions, demands, bindings, assignments, ledger.*, operations` | **никто на этапе A** | — | — | — |
| strategyShadow | `rooms.<room>.eventCursor` | `observation` (A3) | EventCursor? | `roomName` = room | нет |
| strategyShadow | `rooms.<room>.flowWindows` | `observation` (A3) | FlowWindow[≤30] | каждый `roomName` = room | нет |
| strategyShadow | `rooms.<room>.observedBindings.<creep>` | `observation` (A3) | ObservedBinding | — | да |
| strategyShadow | `observedOperations.<key>` | `observation` (A3) | ObservedOperation | `observationKey` = ключ | да |
| strategyShadow | `rooms.<room>.forecast` | `finance` (A4) | ForecastSummary? | `roomName` = room | нет |
| strategyShadow | `ledger.reservations.<id>` | `finance` (A4) | Reservation | `reservationId` = ключ | да |
| strategyShadow | `rooms.<room>.decisionRing` | `planning` (A5) | DecisionRecord[≤100] | — | нет |
| strategyShadow | `proposals.<id>` | `planning` (A5) | Proposal | `proposalId` = ключ | да |
| strategyShadow | `schemaVersion` | StateStore внутри | — | — | — |

Обязанности A2: `apply` создаёт недостающие промежуточные контейнеры по `emptyShadowRoom()`/`emptyShadowRoot()`; повтор `patchId` (из `recentPatchIds`) — no-op; пакет применяется целиком или отклоняется (`REJECTED(STALE_INPUT)` при чужой ревизии, `REJECTED(INVALID_RECORD)` при невалидном патче или чужом пути). `control` на этапе A никто из компонентов не меняет: StateStore создаёт пустую схему, режим комнаты меняет оператор/инструмент координатора. **ReconciliationPatch** (выход A3, `validateReconciliationPatch`): `{tick, patches: StatePatch[] (только writer 'observation'), gaps: EventGap[], domainStatus: {[room]: OK|UNCERTAIN_FUNDING}, reasonCodes}`.

**Уточнения после независимого ревью A.2 (координатор):**

- Ключи `__proto__`, `constructor`, `prototype` в сегментах пути запрещены (`PATH_NOT_PATCHABLE`); A2 всё равно применяет патчи без присваивания через прототип.
- `strategyShadow.rooms` ограничен `LIMITS.shadowRooms = 64`, `observedBindings` — 256 на комнату. Создание/удаление целой shadow-комнаты (`rooms.<room>`) — писатель `state` (A2): A2 вытесняет давно не наблюдавшиеся комнаты и компактирует данные при приближении к лимитам; спорные данные не удаляются ради места.
- `patch.writer` самодекларируемый. A2 обязан выдавать **writer-bound handles** (`state.forWriter(writer)` подставляет и проверяет writer), а `wireStageA`/A5 передают каждому компоненту только handle своего writer.
- Если `observe.snapshot` отложен/в breaker, тики без снимка — разрыв (`EVENT_GAP`/UNKNOWN) для A1/A3, а не нулевые потоки.

## 6. Сериализация, fingerprint, ключи

- `canonicalJson(value)` — ключи по возрастанию, массивы по порядку, `-0 → 0`; отвергает (`CanonicalError{code, path}`) undefined (в т. ч. дырки массива), **массивы с дополнительными свойствами** (`ARRAY_EXTRA_PROPERTY`), NaN, ±Infinity, функции, symbol, bigint, циклы, непростые прототипы. Также `checkJsonSafe`, `isJsonSafe`, `isPlainObject`, `canonicalClone`.
- `fingerprint(value)` = `'fnv1a64:' + 16 hex` (UTF-8 canonical JSON; чистый JS). Не криптографический, 64 бита (порог ~2³² значений для 50 % коллизии): для обнаружения изменения входа, кэша, идентичности артефакта; не единственное доказательство идентичности денег/крипов.
- `buildOperationKey({domain, ownerEpoch, demandStableKey, generation, action, occurrence})` → `domain/ownerEpoch/demandStableKey/generation/action/occurrence`; в текстовых сегментах экранируются только `%`→`%25`, `/`→`%2F`; `parseOperationKey` (с проверкой каноничности), `isOperationKey`.
- `eventKey(roomName, effectTick, originalArrayIndex)` → `ev:<room>:<tick>:<index>`, `parseEventKey`.
- `shortCreepName(fullKey, prefix='s')` → `<prefix>_<12 hex>`; другой ключ с тем же именем — `NAME_COLLISION`.
- `spawnPoolNodeId(room)`, `spawnPoolRoom(id)`; `makePosition`, `isPosition`, `positionKey`, `isRoomName`.
- `deepFreeze(value)` — **двухпроходный**: сначала проверяется весь граф (только plain-объекты и массивы; иначе TypeError и **ничего не заморожено**), затем всё замораживается; циклы допустимы.

## 7. Порты, capability и правила исходников

`src/bot/app/ports.js` (при создании ничего не читают):

| Порт | API | Кто получает |
| --- | --- | --- |
| ClockPort | `tick() → int?` | любой компонент (`frame.services.clock`) |
| CpuPort | `read() → {used, limit, tickLimit, bucket: number?, missingFields}` | любой (`frame.services.cpu`), WorkBudget |
| LogPort | `debug/info/warn/error(code, fields)`, `beginTick()`; `[strategy]`, ≤20 строк/тик | любой (`frame.services.log`) |
| GameReadPort | `time, shardName, roomNames, room, creepNames, creep, spawnNames, spawn, getObjectById, eventLog(room) → Array?, allowedCalls` | **только Reader** (через `stageA.js`) и composition root (список комнат BOOT) |
| MemoryPort | `namespace, read(), write(value), remove()`; namespace ∈ `strategy, strategyShadow, strategyMigration` | **только StateStore** (через `stageA.js`) |

`frame.services.state` — API StateStore (A2 определяет объект; без MemoryPort внутри), `null`, пока A2 не подключён.

`src/bot/app/context.js`: `createContext({mode, tick, snapshot, stateView, stateRevision, versions, ownerTokens, budget, reservations})` → замороженный контекст (snapshot/stateView через `deepFreeze`); ключи `gateway, Game, game, Memory, memory, rawMemory, RawMemory` → TypeError. `capabilitiesFor('legacy'|'shadow')`: `ISSUE_INTENTS:false`, `WRITE_LEGACY_MEMORY:false`; `adaptive-v1` → TypeError.

Правила `src/bot/**` (tripwire `tests/bot/unit/domain/purity.test.js`): CommonJS + JSDoc; бандл не strict на верхнем уровне (модули не начинаются с `"use strict"`), иначе ломается `dist2/mapPatch.js`; **нельзя** `Array.prototype.flat`, `Map.prototype.toObject/filter`, `Map.fromObject` (их подменяет mapPatch; `flat` бросает на пустом массиве, `toObject` пишет неявный глобал `result`); чистые слои не упоминают `Game/Memory/RawMemory/PathFinder/InterShardMemory` и не требуют `dist2`; без Node builtins. Тесты чистых модулей выполняются и с патчем: `tests/bot/support/mapPatch.js` `installMapPatch()`.

## 8. Каркас app и LegacyAdapter

**Порядок фаз этапа A** (`STAGE_A_PHASE_ORDER`): `BOOT, OBSERVE, CRITICAL, EXECUTE, RECONCILE, FORECAST, PLAN, ADMIT, CLOSE`. До legacy выполняются **только встроенные** `boot.environment`, `boot.router`, `observe.snapshot`; `createStrategyApp` отвергает дополнительные компоненты в фазах до EXECUTE (BOOT/OBSERVE/CRITICAL). RECONCILE перенесён после legacy; снимок по-прежнему снимается в OBSERVE до legacy. Канонический `PHASES` сохранён для adaptive.

**Защита CPU-базы legacy:**

| Работа | Класс бюджета | Ограничение (начальные настройки `DEFAULT_BUDGET_SETTINGS`) |
| --- | --- | --- |
| `execute.legacy`, `boot.environment` | exempt | не проверяется, никогда не пропускается |
| `observe.snapshot` (до legacy) | optional + scoped | общий optional-лимит и потолок `observeCeilingCpu = 3` CPU на снятие (`createScopedBudget`); Reader проверяет бюджет перед каждой комнатой и при нехватке возвращает DEFERRED(cursor) |
| shadow RECONCILE…CLOSE | optional | без заимствования из bucket: `used + estimate ≤ min(limit, tickLimit) − hardMarginCpu(2) − criticalReserveCpu(5)`; при `bucket < minShadowBucket (1000)` → `DEFERRED(BUDGET_DEFERRED)`; неизвестный CPU → UNKNOWN, не выполняется |
| `boot.router`, `close.report` | critical | `used + estimate ≤ tickLimit − hardMarginCpu` |

**TickRunner**: `createTickRunner({faultBoundary, workBudget, log?, phaseOrder?, services?})` → `{register(spec), runTick({tick, tickToken}), plan(), phaseOrder}`; `ComponentSpec = {name, phase, budgetClass?='optional', estimateCpu?, bypassCooldown?, inputFingerprint?(frame), run(frame) → Result}` (другие ключи отвергаются); `frame = {tick, tickToken, phase, services, result(name)}`, `services` заморожен. Бюджет: DEFERRED пропускает компонент; UNKNOWN пропускает optional, critical выполняется; exempt не проверяется.

**Имена встроенных компонентов**: `boot.environment`, `boot.router` (READY(RoutingTable)), `observe.snapshot` (Result<Snapshot>), `execute.legacy`, `close.report`. Компоненты задач — с префиксами `reconcile.*`, `forecast.*`, `plan.*`, `admit.*`, `close.*`.

**FaultBoundary**: `createFaultBoundary({store?, log?})` → `{run(component, {tick, inputFingerprint?, bypassCooldown?}, fn), status(component)}`; `RETRY_COOLDOWN_TICKS=25`, `BREAKER_THRESHOLD=3`, `BREAKER_TICKS=100`. Исключение → `REJECTED(COMPONENT_FAULT, {component, consecutiveFailures, errorName, message≤200, tick})` только для этого компонента; повтор раньше 25 тиков при неизменном входе (null = неизменный) → `RETRY_COOLDOWN`; изменённый вход — сразу; 3 подряд → `CIRCUIT_OPEN` на 100 тиков (вход не обходит); затем half-open (один успех закрывает, одна ошибка снова открывает). `bypassCooldown` выполняется всегда. Возврат не-Result — `COMPONENT_FAULT`. При неизвестном `tick` cooldown/breaker не применяются. **FaultStore** `{load(component) → FaultStatus?, save(component, status)}`: `load` возвращает **изменяемую копию** (никогда не хранимый объект), граница её изменяет и передаёт в `save`; по умолчанию heap (`createHeapFaultStore`), A2 может хранить в `strategy.faults`.

**WorkBudget**: `createWorkBudget(cpuPort, settings?)` → `{admit({name, budgetClass, estimateCpu?, cursor?}), settings}`; `createScopedBudget(base, cpuPort, ceilingCpu)` → `{admit, ceilingCpu}`. Отсутствующие поля CPU → `UNKNOWN(MISSING_FIELD, [...])`.

**OwnershipRouter**: `routeRooms({state, roomNames}) → {legacyExecution:'PRE_EXISTING_EXECUTOR', stateSource: NO_STATE_STORE|OPEN|SUSPENDED, rooms: {[room]: RoomRoute}, quarantine: [{namespace, key, reasonCode}]}`, `RoomRoute = {roomName, requestedMode?, effectiveOwner, newSystem, epoch?, token?, status: Result}`; control берётся из `state.value.strategy.control.rooms`.

| Вход | effectiveOwner | newSystem | status |
| --- | --- | --- | --- |
| нет StateStore / нет записи / `legacy` | legacy | OFF | READY |
| `shadow` | legacy | SHADOW | READY |
| `adaptive-v1` | legacy | OFF | REJECTED(UNSUPPORTED_CAPABILITY) |
| `blockedReason` в записи | legacy | SUSPENDED | REJECTED(blockedReason) |
| запись невалидна | unconfirmed | SUSPENDED | REJECTED(INVALID_RECORD) + quarantine |
| ключ control не имя комнаты | — (не маршрутизируется) | — | только quarantine |
| запись утверждает owner ≠ legacy | unconfirmed | SUSPENDED | REJECTED(UNSUPPORTED_CAPABILITY) |
| open не READY / StateView SUSPENDED | unconfirmed (все) | SUSPENDED | REJECTED(причина) |

**Нюанс этапа A.** Router никогда не превращает неизвестную/несовместимую схему в решение (вновь) включить legacy: такие комнаты получают `unconfirmed`/`SUSPENDED` для новой системы. Legacy dist2 продолжает работу как единственный уже существующий глобальный исполнитель (`legacyExecution: 'PRE_EXISTING_EXECUTOR'`), а не по выбору Router. Покомнатное ограждение — этап B.

**LegacyAdapter**: `createLegacyAdapter({loadModules?, prepareEnvironment?, getGame?})` → `{prepareEnvironment(), runTick(tickToken) → {ran, initializedNow}, isInitialized(), initCount()}`; `loadDist2Modules()`, `applyDist2Environment()`. При первом legacy-тике после reset — require dist2-модулей в порядке `dist2/main.js` (mapPatch, roles, logger, resourceManager, resources.sourceResource, SourceController, SpawnController, resources.spawnProcess, resources.creepOrder, RoomController, BuildController, resources.constructionOrder, js-yaml), `logger.debug("Initializing game state...")`, четыре `registerResourceType`, `resourceManager.load()`, `initialize()` build/source/spawn/room, `logger.debug("Initialization complete")`; каждый тик под одним try/catch: `logger.load()`, `roles.run` для `Game.creeps`, reconcile source/spawn/room/build, `resourceManager.save()`; ошибка → `logger.error("Error in main loop: " + stack)`. Все require внутри функций. Не более одного запуска на `tickToken`. Исключение инициализации логируется со стеком (`LEGACY_INIT_FAULT`, до 1000 символов).

**Поведенческое отличие от dist2/main.js:** инициализация выполняется **при первом loop после reset, а не при require** — тот же тик и те же Game/Memory, но (1) после BOOT/OBSERVE новой системы и внутри CPU loop; (2) mapPatch применяется в BOOT первого loop; (3) исключение инициализации пропускает legacy-цикл этого тика (как неудачный require dist2 main), инициализация повторяется на следующем тике, вычисленные модули остаются в кэше.

**StrategyApp / main.js / stageA.js**: `createStrategyApp({ports: {clock, cpu, log}, legacy, listRoomNames?, openState?, stateApi?, observe?(frame, observationBudget), components?, faultStore?, budgetSettings?, phaseOrder?, buildInfo?})` → `{tick(token?), lastReport(), plan(), faultStatus(name)}`. `main.js` экспортирует только `loop`, top-level — объявления; при первом loop создаёт порты, вызывает `wireStageA(ports, buildInfo)` из `src/bot/stageA.js` → `{observe, openState, stateApi, faultStore, components}` (в A0 всё null/[]) и передаёт в приложение **только** clock/cpu/log. Гарантии: исключение shadow-компонента не мешает legacy (FaultBoundary + safety net при падении runner); ошибка legacy не мешает shadow и CLOSE; дефект создания приложения → loop исполняет только legacy, ошибка логируется при первом сбое и далее раз в 100 loop.

## 9. Сборка и загрузка

`npm run build:strategy` → `build/strategy/main.js` + `manifest.json` (`build/` не коммитится). esbuild `0.28.2` (devDependency, закреплён), `cjs`, `platform: neutral`, `target: es2018`, без минификации; aliases `logger → ./dist2/logger.js`, `js-yaml → ./dist2/js-yaml.js`. Сборка падает на Node builtins (plugin `noNodeBuiltins`), на `dist2/main.js`, на strict верхнего уровня, без `loop`. Детерминизм: относительные пути, без timestamps; `buildId = 'b-' + sha256(inputs + options + esbuild.version)[0..16]`, внедряется как `__STRATEGY_BUILD_ID__`. Manifest: `manifestVersion, buildId, testBuild, contractVersion, schemaVersion, screepsModuleName:'main', entry, output{path, sha256, bytes}, builder{…}, moduleCount, inputs[{path, sha256, bytes}]`.

**Тестовые сборки**: `buildStrategy({outdir, testPlugins})` — только для тестов (подмена dist2/`stageA.js` фейками); помечаются `testBuild: true`, `buildId` с префиксом `t-`, виртуальные входы `{virtual: true}`. Не развёртывать.

esbuild оборачивает CommonJS-модули в `__commonJS` без `"use strict"`: mapPatch сохраняет sloppy-семантику (проверено загрузчиком). Модуль, бросивший при вычислении, повторно вычисляется при следующем require (как в движке).

Тестовая обвязка `tests/bot/support/`: `screepsLoader.js` (`createScreepsSandbox({modules, Game, Memory, console?, globals?})` → `{require, runMainLoop(), setGlobals(), evaluate(), consoleLines}`; повторяет `requireFn`/`evalCode`: карта модулей, срез `./`, без fs/Node-резолвера, «Circular reference», sloppy-обёртка, отдельный V8-контекст; новый sandbox = reset), `trapRuntime.js` (`createTrapGame`, `createTrapMemory` — журнал, `TrapViolation`), `fakeLegacy.js`, `fixtures.js` (образцы всех DTO, по одному StatePatch на writer), `mapPatch.js`. Объекты из sandbox другого realm — сравнивать через JSON.

## 10. Модули A1–A6 и ожидаемые сигнатуры

Все функции синхронные, возвращают Result или DTO; чистые модули не получают портов.

**A1 — Reader/Snapshot/replay** (scope: `src/bot/observation/ScreepsReader.js`, `src/bot/observation/WorldSnapshotBuilder.js`, `src/bot/telemetry/ReplayExporter.js`, `tools/replay.js`)

```text
ScreepsReader.createReader({gameRead, cpu}) -> { capture(tick, scope, observationBudget) -> Result<Snapshot> }
    scope = {rooms: string[] | 'ALL_VISIBLE', stage: 'FULL'}   (этап A: полный снимок в OBSERVE)
    observationBudget.admit({name, budgetClass:'optional', estimateCpu, cursor}) перед каждой комнатой;
    READY(snapshot, snapshot.fingerprint) | DEFERRED(cursor, BUDGET_DEFERRED) | UNKNOWN(MISSING_FIELD, …)
WorldSnapshotBuilder.buildSnapshot(observation) -> Snapshot           (чистая; observation — внутренний plain-формат A1)
WorldSnapshotBuilder.buildRoomSnapshot(roomObservation) -> RoomSnapshot
WorldSnapshotBuilder.classifyEnergyNodes(roomObservation) -> EnergyNode[]
ReplayExporter.exportFixture({snapshots, stateView, events, expectedReasonCodes, expectedForecast, buildId, policyVersion, seed}) -> ReplayFixture
ReplayExporter.validateFixture(fixture) -> ValidationResult           (= domain validateReplayFixture + свои проверки)
tools/replay.js  (Node CLI): node tools/replay.js <fixture.json>
```

**A2 — StateStore schema1** (scope: `src/bot/state/**`)

```text
StateStore.createStateStore({memory: {strategy, strategyShadow, strategyMigration}: MemoryPort, buildInfo, log})
  .open(tick) -> READY(StateView) | REJECTED(INCOMPATIBLE_SCHEMA, ev) | UNKNOWN(INVALID_RECORD, …)
  .apply(expectedRevision, patches: StatePatch[]) -> READY({revision}) | REJECTED(STALE_INPUT, {expectedRevision, actualRevision}) | REJECTED(INVALID_RECORD, {patchId, errors})
  .checkpoint(label) -> Result
  .view() -> StateView | null
  .api() -> {view, apply}            (frame.services.state; без MemoryPort)
  .faultStore() -> FaultStore        (strategy.faults; load возвращает изменяемую копию)
StateCodec.decode(namespace, raw) -> {value, quarantine}; StateCodec.encode(namespace, value) -> JSON
MigrationRegistry.createMigrationRegistry() -> {register(fromVersion, migrate), plan(fromVersion, toVersion)}
```

**A3 — события, EffectMatcher, сверка, потоки** (scope: `src/bot/observation/EventNormalizer.js`, `src/bot/observation/EffectMatcher.js`, `src/bot/app/Reconciler.js`, `src/bot/models/FlowAccounting.js`)

```text
EventNormalizer.normalizeRoomEvents(roomSnapshot, cursor: EventCursor|null) -> Result<{events: NormalizedEvent[], gaps: EventGap[], cursor: EventCursor}>
EffectMatcher.matchEffects({operations, receipts, events, previous: Snapshot|null, current: Snapshot}) -> EffectResult[]
EffectMatcher.observeOperations({events, previous, current}) -> ObservedOperation[]      (shadow: действия legacy)
Reconciler.reduce(snapshot, stateView, pendingOps) -> Result<ReconciliationPatch>        (patches writer 'observation', пути §5)
FlowAccounting.accountFlows({previous, current, events, gaps}) -> Result<FlowDelta[]>    (по комнате)
FlowAccounting.closeWindow(windowStart, deltas) -> FlowWindow
```

**A4 — финансы** (scope: `src/bot/models/EconomyModel.js`, `src/bot/models/ForecastCalendar.js`, `src/bot/models/ReplacementForecast.js`, `src/bot/scheduling/BudgetLedger.js`)

```text
EconomyModel.evaluate(snapshot, stateView, horizon) -> Result<ForecastSummary>   (NO_HISTORY до 3 окон; 0.8 аналитического)
ForecastCalendar.buildCalendar({snapshot, flowWindows, reservations, demands, horizon}) -> Result<Calendar>
ReplacementForecast.forecastReplacements({snapshot, demands, observedBindings, horizon}) -> Result<ReplacementPlan>
BudgetLedger.createLedgerView(snapshot, reservations) -> LedgerView              (включая spawnPool:<room>)
BudgetLedger.admit(context, proposal, ledgerView) -> READY({reservations: Reservation[], expectedRevision}) | REJECTED(INSUFFICIENT_LIQUIDITY|STALE_INPUT|UNCERTAIN_FUNDING, …)
патчи: writer 'finance' — rooms.<room>.forecast, ledger.reservations.<id>
```

**A5 — shadow pipeline** (scope: `src/bot/planning/**`, `src/bot/telemetry/DecisionRecorder.js`, `src/bot/integration/ShadowAdapter.js`, wiring в `src/bot/stageA.js`, `src/bot/main.js`, `src/bot/app/TickRunner.js`)

```text
RoomGovernor.propose(context, roomState) -> Proposal[]                  (context.mode === 'shadow', без gateway; missionPatches = [])
DecisionRecorder.createDecisionRecorder({capacityPerRoom: 100}) -> {append(record) -> Result, drain() -> StatePatch[] (writer 'planning')}
ShadowAdapter.createShadowComponents({models, recorder}) -> ComponentSpec[]
    фазы RECONCILE..CLOSE; входы: frame.result('boot.router') (только newSystem === 'SHADOW'),
    frame.result('observe.snapshot'), frame.services.state (view/apply); НЕ получает порты
stageA.wireStageA(ports, buildInfo) -> {observe, openState, stateApi, faultStore, components}
    здесь и только здесь: gameRead -> Reader (A1), memory -> StateStore (A2)
```

**A6 — изолированный e2e** (scope: `e2e/strat/**`): загрузка `build/strategy/main.js` как модуля `main` в одноразовой `e2e/server/instance.js`; reset, отсутствие shadow-intents и записей новой системы в legacy Memory.

## 11. Отклонения от ARCHITECTURE и обоснование

1. **Порядок фаз этапа A** — `BOOT, OBSERVE, CRITICAL, EXECUTE, RECONCILE, FORECAST, PLAN, ADMIT, CLOSE`; до legacy — только встроенные BOOT/OBSERVE. На этапе A ни один shadow-результат не идёт в EXECUTE, а CPU-база legacy не должна зависеть от shadow. Снимок снимается в OBSERVE до legacy, поэтому Reader снимает полный снимок в OBSERVE, FORECAST не читает Game. Сверка (RECONCILE) использует этот снимок после legacy — побочных эффектов в мире это не меняет (intents legacy разрешаются после тика).
2. **Инициализация legacy** — при первом loop, а не при require (§8).
3. **ReasonCode** дополнен кодами этапа A (§2).
4. **Router не ограждает legacy покомнатно** (этап B).
5. **Shadow не заимствует bucket** и не работает при bucket < 1000; при неизвестном CPU optional-блоки не выполняются.
6. **`Memory.strategy.rooms`** (ARCHITECTURE §6: forecastCursor, flowWindows, decisionRing) на этапе A пуст; эти данные — в `Memory.strategyShadow.rooms` (решение координатора).
7. **Reservation** дополнена `unknownAmount` и состоянием `RETIRED`; `Operation` — переходами `NO_EFFECT→ISSUED`, `UNKNOWN→UNKNOWN`.

## 12. Открытые риски

- `target es2018` и V8 официального сервера не проверены на целевом runtime (только локальная семантика загрузчика и Node 22 vm) — A6.
- Реальная dist2 в loader-тесте проверена только на пустом мире; изоляция shadow/legacy на артефакте проверена тестовой сборкой с фейковой dist2.
- Mapping `PATCH_RULES` проверяется валидатором, но его обязательное применение в `apply()` — ответственность A2.
- Запрет на API mapPatch — текстовый tripwire, не статический анализ.
- `node --test tests/bot` (каталог) в Node 22.23 не разворачивается — используйте `npm run test:bot`.
- FaultStatus в heap до подключения A2: после reset cooldown/breaker обнуляются.
- Начальные пороги CPU (`observeCeilingCpu=3`, `minShadowBucket=1000`, резерв 5 + запас 2 от `Game.cpu.limit`) не откалиброваны.

## История

- `A.1` — первая фиксация (STRAT-A0, #19).
- `A.2` — по итогам ревью #19: компоненты получают только `frame.services` (без портов), `stageA.js`; полная раскладка `Memory.strategy`/`Memory.strategyShadow`, `StatePatch` и владельцы путей; DTO FlowDelta/FlowWindow, EventCursor, Binding/ObservedBinding, ObservedOperation, CalendarEntry/Calendar, LedgerView, ReplacementPlan, ForecastSummary, ReplayFixture body, ReconciliationPatch, DemandOption; `Reservation.unknownAmount` + `RETIRED`, узел `spawnPool:<room>`; `NormalizedEvent.energyAmount`; переходы `NO_EFFECT→ISSUED`, `UNKNOWN→UNKNOWN`; новый stage-A порядок фаз и CPU-ограничения shadow; fingerprint снимка без `cpu`; двухпроходный `deepFreeze`; отказ canonical JSON на массивах с доп. свойствами; quarantine ключей control; ограничение логов `APP_CREATE_FAULT`.
- `A.3` — аддитивно (координатор, по отчёту A1 #20): `GameReadPort.creepMemory(name)` — read-only копия `{role, strategy: {operationKey, homeRoom, ownerEpoch}}` из `Memory.creeps[name]` без обращения к getter `creep.memory` (он создаёт запись) и без записи Memory; read-only методы store `getUsedCapacity/getCapacity/getFreeCapacity` разрешены Reader; `EnergyObjectType` дополнен `tower` (класс STORAGE_CONTAINER). Флаг экспорта replay в схему `Memory.strategyShadow` пока не добавлен — решается при композиции A5.
