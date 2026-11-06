# SPN scenario suite (e2e/spn/)

Spawn/plan/ownership/recovery e2e scenarios on top of the HAR scenario
harness (`e2e/har/` — used unmodified). Each mode uploads the REAL production
modules verbatim (sha256 per frame) plus a test `main` driving real public
methods on real Game objects — no production rewrite, no Game/engine
substitution, no verified-result writes. Per-fence state (queue, orders,
spawnProcess, spawn.spawning, energy, creep objects, Memory.creeps) is read
probe-side from the trace frames; `Memory.spn` only carries compact action
records (CAP results, reload markers, done flag) to stay under the ~10 KB
eval-truncation limit documented in [orders.md](orders.md).

## Files

| File | Contents |
|---|---|
| `e2e/spn/spn.js` | Mode-per-scenario runner: F0 fixture + `runScenario`, per-tick obs collection, energy-conservation model, per-mode oracle + check, `oracle.json`/`budgets.json` artifacts |
| `e2e/spn/entrypoints.js` | In-game `main` builders per tree: dist `parent`-emulated `RoomManager.run()` ordering; dist2 real `SourceController`/`SpawnController` singletons (verbatim module upload via `prodModules`) |

## Driver model

- **dist** — a test `parent` object supplies RoomManager's surface
  (`managers` Map + `sourceManagers`); the call order is exactly
  `dist/RoomManager.js:58-107`: `spawnManager.run()` → `sourceManager.run()`
  → `queueCreeps` do/while priority selection → `save()`. All managers are
  real classes (`SourceManager`, `SpawnManager`, `DeliveryManager` — the
  latter needed because `SpawnManager.save()→energyNeeded` dereferences
  `DeliveryManager.cache`; no routes/consumers registered). One
  `SourceManager` for S1 only (S2 unmanaged — single-order determinism).
- **dist2** — `sourceController.initialize()` (real order creation) or
  `rm.applyResource('creepOrder', spec)` (real public API input), then every
  tick `SourceController.reconcile()` + `SpawnController.reconcile()` +
  `rm.save()` exactly as `dist2/main.js` does. Reconcile gates are real:
  SpawnController acts only at `Game.time % 10 == 0` (frames 11/21/31).

## Verified engine facts (calibrated this run)

- `Game.creeps` **includes** creeps still `spawning:true` → dist
  `CreepOwner.run()` binds the queued name to the *spawning* creep on the
  same tick the intent lands (spawnManager.run precedes sourceManager.run).
- Spawn energy fence model (verified): intent charge is applied before the
  spawn's per-tick regen, so a spawn-event fence delta = `-cost + 1`; all
  other fences `+1` while store < 300, `0` at cap.
- `needTime = 3 × parts`, creep born when `gameTime >= spawnTime - 1`;
  `harvester0` [work,move] took 5 fences; `harvester_<id>_0` [m,c,w,w]
  born ~11 fences after intent.
- `rooms.intents` rows are empty in post-step frames (consumed during
  processing) — spawn intents are proven via `spawn.spawning` + energy
  deltas + Memory evidence, not via intent rows.
- dist2 creep name = `<annotation>_<Game.time % 2>` = `..._0` at %10
  reconciles; `expiryTime = activation user-tick + 1500`.
- dist `harvester0` override: `SpawnManager.queueCreep` special-cases the
  name → `[work,move]` cost 150 eff 1 (not the [m,w,w] 250 template);
  mule at 300 capacity = 6 parts `[c,c,m,c,c,m]` cost 300 eff 4 (ratio set
  cost 150, two sets — no 50-part issues here but see SPN-R1).

## Run commands

```sh
N=~/.local/node22/bin/node
$N e2e/spn/spn.js --mode spn-01-d            --http-port 32402 --cli-port 32403
$N e2e/spn/spn.js --mode spn-01-d-occupied   --http-port 32402 --cli-port 32403
$N e2e/spn/spn.js --mode spn-01-d-noenergy   --http-port 32404 --cli-port 32405
$N e2e/spn/spn.js --mode spn-01-d-priority   --http-port 32406 --cli-port 32407
$N e2e/spn/spn.js --mode spn-01-d-nameexists --http-port 32408 --cli-port 32409
$N e2e/spn/spn.js --mode spn-01-d2           --http-port 32410 --cli-port 32411
$N e2e/spn/spn.js --mode spn-01-d2-occupied  --http-port 32410 --cli-port 32411
$N e2e/spn/spn.js --mode spn-01-d2-noenergy  --http-port 32412 --cli-port 32413
$N e2e/spn/spn.js --mode spn-01-d2-priority  --http-port 32414 --cli-port 32415
$N e2e/spn/spn.js --mode spn-01-d2-nameexists --http-port 32416 --cli-port 32417
$N e2e/spn/spn.js --mode spn-01-d2-starve    --http-port 32418 --cli-port 32419
$N e2e/spn/spn.js --mode spn-02-d            --http-port 32402 --cli-port 32403
# remaining modes — second worker's port range (32420–32439):
$N e2e/spn/spn.js --mode spn-02-d2           --http-port 32420 --cli-port 32421
$N e2e/spn/spn.js --mode spn-03-d2-api       --http-port 32422 --cli-port 32423
$N e2e/spn/spn.js --mode spn-03-d2-kill      --http-port 32424 --cli-port 32425
$N e2e/spn/spn.js --mode spn-03-d2-nospawn   --http-port 32426 --cli-port 32427
$N e2e/spn/spn.js --mode spn-03-d2-orphan    --http-port 32428 --cli-port 32429
$N e2e/spn/spn.js --mode spn-03-d2-expiry    --http-port 32430 --cli-port 32431
$N e2e/spn/spn.js --mode spn-03-d-deadq      --http-port 32432 --cli-port 32433
# overrides: --max-steps N --wcase-ms N --http-port/--cli-port
```

Mode `main` modules see `Game.time = frame.gameTime - 1` (first user tick
Game.time=1 → post-step frame 2), same as ORD.

## Scenario map

| Mode | Tree | Scenario | Input | What the fences must show |
|---|---|---|---|---|
| spn-01-d | dist | SPN-01 | free spawn, 300/300 | `harvester0` queued t1 [w,m]/150 → spawn intent f3 → creepOwner binds same fence → born f8, `assignedSource`=S1, energy −149 |
| spn-01-d-occupied | dist | SPN-01 | entrypoint `spawnCreep(['move'],'occ')` at t1 | `occ` event first, `harvester0` waits for a free spawn then spawns normally |
| spn-01-d-noenergy | dist | SPN-01 | spawn energy 0 (beforeStep) | queue + creepsQueued retained, zero spawn events, energy regen only |
| spn-01-d-priority | dist | SPN-01 | stub manager priority 8 mule vs harvester 5 | `mule0` heads queue and spawns first (real `queueCreeps` priority pick) |
| spn-01-d-nameexists | dist | SPN-01 | living creep named `harvester0` (fixture) | **SPN-D1**: queue entry consumed by silent `ERR_NAME_EXISTS`, zero spend, foreign creep adopted |
| spn-01-d2 | dist2 | SPN-01 | SourceController orders S1+S2 | pending→spawning→process→active chain; top-priority source order spawns f11, 4-part body, energy 300→0, active f31 expiry 1530 |
| spn-01-d2-occupied | dist2 | SPN-01 | direct `occ1` spawn at t7 | occupied spawn → reconcile early-returns; all orders pending, no process |
| spn-01-d2-noenergy | dist2 | SPN-01 | spawn energy 0 | orders pending, no process, no spend |
| spn-01-d2-priority | dist2 | SPN-01 | + `probe_low` (priority 1) | top order wins; `probe_low` + other source order stay pending |
| spn-01-d2-nameexists | dist2 | SPN-01 | living `harvester_<top>_0` | `ERR_NAME_EXISTS` → pending forever, no process, energy 300 flat |
| spn-01-d2-starve | dist2 | SPN-01 | `top_impossible` (priority 1e15, 400-cost schema) | **SPN-D2**: `calculateBodyParts`→null breaks the order loop — both real orders starve ≥3 reconcile windows |
| spn-02-d | dist | SPN-02 | real queue | order→spawn→name→ID→`assignedSource` chain + runtime reload (wipe) keeps binding |
| spn-02-d2 | dist2 | SPN-02 | API order `first` | same chain for `first_0` + post-reload `instanceof CreepOrder`, active, creep alive |
| spn-03-d2-api | dist2 | SPN-03 | `api_rec` applied at t=12 mid-spawn | stays pending until `first` completes; spawns after; never a false active |
| spn-03-d2-kill | dist2 | SPN-03 | `suicide()` born `first_0` at t=25 + `energy0` drain t30/`energyFull` t35 | order reverts (transient pending f31–f40), `Memory.creeps` cleaned at %10 (observable in the drained window), re-spawn `first_0` f41 → active f51 |
| spn-03-d2-nospawn | dist2 | SPN-03 | spawn row deleted at step 13 | engine deletes the spawning creep with its spawn (no ghost) → process failed+removed at first %10 reconcile → order pending forever; never false active (**SPN-D4 retracted**) |
| spn-03-d2-orphan | dist2 | SPN-03 | order forced `status='spawning'`, no process | %10 reconcile resets to pending → then spawns normally; no fabricated process |
| spn-03-d2-expiry | dist2 | SPN-03 | `expiryTime` forced near T | **SPN-D5**: order reset to pending while its living `first_0` blocks the re-spawn (`ERR_NAME_EXISTS`) → permanent stall |
| spn-03-d-deadq | dist | SPN-03 | `suicide()` owned `harvester0` | dead name leaves saved creeps/creepsQueued; source re-queues `harvester1` |

## Executed runs (2026-11-02)

| runId | mode | verdict | evidence |
|---|---|---|---|
| `spn01d-1793663620018-67312` | spn-01-d | PASS | queue f2 → spawn f3 → promoted f3 → born f8; [w,m]/150; energy −149 |
| `spn01doccupied-1793663681436-67673` | spn-01-d-occupied | PASS | spawn events [occ, harvester0] in order; occupied spawn deferred the queue |
| `spn01dnoenergy-1793663696705-67794` | spn-01-d-noenergy | PASS | 8 fences: queue+creepsQueued retained, 0 spend, +1 regen/tick |
| `spn01dpriority-1793663919430-68752` | spn-01-d-priority | PASS | queue head `mule0` before harvesters; 6-part/300 body; born f20 |
| `spn01dnameexists-1793663754476-68114` | spn-01-d-nameexists | PASS | **SPN-D1 reproduced** — queue consumed f3, energy 300 flat, foreign `harvester0` in `creeps[]` |
| `spn01d2-1793663635189-67439` | spn-01-d2 | PASS | pending f2 → spawning f11 (needTime 12, spawnTime 22) → active f31, expiry 1530; other order pending |
| `spn01d2occupied-1793663947501-68916` | spn-01-d2-occupied | PASS | only `occ1` spawn event; all orders pending; no process |
| `spn01d2noenergy-1793663964923-69044` | spn-01-d2-noenergy | PASS | orders pending 13 fences, no process, energy ≤13 |
| `spn01d2priority-1793663980738-69167` | spn-01-d2-priority | PASS | argmax-priority order spawned; `probe_low`+other pending |
| `spn01d2nameexists-1793664020590-69372` | spn-01-d2-nameexists | PASS | `ERR_NAME_EXISTS` → pending forever, no process, energy 300 flat |
| `spn01d2starve-1793664036127-69511` | spn-01-d2-starve | PASS | **SPN-D2 reproduced** — 3 reconcile windows (f11/f21/f31), zero spawns, all pending |
| `spn02d-1793664072473-69700` | spn-02-d | PASS | full chain + reload t9: `creeps=["harvester0"]`, binding persisted |
| `spn02d2-1793664089090-69837` | spn-02-d2 | UNKNOWN | step 10 lost — rejected ack; audit shows **SPN-D6** runner timeout (`calculateBodyParts` infinite loop, deterministic) |
| `spn03d2api-1793664101411-69944` | spn-03-d2-api | UNKNOWN | step 10 lost — rejected ack; audit shows **SPN-D6** runner timeout (deterministic) |
| `spn03d2kill-1793664113890-70057` | spn-03-d2-kill | UNKNOWN | step 10 lost — rejected ack; audit shows **SPN-D6** runner timeout (deterministic) |

## Executed runs (2026-11-06, second pass — fixed specs + runner fixes)

| runId | mode | verdict | evidence |
|---|---|---|---|
| `spn02d2-1793925521518-694006` | spn-02-d2 | PASS | pending f2 → spawning f11 → active f21 expiry 1520; runtime reload t21: order active, `instanceof CreepOrder`, creep alive — SPN-D6 regression clean past tick 10 |
| `spn03d2api-1793925558723-694332` | spn-03-d2-api | PASS | `api_rec` pending f13 → spawning f21 → active f31; spawned only after `first` completed; never false active |
| `spn03d2kill-1793925594835-694607` | spn-03-d2-kill | PASS | `first_0` killed t25 → %10 cleanup removed Memory key during drained window (f31–f40) → order pending → re-spawn f41 → active f51 |
| `spn03d2nospawn-1793925654169-695017` | spn-03-d2-nospawn | PASS | **SPN-D4 retracted**: engine deletes the spawning creep with its spawn (no ghost) → process failed+removed at first %10 reconcile → order pending forever; no false active |
| `spn03d2orphan-1793925683233-695302` | spn-03-d2-orphan | PASS | forced `spawning` (no process) f2–f10 → reset pending f11 → real spawn `orph_0` f21 → active f31 |
| `spn03d2expiry-1793925719602-695542` | spn-03-d2-expiry | PASS | **SPN-D5 confirmed**: expiry reset ~t30 → order pending 24 fences while living `first_0` blocks its own re-spawn (`ERR_NAME_EXISTS` stall) |
| `spn03ddeadq-1793925776691-695946` | spn-03-d-deadq | PASS | dead `harvester0` removed from saved `creeps[]`/`creepsQueued`; `harvester1` re-queued (unaffordable at ~160 energy, stayed queued) |

First-pass attempts on this date (kept for history): five UNKNOWNs
(`spn02d2-…689828`, `spn03d2api-…690148`, `spn03d2orphan-…691151`,
`spn03d2expiry-…691583`, `spn03ddeadq-…692224`) all demoted by the broken
`beforeTeardownVerify` restore — see runner fixes below; two FAILs
(`spn03d2kill-…690469`, `spn03d2nospawn-…690905`) whose evidence drove the
kill redesign and the SPN-D4 retraction respectively.

## Runner fixes (2026-11-06, coordinator, after first-pass evidence)

1. **`beforeTeardownVerify` removed.** Its premise was wrong: `objectsBaseline`
   is captured at `resolveFixture` — *before* the test user exists — so the
   user's spawn is never in baseline; `destroyUser` deletes it correctly and
   re-inserting the row made it `extra` for **every** mode, demoting five
   otherwise-clean PASSes to UNKNOWN. Deleting the spawn mid-scenario needs
   no restore: teardown wants the pre-user world back. (`ctx.spawnRow`
   capture removed with it; `ctx.spawnId` stays for spawnProcess/injection.)
2. **`ctx.multiCycle` wired** — the mode flag existed but was never copied to
   ctx, so the "process present at/after activation" assertion ran even for
   multi-spawn scenarios (false FAIL in the first kill run).
3. **kill mode redesigned**: a `blocker` directSpawn could not defer the
   reconcile's own re-spawn — same-tick intents are resolved in order and
   the reconcile's later intent wins (engine fact: a second spawn intent on
   the same spawn in one tick supersedes the first; `blocker` returned OK,
   never became a creep, and its orphaned `Memory.creeps` key was cleaned at
   the next reconcile). Replaced by `energy0` at t30 + `energyFull` at t35:
   the %10 cleanup runs while `spawnCreep` fails `ERR_NOT_ENOUGH_ENERGY`,
   making dead-key deletion + transient pending observable (f31–f40).
4. **`skipEnergyDeltaG`** in `energyProblems` — injected energy writes are
   journaled world writes, not engine deltas; the frame pair that first
   shows an injection (`beforeStep(i)` lands in tick i → frame i+1) is
   skipped, all other deltas still checked.
5. **nospawn oracle rewritten to the real contract** — the old oracle
   *required* the ghost-creep/false-active path; the engine cannot produce
   it. The oracle now asserts: exactly one spawn event, creep gone with the
   spawn, process failed+removed at the first %10 reconcile, order pending
   forever, never falsely active.

## Engine facts added this pass

- Deleting a `rooms.objects` spawn row mid-spawn removes the still-spawning
  creep object as well — no ghost creep exists.
- Two `spawnCreep` intents on one spawn in one tick: both return `OK` at
  issue time, the later intent supersedes; the loser only leaves an orphaned
  `Memory.creeps[name]` entry cleaned by the next %10 reconcile.

## Independent review (2026-11-06)

Read-only reviewer verdict: **accept-with-findings** — all coordinator runner
changes verified legitimate (not oracle-weakening), 7/7 second-pass runs
coherent, coverage complete vs the issue spec. Applied the three recommended
oracle tightenings (they add assertions over already-collected frames whose
values the reviewer verified in the traces):

- `spn-03-d2-nospawn` also asserts `Memory.creeps[first_0]` removal at f≥21
  and no `spawning` status after the post-deletion reconcile.
- `spn-03-d2-kill` also asserts second-cycle re-activation (active + cn +
  expiry = act tick +1500) and no dangling process after it.
- `spn-03-d2-expiry` also asserts no `spawnProcess` exists while the order
  sits pending in the stall window.

Reviewer residual notes (recorded, no action): SPN-D6's primary `ack-10`
evidence was ephemeral (quarantined roots since cleaned — journal/run.json
secondary evidence survives); `skipEnergyDeltaG` serializes as `{}` in
run.json ctx (injected steps are journaled); SPN-D2's run artifacts lack a
human-readable characterization string though the defect evidence is in the
frames.

Iteration runs (kept for history): `spn01d-…593552-67137` FAIL (oracle bug:
spawn-fence delta is `-cost+1`, model calibrated), two
`spn01dpriority-…987`/`…268` UNKNOWNs (harness bug: unpersisted stub manager
re-queued a mule every tick → queue blew up the eval), one
`spn01dpriority-…339` FAIL (oracle bugs: `StubM` owner-key match, `as`
undefined-gate).

The three step-10 UNKNOWNs (`spn-02-d2`, `spn-03-d2-api`, `spn-03-d2-kill`)
were root-caused from the quarantined server roots — **not flake, not a
fence violation**: every `ack-10.json` carries `postBarrierWrites:[]`,
`resetDuringCycle:false`, clean drains, and
`audit.runner[0].error = "Script execution timed out.\n at
calculateBodyParts (resources.creepOrder:72:24)"` at sequence 10 /
gameTime 11 — the first `%10` reconcile tick (user Game.time=10). All
three modes drive API orders whose spec `schema.ratio` was `{}` — the
`CreepOrder.createSchema` default — which makes `ratioSetCost=0` and
`maxSets=Math.floor(remainingEnergy/0)=Infinity`: an infinite loop in
`dist2/resources.creepOrder.js:60-77`. This is defect **SPN-D6**
(confirmed). `spn01d2-…67439` passed the same tick only because real
`sourceController` orders carry a non-empty `{work:1}` ratio set;
`top_impossible`/`probe_low` escaped it via early returns/priority order.
The "transient contention" hypothesis is retracted.

**Fixture adjustment (2026-11-05, not an oracle change):** the API-order
specs (`first`/`api_rec`/`orph`/`probe_low`) now use
`ratio:{work:1}` + `maxCost` clamped to the constant cost — the real
ratio path runs but `setsByMaxCost=0` yields 0 added sets, preserving the
intended constant-only bodies (`[work,move]`/`[move]`) and all designed
timings. `top_impossible` keeps `ratio:{}` (returns null at the constant
cost check before the ratio loop — required input for the SPN-D2 starve
scenario). Separately, `oracleDist2Chain` gained a ctx-bounded exemption
(`forcedSpawnWindowEnd`) for `spn-03-d2-orphan`'s *arranged* forced
`'spawning'`-without-process input (frames ≤11 for that order only);
post-reset violations remain asserted.

**Runner fixes (2026-11-06, static audit — superseded by the run-evidenced
fixes documented below):**

- `spn-03-d2-kill` — the audit correctly identified that the
  `Memory.creeps[first_0]` cleanup assertion could never pass unaided: the
  %10 reconcile deletes the dead key (`SpawnController.js:11-15`) and the
  same reconcile's order loop re-spawns `first_0`, whose `spawnCreep`
  immediately rewrites `Memory.creeps[name]` (verified: `spn01d2-…67439`
  frame g11 carries the key at intent time). The audit's `blocker`
  directSpawn design did **not** work in practice (see fix #3 below).
- `spn-03-d2-nospawn` — the audit's `beforeTeardownVerify` restore hook was
  based on a wrong baseline premise and actively corrupted every mode's
  teardown (see fix #1 below); reverted.

All defined modes executed (2026-11-06 second pass — see run table).

## Defect records (observed, trace-bound)

| ID | Contract violated / risk | Reproduction | Expected | Actual |
|---|---|---|---|---|
| SPN-D1 | `SpawnManager.run()` checks dryRun result but **ignores the real `spawnCreep` return** (`dist/SpawnManager.js:160-163`); queued entry is `shift()`ed regardless. On `ERR_NAME_EXISTS` the entry is lost with no energy spend and `CreepOwner` promotes the same-named foreign creep into `creeps[]` — a fabricated ownership binding. | `spn-01-d-nameexists`: fixture creep `harvester0`; t1 queue [harvester0 w,m 150] + creepsQueued → f3 queue empty, energy 300 (no spend), `SrcM.creeps=["harvester0"]` (foreign object) | spawn failure → order retained or error surfaced; foreign creep never bound | queue entry silently consumed; foreign creep adopted; manager believes the source is worked (hasWork=1, freePlaces=0 → starvation) |
| SPN-D2 | `SpawnController.reconcile` order loop breaks on the FIRST uncomputable body (`if (!bodyParts) break`, `dist2/SpawnController.js:89-92`) after sorting by priority desc — an impossible highest-priority order starves every lower order. | `spn-01-d2-starve`: `top_impossible` priority 1e15, const cost 400 > energyToUse 300 → `calculateBodyParts`→null → `break` | lower-priority feasible order spawns | 3 reconcile windows f11/f21/f31: zero spawn events, all orders pending, energy 300 flat — starvation |
| SPN-D4 | ~~`SpawnProcess.isComplete` ghost-creep false active~~ — **RETRACTED** (`spn03d2nospawn-1793925654169-695017`): the engine deletes the spawning creep together with the spawn row, so no ghost exists; the process fails+is removed at the first %10 reconcile and the order resets to `pending` forever. The contract "never a fabricated active" holds; the residual observation is only that an order whose spawn is never rebuilt starves pending — expected. | `spn-03-d2-nospawn` | process 'failed', order pending, never false active | exactly that — premise impossible in this engine |
| SPN-D5 | expiry reset (`dist2/SpawnController.js:20-24`) nulls `creepName` but the living creep keeps the engine name `<annotation>_0`; the re-spawn collides with it → `ERR_NAME_EXISTS` → `break` → permanent stall. | `spn03d2expiry-1793925719602-695542` | re-spawn proceeds (rename or skip) | **confirmed** — order pending 24 fences to end of run; living `first_0` blocks its own re-spawn |
| SPN-D6 | `CreepOrder.calculateBodyParts` (`dist2/resources.creepOrder.js:60-77`) divides `remainingEnergy` by `ratioSetCost` with no zero guard — `schema.ratio={}` (the `createSchema(constant=[], ratio={}, maxCost=0)` **default**) or any zero-cost ratio set gives `maxSets=Infinity` → `for (i<maxSets)` never terminates → user script hard timeout **every %10 reconcile**. `maxCost` does not save it (`floor(x/0)=Infinity` for `setsByMaxCost` too). Any constant-only API order wedges the user runner permanently. | `spn02d2-…69837`, `spn03d2api-…69944`, `spn03d2kill-…70057`: three independent runs died identically at ack seq 10 / gameTime 11 — `audit.runner` error `Script execution timed out. at calculateBodyParts (resources.creepOrder:72:24)`; `postBarrierWrites=0`, clean drains, `resetDuringCycle:false` | order body computed (0 ratio sets → constant parts only), spawn proceeds | infinite loop → runner killed mid-tick; order stuck `pending`, user script burns its full tick budget every reconcile |

SPN-D1, SPN-D2, SPN-D5 and SPN-D6 are confirmed with trace/ack evidence (see
run tables; SPN-D6's reproduction is the three quarantined step-10 acks —
the rejected ack IS the defect footprint: runner killed mid-cycle by the
production infinite loop). SPN-D4 is retracted by direct run evidence.

Risks (recorded, not defects): **SPN-R1** — neither `CreepPlanner` nor
`CreepOrder.calculateBodyParts` has a `MAX_CREEP_SIZE` cap (ORD-D9 confirms
the engine-side −10 rejection for >50 parts; bodies ≤50 only land with
valid body/cost/energy). **SPN-R2** — dist `queueCreep` plans bodies at
`energyCapacityAvailable` (300), so a depleted spawn accumulates queued
creeps it cannot afford; `harvester1`/`harvester2` (250) sat queued ~100+
ticks behind a drained spawn — by design of the planner, recorded.

## Oracle discipline applied

- Invalid bodies/energy are negative engine inputs only — a fake spawn /
  fake process / fake `active` status is always a violation (asserted
  per-fence, not just at the end).
- Engine rejections (−3 name, −4 busy, −6 energy, −10 args) produce **no**
  spawnProcess, **no** energy spend, and the order never reaches
  `spawning` — verified via `spawn.spawning`, `spawnProcess` rows, and the
  per-fence energy model.
- Balance by per-fence deltas: spawn regen `+1`/tick (post-charge
  semantics, calibrated), spawn cost `-cost+1` at the intent fence, source
  regen left out of scope (recorded, not asserted), death/decay only in
  kill/nospawn windows. Unknown quantities would have failed closed to
  UNKNOWN; none occurred in the PASSed runs.
- `queue` column stays `asserted-by-protocol-not-read` — order queues are
  evidenced via `Memory.managers`/`Memory.resourceManager` in frames.

## Harness change requests (not made — e2e/har/**, e2e/server/** read-only)

1. `rooms.intents` is always empty in post-step frames (consumed during
   processing) — spawn-intent evidence would benefit from an optional
   pre-processing intent capture or ack-level intent echo.
2. The >10 KB `print()` truncation still silently stalls field reads; a
   large `Memory.managers.queue` (14 QueuedCreep entries) reproduced it
   even though individual objects are small — chunking would have saved a
   run. (orders.md request #1 confirmed again.)
3. Three step-10 UNKNOWNs (`status=unknown` acks) offered no
   machine-readable reason in `run.json` — the rejected ack's
   `audit.runner[].error` DID carry it (`Script execution timed out. at
   calculateBodyParts`), but only inside the quarantined server root.
   Surfacing `audit` errors in the run's `problems`/`run.json` would have
   made SPN-D6 diagnosable without forensic ack reads.

## Limits / not proven

- dist: only ONE SourceManager (S1) was driven; multi-source contention,
  DeliveryManager routes/consumers, Storage/ControllerManager orders and
  `RoomManager` itself are out of scope (its construction pulls in
  `DeliveryManager` + serialized costMatrix — an evidence-size hazard).
- dist2: `calculateEnergyToUse` always returned `SPAWN_ENERGY_CAPACITY`
  (no source had both harvester+mule active) — the
  `energyCapacityAvailable` branch is unexercised.
- SPN-D4 retracted by `spn03d2nospawn-1793925654169-695017` (engine deletes
  the spawning creep with the spawn; no false active). SPN-D5 confirmed by
  `spn03d2expiry-1793925719602-695542` (24-fence ERR_NAME_EXISTS stall).
- Respawn after re-queue in dist (`harvester1` at 250 needing ~100 regen
  ticks) observed as queued, not spawned — long-window tail unproven.
- One room, one spawn, one seed; no multi-spawn, no extensions, no
  hostiles, no `PWR_*` effects. `Game.time↔frame` mapping verified only in
  this packaged engine.
- Quarantined roots under `e2e/server/.runs/` from the UNKNOWN runs need
  manual cleanup after inspection.
