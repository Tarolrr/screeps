# Autonomous work

The sole active task queue is [GitHub Issues](GITHUB_ISSUES.md) in `Tarolrr/screeps`; `queue-source.json` selects GitHub. `state/tasks.json` is a read-only archive, never a fallback. Queue access or data errors are errors, never an empty queue.

Coordination follows the task-lease protocol of the portable kit ([ADR 0002](../docs/adr/0002-task-leases-and-worktrees.md)). There is no repository-wide lease. [`autonomyctl.py`](autonomyctl.py) keeps a local registry in `<git-common-dir>/autonomy-coordination-v2/` (shared by linked worktrees, never committed); its `flock` is held only for one atomic transition. Claims for different tasks coexist; a task claim prevents duplicate work on that task only; named resource leases serialize only genuinely shared resources.

1. Read HANDOFF, inspect Git, the Issues queue and `python3 autonomy/autonomyctl.py status`; distinguish new facts from an idle cycle.
2. Pick a ready issue, claim it (`claim --task issue-N`), then set `status:in-progress`. Create its worktree and branch (`workspace-create`) and do all writes there. Only top-level sessions change issues, labels and comments.
3. Delegate bounded scopes inside the task worktree; record active delegate references with `heartbeat --run`. Claim resources (`resource-claim`) only while mutating them.
4. Collect evidence and arrange independent read-only review when authorized. Address findings, update the issue, and clear runs only after delegates stopped.
5. Commit on the task branch, integrate under `integration:master`, push, then `finish` the claim. Scheduled runs also follow AUTOMATION_PROMPT and PROCESS.

See PROCESS for roles, integration and run outcomes; RECOVERY for task/resource lease commands and recovery; TASK, DELEGATION and REVIEW templates for prompts; AUTOMATION_BOOTSTRAP for the disabled scheduler integration. Run offline infrastructure tests with `python3 -m unittest discover -s autonomy -p 'test_*.py'`. Tests use temporary repositories and fake endpoints; never test against a real automation or claim tasks in the real registry from tests.

The previous repository-wide lease (`coordination.py`, runtime under `<git-common-dir>/autonomy-coordination/`) was retired in #18; its runtime directory is kept as history and is no longer read.
