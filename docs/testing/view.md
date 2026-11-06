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
другому синтетическому пользователю.

В терминале раннера доступны команды:

- `status` — текущий `gameTime` и комната;
- `pause` / `resume` — остановить или продолжить slow-mode;
- `speed 5000` — изменить длительность тика в миллисекундах;
- `stop` — удалить тестового пользователя, остановить процессную группу и
  уничтожить scratch-root.

`Ctrl-C` и `SIGTERM` выполняют тот же cleanup. EOF stdin сам по себе не
останавливает инстанс: явный `stop`/сигнал сохраняет модель владения.

## Ручное шагание

```sh
node e2e/view/view.js --fixture har-01 --tick-mode step \
  --http-port 32500 --cli-port 32501
```

В этом режиме exclusive step-gate удерживает мир на последнем согласованном
состоянии. Команда `step` выполняет один тик, `step 10` — десять. `resume` и
`speed` отключены, чтобы не обходить gate.

Поддерживаются два профиля на общей F0 fixture/seed-пайплайне:

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
startup дополнительно выполняет пробный offline login без сохранения token.
