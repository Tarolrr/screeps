# e2e — тестовая обвязка для живого standalone-сервера

Позволяет прогонять тест-кейсы с метриками на работающем сервере без игрового
клиента. Управление идёт через админский CLI-сокет (`[::1]:21026`): загрузка
кода юзеру, прямые вставки/удаления в `rooms.objects`, чтение `Memory` и env.

Для визуального наблюдения через стандартный Steam-клиент используйте
долгоживущий изолированный [E2E-VIEW инстанс](../docs/testing/view.md). Он не
работает с живой БД и держится до явного `stop`/`Ctrl-C`.

## Безопасность и расположение

Тесты изменяют живую БД и глобальную длительность тика; запускайте только на выделенном сервере при исключительном доступе. Каждый тест с размещением пользователя проверяет, что W5N8 содержит только контроллер, источники и минерал, без владельца и резервации. Проверка не является блокировкой от параллельных игроков. Прерывание процесса или потеря CLI могут помешать очистке и восстановлению тиков; проверьте состояние сервера после аварии. Cleanup удаляет новые нейтральные постройки, поэтому комната должна оставаться выделенной на весь прогон. Код стратегии берётся из родительского каталога репозитория. Для simplebot путь к серверу задаётся `SCREEPS_SERVER_HOME` (по умолчанию `~/screeps`); CLI настраивается через `SCREEPS_CLI_HOST` и `SCREEPS_CLI_PORT`.

На момент переноса проверены синтаксис, загрузка модулей и защитный отказ теста. В W5N8 есть резервация контроллера игроком, поэтому live-прогон после переноса не выполнялся и заблокирован до освобождения комнаты. Не снимайте её ради теста без согласования.

## Запуск

```bash
export PATH=~/.local/node22/bin:$PATH
node e2e/run-all.js             # все тесты последовательно (~3 мин)
node e2e/test1-cpu-ticks.js     # простой тест: код тикает, CPU меряется
node e2e/test2-harvest-env.js   # среда через БД: крип+спавн вставлены напрямую
node e2e/test3-simplebot.js     # реальный @screeps/simplebot из node_modules
node e2e/test4-combat.js        # бой: ATTACK-крип убивает манекен
node e2e/test5-build.js         # код ставит site + WORK-крип достраивает дорогу
node e2e/test6-user-dist.js     # реальная стратегия юзера: Tarolrr/screeps dist/
node e2e/test7-user-dist2.js    # то же, но dist2/ (WIP-реархитектура)
```

## Структура

- `cli-client.js` — клиент CLI-сокета. `eval(expr)` выполняет JS в серверной
  песочнице (доступны `storage.{db,env,pubsub}`, `map`, `bots`, `system`,
  `print`) и возвращает результат.
- `harness.js` — `Harness`: helpers (`dbFind/dbInsert/dbUpdate/dbRemove`,
  `gameTime`, `waitTicks`, `waitUntil`, `getMemory`, `createUser`, `destroyUser`,
  `setUserCode`, `insertCreep`, `findFreePos`, `pause/resumeSimulation`,
  `setTickDuration`) и раннер `runCase(name, {setup, test, teardown})`
  в стиле python setup/teardown.
- `test*.js` — примеры тестов.
- `user-strategy-runner.js` — общий раннер для кода юзера из
  github.com/Tarolrr/screeps (клонирован в `~/screeps-strategy`):
  грузит все `*.js` каталога как модули и гоняет стратегию на тестовом юзере.
  `require('./role.x')` в юзерском коде работает — движок срезает `./`
  (`engine/src/game/game.js` requireFn).

## Каналы метрик

- `Memory` юзера — env-ключ `memory:<userId>` (`h.getMemory`). Код пишет
  `Memory.test = {...}`, харнес читает снаружи.
- `rooms.objects` — состояние юнитов/структур каждый тик (`store.energy`,
  позиции, `actionLog`).
- `users.cpuAvailable` — бакет CPU (`cpuAvailable + cpu - cpuUsed`).
- `gameTime` — тики; `system.setTickDuration(ms)` ускоряет прогон.

## Подводные камни (выяснено экспериментально)

- **Юзер без объектов не тикает**: если у юзера ноль записей в `rooms.objects`,
  раннер ставит `users.active=0` и код не исполняется (`driver/lib/runtime/data.js`).
  Поэтому `createUser` с `spawn:true` ставит спавн и забирает контроллер.
- **Спавн сам генерирует 1 energy/тик** — учитывать в критериях («спавн
  наполнился» ≠ «крип передал энергию», проверять порог >= 50).
- **CLI ест ввод построчно** — многострочные выражения отправляются как
  JSON-строка в `eval()` (реализовано в cli-client).
- **`print()` прогоняет аргумент через `util.inspect`** — экранирует
  кавычки/бэкслеши; payload кодируется `encodeURIComponent`.
- Комната для тестов должна иметь свободный контроллер; тесты ходят в `W5N8`.
- `destroyUser(userId, room)` очищает тестового пользователя и новые нейтральные постройки относительно снимка комнаты перед тестом.
- **build тратит энергию 1:1 с прогрессом** (BUILD_POWER=5 → 5 прогресса и
  5 энергии за тик на WORK) — дорога за 300 прогресса требует 300 энергии.
- Ошибки юзерского кода попадают в `users.notifications` (type:'error') —
  читаются через `h.dbFind`; также сыплются в pubsub `user:<id>/console`.
- `system.setTickDuration(ms)` ускоряет прогон; в teardown возвращать ПЕРВЫМ
  делом, иначе сервер останется на быстрых тиках.
- Системный юзер не нужен; `bots.spawn` — референс реализации спавна юзера.
- **Память крипа не в `rooms.objects`** — `creep.memory` хранится в
  `Memory.creeps[name]`; читать роля — проекцией внутри песочницы
  (сырой memory-блоб слишком большой для CLI-вывода, может дать eval-timeout).
- Спавн стратегии может флакать: в прогонах dist один раз крип не
  появился за 100 тиков (очередь формировалась, но spawnCreep не отработал) —
  при повторении прошёл за ~10 тиков.
- Исторические результаты до переноса: 5 базовых тестов PASS + user-strategy-dist PASS
  (harvester0 за ~10 тиков) + user-strategy-dist2 PASS
  (harvester_..._0 за ~18 тиков, WIP-код тоже живой).

## dist2 deep-dive (test8 → dist2-deep-xfail.js)

Глубокий тест конвейера строительства/апгрейда dist2 (`dist2-deep-xfail.js`,
исключён из run-all — документирует реальные баги в WIP-коде). Диагностика
писалась в `Memory.e2eBuild` через инструментированную копию dist2 (удалена).

Работает: spawn-пайплайн (harvester,mule), апгрейд (controller.progress>0).
НЕ работает: ни один constructionSite не создаётся. Цепочка багов
(каждый найден экспериментально на живом сервере):

1. `resources.constructionOrder.js:2` — `require('./constructionPatterns')`
   возвращает `{patterns}`, а нужен `.patterns` → `patterns[type]` undefined →
   generatePositions молча возвращает []. Все ордера живут с `positions:[]`.
2. После фикса — `patternFunc(...)` TypeError: значения мапы — экземпляры
   классов, нужно `patterns[type].getPositions(params, index)`
   (подтверждено в Memory.e2eBuild: genErr).
3. `BuildController.js` — road-ордера кладут опции в `params.opts{...}`, но
   PathPattern достаёт их как `...pathOpts` напрямую в findPath → вложенный
   `opts` игнорируется, range=0 → путь до занятого тайла спавна/контроллера
   не находится → позиций нет. После расплющивания — road-ордер сгенерировал
   70 позиций и поставил 5 road-сайтов (siteResult:OK).
4. `constructionPatterns.js isValidPosition` ожидает строку террейна
   `terrain[y*50+x]`, а получает объект `room.getTerrain()` → проверка стен
   не работает → patternPlacer всегда возвращает позицию у спавна → реальный
   `order.isValidPosition` отбрасывает все → extensions genPositions:0.
   После фикса — скан 2500×28 паттернов в module-init, вероятно, упирается
   в CPU-килл на загрузке (e2eBuild не пишется вообще).

Так что `test6/7 PASS` ≠ «код рабочий» — базовые критерии проверяют только
спавн+отсутствие ошибок; глубокий тест показал, что вся стройка мертва.
