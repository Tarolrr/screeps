# StateStore schema1 (A2): заметки реализации

Задача [#21](https://github.com/Tarolrr/screeps/issues/21). Контракт — [CONTRACTS-A](CONTRACTS-A.md) §5, §10 (A2); основание — [ARCHITECTURE](ARCHITECTURE.md) §6. Код: `src/bot/state/` (`StateCodec.js`, `StateStore.js`, `MigrationRegistry.js`, `Retention.js`, `objects.js`), тесты `tests/bot/unit/state/` (нативно и с `dist2/mapPatch.js`).

## API (для §10 CONTRACTS-A)

```text
StateStore.createStateStore({memory: {strategy, strategyShadow, strategyMigration}: MemoryPort, buildInfo?, log?, clock?, registry?})
  clock?: ClockPort — faultStore() открывает сессию текущего тика сам; запись через сессию прошлого тика -> STALE_INPUT(SESSION_EXPIRED)
  registry?: MigrationRegistry (по умолчанию пустой)
  .open(tick) -> READY(StateView) | REJECTED(INCOMPATIBLE_SCHEMA, ev) | UNKNOWN(MISSING_FIELD ['tick'] | INVALID_RECORD ['memory.<ns>'])
  .apply(expectedRevision, patches) -> READY({revision}) | READY({revision, replayed: true})
                                     | REJECTED(STALE_INPUT, {expectedRevision, actualRevision, cause?: NO_SESSION|MIGRATION_FREEZE|SESSION_EXPIRED})
                                     | REJECTED(INVALID_RECORD, {patchId, errors[{path, code}], ...})
                                     | REJECTED(BUDGET_DEFERRED, {patchId, sizeBytes, limitBytes, degraded: true})
                                     | REJECTED(INCOMPATIBLE_SCHEMA, {cause: SUSPENDED} | {patchId, namespace: 'strategyShadow'})
  .checkpoint(label) -> READY({label, revision}) | REJECTED(как apply)
  .compact(tick?) -> READY({evicted: room[], revision?}) | REJECTED(STALE_INPUT, {cause})
  .releaseQuarantine(namespace, key) -> READY({namespace, key, raw}) | REJECTED(INVALID_RECORD NOT_QUARANTINED) | REJECTED(как apply)
  .view() -> StateView | null
  .api() -> {view, apply, forWriter}               (только composition root)
  .api().forWriter('observation'|'finance'|'planning') -> {writer, view, apply}   ('state' и прочее -> TypeError)
  .readOnlyApi() -> {view, apply}                   (frame.services.state; apply -> REJECTED(INVALID_RECORD READ_ONLY_HANDLE))
  .faultStore() -> {load(component) -> FaultStatus copy | null, save(component, status)}
  .migrator() -> {start(tick, safety), step(tick, safety), expire(tick), status()}
  .health() -> {status, tick, sizeBytes, limitBytes, blocked, degradation[]}
StateCodec.decode(namespace, raw, {meta?}) -> {status: ABSENT|OK|OLDER|INCOMPATIBLE, schemaVersion, value, quarantine[{namespace, path, key, reasonCode, code, raw}], errors}
StateCodec.encode(namespace, value) -> canonical JSON (CanonicalError на Game/Map/NaN/Infinity/undefined/циклах)
StateCodec.validateNamespace(namespace, value) -> ValidationResult
MigrationRegistry.createMigrationRegistry() -> {register(fromVersion, migrate), plan(from, to), migrate(from, draft), has(v)}
MigrationRegistry.createMigrationRunner({ports: {source, migration}, registry, targetVersion, validateTarget, finalize?, onSwap?, log?})
Retention: admitOperation, countUnfinishedByRoom, compactOccurrences, roomLastSeen, roomsWithDisputedData, selectEvictableRooms; SIZE_LIMIT_BYTES, OPERATION_LIMITS
```

`safety = {threat: boolean, ticksToCriticalDeadline: number|null, unresolvedOperations: number|null, snapshotFresh?: boolean}`.

## Открытие (`open(tick)`)

| Состояние Memory | Результат | Запись в Memory |
| --- | --- | --- |
| namespaces нет | `READY(StateView OPEN)`, пустая schema1, `revision 0` | нет (создаётся при первой принятой записи или `checkpoint`) |
| schema1, всё валидно | `READY(OPEN)` | нет |
| повреждённые записи доменов | `READY(OPEN)`, записи в `view.quarantine`, остальное загружено | нет; raw записи остаются в Memory |
| `strategyShadow` неизвестной версии/повреждён корень | `READY(OPEN)`, `shadow: null`, quarantine `strategyShadow:*` | `strategyShadow` не пишется никогда |
| `strategyMigration.status = RUNNING`, окно не истекло | `READY(READ_ONLY)`: все writers заморожены | нет |
| `RUNNING`, `tick ≥ deadlineTick` | draft отменяется (`WINDOW_EXPIRED`, `notBefore = tick + 100`), источник цел, далее как обычно | `strategyMigration` |
| новее schema1, повреждён корень/meta/`control`/`migrations`, неизвестный формат `strategyMigration` | `REJECTED(INCOMPATIBLE_SCHEMA, ev)`, `view() = null` | нет; namespace байт-в-байт неизменён |
| старше schema1 | `REJECTED(INCOMPATIBLE_SCHEMA, {migration: REQUIRED/RUNNING/UNAVAILABLE})` | нет |

Класс «control» (любой дефект блокирует namespace): `schemaVersion, policyVersion, buildId, revision, lastClosedTick, recentPatchIds, control, migrations`. Повреждённая запись `control.rooms` блокирует весь namespace (консервативно). Записи доменов (`faults, operations, demands, bindings, rooms, missions, assignments, ledger.*`; в shadow — поля комнаты, `observedBindings.*`, `ledger.reservations.*`, `observedOperations.*`, `proposals.*`, ключи комнат) карантинятся по одной; неизвестные ключи — тоже. Превышение лимита записей при чтении — карантин хвоста (по порядку ключей).

Одна сессия на тик: повторный `open` того же тика возвращает ту же сессию; после записи — тот же session с новым view. Новый тик перечитывает Memory. **Кэш:** после успешного декодирования и после каждой записи store хранит приватное зеркало (JSON-копию) namespace; если JSON-текст Memory на следующем open равен тексту зеркала, используется прежний view без валидации (измерено на 245 KB в Node 22: холодный open ~54 мс, повторный без изменений ~2 мс, после записи ~4 мс). `inputFingerprint` результата `open` — heap-локальная идентичность содержимого `{nonce: первый тик heap, content: счётчик изменений, revision, status, quarantine}`: не меняется, пока содержимое не изменилось; не сравнивается между heap. `boot.router` в `StrategyApp` берёт fingerprint от `state.inputFingerprint` (или `{kind, reason}`) и roomNames, а не от всего view.

## Запись

- Пакет целиком: `validateStatePatch`; запрет `__proto__/constructor/prototype` в пути и в любом месте значения; дубликаты `patchId` в пакете; карантин; лимиты числа записей; 256 KiB; проверка, что промежуточные объекты в Memory — plain objects (`MEMORY_CONFLICT`).
- **Повтор `patchId`.** Элемент `recentPatchIds` = `patchId + '|' + fingerprint({writer, namespace, path, op, value})` (≤ 256, последние). Повтор с тем же содержимым — no-op; пакет только из повторов → `READY({revision, replayed: true})` без записи, но `expectedRevision > revision` → `STALE_INPUT`. Тот же `patchId` с другим содержимым → `INVALID_RECORD PATCH_ID_REUSED`.
- `revision++` один раз на принятый пакет компонента. **Внутренние записи** writer `state` (FaultStore, `compact`, `releaseQuarantine`) revision **не** повышают и не занимают `recentPatchIds`: компоненты одного тика не получают `STALE_INPUT` из-за сохранения статуса ошибки соседа. Вытеснение комнат внутри пакета компонента входит в его ревизию.
- **Memory и view.** View — глубоко замороженная копия (copy-on-write по пути патча). Принятый пакет применяется own-property defines к живым объектам Memory текущего тика (не замороженным plain JSON-копиям значений) и к приватному зеркалу; отсутствующий namespace создаётся `port.write`. В Memory никогда нет замороженных объектов. **Правило правок оператора:** правки `Memory.strategy*` из консоли после loop действуют; store обнаруживает их на следующем `open` по отличию JSON-текста от зеркала и полностью перекодирует namespace (изменённая запись может оказаться в карантине или заблокировать namespace по правилам выше).
- `checkpoint(label)` — записи уже в Memory (write-through); создаёт отсутствующие namespaces и возвращает revision. Не durable commit: сериализацию выполняет runtime в конце тика.

### Карантин

Raw-данные карантинной записи остаются в Memory. Компонентные writers (`forWriter`, `store.apply`) не могут ни заменить (`set`), ни удалить ровно карантинный путь (`QUARANTINED`), ни писать под ним (`QUARANTINED_PARENT`), ни заменить/удалить его предка (`QUARANTINE_CONFLICT`); это касается и writer `state` (удаление shadow-комнаты, FaultStore → heap). Снять карантин можно только явным вызовом обслуживания `store.releaseQuarantine(namespace, key)`: запись удаляется из Memory, её raw-значение возвращается для архивирования, после чего владелец пути пишет новую запись обычным патчем.

### Writer-bound handles и wiring

- `store.api().forWriter(w)` подставляет `writer` в копию каждого патча и отвергает пакет, если патч объявляет другой writer (`WRITER_MISMATCH`). `forWriter('state')` — TypeError.
- `frame.services.state = store.readOnlyApi()`.
- `src/bot/stageA.js`: `openState(frame) = store.open(frame.tick)`, `stateApi = store.readOnlyApi()`, `faultStore = store.faultStore()`, store создаётся с `clock`. A5 создаёт handles `store.api().forWriter(...)` в `wireStageA` и передаёт каждому компоненту только его handle через замыкание.

### FaultStore

`strategy.faults.<component>` внутренними патчами (без revision). `load` возвращает изменяемую копию. Если store не OPEN (SUSPENDED, READ_ONLY) или запись отклонена (например, запись в карантине) — статус в heap (теряется при reset), namespace не трогается.

## Ретенция и лимиты (`Retention.js`)

- Shadow-комнаты: при превышении `LIMITS.shadowRooms` в пакете и при `compact()` вытесняются самые давно не наблюдавшиеся комнаты возрастом ≥ 1500 тиков; `compact()` дополнительно удаляет комнаты без наблюдений ≥ 30 000 тиков и держит запас 4 комнаты. Не вытесняются: комнаты с карантином, затронутые пакетом, с незавершённым/спорным shadow-резервированием, с `ObservedOperation.effect = UNKNOWN`. Нет места — пакет отклонён, `health().degradation`, лог `STATE_DEGRADED`.
- 256 KiB (точная длина JSON при полном open + инкрементальные дельты): рост shadow выше порога отклоняется (`BUDGET_DEFERRED`) после попытки вытеснить устаревшие комнаты; уменьшение и записи `strategy` разрешены. Спорные данные ради места не удаляются.
- Операции (чистые функции, на этапе A записей нет): `admitOperation` — ≤ 256 незавершённых на комнату, последние 10 мест только CRITICAL; `compactOccurrences` — CONFIRMED-occurrence серии сворачиваются в монотонный `closedThrough` только по непрерывному префиксу; разовые CONFIRMED → dedup; UNKNOWN/UNKNOWN_RETIRED/NO_EFFECT остаются; записи ниже watermark сообщаются (`belowWatermark`).
- Кольцо 100 решений и 30 окон — лимиты схемы; обрезка — обязанность писателя.

## Миграции (`MigrationRegistry.js`)

Production-миграций нет; `store.migrator()` на этапе A используется только тестами (синтетическая v0→v1), adaptive cutover не включается.

Формат `Memory.strategyMigration` (A2): `{formatVersion: 1, namespace: 'strategy', fromVersion, toVersion, draftVersion, status: MigrationStatus, startedAt, deadlineTick, sourceRevision, sourceFingerprint, draft, cancelReason, cancelledAt, notBefore, completedAt}`.

- `start`: только при `unresolvedOperations === 0`, `threat === false`, `ticksToCriticalDeadline ≥ 100`, вне паузы после отмены; фиксирует `sourceRevision`, `fingerprint(source)`, draft = копия источника; `deadlineTick = startedAt + 10`. Отказы: `AMBIGUOUS_EFFECT` (операции), `CRITICAL_DEADLINE` (угроза/срок), `RETRY_COOLDOWN`, `STALE_INPUT` (уже RUNNING), `INCOMPATIBLE_SCHEMA` (нечего/нечем мигрировать).
- `step`: не более одного шага vN→vN+1 за вызов, затем swap. Отмена (draft удаляется, источник цел, `notBefore = tick + 100`): 11-й тик (`WINDOW_EXPIRED → BUDGET_DEFERRED`), угроза/неизвестная угроза и срок < 100/неизвестен (`→ CRITICAL_DEADLINE`), изменение revision/fingerprint (`SOURCE_CHANGED → STALE_INPUT`, evidence: ожидаемые и фактические revision/fingerprint), исключение `migrate` (`→ COMPONENT_FAULT`), невалидный draft (`→ INVALID_RECORD`). Swap: повторное сравнение revision и fingerprint, `validateStrategyRoot`, требуется `snapshotFresh === true` (иначе `DEFERRED`), источник := draft с `migrations = {version, cursor: null, sourceRevision, status: DONE}`, затем запись DONE.
- Reset: runner без heap-состояния; продолжает только draft с тем же fingerprint/revision. Если swap записан, а DONE — нет (обе записи в одном тике, поэтому возможно только при частичной записи), и источник совпадает с финализированным draft — runner записывает DONE (лог `MIGRATION_SWAP_RECOVERED`), а не отменяет. Брошенный RUNNING отменяет `open` после `deadlineTick`.
- **Этап B:** ограничение CPU на каждый блок миграции (ARCHITECTURE §6) не реализовано — шаг выполняется целиком.

## Ограничения

- Отказ `port.write`/записи в Memory посреди пакета может оставить Memory частично обновлённой; кэш сбрасывается, следующий open перекодирует namespace.
- Диагностика несовместимой схемы — только лог (`STATE_INCOMPATIBLE`, не чаще раза в 100 тиков при неизменной причине) и `health()`.
- Размер — оценка между полными open.
- Полная валидация (холодный open) — на первом тике после reset и после внешней правки; CPU на сервере не измерен.
