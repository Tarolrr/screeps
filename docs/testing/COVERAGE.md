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
