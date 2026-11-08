# Task issue

- Title and outcome:
- Acceptance criteria:
- Labels: `task`, exactly one `status:ready` / `status:in-progress` / `status:blocked` / `status:review`; optional `needs:owner` and `priority:*`.
Depends on: none
- Scope and constraints (expected paths; shared resources such as `integration:master`, `screeps-server:live`, `screeps-world:<room>`, `ports:<range>`):
- Evidence and reviewer findings:
- If blocked: reason, missing information, next manual step:

Only top-level sessions create or update the issue. Use an independent `Depends on: #N, #M` line in the body when dependencies exist. The task key in `autonomyctl.py` is `issue-<number>`; set `status:in-progress` only after a successful claim. Expected paths are planning hints, not locks.
