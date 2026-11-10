# E2E-VIEW: наблюдаемый изолированный инстанс

`e2e/view/view.js` поднимает одноразовый мир из packaged seed, размещает в нём
F0-фикстуру и оставляет сервер доступным стандартному Steam-клиенту до команды
`stop` или `Ctrl-C`. Живой `~/screeps` используется только как источник
установленных пакетов и seed, а в `--auth steam` — также `steam_api_key`; его
БД, процессы, порты 21025/21026 и мир не изменяются.

## Быстрый запуск через SSH-туннель

На сервере:

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
node e2e/view/view.js \
  --fixture eco-01-d --room W9N8 \
  --auth none \
  --http-port 32500 --cli-port 32501 \
  --tick-mode slow --tick-ms 2000
```

Команда работает в foreground и печатает `ready` только после проверки
изолированного root, фикстуры и HTTP auth-mode. Не закрывайте её, пока смотрите
мир. С клиентской машины создайте туннель:

```sh
ssh -N -L 32500:127.0.0.1:32500 <ssh-host>
```

В Steam-клиенте Screeps выберите **Change server**, укажите
`127.0.0.1:32500` и откройте комнату, напечатанную раннером (`W9N8`, если эта
packaged-seed комната удовлетворила фикстуре). В режиме `--auth none` Steam
ticket принимается локальным offline-adapter без внешней проверки; все
подключения получают один disposable spectator account. Сценарий принадлежит
другому синтетическому пользователю (для профиля `strategy` по умолчанию
вход идёт под пользователем бота — см. `--login-as-bot`).

В терминале раннера доступны команды:

- `status` — текущий `gameTime` и комната;
- `pause` / `resume` — остановить или продолжить slow-mode;
- `speed 5000` — изменить длительность тика в миллисекундах;
- `console on|off`, `mem PATH`, `strat CMD` — см. профиль `strategy` ниже;
- `stop` — удалить тестового пользователя, остановить процессную группу и
  уничтожить scratch-root.

`Ctrl-C` и `SIGTERM` выполняют тот же cleanup. EOF stdin сам по себе не
останавливает инстанс: явный `stop`/сигнал сохраняет модель владения.

## Профиль `strategy`: теневая стратегия под пользователем бота

Профиль `--fixture strategy` загружает собранный артефакт
`build/strategy/main.js` как **единственный** модуль `main` (как `e2e/strat`).
Перед созданием сервера раннер сверяет sha256 и размер файла с
`build/strategy/manifest.json` (`screepsModuleName: main`, `testBuild: false`);
нет файла или хэш не совпал — отказ с кодом 2 и подсказкой
`npm ci && npm run build:strategy`. Другой артефакт: `--artifact PATH --manifest PATH`.
После загрузки код читается обратно из `users.code` и должен быть ровно
`{main}` с хэшем манифеста.

Фикстура — STRAT S1 (`e2e/strat/fixture.js`, без изменений): F0 плюс `mul1`,
`upg1`, `bld1`, контейнер у контроллера и стройплощадка дороги, чтобы legacy
dist2 внутри артефакта реально играл (спаун, добыча, апгрейд, стройка). После
валидации фикстуры Memory засевается: creep memory S1,
`Memory.strategy` schema 1 с `control.rooms[ROOM] = {requestedMode:'shadow',
effectiveOwner:'legacy', epoch:0, ...}` и операторские флаги
`Memory.strategyView = {rooms:{[ROOM]:{overlay:true}}, console:true}`
(`--no-overlay` → `overlay:false`). Если презентер (`present.shadow`) ещё не
входит в артефакт, флаги просто игнорируются: shadow считает, оверлея нет.

Запуск по SSH-туннелю (на сервере):

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
npm ci && npm run build:strategy
node e2e/view/view.js --fixture strategy --room W9N8 \
  --auth none --http-port 32504 --cli-port 32505 \
  --tick-mode slow --tick-ms 2000
# на клиентской машине:
ssh -N -L 32504:127.0.0.1:32504 <ssh-host>
# Steam-клиент: Change server -> 127.0.0.1:32504
```

Запуск через Tailscale (клиент подключается напрямую к адресу tailnet):

```sh
node e2e/view/view.js --fixture strategy --room W9N8 \
  --auth none --host 100.96.112.15 --http-port 32504 --cli-port 32505 \
  --tick-mode slow --tick-ms 2000
# Steam-клиент: Change server -> 100.96.112.15:32504
```

(Порты произвольные из незанятых; 21025/21026 запрещены. Если старый
демо-инстанс ещё держит 32500/32501, выберите другие.)

### Вход под пользователем бота (`--login-as-bot`)

В `--auth none` offline-adapter отображает любой Steam ticket на один
фиксированный Steam ID. С `--login-as-bot` (по умолчанию для `strategy`,
выключается `--no-login-as-bot`; для `eco-01-d`/`har-01` по умолчанию выключен)
этот Steam ID до первого входа привязывается к пользователю сценария, поэтому
клиент входит **как бот**: видит его `RoomVisual`-оверлей, консоль, Memory и
может вводить команды в консоль. Без флага — прежний отдельный
`view_spectator`. Старт проверяет пробным входом, что token выдан именно боту
(`/api/auth/me`), token не сохраняется; `view_spectator` при этом не создаётся.
`--login-as-bot` с `--auth steam` отклоняется.

**Риск.** Любой, кто достучится до HTTP-порта, получает полный контроль над
ботом: может перезалить код из редактора клиента, менять Memory, выполнять
консольные команды. Это допустимо только для одноразового мира: правила bind
не ослаблены (`--auth none` — только loopback или явный адрес Tailscale
`100.64.0.0/10`; admin CLI всегда `127.0.0.1`; ключ Steam не читается), мир
уничтожается командой `stop`. Код, загруженный из клиента, больше не является
проверенным артефактом — перезапустите инстанс, если важна чистота прогона.

### Консоль бота в терминале

Раннер подписывается отдельным CLI-соединением на pubsub
`user:<id>/console` (тот же канал, что у клиента) и печатает строки как
`bot [gameTime] текст`; `gameTime` — значение на момент получения. HTML-теги
удаляются, сущности декодируются, управляющие символы заменяются на `?`;
ошибки (`ERROR ...`) и строки с красным HTML-цветом выделяются красным в TTY
(`NO_COLOR` отключает цвет); результаты консольных выражений — `=> ...`.
Буфер ограничен (500 сообщений, строки до 1000 символов); потеря отмечается
строкой `dropped`. Pubsub — best effort, не журнал. `--no-console` не
подписывается вовсе.

Дополнительные команды раннера (для всех профилей):

- `console on|off` — включить/приглушить печать консоли бота;
- `mem PATH [LIMIT]` — JSON-выдержка Memory бота, например
  `mem strategyShadow.rooms.W9N8.decisionRing` (по умолчанию первые 4000
  символов, `LIMIT` 100..20000; без пути — ключи верхнего уровня);
- `strat CMD` — поставить `strat.*` в очередь консольных команд бота
  (`users.console`, как консоль клиента), выполнится в следующем тике в
  sandbox бота, результат придёт в поток консоли: `strat report` →
  `strat.report("W9N8")`, `strat why`, `strat visual('W9N8', false)`,
  `strat export(10)`. Если артефакт не устанавливает `strat`, ответ —
  `strat.* console commands are not installed by this artifact`. Проверка
  формы — защита от опечаток, не sandbox; то же можно набрать в консоли клиента;
- `status` дополнительно показывает число крипов, размер Memory,
  `strategy.lastClosedTick` и наличие `Memory.strategyShadow`.

## Ручное шагание

```sh
node e2e/view/view.js --fixture har-01 --tick-mode step \
  --http-port 32500 --cli-port 32501
```

В этом режиме exclusive step-gate удерживает мир на последнем согласованном
состоянии. Команда `step` выполняет один тик, `step 10` — десять. `resume` и
`speed` отключены, чтобы не обходить gate.

Кроме `strategy` (см. выше) поддерживаются два профиля на общей F0 fixture/seed-пайплайне:

- `eco-01-d` (по умолчанию): тело `[WORK,CARRY,MOVE]`, Memory и неизменённый
  `dist/role.harvester.js` как в основном ECO-01-D сценарии;
- `har-01`: тело `[MOVE,CARRY,WORK]` и минимальный HAR-01 entrypoint.

`--room ROOM` ограничивает resolver конкретной комнатой; невозможная фикстура
отклоняется до запуска наблюдения.

## Аутентификация и Tailscale

`--auth none` (по умолчанию) не читает и не копирует Steam API key. Такой
режим разрешён только на loopback или на явном адресе Tailscale из
`100.64.0.0/10`; wildcard и произвольный внешний интерфейс отклоняются.
Например:

```sh
node e2e/view/view.js --auth none --host 100.96.112.15 \
  --http-port 32500 --cli-port 32501 --tick-mode step
```

`--auth steam` включает реальную проверку Steam ticket. Только в этом режиме
`steam_api_key` читается из `~/screeps/.screepsrc` (или `--steam-config`) и
копируется в mode-600 конфиг scratch-root.

## Публичный bind

Предпочтителен loopback + SSH-туннель. Если нужен `0.0.0.0`, серверный пароль
обязателен и передаётся только через имя переменной окружения, не аргументом:

```sh
read -rs VIEW_PASSWORD
export VIEW_PASSWORD
node e2e/view/view.js --host 0.0.0.0 \
  --auth steam \
  --server-password-env VIEW_PASSWORD \
  --http-port 32500 --cli-port 32501
unset VIEW_PASSWORD
```

Admin CLI всегда остаётся на `127.0.0.1`. Встроенный backend обычно печатает
пароль в лог; viewer preload заменяет эту строку на `redacted` до старта
процессов.

## Секреты, ownership и артефакты

- В `--auth steam` ключ копируется только в `.screepsrc` scratch-root с mode
  600; значение не печатается и не записывается в viewer metadata. В
  `--auth none` ключ вообще не читается.
- Scratch-root создаётся под `e2e/server/.runs/`; `ownership.json`, marker,
  PID/start-time и проверка сокетов защищают stop/destroy от чужого процесса.
- Несекретные metadata и проверка фикстуры лежат в игнорируемом
  `e2e/view/.runs/<runId>/`. Успешный stop удаляет server root вместе с ключом,
  БД и логами.
- Если ownership/процессная проверка не позволяет безопасно остановиться,
  root карантинируется и путь печатается. Не удаляйте его вслепую: сначала
  установите, что принадлежащая ему процессная группа остановлена; затем
  удалите root и убедитесь, что порты свободны.

Для `--auth steam` фактический успешный login требует Steam-клиента владельца;
автоматическая проверка подтверждает валидность Web API key при старте backend,
`useNativeAuth:false`, HTTP endpoint, fixture и lifecycle. Для `--auth none`
startup дополнительно выполняет пробный offline login без сохранения token и
проверяет через `/api/auth/me`, какому пользователю он выдан.
