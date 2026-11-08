# Task leases, resources and recovery

Runtime state lives in `<git-common-dir>/autonomy-coordination-v2/`, shared by all linked worktrees. Commands emit JSON and accept `--repo PATH` (default: current directory). Use a unique owner per top-level session and the issue number as the task key:

```sh
python3 autonomy/autonomyctl.py status
python3 autonomy/autonomyctl.py claim --task issue-N --owner SESSION-UNIQUE [--session HAPPIER_SESSION_ID]
git fetch origin   # before workspace-create, so origin/master is current
python3 autonomy/autonomyctl.py workspace-create --task issue-N --owner SESSION-UNIQUE   # base origin/master; prints the worktree path
python3 autonomy/autonomyctl.py workspace-attach --task issue-N --owner SESSION-UNIQUE --path /existing/worktree
python3 autonomy/autonomyctl.py heartbeat --task issue-N --owner SESSION-UNIQUE --run DELEGATE_REF [--run ...]
python3 autonomy/autonomyctl.py heartbeat --task issue-N --owner SESSION-UNIQUE --clear-runs
python3 autonomy/autonomyctl.py resource-claim --resource NAME --task issue-N --owner SESSION-UNIQUE
python3 autonomy/autonomyctl.py resource-release --resource NAME --task issue-N --owner SESSION-UNIQUE
python3 autonomy/autonomyctl.py finish --task issue-N --owner SESSION-UNIQUE --outcome done|blocked|abandoned [--commit SHA]
```

Default worktrees go to `../.autonomy-worktrees/screeps-strategy/<task>` on branch `autonomy/<task>`. The default lease is 7200 seconds; heartbeat before expiry with the complete set of active delegate references (repeated `--run`), which also renews the task's resource leases. An expired claim cannot be heartbeated: it needs `recover --confirm-stopped` before further heartbeat. Clear runs only after confirming the delegates stopped; `finish` refuses while runs are recorded, releases that task's resources, and keeps the worktree and branch for integration. Remove worktrees only after integration or explicit abandonment.

## Resources

Claim a resource only for the interval in which it is mutated; prefer disposable instances and unique ports. Screeps resource names:

- `integration:master` — merging a task branch into `master` and pushing.
- `screeps-server:live` — the user's private server at `~/screeps` (restart, config, mods, CLI mutations); `screeps-world:<room>` — mutating a room of that live world (e.g. `screeps-world:W5N8`). Owner scope is still required; the lease only serializes authorized sessions.
- `ports:<first>-<last>` — an e2e suite's fixed port range when two tasks could run the same suite (e.g. `ports:32440-32459` ECO, `ports:32460-32479` BLD, `ports:32500-32501` VIEW).

## Recovery

Expiry is a signal, not proof that the writer stopped: a new claim of an expired task still fails. Before recovering, establish independently that the previous owner session and every recorded run have stopped (session/run status, processes, recent Git activity in the task worktree). Only then, and only after the claim has expired (a live claim cannot be recovered; ask its owner to finish it), run `recover --task issue-N --owner NEW-UNIQUE --confirm-stopped`; it keeps the recorded worktree and branch, transfers that task's resources, and records the previous owner in history. Recovery concerns only that task: other tasks do not wait for it. A busy or uncertain claim is not a recovery authorization. Do not edit or delete the registry, lock or receipt files to force progress; investigate malformed state instead.

The registry coordinates sessions on this machine only, not outside processes that ignore the protocol or other hosts. The scheduler pause helper never claims, recovers or finishes tasks and does not change claims, but it writes its receipt file inside short registry transactions; see AUTOMATION_BOOTSTRAP.
