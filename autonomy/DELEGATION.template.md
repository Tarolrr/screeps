# Delegate assignment

Preamble for the top-level session (not pasted into the brief): only a top-level session delegates, through its native subagent tool by default (Happier-managed only on explicit user request). Delegate inside the task's claimed worktree; record the delegate reference with `autonomyctl.py heartbeat --run`. Never transfer a task or resource lease to a delegate, never make it a "background coordinator", and never describe agent-spawn routes in the brief. Work that must outlive your turn becomes a separate top-level task session with its own claim and worktree.

Task and intended outcome: …
Task worktree and branch: …
Acceptance criteria: …
Writable paths and exclusions: …
Relevant context and constraints: …
Validation and evidence to report: …

Общий хвост (вставлять в каждое поручение целиком):

```text
Ты делегат (лист). Ты не запускаешь агентов, субагентов, сессии и runs никаким
способом: ни через Agent/Task, ни через MCP, ни через `happier session
run|delegate`, `claude -p`, `codex exec`, `devin`, ни через subprocess из Python/Node.
Правила AGENTS.md о делегировании и разделы «Только для координатора» относятся
к координатору, не к тебе: задачу выполняешь ты сам. Если без помощника нельзя,
остановись и верни это в отчёте. Чтение состояния Happier (`happier session
list|history|run get`) допустимо. Запускать собственные тесты, скрипты и e2e
репозитория в рамках задачи можно; запрет касается только запуска агентов,
сессий и runs.
Не захватывай, не продлевай и не освобождай аренды задач и ресурсов
(`autonomyctl.py claim|heartbeat|recover|finish|resource-*`), не меняй issues,
метки и комментарии, не коммить и не пушь, если это не указано в поручении явно,
и не пиши за пределами выделенного scope. Сохраняй чужую работу. Сообщай о
блокерах и неожиданных изменениях сразу.
```
