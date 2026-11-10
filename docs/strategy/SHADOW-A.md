# Теневой конвейер этапа A (STRAT-A5)

Задача [#25](https://github.com/Tarolrr/screeps/issues/25), контракт `A.4` ([CONTRACTS-A](CONTRACTS-A.md) §2, §4.6, §5, §10, история). Основание — [ARCHITECTURE](ARCHITECTURE.md) §2–§4, §9; [DESIGN](DESIGN.md) §4, §5, §7, §13; [INTEGRATION](INTEGRATION.md) (shadow). Исполнитель — по-прежнему legacy dist2; shadow ничего не исполняет.

## 1. Конвейер

| Фаза | Компонент | Что делает | Запись (writer-bound handle) |
| --- | --- | --- | --- |
| BOOT | `boot.router` (A0) | StateStore.open + OwnershipRouter | — |
| OBSERVE (до legacy) | `observe.snapshot` (A1) | Reader снимает **только shadow-комнаты**; нет shadow-комнат → `REJECTED(NOT_REQUESTED)`, снимок не снимается | — |
| EXECUTE | `execute.legacy` | dist2 как раньше | legacy Memory (только legacy) |
| RECONCILE | `reconcile.shadow` | A3 `Reconciler.reduce` на отфильтрованном снимке T и снимке T−1 из heap (после reset/пропущенного тика T−1 нет → разрыв `EVENT_GAP`, не нули) | `observation` |
| FORECAST | `forecast.shadow` | A4 `EconomyModel.evaluate`, `ForecastCalendar.buildModel/reservesOfModel`, `ReplacementForecast.analyzeReplacements`, `BudgetLedger.liquidity`, `modeSignals`; пересчёт раз в 25 тиков, по структурному событию или при переходе ликвидности через полосу резерва (ниже нижнего / ниже целевого / на цели) | `finance` (`rooms.<r>.forecast` при пересчёте) |
| PLAN | `plan.shadow` | `planning/ShadowGovernor.evaluateRoom` (RoomGovernor.propose) | — |
| ADMIT | `admit.shadow` | гипотетический `BudgetLedger.admit` наступивших предложений (ничего не резервируется); DecisionRecord при значимом изменении; подготовка proposals | (буфер DecisionRecorder) |
| CLOSE | `close.shadow` | записи прерываний; кольцо решений и proposals — **двумя отдельными пакетами** (отказ пакета proposals не блокирует кольцо с гистерезисом); удаление proposals комнат, выведенных из shadow; TTL и replay-экспорт; затем `StateStore.close(T)` → `strategy.lastClosedTick = T` (последняя запись тика) | `planning`; close — внутренний writer StateStore |
| CLOSE | `close.report` (A0) | сводка тика (heap) | — |

Все компоненты shadow — класс бюджета `optional` (без заимствования bucket), под FaultBoundary. Кроме проверки TickRunner, каждый компонент сам допускает себя по **измеренной** оценке CPU (heap: максимум из скользящего среднего и медленно затухающего пика, начиная с консервативных априорных значений reconcile 5, forecast 10, plan/admit/close 1 — не меньше измеренных) и при `used + оценка > min(limit, tickLimit) − 2 − 5` возвращает `DEFERRED(BUDGET_DEFERRED)`. Компонент получает только значения `frame.result(...)` и пишет только через **свой** handle (`stageA.js`): observation → reconcile, finance → forecast, planning → close (plan/admit только читают); общего диспетчера записи нет. `expectedRevision` — ревизия view, прочитанного в начале компонента, затем ревизия, возвращённая его предыдущим принятым пакетом (без «слепого» перечитывания). `closeTick` — функция над `store.close`. GameReadPort, MemoryPort, gateway, функции legacy компонентам не передаются. Каждый следующий компонент работает только если предыдущий в этом тике `READY`; иначе он передаёт причину дальше (`DEFERRED`/`UNKNOWN`/`REJECTED{dependsOn}`).

Фильтр снимка (`filterSnapshot`): остаются только shadow-комнаты и крипы, которые находятся в них, имеют envelope с домом в них или уже связаны там ObservedBinding; fingerprint пересчитывается.

## 2. Управление оператором

**Включить shadow для комнаты** (по умолчанию — legacy **без** shadow-работы; снимок не снимается):

```js
// консоль Screeps; Memory.strategy создаёт StateStore при первой записи. Если его ещё нет:
if (!Memory.strategy) Memory.strategy = { schemaVersion: 1, policyVersion: null, buildId: null, revision: 0, lastClosedTick: null,
  recentPatchIds: [], control: { rooms: {} }, rooms: {}, missions: {}, demands: {}, bindings: {}, assignments: {},
  ledger: { reservations: {}, funds: {}, missionExposure: {} }, operations: {}, faults: {},
  migrations: { version: 1, cursor: null, sourceRevision: null, status: 'NONE' } };
Memory.strategy.control.rooms['W1N1'] = { requestedMode: 'shadow', effectiveOwner: 'legacy', epoch: 0,
  transitionPhase: null, transitionId: null, previousOwner: null, blockedReason: null };
```

Выключить: `requestedMode: 'legacy'` (или удалить запись). `adaptive-v1` отклоняется роутером (`UNSUPPORTED_CAPABILITY`, лог `SHADOW_ROUTE_REJECTED`), исполняет legacy. Невалидная запись/несовместимая схема `Memory.strategy` → shadow `SUSPENDED`, namespace не трогается (лог `STATE_INCOMPATIBLE`), legacy работает.

**Экспорт replay** (только по явному запросу, ограниченный):

```js
Memory.strategyShadow.exportRequest = { requested: true, ticks: 10 /* 1..49 */, tickFrom: null /* или тик начала */ };
```

Конвейер ждёт тик, на котором прогноз всех shadow-комнат свежий (≤ 25 тиков), берёт его как базовый (снимок T0 + выбранное состояние после CLOSE T0) и записывает `ticks` следующих полных тиков подряд. Статус — `Memory.strategyShadow.replayExport = {requestFingerprint, status: RECORDING|READY|FAILED|EXPIRED, startedAt, completedAt, reasonCode, detail, fixture}`. Через 1500 тиков после READY/FAILED planning переводит запись в `EXPIRED` (фикстура удаляется, отпечаток запроса остаётся — тот же запрос не исполняется повторно); снимите фикстуру раньше. Неполный тик (дефер, ошибка, reset) перезапускает запись. Фикстура > 98 304 символов canonical JSON → `FAILED(BUDGET_DEFERRED)` (небольшая комната — около 6–7 KB на тик, т. е. ~12 тиков). Тот же запрос повторно не исполняется; новый запрос — изменить поля `exportRequest`. `exportRequest` пишет только оператор (компоненты его не меняют).

Воспроизведение (локально, без сервера):

```text
node tools/replay.js --extract memory.json --out fixture.json   # дамп Memory или Memory.strategyShadow
node tools/replay.js fixture.json                               # policyVersion 'shadow-a5.*' -> pipeline shadow-a5
```

Pipeline `shadow-a5` (`ShadowAdapter.replayShadowFixture`) повторяет RECONCILE…CLOSE по снимкам 1..n из состояния после CLOSE снимка 0 теми же функциями шагов, что и живой конвейер, и сравнивает объединение reason codes и прогноз последнего тика (`REPRODUCED`/`MISMATCH`, коды выхода 0/1/2).

## 3. Журнал решений (`strategyShadow.rooms.<room>.decisionRing`)

Кольцо ≤ 100 записей на комнату и ≤ 24 000 символов JSON (самые старые вытесняются, новейшая всегда остаётся). Запись добавляется только при **значимом** изменении подписи: режим/удержание тревоги, зрелость, класс угрозы, обязательные потребности и их срочность, исход гипотетического допуска альтернатив, причины UNKNOWN, сравнение с legacy, новое завершённое окно потоков, качество прогноза. Каждая запись: `mode: 'shadow'`, `executed: false`.

| Поле | Смысл |
| --- | --- |
| `reasonCode` | главная причина: отказ допуска (`INSUFFICIENT_LIQUIDITY`, `UNCERTAIN_FUNDING`, …) → `CRITICAL_DEADLINE` (просроченная замена, RECOVER/SIEGE) → первая причина UNKNOWN → `SHADOW_ONLY`; прерывания — `BUDGET_DEFERRED`, `COMPONENT_FAULT`, `RETRY_COOLDOWN`, `CIRCUIT_OPEN`, `EVENT_GAP` |
| `inputs.gov` | `{mode: SIEGE/RECOVER/ALERT/STABILIZE/GROW, since, hold: {mode, clearSince}}` — состояние гистерезиса (из него восстанавливается режим после reset) |
| `inputs.threat`, `inputs.maturity` | класс угрозы (ARMED/THIEF/SCOUT/NONE/NOT_VISIBLE), зрелость (BOOTSTRAP/BASIC/BUFFERED/NETWORKED) |
| `inputs.needs` | обязательные потребности: замены (не OPTIONAL, старт ≤ T+150, просроченные или с UNKNOWN), отсутствующая цепь harvest/feed (аварийный шаблон) |
| `inputs.legacy` | сравнение с фактическим legacy: `CONSISTENT`, `LEGACY_BEHIND` (наша замена наступила, legacy ничего этой функции не спаунит), `LEGACY_UNPLANNED_SPAWN` (legacy спаунит то, чего не было в прошлом решении), `UNKNOWN` |
| `inputs.balance` | объяснение баланса: последнее завершённое окно A3 (доход = harvest+externalIn; internal transfer отдельно, не доход; unexplained) и прогноз A4 (`computedAt`, `age` — возраст кэшированного прогноза в тиках, free, нижняя оценка дохода, обязательства, резервы); UNKNOWN показывается как `{value: null, reason}` |
| `inputs.unknown` | причины UNKNOWN (не 0, не PASS) |
| `inputs.interruption` | для прерываний: компонент или `LOST_TICKS {from, to}` |
| `alternatives` | `spawn:<slot>` (допуск сейчас), `emergency:<slot>` (дешёвое тело при отказе), `defer:<slot>`, `schedule:<slot>` (ещё не наступила), `optional-growth` (только в GROW) |
| `expectedNextFact` | ожидаемый следующий факт (старт spawn ближайшей потребности) |

Предложения (`strategyShadow.proposals`) — гипотетические Proposal (`mode: 'shadow'`, `missionPatches: []`, SPEND на `spawnPool:<room>`), перезаписываются только при изменении сути, удаляются, когда больше не предлагаются.

**Режимы** (DESIGN §4): вход немедленный; выход из SIEGE/ALERT — после 100 подряд **оценённых** видимых тиков без подтверждённой угрозы. Непрерывность — по комнате и по оценке: счёт перезапускается, если тик не закрыт (`lastClosedTick ≠ T−1`), если у комнаты в этом тике разрыв событий (отложенная сверка, комната была выведена из shadow и возвращена — запись старше текущего shadow-окна не считается непрерывной, невидимость), и каждая запись прерывания (дефер/ошибка любой стадии) сохраняет `hold.clearSince = null`. RECOVER/STABILIZE — признаки A4 `modeSignals` без задержки. **Прерывания:** дефер/ошибка в тике пишется в CLOSE того же тика; тики, где не выполнился даже CLOSE, — записью `LOST_TICKS` на следующем тике (`BUDGET_DEFERRED`, если тот же heap был жив, иначе `EVENT_GAP`).

**Путь для резервов legacy** (`planning/TravelEstimate`): `ceil(расстояние Чебышёва × тиков_на_клетку × 1.25)`, тиков на клетку = `max(1, ceil(не-MOVE / MOVE))` (гружёный, равнина), расстояние — до самого дальнего источника (harvest/feed) или до самой дальней внутренней клетки комнаты (прочие функции: у ControllerSnapshot нет позиции). Качество `ESTIMATED`; это **не доказанная** верхняя граница (стены, обходы, болота). Нет спавна/источников/MOVE/видимости → оценки нет → UNKNOWN как раньше.

## 4. Ограничения и измерения

- CPU (Node 22, Cortex-A55, загрузчик тестов, одна комната RCL2, 3 крипа, ловушки-прокси на Game): legacy (фейк) ≈ 0.55 мс/тик; со shadow ≈ 12.8 мс медиана, p90 ≈ 19, пик ≈ 40 (тики пересчёта прогноза). Профиль: OBSERVE (A1 build+validate snapshot) ≈ 3.9 мс, RECONCILE ≈ 4.6 мс (A3 reduce ≈ 2.3, StateStore.apply валидация ≈ 2.4), FORECAST ≈ 0.8 мс в среднем (≈ 9 мс в тик пересчёта; `validateSnapshot` на каждом `analyzeReplacements`), PLAN+ADMIT+CLOSE ≈ 0.6 мс, open ≈ 0.85 мс. Реальный CPU сервера не измерен (A6). OBSERVE измерен ≈ 3.9 мс при потолке `observeCeilingCpu = 3`: Reader (A1) проверяет потолок перед каждой комнатой, но с оценкой 0.3 CPU на комнату, поэтому одна комната может превысить потолок на последней проверке; предложение A1 — поднять `ESTIMATE_ROOM_CPU` до ≈ 4 (или учитывать валидацию снимка отдельным блоком).
- Прогноз используется до 25 тиков (`computedAt`/`age` показывают возраст), но пересчитывается сразу при структурном событии или переходе ликвидности через полосу резерва — по DESIGN §4.
- Признаки RECOVER берутся из A4 (`modeSignals`): комната, где dist2-harvester сам кормит spawn без роли mule, будет видна как `NO_FEED_CHAIN`/RECOVER (ложная тревога только в журнале).
- SIEGE/ALERT — только собственная видимая комната; маршруты/remote — этап D. «Повреждение критических объектов» по журналу событий не анализируется.
- Replay требует пустых `strategy.demands` и shadow-ledger (на этапе A так и есть; иначе `FAILED(UNSUPPORTED_CAPABILITY)`); `events` фикстуры пуст — pipeline нормализует сырые журналы снимков сам.
- Ошибка записи кольца теряет только буфер этого тика; значимость сравнивается с сохранённым кольцом, поэтому запись повторится.

Тесты: `tests/bot/integration/` — артефакт тестовой сборки (фейк dist2, настоящий конвейер) в загрузчике Screeps над детерминированным миром `support/simWorld.js`; реальная dist2 — дифференциальный прогон legacy vs shadow (`realLegacy.test.js`); чистые модули — нативно и с mapPatch (`units*.test.js`).

**Reset и `Memory.strategy` (находка e2e RESET на b-003544fc5aa70751).** Расхождение `revision`/`recentPatchIds` между прогоном с reset и без него начиная с тика после reset ожидаемо: снимка T−1 в heap нет, поэтому Reconciler пишет для этого тика UNKNOWN-дельту (`EVENT_GAP`) — другие `flowWindows` и другие content-hash `patchId`; кэш прогноза пуст, поэтому прогноз пересчитывается и пишется лишний пакет finance (+1 revision). Legacy-память и intents не затрагиваются (LEGACY-EQ PASS).
