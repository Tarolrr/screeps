# Handoff

Repository: `Tarolrr/screeps` on `master`, pushed through `90112c9` (2026-11-06): all bootstrap/autonomy/e2e work is committed in per-issue commits per the commit-on-completion policy added to [PROCESS.md](PROCESS.md). Run artifacts under `*/.runs/` and `e2e/*/logs/` are git-ignored local evidence. At session start, inspect the current branch and working tree, inspect GitHub Issues in `Tarolrr/screeps` for task status, and use `python3 autonomy/coordination.py status` for the actual lease. Do not infer either from this handoff.

The private server remains at `~/screeps`, with API port 21025 and CLI port 21026. [Server documentation](../docs/server/README.md) records commands and manifest, lockfile and mods snapshots. The repository-root `.screepsrc` is an ignored, private mode-600 reference copy; the server still reads `~/screeps/.screepsrc`. No server restart or runtime migration was performed. Preserve the server and its world. Node 22 is available under `~/.local/node22/bin`.

[E2E instructions](../e2e/README.md) document execution and the known `dist2` construction failure chain. The pre-existing untracked `dist2dbg` diagnostic copy was deleted on owner instruction (2026-11-06) — `dist2/tests` already contains identical test files; `dist` and `dist2` were unchanged. Bootstrap verification covered JavaScript syntax for all e2e files and module loading from an external working directory (`dist`: 27, `dist2`: 21). The live suite was not rerun because room W5N8 had a reservation belonging to user `2`; the observed server tick remained 1000. Do not run live e2e without considering its effects on the user's world.

The adapted autonomy infrastructure passed 43 offline tests after cycle detection was fixed. An independent reviewer found a snapshot ignore omission and local queue dependency cycles; both were fixed, and final independent rereview accepted the changes with no remaining must-fix findings. The user corrected the queue decision on 2026-11-02: GitHub Issues is the sole active queue. After the user updated permissions, the coordinator migrated and read back all five tasks, switched `queue-source.json` to GitHub and archived `tasks.json` read-only without fallback. SCREEPS-001–003 map to completed issues #1–#3; The e2e specification was accepted and [#4](https://github.com/Tarolrr/screeps/issues/4) closed; migration is tracked in [#5](https://github.com/Tarolrr/screeps/issues/5). The eight implementation issues [#6–#13](../docs/testing/issues/README.md) were published and read back. At this handoff #6 is in progress with two native workers assigned non-overlapping environment setup and step/fence investigation; #7–#13 await their dependencies. Verify current issue and worker status at runtime. The user explicitly instructed on 2026-11-02 to assign agents subsequent work and went to sleep; continue noninteractively within the authorized scope, recording blockers rather than asking sleeping-user questions. Earlier 403 responses were resolved by the permission update. Scheduler integration is unconfigured and disabled; no schedule was created. On 2026-11-02, a read-only audit of the local Happier SQLite `Automation` table found no Screeps automation. Its sole automation belonged to the source keyboard project and was disabled; recent run records did not establish that a session or work executed. The source autonomy kit was taken from its local working branch at `d6c5f17`, rather than its default branch. Historical project permissions do not transfer.

## 2026-11-06 coordinator run (`screeps-coord-20261106-run2`)

Lease recovered from `run1` (all worker/exec activity stopped ~9.5h). Session
completed the remaining evidence pipeline end-to-end:

**#9 E2E-SPN — CLOSED completed.** Evidence + review-verdict comment posted;
issue closed (19 runs, defects SPN-D1/D2/D5/D6).

**#11 E2E-BLD — CLOSED completed.** Suite executed and iterated to
**8 PASS + 2 UNKNOWN** (oracle-pipe ceiling UNKNOWNs, documented). Runner fixes:
default `ctx.room`, `sourceResource` registration, BLD-PAT-IDX defect binding,
decay-aware ineligible check, `genA.v` CAP unwrap, adaptive `bld-04-d2` second
removal + stale-id characterization (`BLD-D2-STALE`), swamp/fatigue budgets.
Independent read-only review: **accept-with-findings, no must-fix** — recorded
in `docs/testing/build.md`; issue closed with evidence comment.

**#10 E2E-ECO — CLOSED completed: 37 PASS + 1 expected BLOCKED**
(eco-00-refuse, intentionally impossible fixture). Six passes; final run ids in
`docs/testing/eco.md`. Independent read-only review (subagent `adec8555`):
**accept-with-findings, no must-fix** — all doc-level findings corrected.
Confirmed defects: ECO-D3 (unguarded
`collectTasks.length` TypeError, dist2 mule), ECO-D-WAITNAN (`getRangeTo` on
deserialized `{x,y}` = NaN → wait-in-place forever, `dist/role.mule.js:17`),
ECO-D2′ (stranded pending after structure-dest removal), ECO-D-PARTIAL
(`getFreeCapacity()==0` collect→work gate starves on partial fill +
exhausted pile, `role.mule.js:140`/`role.upgrader.js:9`), ECO-D1 (pending
double-counted in `energyNeeded`, StrM+CtrlM), ECO-D5 (queue head `shift()`
before `spawnCreep` → ERR_NAME_EXISTS drains orders). Engine facts learned
(spawning-creep retention rule, getRangeTo NaN, drop decay ~1/tick, pocket
sources) recorded in eco.md. Harness fixes: `initialFrame`/`readFieldSet` split
under the ~10 KB CLI pipe (fixed deterministic snapshot UNKNOWNs), `memInject`
server-side, `energy` drops walkable in route BFS, `pickCell` r2 fallback +
`keepAdjFree:false` for dist SrcM modes. Independent review verdict pending at
this handoff — see `docs/testing/eco.md`.

**Cleanup:** 133 quarantined server roots under `e2e/server/.runs/` inspected
(all dead disposable instances; evidence preserved in `e2e/har/.runs/`, 46M)
and removed. Live user server/world untouched throughout.

**Remaining queue:** #12 (integration), #13 (gate/coverage) — previously
blocked on #9/#10/#11, now unblocked; #14 (E2E-VIEW spectator instance,
owner-requested, status:ready). All work committed+pushed through
`5e479cd` under the new commit-on-completion policy. `dist2dbg` deleted
per owner instruction; run artifacts git-ignored. Verify issue state at
runtime.

## 2026-11-06 coordinator run (`screeps-coord-20261106-run1`)

Lease recovered from `screeps-coord-20261103-run1` (expired 2026-11-03; workers confirmed stopped — no execution runs, no file activity since 2026-11-03). Queue state entering the session: #6–#8 closed completed; #9 in-progress mid-flight; #10/#11 ready; #12/#13 blocked on deps.

**#9 E2E-SPN — evidence complete, pending issue update.** 19 executed runs total: 12 PASS (2026-11-03) + 7 PASS (2026-11-06 second pass, all remaining modes). Defects SPN-D1/D2/D5/D6 confirmed with trace evidence; SPN-D4 retracted (engine deletes the spawning creep with its spawn — no ghost, no false active). Independent read-only review: **accept-with-findings**; all three recommended oracle tightenings applied to `e2e/spn/spn.js`. Runner changes this session (documented in `docs/testing/spawn.md`): removed the wrong-premise `beforeTeardownVerify` restore, wired `ctx.multiCycle`, added `energy0`/`energyFull` injections + `skipEnergyDeltaG`, redesigned kill mode around an energy drain window, rewrote the nospawn oracle to the real contract. Remaining: post evidence comment + close #9 (gh blocked — see below).

**#11 E2E-BLD — suite implemented, NOT executed.** Worker wrote `e2e/bld/` (bld.js ~1110 lines, entrypoints.js ~550; 10 modes, ports 32460–32479) + `docs/testing/build.md` with defect records; could not run anything (background subagents get exec auto-denied — see lesson below). Needs `node --check` + mode runs + evidence collection + review.

**#10 E2E-ECO — worker still running at this handoff** (`subagent:eco-scenarios`, scope `e2e/eco/**` + `docs/testing/eco.md`, ports 32440–32459); expected to deliver code + docs only, same exec limitation.

**Key lesson — background subagents cannot execute binaries.** Every interpreter/binary (node, python3, bash, mkdir…) is auto-denied in background mode; only read tools work. Workers can implement suites and audit code but the coordinator (or a foreground subagent) must run scenarios. Plan accordingly.

**Blocked on exec in this session:** the user repeatedly skipped exec tool calls — gh comments/issue updates, node mode runs, lease heartbeat. When exec is available: (1) post #9 evidence+review comment and close as completed; (2) run BLD/ECO modes per `build.md`/`eco.md` run commands; (3) heartbeat/release the lease; (4) quarantined roots under `e2e/server/.runs/` from first-pass FAIL/UNKNOWNs need inspection+cleanup (61 dirs pre-existed + ~12 new). `gh` needs `GH_CONFIG_DIR=~/.config/gh` exported in this environment (XDG_CONFIG_HOME points elsewhere).

The [testing index](../docs/testing/README.md) links the accepted plan, coverage matrix, audits and issue specifications. Isolated-server setup and a coherent step/fence remain work in progress; this handoff does not claim they have been verified. Preserve the existing user server and world. Check the current coordinator lease at runtime; workers act under that lease and must not acquire or release it.
