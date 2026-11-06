# BLD scenario suite (e2e/bld/)

Construction-pattern / build-lifecycle / builder+repairer / target-selection
e2e scenarios for GitHub issue #11 (`docs/testing/issues/E2E-BLD.md`), on top
of the HAR scenario harness (`e2e/har/` — used unmodified). Each mode
provisions a disposable F0 world, uploads the REAL production modules verbatim
(SHA-256 of every uploaded file recorded in every trace frame) plus a test
`main` that calls real public methods on real Game objects — no production
rewrite, no Game/engine substitution, no verified-result writes. Evidence
lands in `Memory.bld` (compact results only — see the evidence-size note) and
is evaluated probe-side against per-mode oracles, alongside a per-fence object
projection kept in `ctx.obs` and in `trace.jsonl`.

> **Execution status: EXECUTED (2026-11-06, coordinator `screeps-coord-20261106-run2`).**
> All 10 modes ran on disposable servers: **8 PASS**, **2 UNKNOWN**
> (`bld-02-d2`, `bld-02-d2-main` — deterministic snapshot-size truncation at
> the >10 KB eval ceiling, mechanism documented below; partial frame evidence
> preserved). Three passes were needed to converge: pass 1 exposed worker
> runner bugs (missing `ctx.room`, missing `resources.sourceResource` in the
> bld-02-d2 module set), pass 2 exposed oracle/scenario defects (centroid
> semantics of indexed `getPositions`, decay vs repair on ineligible
> structures, `genA` CAP unwrap, collect-path budget, bld-04-d2 fixed-step
> removal racing the collect path). All fixes are listed under
> [Runner fixes](#runner-fixes-2026-11-06-coordinator); defect records marked
> `expected` that a run confirmed are now `confirmed`.

## Files

| File | Contents |
|---|---|
| `e2e/bld/bld.js` | Mode-per-scenario runner: F0 fixture + `runScenario`, per-mode oracle evaluators writing `oracle.json` per run (~1110 LoC) |
| `e2e/bld/entrypoints.js` | In-game `main` builders per mode; production modules loaded byte-verbatim via `prodModules` (~540 LoC) |

## Driver model

- World: disposable server per mode, exclusive step gate (ack sequence +
  barrier evidence), coherent per-tick field-set snapshots (`rooms.objects`,
  `memory:<uid>`, `gameTime`, `activeRooms`, TTL checks).
- Fixture: `fixtureF0` (RCL2 owned room, spawn, S1/S2, optional `[W,C,M]`
  creep ~3 BFS off S1, empty user Memory). Arrangement adds only INPUT rows —
  construction sites, damaged structures, dropped energy, neutral blockers,
  seeded creep Memory — journaled per object with real ids. Positions are
  computed from live terrain/objects (`preBuild`), never hardcoded; anchors
  (spawn/controller/sources/creep cell) are excluded.
- Two-phase arrange: `preBuild` computes geometry before the entrypoint source
  is baked (positions get inlined into `main`), `arrangeBase` creates
  user+spawn+controller+RCL+creep, `arrangeExtra` then inserts input objects
  and seeded Memory (needs `userId`).
- Entrypoints record compact evidence in `Memory.bld` (`CAP(fn)` →
  `{ok,v}`/`{ok:false,n,m}` — error names + ≤60-ch messages, flat position
  pairs, ids, counts) and set `Memory.bld.done`; the postcondition reads it.
  All in-game phase gates use a user-relative tick `rt = Game.time - t0 + 1`
  so they work regardless of the seed's absolute gameTime.
- Per-tick check: `commonTickCheck` (entrypoint `S.err`, user error
  notifications) + `collectFrame` (compact obs: creeps/energy/state/target/
  action flags, sites+progress+progressTotal, structure hits, drops, rm
  order/pos/claim fields, spawn procs) + oracle evaluation, which fires once
  (`bld.done` or the final step for `runFullBudget` modes).
- Teardown: HAR `destroyUser` (removes user objects + the documented set of
  completed/created object types in the room incl. `constructionSite`, `road`,
  `container`, `constructedWall`, `extension`, `energy`), baseline verify,
  user/code/memory residue check, quarantine on dirty teardown.

## Evidence-size constraint (important)

Every CLI `eval` response is printed through the sandbox `print()` →
`util.inspect` truncates strings >10 000 chars → stall + deterministic
UNKNOWN. `Memory.bld` therefore stores only compact results. Additional
exposure: `dist2` construction orders persist `pattern.params.terrain =
room.getTerrain()` — if a RoomTerrain object JSON-serializes with its backing
data (2 500 cells), raw `main`'s `Memory.resourceManager` alone can exceed the
limit and produce UNKNOWN on every frame. This is a *suspected production
Memory-bloat defect*, currently unverified — the `bld-02-d2-main` run must
confirm or refute it (recorded as a limit + suspected defect, below).

## Modes / run commands

```sh
N=~/.local/node22/bin/node
$N e2e/bld/bld.js --mode bld-01-d2         --http-port 32460 --cli-port 32461
$N e2e/bld/bld.js --mode bld-02-d-rcl1     --http-port 32462 --cli-port 32463
$N e2e/bld/bld.js --mode bld-02-d-rcl2     --http-port 32464 --cli-port 32465
$N e2e/bld/bld.js --mode bld-02-d2         --http-port 32466 --cli-port 32467
$N e2e/bld/bld.js --mode bld-02-d2-main    --http-port 32468 --cli-port 32469
$N e2e/bld/bld.js --mode bld-03-d          --http-port 32470 --cli-port 32471
$N e2e/bld/bld.js --mode bld-03-d-notarget --http-port 32472 --cli-port 32473
$N e2e/bld/bld.js --mode bld-03-d-noenergy --http-port 32474 --cli-port 32475
$N e2e/bld/bld.js --mode bld-03-d2         --http-port 32476 --cli-port 32477
$N e2e/bld/bld.js --mode bld-04-d2         --http-port 32478 --cli-port 32479
```

| mode | scenario | tree | ports | max steps / Wcase | fixture deltas on F0 |
|---|---|---|---|---|---|
| `bld-01-d2` | BLD-01 | dist2 | 32460/32461 | 7 / 300 s | none (real terrain: wall, edge, spawn→S1 path) |
| `bld-02-d-rcl1` | BLD-02-D | dist | 32462/32463 | 4 / 300 s | RCL1, seeded `Memory.managers` row |
| `bld-02-d-rcl2` | BLD-02-D | dist | 32464/32465 | 4 / 300 s | RCL2, seeded `Memory.managers` row |
| `bld-02-d2` | BLD-02-D2 | dist2 | 32466/32467 | 30 / 300 s | isolated BuildController+SpawnController+rm drive |
| `bld-02-d2-main` | BLD-02-D2 | dist2 | 32468/32469 | 105 / 600 s | raw unpatched `main.js`, full budget to a %100 reconcile |
| `bld-03-d` | BLD-03-D | dist | 32470/32471 | 100 / 600 s | owned road site p150/300, 2×400 piles, repair road h1000, threshold road h4000(=hitsMax−1000), walls h299500/h300500, repairer creep, seeded creep Memory |
| `bld-03-d-notarget` | BLD-03-D | dist | 32472/32473 | 18 / 300 s | no site; only ineligible repair targets + pile |
| `bld-03-d-noenergy` | BLD-03-D | dist | 32474/32475 | 14 / 300 s | site + repair target, zero energy anywhere |
| `bld-03-d2` | BLD-03-D2 | dist2 | 32476/32477 | 9 / 300 s | owned extension (compatible), neutral wall (incompatible blocker) at order-A pos2 |
| `bld-04-d2` | BLD-04-D2 | dist2 | 32478/32479 | 45 / 300 s | 2 owned road sites (near d2–3, far d6–10), pile 400, seeded builder collect templates |

## Module sets (byte-verbatim, per-frame SHA-256)

- `bld-01-d2` (dist2): `logger constructionPatterns`
- `bld-02-d-*` (dist): `mapPatch logger Manager CreepOwner ConstructionManager`
- `bld-02-d2` (dist2): `logger mapPatch resourceManager resources.Resource
  resources.creepOrder resources.spawnProcess resources.constructionOrder
  constructionPatterns SpawnController BuildController`
- `bld-02-d2-main` (dist2): full production set incl. `mapPatch roles logger
  resourceManager resources.sourceResource SourceController SpawnController
  resources.spawnProcess resources.creepOrder RoomController BuildController
  resources.constructionOrder js-yaml role.* resources.Resource
  utils.priority constructionPatterns main`
- `bld-03-d` (dist): `role.builder role.repairer`
- `bld-03-d2` (dist2): `logger resourceManager resources.Resource
  resources.constructionOrder constructionPatterns`
- `bld-04-d2` (dist2): `mapPatch logger resourceManager resources.Resource
  resources.constructionOrder constructionPatterns roles role.harvester
  role.mule role.upgrader role.builder`

## Oracle boundaries (what each mode asserts vs records)

- `bld-01-d2`: exact cell sets for single/checkboard(size3)/line(size3)/
  ring(radius→1)/rectangle(3×2)/parallelLines(size3) against
  startPos-centroid geometry; index 0 vs past-end (`outOfBounds`); `direction`
  and `filled` variants; `path` width1/width2 enumeration vs real
  `Room.findPath` (walkability, adjacency, ≤1 of target, `outOfBounds` at
  exactly L / 2L / 1000); flat vs nested `opts`; unreachable room; wall
  target; `patternPlacer` with terrain string vs RoomTerrain object; unknown
  names (`patternPlacer` 'nosuch', registry 'nosuch', 'checkerboard').
- `bld-02-d-*`: fresh-ctor error name, load()-path fields
  (`priority` type, `queue` presence, `pos`), `queueExtension`,
  `creepNeeded`, `run`, `save` return/error signatures at RCL1 and RCL2.
- `bld-02-d2`: real `BuildController.initialize` → ≥6 construction orders →
  `handleConstructionSites` at ticks 2/4/6 → site count; the real
  creepOrder→spawnProcess→`spawnCreep` chain producing a builder
  (pending→spawning→active); reconcile/spawn error ledgers empty.
- `bld-02-d2-main`: same evidence through unpatched `main.js` across the full
  105-step budget incl. the %100 reconcile (reconcile tick derived from the
  first observed gameTime, not assumed).
- `bld-03-d`: site progress monotonic +≤5/tick (BUILD_POWER×1 WORK), ≤300
  (progressTotal), site→structure conversion at the exact cell, build-intent
  range ≤3 only when energy actually spent, collect→build trip count ≥3,
  eligible-repair hits growth ≤100/tick (REPAIR_POWER×1), ineligible targets
  bitwise untouched, energy pickup/spend totals.
- `bld-03-d-notarget`/`-noenergy`: zero `build`/`repair` actionLog entries;
  creep store maxima (50 from the pile / 0 without energy); site progress
  pinned at its input value.
- `bld-03-d2`: `applyResource` ids = annotations; `claimStructures` claims
  only the compatible extension; `generateConstructionSitePositions` excludes
  owned-structure cells and returns the 3 remaining cells; real
  `createConstructionSite` codes — all-OK for 6 road positions (RCL-free
  type), error at the blocked cell, OK after the controlled unblock, and a
  `tower` probe returning non-OK at RCL2 (RCL-limit evidence);
  `updateSpec`→`onSpecUpdate` side effects (positions, owned, flags);
  `validateOwnedStructures` filtering dead ids; `deleteResource` + row
  removal.
- `bld-04-d2`: real rm orders bld_lo(pri10)/bld_hi(pri90); first
  `targetSiteId` selection; whether any order ever carries
  `constructionSites` (priority-map emptiness); controlled removal of the
  selected site then the remaining site; stale-id cleanup (never a target id
  pointing at a removed site across a fence); re-selection of the survivor;
  IDLE with no sites.

## Budgets (per spec §"Параметры бюджета")

Upper bounds, not tick predictions. Values marked *unconfirmed* must be
calibrated at runtime — the runner records `budgetFacts` (path length,
enum/findPath CPU) into `oracle.json` where available.

- `R10(T) = 10 − (T mod 10)`, `R100(T) = 100 − (T mod 100)` — steps to the
  next %10/%100 boundary from the run's start tick.
- `Bspawn([W,C,M])` = 3 parts × CREEP_SPAWN_TIME(3) = 9 ticks (200 energy ≤
  300 spawn store); recorded `spawnProcs`/`spawnBusy` fences confirm.
- `Bmove(route)` = route length (chebyshev, measured per fixture) — BFS
  distances recorded in `fixture.json`.
- `Baction` = 1 tick per applied intent (build/pickup/withdraw/repair).
- `Bpath` = `pathLen + 1` getPositions calls — recorded as `budgetFacts`
  (unconfirmed: ≤45 calls, each one `findPath`; ~100–300 user CPU at
  cpu=300, well inside stepTimeout).
- `Bconstruction` for `bld-03-d`: remaining 150 progress →
  `Nbuild = ceil(150/(1×5)) = 30` build ticks (BUILD_POWER=5 assumed —
  **unconfirmed engine constant**, the oracle bounds per-tick deltas at +5
  and reports any violation); supply 800 ≥ 150 spend; 3 collect→build
  trips × (Bmove out+back + Baction + ~10 build) ≈ ≤90 ticks ≤ budget 100.
- `bld-02-d2`: spawn reconcile R10 ≤ 10 + Bspawn 9 + completion reconcile 1
  ≈ ≤21 ≤ 30. `bld-02-d2-main`: R100 ≤ 105-step budget only if the seed's
  gameTime starts ≤ ~5 (same convention ORD-04 relied on); otherwise the
  reconcile is out of budget and the mode records that coverage gap rather
  than passing on partial evidence.
- `Breload`, `Bupstream`: not exercised yet (no harvester/mule chains inside
  the driven scenarios; `bld-02-d2-main` covers them only as observed
  production behavior).
- `Wcase` per mode (300 s / 600 s) bounds wall-clock; step/op timeouts are
  the harness defaults (20 s / 15 s).

## Defect records (status after 2026-11-06 runs)

| defect id | module | expected engine signature | status |
|---|---|---|---|
| BLD-PAT-DIR | dist2/constructionPatterns.js | `line` direction RIGHT/BOTTOM/default → identical positions (param accepted, ignored) | confirmed |
| BLD-PAT-FILL | dist2/constructionPatterns.js | `rectangle` filled=true/false → identical output | confirmed |
| BLD-PAT-OPTS | dist2/constructionPatterns.js | PathPattern destructures only flat `pathOpts`; `params.opts` (the shape BuildController sends) silently dropped → nested-opts path differs | confirmed |
| BLD-PAT-ROOMCHK | dist2/constructionPatterns.js | `room.getTerrain()` runs before the `!room` guard → unreachable room throws TypeError instead of `{positions:[],outOfBounds:true}` | confirmed |
| BLD-PAT-TERRAIN | dist2/constructionPatterns.js | `isValidPosition` indexes terrain as a string — RoomTerrain objects yield `undefined` cells (walls invisible); BuildController passes `room.getTerrain()` so wall checks never fire | confirmed |
| BLD-PAT-NAME | dist2/constructionPatterns.js | registry exposes `'checkboard'` (misspelled); `'checkerboard'` lookup → TypeError | confirmed |
| BLD-PAT-IDX | dist2/constructionPatterns.js | `offsetPositions` re-centers every indexed subset — each valid index of a multi-cell pattern returns the anchor cell (`cb_i0`==`cb_i4`==startPos) → index-based site placement cannot address distinct cells | confirmed |
| BLD-D2-STALE | dist2/role.builder.js | `targetSiteId` validated only in `handleBuildingState` — while COLLECTING a dead site id persists across fences (18+ observed); cleanup happens only on the BUILDING path | confirmed |
| BLD-D2-GENPOS | dist2/resources.constructionOrder.js + BuildController.js | `patterns[type]` indexes the module exports `{patterns:{...}}` object, not the map → `patternFunc` undefined → `generatePositions()` always `[]` → every order carries `positions=[]` → `handleConstructionSites` creates 0 sites; `updateSpec` regenerates `[]` and destroys owned structures | confirmed |
| BLD-D2-PRIO | dist2/role.builder.js | `findHighestPrioritySite` reads `order.constructionSites` — nothing ever sets it → priority map always `{}` → all sites priority 0 → selection degenerates to distance | confirmed |
| BLD-D2-SELECT | dist2/role.builder.js | consequence of BLD-D2-PRIO: builder picks the nearer low-priority site over the far high-priority one — distance fallback is RED, not a pass | confirmed |
| BLD-CM-CTOR | dist/ConstructionManager.js | fresh ctor path → `TypeError` (`this.controller.pos` — `Manager` sets only room/parent) | confirmed |
| BLD-CM-LOAD | dist/ConstructionManager.js | `load()` assigns `Memory.managers[name].queue` over `this.priority` → priority becomes the queue array | confirmed |
| BLD-CM-QUEUE | dist/ConstructionManager.js | `load()` never restores `this.queue` → `run()` throws `TypeError` on `this.queue.filter`; all construction behavior behind `run()` is dead code | confirmed |
| BLD-CM-EXT | dist/ConstructionManager.js | `findExtensionPos` → `ReferenceError` (ring-candidate `pos` is block-scoped inside the inner loop; the post-loop read is out of scope). `pos.t` typo, inverted `!lookFor(LOOK_STRUCTURES)`, single-candidate-per-ring are all masked behind it. Masked at RCL1 (0 extension cap) | confirmed |
| BLD-CM-DEPS | dist/ConstructionManager.js | `availableEnergy`/`energyNeeded` reference bare `DeliveryManager` (never imported) → `ReferenceError` | confirmed |
| BLD-CM-RUN | dist/ConstructionManager.js | `run()` throws `TypeError` (this.queue undefined) at both RCLs — the RCL1/RCL2 extension path is unreachable | confirmed |
| BLD-D2-MEMBLOAT (suspected) | dist2/resources.constructionOrder.js via BuildController | `pattern.params.terrain = room.getTerrain()` serialized into `Memory.resourceManager` — if RoomTerrain carries backing data into JSON, user Memory exceeds the ~10 KB snapshot ceiling → deterministic UNKNOWN | mechanism refuted for serialization (terrain→{}); cumulative snapshot ceiling hit confirmed — see engine facts |

## Known RED findings (scenario-level)

- BLD-02 dist2 (`bld-02-d2`, `bld-02-d2-main`): the full-construction chain
  is expected to halt at `positions=[]` (BLD-D2-GENPOS). Empty positions are
  evidence of the defect, never a pass — downstream stages
  (site→progress→structure→claim) are unreachable and recorded as
  not-covered/BLOCKED-on-defect, not PASS.
- BLD-02 dist: `ConstructionManager` is dormant in production main; the suite
  drives it directly. Every public entry point except the fresh/load split
  throws — the mode asserts the *throw signatures*, so a silent repair would
  surface as an oracle FAIL, not a quiet pass.
- BLD-04 dist2: priority-influence is expected absent (BLD-D2-PRIO/
  BLD-D2-SELECT). The oracle records actual selection either way and only
  fails on broken mechanics (stale ids, no re-selection, no IDLE), so a
  surprise priority-correct selection is recorded, not claimed.

## Limits / residual risks

- Trace projection does not carry `structureType` on construction sites —
  site identity is tracked by id/position (field not asserted anywhere).
- Fixture validation re-runs the spawn↔source BFS over live objects —
  arranged sites/piles/structures could theoretically sever the route →
  BLOCKED (fixture problem, honest, retryable) — not a silent failure.
- `bld-01-d2` path enumeration caps at 45 getPositions calls; a path longer
  than ~44 cells would record `oob=-1` and FAIL, not pass silently.
- `bld-02-d2-main` needs the %100 reconcile inside 105 steps — depends on the
  seed's starting gameTime (derived dynamically; a coverage gap is recorded,
  not hidden).
- Raw-main Memory size vs the 10 KB snapshot ceiling: see BLD-D2-MEMBLOAT.
- dist role.collect prefers containers; none are placed, so the pile path is
  exercised — any fixture that adds a container changes collect behavior.
- `bld-04-d2` requires the fixture creep to reach the pile within the
  collect-template range (pile ≤5 of spawn center, template range 5).
- Independent read-only review (2026-11-06, subagent `70e45f9d`):
  **accept-with-findings, no must-fix items**. All runner fixes verified
  against code + artifacts (none weakens an oracle — corrected branches
  still hard-FAIL on changed production behavior); UNKNOWN mechanism
  (10 KB eval ceiling) confirmed real and honestly labeled; every defect
  record spot-checked matches production source signatures. Minor notes:
  `bld-04-d2` stale-char text hardcodes "18+ fences" (gt is in evidence);
  the growth-only ineligible check has a bounded gap (repair landing
  exactly at `want` after decay); the `bld03dnotarget` run-history
  attribution was corrected above.

## Resolved blockers (2026-11-06)

1. ~~Worker sandbox denies exec~~ — resolved; all modes ran under the
   coordinator lease with real disposable servers.
2. Calibrated facts now recorded (see engine facts): build +≤5/tick bound
   held, repair +≤100/tick held, road decay event observed, collect cycle
   ≈60 ticks on this terrain, RoomTerrain→`{}` in JSON.
3. BLD-D2-MEMBLOAT resolved: production `main.js` Memory exceeds the
   snapshot ceiling from tick 1 (confirmed UNKNOWN footprint); the
   specific terrain-serialization mechanism is refuted (`terrain:{}`).

## Run table

| mode | scenario | tree | runId | verdict | evidence |
|---|---|---|---|---|---|
| bld-01-d2 | BLD-01 | dist2 | `bld01d2-1793962094770-837043` | PASS | exact cell sets all 6 patterns; indexed getPositions re-center onto anchor (BLD-PAT-IDX); direction/filled ignored; nested-opts path differs (n=21 vs flat n=20); unreachable → TypeError; object-terrain walls invisible; 'checkerboard' unknown |
| bld-02-d-rcl1 | BLD-02-D | dist | `bld02drcl1-1793961507024-833183` | PASS | ctor TypeError; priority=queue array; queue unrestored; queueExtension no-op at RCL1 (EXT masked); creepNeeded/save ReferenceError(DeliveryManager); run() TypeError — all 6 CM defects confirmed |
| bld-02-d-rcl2 | BLD-02-D | dist | `bld02drcl2-1793961510544-833263` | PASS | same + live `findExtensionPos` ReferenceError (`pos` block-scoped) at RCL2 — BLD-CM-EXT unmasked |
| bld-02-d2 | BLD-02-D2 | dist2 | `bld02d2-1793961701754-834897` | **UNKNOWN** | snapshot incoherent at step 10 (eval response >10 KB ceiling: objects+loki meta + user Memory). Partial evidence frames gt1–10: `extensions_W9N8_0` positions=[] (BLD-D2-GENPOS confirmed in-frame), `hcs2/4/6` ok + `sites=0`, `builder_W9N8` pending→spawnProcess started (spawn row spawnTime 19) |
| bld-02-d2-main | BLD-02-D2 | dist2 | `bld02d2main-1793961517779-833462` | **UNKNOWN** | snapshot incoherent at step 1 — raw `main.js` Memory (6 orders incl. mule `collectTemplates`) exceeds the eval ceiling from the first tick — BLD-D2-MEMBLOAT class confirmed |
| bld-03-d | BLD-03-D | dist | `bld03d-1793962206953-837957` | PASS | 179 steps: site 150→300 road conversion at exact cell; +≤5/tick bound held; 3 collect→build trips; repairer grew eligible road; ineligible targets only decayed (one −100 event), never grew; energy pickup/spend totals recorded |
| bld-03-d-notarget | BLD-03-D | dist | `bld03dnotarget-1793962100867-837210` | PASS | zero build/repair intents; both creeps filled 50 from pile then held; no site appeared |
| bld-03-d-noenergy | BLD-03-D | dist | `bld03dnoenergy-1793961857628-835842` | PASS | zero intents; stores pinned 0; site progress flat at input value |
| bld-03-d2 | BLD-03-D2 | dist2 | `bld03d2-1793962139621-837460` | PASS | apply ids=annotations; claim only compatible extension; gen excluded owned cell (3 remaining); create codes: error at wall cell, OK after unblock, tower →ERR_RCL_NOT_ENOUGH; updateSpec→positions=[] + owned destroyed (BLD-D2-GENPOS); validate filtered dead ids; delete removed row |
| bld-04-d2 | BLD-04-D2 | dist2 | `bld04d2-1793962147762-837590` | PASS | orders bld_lo(pri10)/bld_hi(pri90); first target = near site (distance fallback — BLD-D2-PRIO/SELECT confirmed); stale targetSiteId persisted across COLLECTING fences (BLD-D2-STALE, new defect); state-triggered second removal → survivor re-selected; final IDLE with no sites |

Artifacts per run: `runDir = e2e/har/.runs/<runId>/` with `trace.jsonl`,
`run.json`, `oracle.json`, `fixture.json`, `fixture-validation.json`,
journal/cleanup files. Earlier iteration runs (kept for history):
`bld01d2-1793961500270-833078` FAIL (runner bug: `ctx.room` unset),
`bld02d2-…833381` FAIL (runner bug: `resources.sourceResource` missing),
`bld03d-…833678`/`bld03dnoenergy-…833984`/`bld03d2-…834087` FAIL
(same `ctx.room` bug), `bld03dnotarget-…833767` FAIL (`ctx.room` bug
plus an 18-step budget too short for the swamp-fatigued builder — the
store-fill failure recurred at `…835685` until the 40-step bump),
`bld04d2-…834190` FAIL (fixed-step removal raced the collect path);
`bld03d-…835168`, `bld03d2-…835973`, `bld04d2-…836111` FAIL
(decay-unaware ineligible check, `genA` unwrap bug, oracle `cb_i0`
assumption, same stale-id evidence).

## Runner fixes (2026-11-06, coordinator)

1. **`epCtx.room` default** — modes relying on `ctxFromFx: () => ({})` never
   populated `ctx.room`, so `Game.rooms[CFG.room]` was undefined and every
   room-touching call crashed (5 modes failed pass 1). `epCtx` now seeds
   `room: fx.room` before `ctxFromFx`; mode values still override.
2. **`BLD02D2_MODULES` += `resources.sourceResource`** — `RM_REGISTER_ALL`
   requires it; the upload set lacked it → `Unknown module` at load.
3. **`cb_i0`/`cb_i4` oracle → BLD-PAT-IDX** — the check assumed index-0
   returns the first enumeration cell; the real contract re-centers every
   indexed subset via `offsetPositions`, so *every* valid index returns the
   anchor cell (evidenced `cb_i0 == cb_i4 == [startPos]`). The check now
   asserts the observed defect and fails if it changes.
4. **Ineligible-target check is direction-aware** — it flagged the
   threshold road's natural decay (4000→3900, one −100 event) as a repair
   touch. Only hits *growth* above the arranged value is a violation;
   drops are recorded as decay characterizations.
5. **`genA` CAP unwrap** — the oracle compared `bld.genA` (a `{ok,v}` CAP
   result) to a raw position array; reads `genA.v` now.
6. **Budgets recalibrated to real terrain** — the collect path crosses
   swamp cells ([W,C,M] creep: ~60-tick collect→build cycle): `bld-03-d`
   100→200 steps/doneAt 195 (needed 179), `bld-03-d-notarget` 18→40/35,
   `bld-04-d2` 45→60/55.
7. **`bld-04-d2` second removal is state-triggered** — a fixed step-20
   removal landed while the creep was still COLLECTING, so both sites were
   gone before the first BUILDING tick and the re-selection path was never
   exercised. The removal now waits for the creep to reach `BUILDING` with
   a site alive (journaled identically).
8. **Stale-`targetSiteId` check is state-aware** — the role validates the
   field only in `handleBuildingState`; a dead id while `COLLECTING` is the
   real defect **BLD-D2-STALE** (recorded), while a stale id observed in a
   `BUILDING` fence remains a hard failure (cleanup is same-tick there).

## Engine facts added this pass

- `RoomTerrain` JSON-serializes to `{}` — `pattern.params.terrain` persisted
  in rm orders carries no cell data (BLD-D2-MEMBLOAT's *specific* mechanism
  refuted); the actual snapshot-ceiling driver is cumulative response size
  (objects rows incl. loki `meta` + user Memory), hit by raw `main.js` at
  tick 1 (6 orders with `collectTemplates` Memory) and by `bld-02-d2` at
  the reconcile tick (spawnProcess + creep rows).
- Roads decay in the packaged engine: the arranged h4000 road lost one
  −100 decay event early in the run, then held.
- dist `role.repairer` threshold: road at `hitsMax−1000` (4000) ineligible;
  road at 1000 and the post-decay 3900 eligible — repairs grew the
  eligible road, never touched the ineligible wall/threshold structures.
- `[W,C,M]` swamp collect cycle ≈ 60 ticks creep→pile→site in this terrain.
