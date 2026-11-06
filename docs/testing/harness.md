# HAR scenario harness (e2e/har/)

Scenario-level tests on top of the SRV admission primitives. Each scenario
runs on a fresh disposable instance (`e2e/server/instance.js`) carrying
`step-mod.js` + `step-preload.js`, driven exclusively through
`StepClient`/`captureSnapshot`. Everything here is harness code only — the SRV
primitives under `e2e/server/` are used unmodified.

## Modules

| File | Contents |
|---|---|
| `e2e/har/fixture.js` | Fixture schema **v1** (`FIXTURE_SCHEMA_VERSION=1`): `fixtureF0()` spec, `impossibleFixture()`, `resolveFixture()` (target→actual coordinate mapping + BFS reachability), `validateFixture()` (engine-side checks via the admin CLI before any step). |
| `e2e/har/trace.js` | Trace schema **v1** (`TRACE_SCHEMA_VERSION=1`): `TraceRecorder` appending one JSONL frame per captured tick to `<runDir>/trace.jsonl`. |
| `e2e/har/harness.js` | `runScenario(opts)` runner: admission, exclusive step-gate, S(T)→step→S(T+1) loop, budgets, per-tick assertions, cleanup journal, verdict taxonomy. |
| `e2e/har/har-01.js` | HAR-01 scenario: minimal harvest driven by the **unchanged** production `dist/role.harvester.js` (sha256 `a3bd38d7…133d5`). Modes: `harvest`, `control`, `refuse`, `validate`. |
| `e2e/har/har-02.js` | HAR-02 sabotage suite (mode-per-case): deliberately injects fence loss, setup failure, deadline timeout, late response and teardown residue inside an F0 world and asserts the harness never fabricates PASS. Modes: `fence`, `setup-fail`, `timeout`, `late-response`, `teardown-object`, `teardown-user`. |

## Fixture schema v1

A fixture spec (`fixtureF0()`) declares *targets* (controller (25,25), spawn
(10,10), S1 (15,10), S2 (15,20), creep (14,10), RCL 2, spawn energy 300/300,
empty Memory, no competitors, creep body `[MOVE,CARRY,WORK]`). Targets are
intents: `resolveFixture()` picks the first `preferredRooms` entry whose real
topology AND placement constraints hold, and records the resolved world in
`fixture.json`:

- `actual` — real ids/coords for controller/spawn/source1/source2/creep and
  the measured source energy/capacity (packaged world: `1500/1500`).
- `distances` — BFS distance creep→S1-adjacent standable set, spawn→S1,
  chebyshev creep→source, adjacent standable-cell count.
- `targetDelta` — every target paired with its actual cell.
- `terrainSha256`, `objectsBaseline` (teardown comparison set).

`required: {slot:{x,y}}` cells must be usable verbatim — `impossibleFixture()`
requires creep (0,0)/spawn (1,0) (border walls) + RCL 9 and must always be
refused. `expectCreep:false` produces the no-creep control variant.

`validateFixture()` runs engine-side (through the CLI against live DB/terrain)
after arrangement, before the first gated step: controller ownership+RCL,
spawn present/position/store/idle/affordable, source capacity, creep
position/body/live parts/store capacity/empty store/TTL/fatigue, terrain
walkability + cell distinctness, recomputed BFS route spawn→S1-adjacent set,
empty user Memory, room in `activeRooms`, zero foreign objects. Any failure →
BLOCKED, never a strategy defect.

## Trace schema v1

`trace.jsonl`: one `kind:"meta"` record (runId, scenarioId, seedId, fixture,
moduleHashes sha256 of every uploaded user module, budgets) then one
`kind:"frame"` record per capture: `schemaVersion`, run/scenario/seed ids,
`wallTs`, `gameTime`, `ackGameTime`, `phase` (`pre-step`/`post-step`),
`stepIndex`, `snapshotOk`, `problems`, `evidence` (bound/stable/postBarrier/
ttlOk/coverageComplete), `ack` (sequence, barrierTs, drains, postBarrierWrites,
queuedUsers/Rooms), all room objects (id/type/user/coords/body/hits/store/
capacity/spawning/fatigue/ageTime/energy/actionLog), `sources`, `controller`,
`sites`, `drops`, `creeps`, `actionLog`, `memory` (test user), `queue`
(`asserted-by-protocol-not-read`), `intents`, `errors`, `notifications`,
`cpu`, `moduleHashes`.

## Artifact layout

`e2e/har/.runs/<runId>/` (own run dir — the server root under
`e2e/server/.runs/` is destroyed on PASS/quarantined on failure, so harness
artifacts must not live there):

- `run.log` — full probe stdout/stderr (teed console).
- `run.json` — verdict, reason, stats (steps, gameTime range, postcondition
  step), problems, teardownProblems, resolved ctx.
- `trace.jsonl` — trace schema v1 series (all frames, not just first/last).
- `fixture.json` / `fixture-validation.json` — resolved fixture + check list.
- `cleanup-journal.jsonl` — one record per created/deleted/verified resource.
- `budgets.json` — effective budgets + observed timing for calibration.

## Verdict taxonomy

- `PASS` (exit 0) — postcondition observed, all per-tick assertions held,
  teardown verified clean. A cleanup failure demotes PASS → UNKNOWN.
- `FAIL` (exit 1) — an observed violation: per-tick assertion broke, or the
  step budget expired without the postcondition.
- `BLOCKED` (exit 2) — fixture/admission impossible (fixture refused,
  identity/cron-marker failure). Never counts as a strategy defect.
- `UNKNOWN` (exit 3) — evidence lost: step ack lost/invalid, incoherent
  snapshot, gate unavailable, incomplete cleanup. Instance is quarantined.

FAIL/UNKNOWN always quarantine the server root (left under
`e2e/server/.runs/`); PASS and cleanly-refused BLOCKED destroy it.

## Cleanup journal format

`cleanup-journal.jsonl`, one record per line:
`{t, runId, scenarioId, kind, id, action, detail, ok}` — kinds:
`server` (create/start/identity/stop/destroy/quarantine), `gate`
(connect/admit), `cli`, `env` (aux seeding), `fixture` (resolve/validate),
`user`, `creep`, `controller`, `room` (verify-baseline), `scenario`,
`teardown`. `ok:false` marks a failed op.

## Run commands

```sh
~/.local/node22/bin/node e2e/har/har-01.js --mode harvest  --http-port 32340 --cli-port 32341
~/.local/node22/bin/node e2e/har/har-01.js --mode control  --http-port 32342 --cli-port 32343
~/.local/node22/bin/node e2e/har/har-01.js --mode refuse   --http-port 32344 --cli-port 32345
~/.local/node22/bin/node e2e/har/har-01.js --mode validate --http-port 32346 --cli-port 32347
# budget override: --bmove N --baction N --max-steps N --wcase-ms N

~/.local/node22/bin/node e2e/har/har-02.js --mode fence           --http-port 32360 --cli-port 32361
~/.local/node22/bin/node e2e/har/har-02.js --mode setup-fail      --http-port 32362 --cli-port 32363
~/.local/node22/bin/node e2e/har/har-02.js --mode timeout         --http-port 32364 --cli-port 32365
~/.local/node22/bin/node e2e/har/har-02.js --mode late-response   --http-port 32366 --cli-port 32367
~/.local/node22/bin/node e2e/har/har-02.js --mode teardown-object --http-port 32368 --cli-port 32369
~/.local/node22/bin/node e2e/har/har-02.js --mode teardown-user   --http-port 32370 --cli-port 32371
```

Disposable ports must stay within 32340–32379; node is not in `PATH`.

## HAR-01 scenario

- **World**: F0 — user owns W9N8 (first free room with controller + 2
  sources), RCL 2, `Spawn1` at (10,10) (target cell usable verbatim),
  S1 `088407718c7f377` at (19,31) (1500/1500, exactly one standable adjacent
  cell (18,30)), S2 `b8e007718c76b6e` at (13,37) recorded.
- **Subject**: `[MOVE,CARRY,WORK]` creep `har1` at (15,27), BFS distance 3
  from S1's standable cell (target (14,10) is unreachable-adjacent; actual
  equivalent recorded with distances).
- **Driver**: test entrypoint calls the real `role.harvester` module's
  `run(creep)` on real Game objects and performs only the same assignment
  production does at spawn time (`creep.memory.assignedSource`,
  dist/SourceManager.js:143). Module file hash recorded in every frame.
  `require` and `run` are wrapped in try/catch so a load/invocation failure
  lands in `Memory.har*` as inspectable FAIL evidence instead of an
  unexplained gate UNKNOWN.
- **Per-tick assertions**: creep present/owned/hits=300/not-spawning, position
  delta ≤1 cell/tick (no teleport), store within [0,50] and non-decreasing,
  source energy non-increasing (any rise = unexpected regen → FAIL),
  zero error notifications, zero module errors. `gameTime` +1 per frame and
  `ack.sequence` contiguity are asserted in `runScenario` core — scenarios
  cannot opt out.
- **Postcondition** (HAR-02 hardening): `creep.store.energy > 0` AND
  `source.energy < initial` AND `actionLog.harvest` observed on the creep the
  same tick — the engine must prove the harvest, not just its side effects.
- **Budgets** (`budgets.json`): `BMOVE=20`, `BACTION=10`, `MAX_STEPS=30`,
  `WcaseMs=300000`. Theory: [MOVE,CARRY,WORK] pays 4 fatigue per plain cell
  and clears 2/tick (~2 ticks/cell worst case); observed real cost was 11
  move-phase ticks including a swamp-entry stall. Saved values hold ~2x
  margin over the observed 12-step total — sized so a repeated (R10/R100)
  run does not flake on route jitter.
- **Control**: identical world minus the creep, trivial loop; 30 gated steps,
  `runFullBudget` PASS requires zero violations and records any engine-side
  source-energy change.

## Executed runs (2026-11-05)

| runId | mode | verdict |
|---|---|---|
| `har01-refuse-1793659744082-53617` | refuse | BLOCKED (fixture refused pre-step; clean teardown, instance destroyed) |
| `har01-harvest-1793659762818-53813` | harvest | PASS — postcondition at step 12, clean teardown |
| `har01-harvest-1793659867020-54440` | harvest | PASS — postcondition at step 12 (repeat, identical timing) |
| `har01-control-1793659818611-54131` | control | PASS — 30 steps, source flat 1500/1500, no regen events |
| `har01-validate-1793659859307-54329` | validate | PASS — fixture valid, one bound coherent step |

An earlier `har01-harvest-1793659750056-53712` BLOCKED on a validator bug
(spawn's own cell included in the route blocked set) — fixed; recorded here
only because it produced a correct BLOCKED verdict for an infra reason.

## HAR-02 sabotage suite

Mode-per-case negative testing: each mode injects one failure inside an
isolated F0 world (`expectCreep:false`, trivial loop) and asserts the harness
fails closed. A case is *effective* only when the verdict is non-PASS (exit 1–3),
both the first error and the sabotage cause are preserved in `run.json` +
`cleanup-journal.jsonl` (`kind:"sabotage"` entries), and the instance root is
quarantined exactly when cleanup verification is uncertain. A fabricated PASS
exits 9 (`SABOTAGE-INEFFECTIVE`). Per-case verdict evidence lands in
`<runDir>/sabotage.json`.

- `fence` — arms `step-control/injected-write.json` (`env.set memory:<uid>`)
  before step 1; step-mod's `consumeInjection` lands it *after* the quiescence
  barrier → ack `status:"unknown"` with `postBarrierWrites:1` → step lost →
  UNKNOWN, rejected ack recorded in the journal.
- `setup-fail` — arrange creates the test user (journaled) then throws →
  UNKNOWN; missing ctx records `user-cleanup-skipped` + `verify-skipped`
  teardown problems → quarantine.
- `timeout` — a supplemental `h.eval` on a never-resolving server-side promise
  exceeds its deadline → `eval timeout` → UNKNOWN, no hang, `server stop` ok
  (process group reaped).
- `late-response` — `room-status-fault.json` `{delayMs:5000}` forces a real
  detached-writer delay into the barrier; `stepTimeoutMs:1500` fires first,
  then the ack arrives late → recorded as `gate/late-response` in the journal
  (evidence loss, never silently ignored) → UNKNOWN.
- `teardown-object` — clean 3-step PASS, then a foreign NPC creep is inserted
  before verification → `verify-baseline` fails → PASS demoted to UNKNOWN,
  `verdictReason` keeps `primary:` + teardown error → quarantine.
- `teardown-user` — clean PASS, then the deleted user's `users.code` row
  reappears → `verify-deleted` fails (`codeRow:true`) → demotion + quarantine.

### Hardening applied (inside `runScenario` core)

- `ack.sequence === stepIndex` and `gameTime` +1 contiguity moved into the
  step loop — scenarios cannot opt out.
- A lost step now triggers `readAckLate`: a bounded grace window reads
  `ack-<seq>.json` and journals it as `gate` action `rejected` or
  `late-response` (status + postBarrierWrites), or `missing`. Late/rejected
  responses are evidence, never silently ignored.
- Teardown with no arrange ctx (e.g. setup threw mid-way) records
  `teardownProblems` + `teardown/*-skipped` journal entries instead of
  silently passing cleanup → quarantine.
- `verify-deleted` now also checks the `users.code` row, not just
  `memory:<uid>` + `users` row.
- PASS→UNKNOWN demotion preserves the primary verdict reason
  (`incomplete cleanup (primary: …): …`).
- New scenario hooks: `beforeStep(i, {h, ctx, server, gate, journal, runDir,
  budgets})` and `beforeTeardownVerify(h, ctx, journal)`.

## Executed runs (HAR-02, 2026-11-02)

| runId | mode | verdict / exit | evidence |
|---|---|---|---|
| `har02-fence-1793660577153-56511` | fence | UNKNOWN / 3 | rejected ack `status=unknown postBarrierWrites=1`; quarantined |
| `har02-setup-fail-1793660580088-56611` | setup-fail | UNKNOWN / 3 | user `create` journaled; cleanup-skipped teardown problems; quarantined |
| `har02-timeout-1793660581903-56698` | timeout | UNKNOWN / 3 | `eval timeout` preserved; `server stop` ok (group reaped); quarantined |
| `har02-late-response-1793660586774-56792` | late-response | UNKNOWN / 3 | `late-response` record, late ack `status=unknown` (`resetDuringCycle`) |
| `har02-teardown-object-1793660594706-56890` | teardown-object | UNKNOWN / 3 | demoted PASS (`primary:` kept); `verify-baseline` ok:false; quarantined |
| `har02-teardown-user-1793660599594-57006` | teardown-user | UNKNOWN / 3 | `verify-deleted` ok:false `codeRow:true`; quarantined |

## HAR-01 regression after hardening (2026-11-02)

| runId | mode | verdict |
|---|---|---|
| `har01-harvest-1793660618212-57170` | harvest | PASS — step 12; `harvestEvidence {creepStore:2, sourceEnergy:1498/1500, actionLogHarvest:{x:19,y:31}}` |
| `har01-control-1793660636522-57319` | control | PASS — 30 steps, no violations |

## Limits / not proven

- Evidence covers one room, one body, one module pair, one world seed — no
  generalization to other fixtures, bodies, swarms, or contest rooms.
- `queue` emptiness remains protocol-asserted, never directly read.
- Pre-step frame uses a plain CLI field read (no ack exists yet); only
  post-step frames carry barrier/journal binding.
- The spontaneous `updateAccessibleRoomsList`/`updateRoomStatusData` writers
  only engage ≥tick 21; all HAR-01 runs end by tick 31 but only the control
  run crossed tick 21 — spontaneous-writer drift is covered for that run
  only (it stayed clean), per the documented SRV limitation.
- Production orchestration above `run(creep)` (spawn memory plumbing) is
  emulated by the entrypoint; nothing above the single-role public method is
  exercised.
- HAR-02 residual gaps (declared by the worker, accepted by review):
  an unjournaled writer bypassing `RpcClient.request` cannot be injected
  from scenario code (mod-level only); a permanently dead gate (SIGSTOP)
  is not implemented — the `readAckLate` `missing` path is untested;
  UNKNOWN verdicts with clean teardown still quarantine by design;
  failures blocked before `arrange` returns `ctx` quarantine by design.
- Quarantined `db.json` can hold seed-time state (storage flush on stop is
  not guaranteed); forensic evidence comes from journals/acks/logs.
- `e2e/har/.runs/` is not gitignored; quarantined roots under
  `e2e/server/.runs/` need manual cleanup after inspection.
