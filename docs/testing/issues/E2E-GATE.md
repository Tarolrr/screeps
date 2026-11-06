<!-- screeps-task-id: E2E-GATE -->
# E2E-GATE: Проверить полноту покрытия и защиту от ложного PASS

Подробное ТЗ подготовлено по аудиту всех собственных production-модулей dist и dist2 и прошло независимое ревью. Постановка: #4. Пользователь поручил после подготовки задач занять агентов их выполнением.

## Результат и приёмка

После остальных: adversarial проверки доказательств и итоговая матрица.

GATE-01/02 демонстрируют, что ложные доказательства/потерянные тики/ошибки teardown отвергаются; каждая строка COVERAGE имеет PASS, RED, BLOCKED или обоснованный API-only слой; отдельный machine-readable отчёт и команда acceptance.

## Обязательный протокол каждого сценария

Работать только на отдельной одноразовой инсталляции с пустой БД, собственными процессами/сокетами/портами и тестовым пользователем. Перед каждым запуском получить исключительное владение scheduler с fencing, убедиться в идентичности среды и отсутствии других пользователей; истечение lease само по себе не разрешает takeover. Отказ при сомнительной идентичности, занятости или недоступном fence. Setup журналирует каждый созданный ресурс с run/scenario ID; finally восстанавливает глобальные настройки, удаляет только свои объекты и пользователя, проверяет снимок и завершение процессов. Незавершённый cleanup или неизвестный исход команды — quarantine среды и ненулевой итог. Не переносить секреты и живую БД.

**Admission:** SRV должен экспериментально доказать ровно один полный шаг, quiescence релевантных писателей и полей и согласованный снимок DB/Memory относительно откалиброванного Game.time, включая задержки и отказы. `pause`, `roomsDone`, polling или одинаковое время вокруг чтений сами по себе не доказательство. Если этого достичь нельзя, HAR и все per-tick e2e остаются BLOCKED; документ с неизвестными не разблокирует их. API-level проверки могут выполняться отдельно и не называться e2e.

Каждый сценарий использует стартовый снимок S(T), один разрешённый шаг и fence F(T→T+1), затем согласованный снимок S(T+1); повторить для каждого тика до выполнения постусловия или бюджета. Связь Game.time, commit, Memory и intent установить в SRV, не предполагать синхронность. Каждая запись содержит run/scenario/seed, время и фазу, все релевантные объекты с id/type/owner/room/координатами/body/hits/store/capacity/спавном, source, controller, site/progress, drop/decay, Memory и очередь, actionLog/intents с происхождением и фазой, ошибки, CPU и hashes загруженного кода. Пропущенный/двойной тик, недоступное поле, нарушение fence или несогласованный снимок — инфраструктурный FAIL/UNKNOWN, не ноль и не PASS. Хранить весь ряд, а не только начальный и конечный кадр; связать происхождение крипа, приказа, объекта, исполнителя и изменение конкретного target ID. `OK`, actionLog, отсутствие errors и spawn — лишь свидетельства намерения, не результат.

Балансы проверять по дельтам на одном fence: отдельно известные engine generation спавна, стоимость spawn/action, source regeneration, decay, смерть и конкурентные intents. При неизвестной величине сначала калибровать, иначе UNKNOWN. Контроль без исполнителя позволяет отделить регенерацию. Реальные production-модули и engine объекты обязательны; отдельный test entrypoint может вызывать их публичные методы на настоящих объектах, но не переписывать production, не заменять Game/эффекты движка, не вносить в Memory или DB проверяемый результат. Вспомогательный entrypoint и данные fixture отделены от неизменённых модулей; хеши каждого загруженного файла сравниваются с исходником. Непатченный raw main обязательно запускается отдельно от изолированных API тестов.

Параметры бюджета: `R10(T)` и `R100(T)` — число шагов до следующего кратного 10/100 тика с учётом откалиброванной фазы, `Bspawn(body)`, `Bmove(route)`, `Baction`, `Bpath`, `Breload` — экспериментально установленные верхние границы с обоснованием и сохранёнными значениями. Для повторяющихся действий суммировать все итерации: `Nbuild = ceil(remainingProgress/(activeWORK × BUILD_POWER))` по подтверждённым engine constants, с поправкой на доступную энергию и фактически активные части; `Bconstruction = Σ(Bspawn(body_i)+R10_i) + Bpath + Σ Bmove(route_j) + Σ Baction_j + Nbuild×Baction + Σ R100_k + Bupstream`. Здесь i включает все нужные роли, j — все рейсы пополнения, k — все требуемые reconcile; Bupstream включает ожидания очередей, регенерации и подготовки источника. Проверить, что суммарный реальный supply покрывает расход, и пересчитать бюджет при изменении состояния. Это верхняя граница сценария, а не утверждение о числе тиков движка. Исторические 20/30/40 тиков и наблюдения в README не являются гарантиями. Каждый игровой бюджет сопровождается отдельным wall timeout `Wcase`, а операции и дочерние процессы — собственными deadline; зависание, отсутствие прогресса или потеря наблюдения не маскируются. Retry infrastructure допустим только с новым run ID, записью первой ошибки и без автоматического скрытия флаков.

Фикстура F0: принадлежащая контроллеру RCL2 открытая комната, controller (25,25), spawn (10,10), source S1 (15,10), S2 (15,20); свободные клетки, зарезервированные объекты без конкурентов, Memory `{}`, spawn energy 300/300, source capacity/energy и terrain фиксируются фактически. До запуска engine-проверка допустимости fixture обязательна: RCL и ownership, terrain и overlap, проходимый маршрут, capacity/store, допустимость body и активных частей, spawning и достаточный TTL. Некорректный fixture — BLOCKED/infra failure, не дефект стратегии; отдельный намеренно невозможный fixture проверяет этот отказ. Координаты — целевые: если выбранная отдельная комната не позволяет их установить, эквивалентные реальные координаты и проверенные расстояния сохраняются в fixture; неподдерживаемая фикстура BLOCKED. Дополнительные container (16,10), pile (16,11), extension (11,10), site (12,10), повреждённая допустимая структура (13,10), storage flag (20,20) создаются только если сценарий указывает их как вход. Начальный body, store и Memory в каждом варианте являются входом; создаваемый в результате объект/заказ/state не подставляется. Отдельный сценарий изоляции роли вправе начать с site, но не выдавать его за результат строительства.

Результаты: PASS требует всех assertion и cleanup; FAIL — наблюдаемое нарушение; BLOCKED — невозможный admission/fixture; UNKNOWN — потеря доказательства. Известное нарушение получает отдельную запись defect ID с точным воспроизведением и ожидаемым контрактом, его фактический результат RED. Задача реализации тестов может быть завершена, когда oracle и контроли доказаны, воспроизводимый RED стратегии записан в отдельный defect report, а остальные критерии задачи выполнены; исправление стратегии не входит в эти задачи. Отдельная приёмка здоровья стратегии остаётся красной при открытом known-red или неожиданном FAIL. Никаких blanket xfail/skip; XPASS требует повторной проверки и закрытия defect. Раздельно отображать verified behavior coverage и открытые дефекты.

## Сценарии

**GATE-01 — ложные доказательства.** В отдельных F0 контролях без mule дать spawn регенерировать, без builder создать только site как вход, без source-передачи создать creep; запуск acceptance assertions должен отвергнуть delivery/build/harvest. Подставить пропуск тика, неверный owner/origin и устаревший snapshot на уровне теста harness, не production; отчёт должен FAIL/UNKNOWN. Baction, Wcase.
**GATE-02 — полнота и восстановление.** По всем IDs матрицы собрать evidence, hashes, trace и результат cleanup; искусственно вызвать timeout и crash после частичного setup, повторить идемпотентный recovery и проверить quarantine при неизвестном владельце. Нет зелёного результата при RED/BLOCKED/UNKNOWN или неучтённом модуле; отдельный defect report допускает фиксацию baseline без подмены acceptance. Wcase и границы шагов инфраструктурных проверок заданы HAR/SRV.

## Полная матрица модулей и контрактов

# Матрица покрытия будущего e2e

Связанные задачи и точные фикстуры/шаги: [PLAN.md](PLAN.md). Статус всех строк сейчас **не выполнено**; указанный ID означает требуемое доказательство, а не уже пройденный тест. Исходные факты и границы: [dist](audit-dist.md), [dist2](audit-dist2.md), [сервер](server-research.md). E2E требует admission E2E-SRV и fence каждого тика; локальный API/interface слой не объявляется полноценным e2e. Изолированный вызов не подтверждает достижимость через main. Каждый production файл должен быть учтён в machine-readable отчёте E2E-GATE, с хешем, связью с результатом и объяснением исключений.

| dist модуль | Сценарии и наблюдаемое доказательство | Достижимость/слой |
|---|---|---|
| main.js | INT-01/02: полный порядок, пойманные исключения, restart | raw main |
| RoomManager.js | INT-01/02, ECO-02: создаваемые менеджеры, маршруты, порядок/save | raw + engine |
| Manager.js | ORD-04: abstract throws и no-op | API/interface |
| CreepOwner.js | SPN-02/03, INT-02: queued→живой, смерть, reload и owner | engine |
| SourceManager.js | ORD-03, SPN-01/02, ECO-01/02: места, заявка, источник/destination | engine |
| SpawnManager.js | SPN-01..03: очередь, тело, dryRun, spawn и ownership | engine |
| DeliveryManager.js | ECO-02: маршруты, приоритет, pending и цель | engine |
| StorageManager.js | ECO-02, INT-01: ресурс, pending/need, storage flag; отсутствие flag RED | engine |
| ControllerManager.js | ECO-02/03: pending/need и заказ upgrader | engine |
| ConstructionManager.js | BLD-02: очередь/extensions, ошибки и deadline | dormant, изолированный engine |
| CreepPlanner.js | ORD-03, SPN-01: роли/body/cost и fractional exception | API + engine |
| creepUtils.js | ORD-03: поля CreepTemplate/QueuedCreep и их потребители | API |
| role.harvester.js | ECO-01 | engine |
| role.mule.js | ECO-02, все достижимые destination/state ветви | engine; код после безусловного break недостижим |
| role.builder.js | BLD-03 | engine, автоматический заказ в main отсутствует |
| role.repairer.js | BLD-03 | engine, отдельный role entrypoint |
| role.upgrader.js | ECO-03 | engine |
| mapPatch.js | GATE-02 и ORD-04: Map round-trip/filter, Array.flat 1/2 и пустой массив, загрязнение global | API; глобальное действие при INT-01, дефекты не норма |
| Consumer.js | ORD-04: интерфейс и no-op | API/interface |
| Producer.js | ORD-04: abstract getters/methods/mixin и исключения | API/interface |
| logger.js | ORD-04: уровни, Memory load/save, invalid level и reload | API; INT-01 проверяет доступность |
| EconomyPlanner.js | ORD-04: коэффициенты, сброс economy, отсутствие записи total | dormant API |
| SpawnPlanner.js | ORD-04: сброс очереди и точная ошибка roles.keys | dormant API |
| SourceDesc.js | ORD-03: terrain/work/carry/distance/update | dormant API на реальной комнате |
| room.harvestPlanner.js | ORD-04: период 100 и назначения | dormant API |
| room.consumptionPlanner.js | ORD-04: период 50 и назначения | dormant API |
| room.pathPlanner.js | ORD-04: no-op run и пустой assignPath | dormant interface, функциональный путь не заявляется |

| dist2 production модуль | Сценарии и наблюдаемое доказательство | Достижимость/слой |
|---|---|---|
| main.js | INT-01/02: регистрация, порядок initialization/loop, save, reload и ошибки | raw main |
| BuildController.js | BLD-02/03, INT-01: orders, sites, limit/retry | engine; baseline RED |
| constructionPatterns.js | BLD-01/02: все зарегистрированные геометрии, terrain/path/placer | изолированный engine + raw integration |
| resourceManager.js | ORD-01/02, INT-02: apply/update/delete/save/load/disabled | engine API + raw |
| resources.Resource.js | ORD-01: schema, spec/state, annotation, исключения и JSON | API + engine consumers |
| resources.sourceResource.js | ORD-01, ECO-01: id/source lookup | engine |
| resources.creepOrder.js | ORD-01, SPN-01..03: body/schema, state/expiry | engine |
| resources.spawnProcess.js | SPN-01..03: spawning/completed/failed и сериализация | engine |
| resources.constructionOrder.js | BLD-02/03: positions, site selection, claim/validate/remove/reload | engine, baseline RED |
| SourceController.js | SPN-01, INT-01: source/harvester orders, 100-tick reconcile | raw + engine |
| RoomController.js | INT-01, ECO-02/03: source-specific mule/upgrader orders | raw + engine |
| SpawnController.js | SPN-01..03: 10-tick lifecycle/order/energy budget | engine |
| role.harvester.js | ECO-01 | engine |
| role.mule.js | ECO-02: templates, entity/area, ground/structure/creep и индексы | engine |
| role.builder.js | BLD-03/04: state/target/progress; приоритет и потеря site | engine |
| role.upgrader.js | ECO-03 | engine |
| roles.js | INT-03: dispatch, spawning, unknown role, реальное исключение и продолжение второго крипа, exists/getAll | raw + engine |
| utils.priority.js | ORD-02, SPN-01: id/offset и сортировка | API + engine |
| mapPatch.js | ORD-04/GATE-02: Map и flat API, empty/depth/global; INT-01 загрузка | API; не полноценный игровой эффект |
| logger.js | ORD-04: уровни и Memory/reload; INT-01 загрузка/ошибки | API + raw |
| js-yaml.js | INT-01: проверка загрузки импортируемого vendor и отсутствия активного consumer config path; повторный статический inventory при изменении | vendor исключён из собственной семантики; не заявлять YAML e2e |

`dist2/tests`, mock-game, visualizer и markdown — существующие тесты/инструменты/документация, не production игровые модули; учитываются как справочные источники, не заменяют engine outcomes. Наружные CLI/визуализация корня репозитория находятся вне игрового dist; проверяются лишь если используются harness и не объявляются покрытием стратегии.

## Матрица независимых контрактов и доказательств

| Контракт | Сценарии | Обязательная проверка |
|---|---|---|
| Наблюдение каждого тика | SRV-01/02, HAR-01/02 | Калиброванный шаг и fence, непрерывная нумерация, coherent DB+Memory, faults не становятся PASS |
| Ресурсы и сериализация | ORD-01/02, INT-02 | ID/annotation, schema, spec/state, disabled и reload без дубля |
| Планирование и приоритет | ORD-02..04, SPN-01 | Различия dist/dist2, тело/цена, порядок, dormant и отрицательные входы |
| Spawn и жизненный цикл | SPN-01..03, INT-01/02 | origin→очередь→spawn→живой ID→owner, смерть, expiry, reload |
| Добыча и доставка | ECO-01/02, INT-01 | source/store/drop/target causal delta; генерация и decay учтены, контроль без исполнителя |
| Upgrader | ECO-03, INT-01 | реальный рост controller.progress и расход энергии |
| Строительство | BLD-01..03, INT-01 | корректные positions→site→progress→structure→claim, не более пяти, retry и ограничения; known-red отдельно |
| Ремонт | BLD-03 | допустимая структура, фактические hitsMax, дельта hits и энергия, пороговые и недоступные цели |
| Main/restart | INT-01..03 | непропатченные хеши и реальный вызов loop, состояния каждого тика и сохранение связей |
| Негативная приёмка | GATE-01/02 | намерение ≠ эффект; искусственные пропуски, неверные owner/origin, teardown и таймаут выявлены |

Побайтная идентичность независимых прогонов не предполагается: сравнивать нормализованные причинные инварианты с отображением выданных ID, seed и времени; детерминизм заявлять только после подтверждения. Серверные ID не обязаны содержать run ID: фиксировать фактически выданные ID в ownership journal. Известные baseline дефекты описаны в аудитах; каждый воспроизведённый дефект связывается с отдельным report и конкретным сценарием, а приёмка здоровья стратегии остаётся красной до устранения. Задача реализации тестов может быть завершена при доказанных oracle и контролях и отдельно документированном воспроизводимом RED; исправление стратегии не входит в scope этих задач. Не смешивать исторические результаты с новым экспериментом.


## Границы работы

- Исполнение делегировано агентам под lease координатора; только координатор меняет Issues и метки.
- Стратегию dist/dist2 не исправлять ради зелёных тестов. Дефект кода оформлять отдельно с трассой; приёмка реализации теста и здоровье стратегии различаются.
- Не изменять работающий пользовательский сервер. Все эксперименты — в выделенной одноразовой установке.
- Не включать scheduler, не публиковать секреты, не выполнять push или merge.
- Каноническое ТЗ в рабочем репозитории: docs/testing/PLAN.md, COVERAGE.md и аудиты. Этот файл — текст issue, не отдельная очередь.

Depends on: #6, #7, #8, #9, #10, #11, #12
