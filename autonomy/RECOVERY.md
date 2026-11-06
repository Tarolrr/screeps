# Lease and recovery

The lease is stored in the Git common directory, so worktrees share it. Commands emit JSON. Use a unique owner per coordinator:

```sh
python3 autonomy/coordination.py status
python3 autonomy/coordination.py acquire --owner UNIQUE
python3 autonomy/coordination.py heartbeat --owner UNIQUE --run WORKER_REFERENCE
python3 autonomy/coordination.py heartbeat --owner UNIQUE --clear-runs
python3 autonomy/coordination.py release --owner UNIQUE
```

The default lease is 7200 seconds. Heartbeat before expiry and maintain the complete set of active worker references with repeated `--run`. Clear only after confirming all workers stopped. A lease expiry does not authorize another coordinator to take over. On an existing lease, stop and establish independently that the old coordinator and every recorded worker have stopped; investigate missing or malformed state rather than deleting files. Only after that confirmation use `recover --owner UNIQUE --confirm-stopped` (optionally supply current worker references). Recovery records the previous lease in the audit. An expired owner also needs explicit recovery before further heartbeat. A busy or uncertain lease is not a recovery authorization.

The lock protects queue and shared-worktree changes across sessions, not outside processes that ignore the protocol. Do not remove the control lock or state to force progress. For linked worktrees, `git rev-parse --git-common-dir` identifies the shared storage. The scheduler pause helper verifies ownership, worker termination, lease duration, identity and queue before contacting an endpoint; see AUTOMATION_BOOTSTRAP.
