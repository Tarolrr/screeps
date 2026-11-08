# Финансовая модель этапа A (STRAT-A4, #23)

Основание: [DESIGN](DESIGN.md) §3, §5, §7, §12, §13; [ARCHITECTURE](ARCHITECTURE.md) §5; [CONTRACTS-A](CONTRACTS-A.md) §4.4, §5, §10 (`contract A.2`). Все модули чистые (значения на вход, Result на выход), не обращаются к Game/Memory и на этапе A только считают гипотетические/shadow-значения — ничего не исполняется. Пороги — начальные настройки DESIGN §12, не оптимум.

| Модуль | Назначение |
| --- | --- |
| `src/bot/scheduling/BudgetLedger.js` | LedgerView узлов, гипотетический `admit`, переходы Reservation, идемпотентное подтверждение, патч `ledger.reservations.<id>` |
| `src/bot/models/ReplacementForecast.js` | ReplacementPlan: сроки, стоимость, spawn 3×body, путь, запас 25, поколения |
| `src/bot/models/ForecastCalendar.js` | Calendar на 1500 тиков, сценарии DESIGN §5, нижний/целевой резерв, проверка расписания с одним перестроением |
| `src/bot/models/EconomyModel.js` | нижняя оценка дохода, аналитический ограничитель, признаки режима, квоты 50/50, фонд SAVING, ForecastSummary и патч `rooms.<room>.forecast` |

## BudgetLedger

- Узлы: все `EnergyNode` снимка и `spawnPool:<room>` (observed = `energyAvailable`). Узел, на который ссылается живое резервирование, но которого нет в снимке, получает observed `UNKNOWN(MISSING_FIELD)`: исчезновение узла не доказывает отсутствие расхода.
- `free = observed − reserved − disputed`, где reserved — непогашенная часть (`amount − settled − released − unknown`) нетерминальных SPEND/MOVE, disputed — `unknownAmount` нетерминальных. observed UNKNOWN ⇒ free UNKNOWN.
- SPEND/MOVE на отдельном spawn/extension дополнительно учитывается в пуле (общая энергия). CAPACITY не занимает энергию.
- MOVE держит узел-источник и не увеличивает цель. SETTLED/RELEASED ничего не держат: подтверждённый spawn снимает обещание, а снимок уже содержит уменьшенный остаток — повторного вычитания нет.
- RETIRED не держит узел (новая физическая база), но `missionExposure` продолжает учитывать верхнюю границу `unknownAmount`.
- `admit(context, proposal, ledgerView)` последовательно проверяет запросы по бегущей копии free: нет узла → `INSUFFICIENT_LIQUIDITY`; узел UNKNOWN → `UNCERTAIN_FUNDING`; спорный узел или домен `UNCERTAIN_FUNDING` → `UNCERTAIN_FUNDING` для необязательного (пропускаются `context.emergency` и предложения с CRITICAL-demand); нехватка → `INSUFFICIENT_LIQUIDITY`; лимит миссии (`context.missionLimits`) → `INSUFFICIENT_LIQUIDITY{reason:'MISSION_LIMIT'}`; чужая ревизия/тик → `STALE_INPUT`. Будущий доход в расчёт не входит. `missionLimits` без `existingReservations` → `UNCERTAIN_FUNDING{reason:'EXPOSURE_UNKNOWN'}` (неизвестная экспозиция не равна 0). С `context.nodeClasses` (`ledgerNodeClasses`) запрос на отдельный spawn/extension проверяется и списывается также из пула в том же пакете.
- Каждый энергетический SPEND оплачивает определённую Demand (единственная в proposal или парная по индексу запроса); резервирование получает `operationKey = room/ownerEpoch/demandStableKey/generation/spawn|spend/0` (`context.ownerEpoch`, по умолчанию 0), и `paymentKeyOfReservation` возвращает `<demandStableKey>#g<generation>` — ключ того же платежа. Без идентичности Demand → `INVALID_RECORD{reason:'NO_DEMAND_IDENTITY'}`, «свободно плавающий» платёж не создаётся. Старые резервирования без operationKey (допустимы в A.2) календарь учитывает один раз под ключом `reservation:<id>`.
- Повторный допуск того же proposal (детерминированные id `res:<proposalId>:<i>` в `context.existingReservations`) возвращает их без нового списания, только если все найдены и совпадают kind/узлы/сумма/ресурс; RELEASED, частичное совпадение или изменённый запрос → `STALE_INPUT` (новая попытка — новый proposalId).
- `applySettlement(reservation, {tick, actor, action, target, amount}, appliedKeys, tick)` — подтверждённое количество сначала закрывает спорную часть, затем удерживаемую; ключ `(tick, actor, action, target)` из `appliedKeys` повторно ничего не списывает.

## ReplacementForecast

- Исполнители комнаты: дом = `strategyEnvelope.homeRoom` → `ObservedBinding.homeRoom` → `creep.roomName`.
- Слот: для крипа с envelope — `demandStableKey` его operationKey (поколение из ключа; старшее поколение покрывает младшие, отдельной замены у них нет); для legacy — `<room>/legacy/<role>/<creep>`. Ключ записи — `<слот>#g<поколение>`; occurrence spawn всегда `0` (`replacementOperationKey`).
- `bodyCost` при неизвестном типе части — `0` с `quality UNKNOWN` и `MISSING_FIELD` (поле DTO целое, null не допускает); потребитель обязан смотреть `quality`, календарь в этом случае даёт UNKNOWN.
- Legacy: k spawning-крипов роли покрывают k ближайших к смерти живых этой роли — замена не дублируется.
- `deadline` = смерть текущего (снимок `ticksToLive`; spawning — `remainingTime + 1500/600`), `spawnTime = 3 × body`, `startBy = deadline − travel − spawnTime − 25`; следующее поколение — от рождения сменщика, пока `startBy ≤ tick + horizon`.
- Путь — `DemandOption.travelTime` или `travelEstimates[слот|роль|функция]` (верхняя оценка вызывающего), иначе UNKNOWN. UNKNOWN TTL/пути ⇒ `quality UNKNOWN`, `startBy null`, `MISSING_FIELD`, без экстраполяции. Просроченный старт ⇒ `CRITICAL_DEADLINE`. `expiryTime` legacy не читается.
- Функции ролей (начальная настройка): harvester/miner → harvest (CRITICAL); mule/hauler/feeder/filler/carrier → feed (CRITICAL); upgrader → REQUIRED; builder/repairer → OPTIONAL; прочие → REQUIRED.

## ForecastCalendar

- Потоки дохода — кусочно-постоянные ставки (INCOME = смена скорости, energy/tick). По умолчанию один локальный поток из `EconomyModel.incomeLowerBound`, зависящий от функций harvest и feed; явные потоки (в т. ч. remote) — `incomeStreams`.
- Платежи (PAYMENT) уникальны по stableKey `<demandStableKey>#g<generation>`: обязательные замены (кроме OPTIONAL), CRITICAL/REQUIRED Demand (срок `requiredBy − travel − spawnTime`; поколение ≤ максимального поколения envelope живого/spawning исполнителя этого слота уже покрыто и не оплачивается повторно), открытые SPEND-резервирования. Reservation, связанная с тем же ключом через operationKey, — это финансирование платежа, а не второй платёж; уже списанная (`settledAmount`) часть исключается, остаток — один раз. DEADLINE — маркер срока замены (сумма информационная, в дефицит не входит).
- Дефицит сценария = `ceil(max префикс(платежи − доход))`, доход до тика платежа (исключая сам тик).
- Сценарии: обычный; потеря всех текущих исполнителей harvest, feed, обеих функций (только если они есть) — сейчас и в момент ближайшего срока замены функции. Будущие замены потерянных слотов заменяются аварийным шаблоном (harvest: WORK+CARRY+MOVE=200, feed: 2×CARRY+MOVE=150) и его следующим поколением в горизонте; доход зависимых потоков 0 до восстановления (`spawnTime + travel` шаблона), затем `min(исходная, template.incomeRate)`.
- Нижний резерв = max дефицитов базовых сценариев; целевой = max(нижний, те же сценарии с нулевым remote-доходом первые 300 тиков). Без remote целевой = нижний; платежи первых 300 тиков повторно не прибавляются.
- UNKNOWN значимой ставки/срока/суммы/времени восстановления ⇒ `UNKNOWN` резерва (не 0).
- `checkSchedule(input, stock)`: непрофинансированный платёж переносится на первый профинансированный тик не позже последнего срока старта — не более одного перестроения; иначе `UNKNOWN(CRITICAL_DEADLINE)`.
- Платёж из пула больше `energyCapacityAvailable` помечается `INSUFFICIENT_LIQUIDITY` (`capacityViolations`).

## EconomyModel

- Доход = `harvest + externalIn`; `internalTransfer` никогда не доход. Нижняя оценка: известный отказ → 0; три последовательных завершённых окна с известным доходом, последнее из которых — последнее закрытое (`floor(tick/100)×100`, без tick — самое новое из переданных), с одинаковым ненулевым `topologyVersion` → min/100 (DERIVED); при `topologyVersion = null` топология не доказана → `0,8 × analytic`, если задан, иначе min/100 с качеством ESTIMATED и `NO_HISTORY`; разрыв/смена топологии → `0,8 × analytic` (`NO_HISTORY`), иначе `UNKNOWN(NO_HISTORY)`.
- `analyticIncome`: min(регенерация источников, 2 × активные WORK harvester/miner); ограничитель доставки на этапе A не моделируется.
- `modeSignals`: RECOVER — нет spawn, исполнителя функции harvest или feed (функция — по demand из envelope или `legacyRole` через `ReplacementForecast.functionOf`, не по частям тела; spawning учитывается); STABILIZE — валовая ликвидность < нижнего резерва, резерв/прогноз UNKNOWN, необъяснённый баланс или просроченная CRITICAL-замена; иначе GROW. SIEGE/ALERT — этап B.
- `allocateQuota`: ниже нижнего резерва (или уровень неизвестен) — всё в резерв; между нижним и целевым — 50/50, нечётная единица резерву (не больше нехватки до цели); на цели — всё на веху. `advanceFund` копит до цели, не меняя `target`/`deadline` (JSON-safe, переживает reset).
- `evaluate(snapshot, stateView, horizon, options)` → ForecastSummary: `freeEnergyNow` — ликвидность (пул + storage/container/link/terminal + cargo + piles; без отдельных spawn/extension, remote и tower) минус активные резервирования; `committedPayments` — платежи календаря без уже удерживаемых резервированиями частей; `nextDeficitTick` — по валовой ликвидности и всем платежам. Нижний резерв сравнивается с валовой ликвидностью, не со свободной (иначе платёж учитывается дважды).

## Отклонения от сигнатур §10 и предложения по контракту

- Дополнительные необязательные параметры: `roomName` (многокомнатный снимок), `travelEstimates`, `incomeStreams`, `analyticIncomePerTick`, `knownFailure`, `emergencyTemplates`, `constants`; `createLedgerView(snapshot, reservations, roomName?)`, `evaluate(..., options?)`.
- Ключи подтверждений `(tick, actor, action, target)` хранит вызывающий (`appliedKeys`): в Reservation нет поля. Предложение: `Reservation.settlementKeys` (ограниченный список) либо журнал подтверждений в `strategyShadow.ledger`.
- ForecastSummary не содержит нижнего/целевого резерва и режима. Предложение: `lowerReserve: M`, `targetReserve: M` (и, возможно, `modeHint`).
- CalendarEntryKind не различает рождение/прибытие/смерть/доставку: они выражены как INCOME (смена ставки) и DEADLINE. Предложение: `BIRTH, ARRIVAL, DEATH, DELIVERY` или поле `cause`.
- ReplacementPlanEntry не содержит generation/operationKey/функции: они в `analyzeReplacements().meta`. Предложение: `generation`, `function`.
- Funds/SAVING на этапе A не персистятся (`strategy.ledger.funds` пуст до этапа B/C).
- Contract A.3: `tower` в STORAGE_CONTAINER исключён из ликвидности по `objectType`.

## Остаточные неизвестные

- Без `travelEstimates` legacy-замены имеют UNKNOWN путь, поэтому резервы на этапе A для legacy-комнат честно UNKNOWN, пока не задана верхняя модель пути (DESIGN §7: fatigue +25% по реальному маршруту — нужен путь, которого нет в снимке).
- `topologyVersion` от A3 пока может быть null: без аналитического ограничителя оценка остаётся ESTIMATED. Нужен реальный `topologyVersion` от A3.
- Очередь spawn (занятость) не сдвигает `startBy`; проверка — через `CRITICAL_DEADLINE`/`checkSchedule`.
- Аварийный шаблон при потере восстанавливает исходную ставку дохода, если `incomeRate` шаблона не задан (политика, не доказанный предел).
