# ORD scenario suite (e2e/ord/)

Order/planner/interface e2e scenarios on top of the HAR scenario harness
(`e2e/har/` — used unmodified). Each mode uploads the REAL production modules
plus a test `main` that calls real public methods on real Game objects — no
production rewrite, no Game/engine substitution, no verified-result writes.
Evidence lands in `Memory.ord` (compact results only — see evidence-size note
below) and is evaluated probe-side against the oracle table.

## Files

| File | Contents |
|---|---|
| `e2e/ord/ord.js` | Mode-per-scenario runner: F0 fixture + `runScenario`, per-mode oracle evaluator, `oracle.json` artifact per run |
| `e2e/ord/entrypoints.js` | In-game `main` builders per mode + verbatim production-module loader (`prodModules`) |

## Evidence-size constraint (important)

Every CLI `eval` response (incl. the field-set read carrying
`memory:<uid>` + `rooms.objects`) is printed through the sandbox `print()`,
which runs `util.inspect` — strings longer than `maxStringLength=10000` are
truncated (`'... N more characters'`), which removes the closing marker and
stalls the eval until timeout (deterministic UNKNOWN). User Memory must stay
≲3 KB raw at all times. Consequences designed around it:

- `Memory.ord` records compact results only (error names + ≤60-char messages,
  ids, counts, part lists).
- ORD-04 per-tick planner effects are verified probe-side from frame memory,
  not stored in-game.
- `room.harvestPlanner`'s serialized `costMatrix` (~625 B base64) is observed
  (tick+len recorded) then deleted in the same tick to stay under budget;
  **costMatrix persistence is NOT proven**.

## Modes / run commands

```sh
N=~/.local/node22/bin/node
$N e2e/ord/ord.js --mode ord-01          --http-port 32380 --cli-port 32381
$N e2e/ord/ord.js --mode ord-02-true     --http-port 32382 --cli-port 32383
$N e2e/ord/ord.js --mode ord-02-strtrue  --http-port 32384 --cli-port 32385
$N e2e/ord/ord.js --mode ord-02-false    --http-port 32386 --cli-port 32387
$N e2e/ord/ord.js --mode ord-03          --http-port 32388 --cli-port 32389
$N e2e/ord/ord.js --mode ord-04          --http-port 32390 --cli-port 32391
$N e2e/ord/ord.js --mode ord-04-api-dist  --http-port 32392 --cli-port 32393
$N e2e/ord/ord.js --mode ord-04-api-dist2 --http-port 32394 --cli-port 32395
```

Modules uploaded per mode (hashes recorded in every trace frame):

- ORD-01/02 (dist2): `logger resourceManager resources.Resource
  resources.sourceResource resources.creepOrder resources.spawnProcess
  resources.constructionOrder constructionPatterns utils.priority mapPatch`
- ORD-03 (dist): `logger SourceDesc SourceManager CreepPlanner creepUtils
  Manager Consumer Producer CreepOwner room.harvestPlanner`
- ORD-04 (dist): `logger mapPatch SourceDesc room.harvestPlanner
  room.consumptionPlanner room.pathPlanner SpawnPlanner CreepPlanner
  creepUtils EconomyPlanner Manager Consumer Producer CreepOwner`
- ORD-04-api-{dist,dist2}: `mapPatch logger` (files are byte-identical between
  dist and dist2; both runtimes verified anyway)

Note: user code sees `Game.time = frame.gameTime - 1` — the first user tick
runs at Game.time=1, so `%100==1`/`%50==1` self-gates fire at user ticks
1/51/101 (frame times 2/52/102).

## Executed runs

| runId | mode | verdict | notes |
|---|---|---|---|
| `ord01-1793661925566-61420` | ord-01 | PASS | postcondition step 3; all oracles held |
| `ord02true-1793661984782-61680` | ord-02-true | PASS | disabled=true latches, V2 lost on reload |
| `ord02strtrue-1793661989778-61761` | ord-02-strtrue | PASS | string `'true'` treated identically |
| `ord02false-1793661994703-61868` | ord-02-false | PASS | control: V2 persisted normally |
| `ord03-1793662040590-62229` | ord-03 | PASS | planner matrix + spawnCreep verified |
| `ord04-1793662048725-62360` | ord-04 | PASS | 102 steps, periodic boundaries proven |
| `ord04apidist-1793662088720-62744` | ord-04-api-dist | PASS | mapPatch+logger characterizations |
| `ord04apidist2-1793662092479-62832` | ord-04-api-dist2 | PASS | identical results, hashes identical |

Iteration runs (kept for history): `ord01-…58345-61305` FAIL (oracle bug:
missing-field resource has `sourceId` own-prop set to `undefined`, oracle
fixed), two `ord01-…` UNKNOWNs from the 10 KB evidence-limit timeout before
evidence compaction, `ord03-…003243-61958`/`…027726-62114` FAILs (oracle bugs:
mule efficiency is CARRY count not parts count; upgrader const is 100 not 150;
`creepOwner.addCreep` is the production entrypoint, not `manager.addCreep`;
load() restores *saved* freePlaces=0), `ord04apidist`/`dist2` FAILs
(oracle bugs: flat() depth-1 is correct via concat; filter predicates receive
entries; logger level persists via module cache).

## Oracle results (proven)

### ORD-01 — dist2 resourceManager

- apply with `metadata.annotation` → id = annotation (`ord1src`); re-apply
  same annotation + changed spec → same id, no duplicate (count 1), spec
  fields updated (`sourceId` S1→S2), state preserved (creepOrder
  `status='active'`, `creepName`, `expiryTime`, `priority` 5→9 kept).
- `save()` → serialized JSON (toJSON round trip); cache-wiped re-require +
  `load()` reconstructs real class instances — `instanceof`, `toSpec`,
  `matchesAnnotation`, `source` getter (real object) all work.
- `getResourceByField` query = 1; `deleteResource` → true then false;
  deletion persists across the next runtime; other types unaffected.
- `CreepOrder.calculateBodyParts`: 199→null, 200→[move,carry,work],
  300→+[work], 10000→8 parts (maxCost 700 cap, whole sets only).
- Unannotated apply → generated id `source_<gameTime>_<n>`.

### ORD-02 — disabled flag + priority helper

- `disabled` read from `Memory.resourceManager.disabled` at save() time;
  `true` and `'true'` both suppress the write (in-mem V2 spec change NOT
  persisted — absent save entry) and latch `rm.disabled=true`.
- `disabled=false` + `save()` → `this.disabled` cleared, `load()` re-reads
  old Memory (in-mem V2 lost), V1 re-saved. Control (`false`): V2 persisted.
- `PriorityCalculator.calculatePriorityFromId` on real ids verified against
  `floor(parseInt(last6hex,16)*100) - offset` for offsets 0/10; boundary
  inputs `'000001'`→100/90, `'000002'`→200; sort vs fixed
  {40,49,50,51,70,80,1000} desc-correct — real ids land ~1.31e9 (dominate).

### ORD-03 — dist planners + data classes

- `SourceManager` on real S1 (capacity arranged 3000): workPlaces=1,
  freePlaces=1, `needWork=5` (`ceil(cap/300/2)`); S2 same terrain count,
  `needWork=3` (cap 1500). `SourceDesc`: totalPlaces=1, needWork=5,
  `timeTo=32` (real PathFinder cost; fixture BFS distance 20 — engine cost,
  not calibrated), `needCarry` matches formula, `availableCarry()=0` fresh
  and =0 at forced `timeTo=0` (zero-distance case).
- `creepOwner.addCreep(QueuedCreep)` → queued=1, freePlaces−1, hasWork+=eff;
  `run()` moves queued→living on real creep, recomputes hasWork=2/
  freePlaces=0. `save()`/`load()` round trip via `Memory.managers` verified
  (restores saved `freePlaces=0`, resolves living creep names to objects).
- `CreepPlanner.calculateCreep` matrix verified: harvester 0→null,
  150→[m,w]/150/eff1, 300→[m,w,w]/250/eff2; mule 0→null, 150→[c,c,m]/eff2,
  300→2 sets/eff4; upgrader 0/150→null, 300→[m,c,w,w]/300; repairer
  0/150→null, 300→[m,w,c]/200; builder 0/150→null.
- Real `spawnCreep(dryRun)` on Spawn1: `[]`→−10, 51 parts→−10,
  50 unaffordable parts→−6 (length accepted, energy rejected),
  valid computed 250-cost body→0. Budget-0 planner output = null (no body).

### ORD-04 — dormant interfaces

- require-time: `room.pathPlanner` → `ReferenceError: assignMule is not
  defined` (exports `assignMule`, defines `assignPath`) every runtime.
- Abstract interfaces: Manager.load/save/name, Consumer.name/energyNeeded/
  destination/rulesTemplate, Producer.availableEnergy/energyRate/
  rulesTemplate/creepNeeded → `Error('Implementation needed')`; ctor /
  planDelivery / Producer ctor (energyAvailable=0) / ProducerMixin OK.
- `SpawnPlanner.run()` → `TypeError: CreepPlanner.roles.keys is not a
  function` on all 102 ticks (roles is a plain object, `.keys()` invalid).
- `room.harvestPlanner` fired exactly at user ticks 1 and 101
  (`Game.time%100==1`): serialized `costMatrix` observed at both ticks
  (deleted for evidence budget), `srcDescs` rewritten for BOTH sources
  (seed covered S1 only), seeded marker gone at first observed frame.
- `room.consumptionPlanner` fired at user ticks 1/51/101 (`%50==1`): mule
  `dst` transitions `spawn`→(51)`cont`→(101)`spawn`, counters
  spawnMules/upgradeMules transition exactly as derived.
- `EconomyPlanner.run()` writes `room.memory.economy = {}` every tick —
  computed total never stored (baseline characteristic, not desired state).
- Seeded `Memory.flags.f1` untouched by all planners.
- API checks (both dist and dist2 runtimes, identical results):
  `Map.fromObject`/`toObject` work; `Map.toObject` leaks global `result`;
  `Map.filter` predicate receives `[k,v]` entries (value-predicate drops
  all); patched `Array.flat` throws `TypeError` on `[]`, flattens at
  `flat(0)` (native doesn't), matches at depth 1/2 on standard input but
  differs on nested input (`[[[1],[2]]].flat(2)`→`[[1],[2]]` vs native
  `[1,2]` — single-element reduce never calls the callback);
  `logger.setLevel` does NOT persist `Memory.loggerState` (save() only
  creates-if-absent); logger level survives via runner module cache across
  ticks; `logger.load()` restores persisted level; invalid level ignored.

## Defect records

| ID | Contract violated / risk | Reproduction | Expected | Actual |
|---|---|---|---|---|
| ORD-D1 | `Map.prototype.toObject` global pollution | `e2e/ord/ord.js --mode ord-04-api-dist` (also dist2): `new Map().toObject()` then `typeof result` | no global leak | `result` is a global object (assign without var decl) — persists across ticks |
| ORD-D2 | `Map.prototype.filter` predicate signature | `m.filter(v=>v>3)` | value-filter semantics | predicate receives `[k,v]` entries — value-style predicate returns empty map silently |
| ORD-D3 | `Array.prototype.flat` API | `[].flat()` | `[]` | `TypeError: Reduce of empty array with no initial value` |
| ORD-D4 | `Array.prototype.flat` API | `[[1],[2]].flat(0)` | `[[1],[2]]` | `[1,2]` (flattened) |
| ORD-D5 | `Array.prototype.flat` API | `[[[1],[2]]].flat(2)` | `[1,2]` | `[[1],[2]]` (single-element reduce never calls callback) |
| ORD-D6 | module load / public interface | `require('room.pathPlanner')` | module loads | `ReferenceError: assignMule is not defined` (dist/room.pathPlanner.js:11) |
| ORD-D7 | SpawnPlanner.run public call | `SpawnPlanner.run()` in F0 | produces queue or no-ops | `TypeError: CreepPlanner.roles.keys is not a function` every tick |
| ORD-D8 | CreepPlanner body planner | `calculateCreep('builder',300)` | body or null | `RangeError: Invalid array length` (`new Array(0.5)` for MOVE:0.5 ratio) |
| ORD-D9 | RISK: no MAX_CREEP_SIZE cap | `CreepPlanner.calculateCreep('harvester',6000)` / `CreepOrder.calculateBodyParts(6000)` | ≤50 parts or null | 60 parts (cost 5950) — engine rejects at spawnCreep (−10) |
| ORD-D10 | resourceManager unknown-type apply | `applyResource('mystery',{a:1})` twice | defined error or support | first apply stores plain `{id,...}` object; repeat → `TypeError: resource.matchesAnnotation is not a function` |
| ORD-D11 | logger level persistence | `logger.setLevel('warn')`, next runtime | level survives (Memory.loggerState is the documented store) | `setLevel` never writes Memory; survives only via runner module cache — lost on real global reset |
| ORD-D12 | SourceManager.availableEnergy getter | `mgr.availableEnergy` | number | returns `undefined`; mutates `this.energyAvailable` instead (side-effect getter, misnamed) |

Baseline characteristics (recorded, NOT defects): null nested metadata →
`TypeError: Cannot convert undefined or null to object`; missing schema field
tolerated (own prop set to `undefined`); null scalar field tolerated;
economy `{}` written but total never stored; `SourceDesc.update()` tolerates
missing `room.memory.costMatrix`; priority NaN on invalid hex input;
short non-hex-valid ids compute numerically ('ab'→17100).

## Unreachable through dist/main (spec-required list)

- `room.harvestPlanner.run`, `SpawnPlanner.run`, `room.consumptionPlanner.run`
  — required at top of dist/main.js but all calls commented out
  (dist/main.js:15-17). Their transitive deps `SourceDesc`, `CreepPlanner`
  (except via `SpawnManager.queueCreep` → `CreepPlanner.calculateCreep`),
  `EconomyPlanner` (not required anywhere) and `room.pathPlanner` (not
  required anywhere, and unloadable anyway) are dead through main.
- `Manager.load/save/name`, `Consumer.*`, `Producer.*` abstract getters —
  reachable (Manager via RoomManager chain) but only throw.
- dist2 `main.js` reaches everything registered; the `disabled` flag and
  `utils.priority` are only exercised through
  SourceController/RoomController reconciles.

## Harness change requests (not made — e2e/har/**, e2e/server/** read-only)

1. `ScreepsCLI.eval` payloads >`util.inspect.maxStringLength` (10000) are
   silently truncated by server-side `print()` → eval times out with no
   marker. `readFieldSet`/`captureSnapshot` cannot be configured to page the
   read; consider chunking `memoryRaw`/objects reads or raising the marker
   payload budget. Workaround used: keep user Memory ≲3 KB.
2. `captureSnapshot` field-read `timeoutMs` (15000) is not wired to
   `budgets.opTimeoutMs` — no scenario-side override exists.
3. `initialFrame`/capture path assumes `supplemental` is cheap; large
   `rooms.intents`/notifications could hit the same 10 KB limit.

## Limits / not proven

- `costMatrix` field deleted immediately after observation; its persistence
  and downstream consumers unproven.
- Resource `matchesSpec`/`updateSpec` equality semantics exercised only via
  the annotation re-apply path, not exhaustive field-diff coverage.
- ORD-02 `disabled` semantics proven for `true`/`'true'`/`false` only —
  other truthy strings ('1', 'yes') untreated by the `=== 'true'` check and
  untested.
- No multi-room, no hostile objects, no actual spawn-cycle completion (dryRun
  only), no mule/upgrader creep behaviors.
- `Game.time` mapping (user tick = frame gameTime − 1) verified only in this
  packaged engine.
- Quarantined roots under `e2e/server/.runs/` from the early UNKNOWN runs
  need manual cleanup after inspection.
