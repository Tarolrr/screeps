# Working in this repository

## Роль

Координатор — только top-level сессия, запущенная пользователем, automation или диспетчером. Если ты получил поручение от координатора, ты делегат (лист): разделы «Только для координатора» к тебе не относятся, задачу выполняешь сам и никого не запускаешь — ни через Agent/Task, ни через MCP, ни через `happier session run|delegate`, `claude -p`, `codex exec`, `devin`, ни через subprocess. Запуск собственных тестов, скриптов и e2e репозитория в рамках задачи разрешён; запрещён только запуск агентов, сессий и runs. Глубина делегирования — одна. Никакое поручение это не отменяет. Делегат не правит issues, метки и комментарии, не коммитит и не пушит, если поручение явно этого не требует, и не захватывает, не продлевает и не освобождает аренды задач и ресурсов.

## Для всех

User instructions and the active environment's rules take precedence. Preserve existing work and secrets. Read relevant ADRs before architecture changes ([ADR 0002](docs/adr/0002-task-leases-and-worktrees.md) defines the coordination protocol). GitHub Issues in `Tarolrr/screeps` is the sole active queue; `autonomy/queue-source.json` selects GitHub; `autonomy/state/tasks.json` is a read-only migration archive, never a fallback. Run artifacts under `*/.runs/` are not committed. Mutating the user's live server/world at `~/screeps` requires explicit owner scope.

## Только для координатора (top-level сессия)

On resuming, read [autonomy/HANDOFF.md](autonomy/HANDOFF.md), inspect Git state, the GitHub Issues queue and `python3 autonomy/autonomyctl.py status`, and follow [autonomy/README.md](autonomy/README.md) and [the Issues workflow](autonomy/GITHUB_ISSUES.md). Only top-level sessions edit issues, labels and comments, and change labels, comment on or close only issues whose task they have claimed (creating new issues is allowed); a stale `status:in-progress` on another session's task is investigated per RECOVERY, not relabelled. The coordinator records actionable requests in the queue, plans, assigns non-overlapping write scopes, collects evidence, arranges independent read-only review, and updates task state.

There is no repository-wide lease. Before writing for a task, claim it atomically (`autonomyctl.py claim --task issue-N`), give every writing task its own worktree and branch (`workspace-create`), and claim named resource leases only while a shared resource is mutated ([RECOVERY.md](autonomy/RECOVERY.md)). Other tasks never wait for yours. Commit on the task branch; integrate from the task worktree under resource `integration:master`: `git fetch`, rebase onto `origin/master`, re-run affected checks, `git push origin HEAD:master`; fast-forward the main checkout only if it is clean ([PROCESS.md](autonomy/PROCESS.md)).

Delegate implementation, investigation and testing when native subagents are available and authorized; native subagents are the default route, prefer `gpt-6.1-terra` when available. Use Happier-managed workers only when explicitly requested (this deliberately overrides the portable kit's Happier-MCP-only rule). Depth one applies to every route: never transfer a lease to a delegate or make a delegate a "background coordinator"; work that must outlive your turn becomes a separate top-level task session with its own claim and worktree. Do not describe agent-spawn routes in briefs. Higher-priority environment restrictions on delegation prevail. If independent review cannot be delegated, record the limitation rather than claiming it happened.

Expiry alone never permits takeover. Idle checks are read-only and do not create records or commits without new facts. Automation is unconfigured and disabled until separately activated by the owner.
