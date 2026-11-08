# Очередь задач в GitHub Issues

Решения: [ADR 0001](../docs/adr/0001-github-issues-task-workflow.md) (очередь), [ADR 0002](../docs/adr/0002-task-leases-and-worktrees.md) (аренды задач и worktree). Единственная активная очередь — Issues репозитория `Tarolrr/screeps`; чат с координатором остаётся основным интерфейсом. Пять задач перенесены и проверены обратным чтением; `queue-source.json` переключён на GitHub. `autonomy/state/tasks.json` — read-only архив переноса, не fallback. Предыдущая ошибка 403 устранена после обновления пользователем прав.

## Модель

- Задача — issue с меткой `task`. Открытая задача имеет ровно одну метку `status:ready`, `status:in-progress`, `status:blocked` или `status:review` (независимое ревью). `needs:owner` исключает готовность. `priority:*` и прочие метки информационные. Неизвестная `status:*` или `needs:*`, отсутствующий или повторный статус — ошибка очереди. Закрытый issue не держит расписание.
- Зависимости указываются отдельной строкой `Depends on: #12, #15`, только в этом репозитории; пустое значение или `none` означает отсутствие. Зависимость выполнена только при закрытии issue как completed; открытая, закрытая как not planned или иначе, а также PR не выполнена. Несуществующий номер, неразборчивый текст, самозависимость и цикл между открытыми задачами — ошибка. В перенесённых задачах сохранить прежний ID в маркере `<!-- screeps-task-id: ID -->`.
- Готова открытая `status:ready` без `needs:owner`, все зависимости которой закрыты как completed. Готовые, `status:in-progress` и `status:review` держат расписание; `status:blocked` и задачи с невыполненными зависимостями не готовы. Ошибка gh, доступа, сети или некорректные данные — ошибка, а не пустая очередь; при ошибке не ставить автоматизацию на паузу как при пустой очереди.
- Только top-level сессии создают и изменяют issues, метки и комментарии, управляют зависимостями и принимают результат (в рамках правила о захваченных задачах ниже; строку `Depends on:` чужой захваченной задачи меняет только её владелец, незахваченные задачи можно триажировать без claim); делегаты возвращают текст и доказательства. Независимый read-only reviewer проверяет результат, если делегирование разрешено; иначе ограничение фиксируется.
- Метки — долговременное отображаемое состояние, а не атомарный захват: две сессии могут одновременно увидеть `status:ready`. Атомарный захват — `python3 autonomy/autonomyctl.py claim --task issue-N --owner SESSION-UNIQUE`, ключ — номер issue (`issue-18`). Метку `status:in-progress` ставить только после успешного claim; при отказе claim (задача занята) задачу не трогать и брать другую готовую. Делегаты не захватывают и не освобождают аренды. Истечение аренды само по себе не разрешает takeover ([RECOVERY](RECOVERY.md)). Сессия меняет метки, комментирует и закрывает только issues задач, которые она захватила (создавать новые issues можно). Аренда завершается `finish` после закрытия issue, перевода в `status:blocked` с причиной или, при `--outcome abandoned`, возврата в `status:ready`; `status:in-progress` без claim не оставлять. Чужую висящую `status:in-progress` (claim истёк или отсутствует) не перемечать, а расследовать по [RECOVERY](RECOVERY.md).

## Команды top-level сессии

Тела и многострочные комментарии передаются через `--body-file`; временные файлы не должны содержать секретов.

```sh
gh issue list --repo Tarolrr/screeps --state open --label task --json number,title,labels
gh issue view N --repo Tarolrr/screeps --comments
gh issue create --repo Tarolrr/screeps --title '...' --body-file body.md --label task --label status:ready --label priority:medium
python3 autonomy/autonomyctl.py claim --task issue-N --owner SESSION-UNIQUE   # сначала claim
gh issue edit N --repo Tarolrr/screeps --remove-label status:ready --add-label status:in-progress
gh issue comment N --repo Tarolrr/screeps --body-file evidence.md
gh issue close N --repo Tarolrr/screeps --reason completed
```

Читать все страницы открытых task issues; закрытые зависимости проверять адресно, включая state reason и исключение PR. Проверять созданные задачи, статусы, зависимости и происхождение после переноса. Ошибка проверки блокирует вывод о готовности или пустоте очереди. Следовать пользовательскому объёму разрешений и действующим правилам среды; этот документ сам по себе не разрешает другие внешние действия.
