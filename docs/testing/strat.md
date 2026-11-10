# STRAT suite: isolated-runtime checks of the built artifact (e2e/strat/)

Issue #24 (STRAT-A6). These checks run the bundled strategy artifact
(`build/strategy/main.js` + `manifest.json`, see
[CONTRACTS-A §8–§9](../strategy/CONTRACTS-A.md)) on fresh disposable instances
(`e2e/server/instance.js`, SRV step-mod/preload) and compare it with the
classic flat upload of `dist2/*.js`. The scenarios implement the items listed
under "Проверки до поэтапного допуска" in [INTEGRATION.md](../strategy/INTEGRATION.md)
that can be checked in stage A: load, reset, legacy equivalence and shadow no-op.
The live server `~/screeps`, its world and the spectator instance are not used.
`~/screeps` is read only as the installed-server source and seed `db.json`.

## Files

| File | Contents |
|---|---|
| `e2e/strat/strat.js` | CLI entry: one scenario per `--mode`, artifact and manifest checks, per-run digests, oracles, `oracle.json`/`run.json`/`run.log` |
| `e2e/strat/runner.js` | `runInstance()`: one disposable instance, same admission, gated S(T)→step→S(T+1) loop, core gameTime/ack-sequence assertions and cleanup journal as `e2e/har/harness.js` runScenario. Adds per-tick aux evidence (raw event log, notifications, user CPU row, console) and the reset hook. |
| `e2e/strat/paged.js` | `pagedEval`/`captureSnapshotPaged`: the same field set and coherence checks as `e2e/server/snapshot-client.js` captureSnapshot (ack binding, double read, post-barrier journal scan, TTL, coverage). The result is read in chunks that stay under the 10 000-char `print()` ceiling and are verified by length plus FNV-1a hash. |
| `e2e/strat/fixture.js` | Fixture S1 = HAR F0 + extra actors (below) |
| `e2e/strat/oracles.js` | Pure helpers: id normalisation, Memory diff/structure, resource summaries, duplication invariants, Game-object scan, console/notification/event-log extraction |
| `e2e/strat/oracles.test.js` | Unit tests for the helpers (`node --test`) |

`e2e/server/**` and `e2e/har/**` are used unchanged. The suite does not call
`runScenario()` because that function writes evidence to `e2e/har/.runs` and
reads Memory in one CLI response. Full dist2 Memory reaches about 9 KB raw, which
is roughly 20 KB once it is encoded for the CLI response. A single response that
large is truncated, and the eval then times out with a deterministic UNKNOWN.

## How to run

```sh
export PATH=~/.local/node22/bin:$PATH
npm ci && npm run build:strategy          # build/strategy/main.js + manifest.json
node --test e2e/strat/oracles.test.js     # pure helper tests
node e2e/strat/strat.js --mode load        --port-base 32520   # 1 instance
node e2e/strat/strat.js --mode reset       --port-base 32522   # 4 instances (32522-32529)
node e2e/strat/strat.js --mode legacy-eq   --port-base 32536   # 2 instances (32536-32539)
node e2e/strat/strat.js --mode shadow-noop --port-base 32530   # 3 instances (32530-32535)
```

Options:

- `--artifact PATH --manifest PATH`: the artifact to check. Defaults are
  `build/strategy/{main.js,manifest.json}`. Use these to rerun on a later A5
  artifact.
- `--steps N`: number of gated steps (default 100, minimum 12).
- `--resets 5,10,37,100`: steps before which a reset is forced (RESET mode).
- `--seed-memory FILE`: JSON merged into the initial Memory of every run in
  the mode, for example a shadow control record for the final artifact.
- `--expect-strategy`: every artifact run returns UNKNOWN unless
  `Memory.strategy` appears in some frame. RESET additionally requires the key
  around each reset, together with its `schemaVersion`, `buildId` and
  `revision` fields.
- `--expect-shadow`: implies `--expect-strategy`. SHADOW-NOOP returns UNKNOWN
  unless `Memory.strategyShadow` appears.
- `--wcase-ms N`: wall-clock budget per instance.

Instance k of a mode uses HTTP port `base+2k` and CLI port `base+2k+1`. The
suite refuses ports outside 32520–32539. Instances inside a mode run
sequentially. Different modes can run in parallel when their port ranges do not
overlap. The four bases above are disjoint, so all four modes can run at once.

Exit codes: PASS 0, FAIL 1, BLOCKED 2, UNKNOWN 3. When several conditions
apply, the scenario verdict takes the most severe one:

1. FAIL, an observed violation;
2. UNKNOWN, lost evidence;
3. BLOCKED, refused before stepping;
4. PASS.

All lists (`fail`, `unknown`, `blocked`, `findings`) are always written to
`run.json` and `oracle.json`. If the suite crashes, it still writes
`oracle.json` with UNKNOWN and the reason `suite crash: …`.

## Evidence layout

Evidence is written to `e2e/strat/.runs/<runId>/`, which is git-ignored:

- `run.log`, `run.json`, `oracle.json`: the scenario verdict, the reasons
  behind it, artifact and manifest facts, and the comparison results.
- `<label>/` for each instance: `trace.jsonl` (HAR trace schema v1, every
  frame including the projected objects and Memory), `aux.jsonl` (per step:
  full raw `rooms.objects` rows, raw `roomEventLog` value, notifications, user CPU row, console messages, injected
  events such as resets), `cleanup-journal.jsonl` (HAR format plus
  `code/verify-upload` and `env/seed`), `fixture.json`,
  `fixture-validation.json` and `run.json`.

Server roots are created under `e2e/server/.runs/`. A root is destroyed only
when the instance completed every step and its teardown verified clean.
Otherwise the root is quarantined and its path is reported.

**STRAT deviation from [harness.md](harness.md):** HAR quarantines every
FAIL/UNKNOWN root. STRAT decides the per-instance root technically. An oracle
FAIL or UNKNOWN that is computed after the instances have finished (comparison,
vacuity, console completeness, `--expect-*`) does not quarantine a root whose
run and teardown were clean. The evidence for those verdicts is the trace,
`aux.jsonl` and `oracle.json` under `e2e/strat/.runs/`, not the server DB.

## Fixture S1

S1 is the HAR F0 world, resolved as W9N8: RCL 2, `Spawn1` at (10,10) holding
300/300 energy, S1 `088407718c7f377`, S2 `b8e007718c76b6e`. The following actors
are added before `validateFixture`:

| actor | body / content | Memory (seeded after validation, before step 1) | purpose |
|---|---|---|---|
| `har1` (F0 creep) | move,carry,work | `{role:'harvester', sourceId:S1}` | harvest |
| `mul1` | carry,move, 50 energy | verbatim `mule_spawn_<S1>` order memory from `RoomController` | transfer creep→spawn |
| `upg1` | work,carry,move | `{role:'upgrader'}` | withdraw + upgradeController |
| container | 1000 energy, range 2 of the controller | n/a | withdraw source |
| `bld1` | work,carry,move, 50 energy | `{role:'builder'}` | build |
| road site | owned constructionSite adjacent to `bld1` | n/a | build target |

Every run of a comparison starts from the same bytes. The suite reads the
`users.code` row back after upload and hashes every module (`code/verify-upload`).
Any mismatch, or an extra module, produces UNKNOWN.

## Scenarios and oracles

Common rules for every instance:

- The instance verdict is technical: COMPLETE, BLOCKED or UNKNOWN.
- The scenario verdict is UNKNOWN if any instance is not COMPLETE. This covers a
  lost or late ack, an ack-sequence or gameTime gap, an incoherent snapshot, an
  aux double-read mismatch, a paged-read integrity failure and incomplete cleanup.
- FAIL is raised for any of the following in any frame:
  - an error notification;
  - an uncaught runtime error (console `error`);
  - a console line matching `[ERROR]`, `Error in main loop`,
    `[strategy] ERROR`, `LEGACY_INIT_FAULT`, `TICK_RUNNER_FAULT` or
    `APP_CREATE_FAULT`;
  - a Game-object-like value in Memory (a Room, a RoomObject with
    `pos.roomName` and `room`, a structure, or a creep with `ticksToLive`);
  - a broken duplication invariant: a creepOrder annotation used twice, two
    spawnProcess records for one order, two spawning processes on one spawn,
    or a same-tick legacy id collision.
  - a stray Memory key that starts with `strategy` but is not exactly
    `strategy`, `strategyShadow` or `strategyMigration`. Only those three
    namespaces are excluded from legacy comparisons; a stray key stays inside
    the legacy comparison and is also reported.
- Console evidence must be complete, otherwise the verdict is UNKNOWN. Every
  post-step drain must hold exactly one console message, the pre-step drain
  none, and the collector sequence numbers must run 1..steps without gaps.
  Pubsub is not a journal, so a gap or a late message never counts as absence.
- Legacy initialisation is counted from the console line
  `[DEBUG] Initializing game state...`. An extra or duplicated initialisation is
  FAIL. A missing initialisation line is UNKNOWN.
- A post-step frame whose raw event log is missing or unparseable is UNKNOWN;
  it is never treated as an empty log.
- Comparison modes (reset, legacy-eq, shadow-noop) apply a vacuity guard. A run
  with no spawned creep, no tick with a non-empty `actionLog`, or zero events is
  UNKNOWN, because equality of two idle worlds proves nothing.

Cross-run comparisons map instance ids to symbolic labels: `$spawn:Spawn1`,
`$creep:<name>`, `$source1/2`, `$controller`, `$<type>@x,y@<first gameTime>`
and `$user`. Objects are compared as the full raw `rooms.objects` row, minus
`_id`, `meta` and `$loki`. That covers every engine field: `user`, `store`,
`storeCapacity*`, `hits`, `spawning`, `fatigue`, `ageTime`, `cooldown`,
controller `level`/`progress`/`safeMode`/`safeModeAvailable`/`downgradeTime`/
`reservation`, source energy and regeneration, and `actionLog`.

Diff lists are kept in full; only reports are truncated. A frame-count
mismatch between compared runs is FAIL, as is a diff list that hits the
pathological size guard. Generated dist2 ids `<type>_<Game.time>_<counter>` become
`<type>_<Game.time>_*`, because the counter lives in the heap and restarts on
every reset. A same-tick collision after that normalisation is reported as a
FAIL, so the normalisation cannot hide a duplicate.

### STRAT-LOAD (`--mode load`, 1 instance, artifact)

- Static checks:
  - manifest `output.sha256` and `bytes` equal the file;
  - `screepsModuleName` is `main` and `testBuild` is `false`;
  - the artifact is evaluated in a fresh V8 context whose `Game`, `Memory`,
    `RawMemory` and `PathFinder` getters throw. The top level must touch none
    of them, and `exports.loop` must be a function.
- The uploaded module set is exactly `{main}` and its sha256 equals the
  manifest hash.
- The loop runs legacy on the first tick: `Memory.resourceManager` and
  creepOrders exist after step 1, and `loggerState` is present.
- Legacy actually executes: `SpawnController` spawns at least one creep in the
  window.
- Initialisation happens exactly once, at step 1. The common error checks apply.

### STRAT-RESET (`--mode reset`, 4 instances)

- A global reset is forced before steps 5, 10, 37 and 100 by bumping the
  `users.code.timestamp` of the unchanged modules, which amounts to a
  re-upload of the same code. The runtime then clears the user isolate
  (`driver/lib/runtime/user-vm.js:23`, `codeTimestamp >` cached value) and
  rebuilds `require.cache` (`engine/src/game/game.js:504-511`).
- The four runs are `artifact-control`, `artifact-reset`, `baseline-control`
  (flat dist2, no reset) and `baseline-reset` (flat dist2, same schedule).
- Oracles:
  1. Each reset takes effect: legacy initialises at steps {1,5,10,37,100} in
     both reset runs and only at {1} in both controls.
  2. The duplication invariants and error checks hold in every frame of all
     four runs.
  3. The artifact matches flat dist2 under resets: `artifact-reset` equals
     `baseline-reset`, and `artifact-control` equals `baseline-control`, per
     tick, with equal frame counts. The comparison covers normalised legacy
     Memory, resources by type/id/status and full raw object rows.
  4. The reset effect (control vs reset) is identical in both trees.
  5. Spawned creeps are equal in all four runs.
  6. `Memory.strategy` identity across each reset (frame s−1 → s):
     - the key is not lost and does not appear only after the reset;
     - `schemaVersion`, `buildId` and `revision` are present, the first two
       unchanged, `revision` monotonic;
     - `control` and `migrations` are unchanged.

     If the key is absent around every reset, the result is a finding
     ("not applicable"), or UNKNOWN under `--expect-strategy`. The suite also
     reports the per-tick `Memory.strategy` difference between artifact-control
     and artifact-reset (`strategyControlVsReset`).

### STRAT-LEGACY-EQ (`--mode legacy-eq`, 2 instances: baseline flat dist2, artifact)

Oracles, compared per tick over the same window:

- the structure of legacy Memory (key paths and leaf types, outside the three
  strategy namespaces);
- resourceManager resources by type, id and status;
- spawned creeps: name, body, role and first frame;
- per-tick action types for each object (`actionLog` keys);
- the artifact adds no top-level Memory keys outside the three namespaces;
- frame counts are equal.

Value, object and event-log differences are reported as findings, not as FAIL,
unless frame counts differ. Expected
difference: the artifact initialises legacy in its first `loop()` instead of
at `require`, which is the same tick with the same Game/Memory. In both trees
the initialisation line appears in the step 1 console.

### STRAT-SHADOW-NOOP (`--mode shadow-noop`, 3 instances: baseline, artifact, baseline2)

Oracles, compared per tick:

- legacy Memory values outside `strategy`, `strategyShadow` and
  `strategyMigration` are identical;
- full raw room object rows, including `actionLog`, are identical; this is the
  intents/effects proxy;
- raw room event logs are identical;
- spawned creeps are equal;
- the artifact adds no non-strategy top-level keys.

A difference is masked only when two conditions hold:

- the same path at the same tick also differs between baseline and baseline2;
- the artifact's value at that path equals baseline2's value, meaning the
  artifact reproduced another observed legacy outcome.

That calibration pair is how documented legacy nondeterminism is defined.
Frame-count mismatches are FAIL, and a truncated calibration is UNKNOWN. When `--expect-shadow` is given and
`Memory.strategyShadow` never appears, the verdict is UNKNOWN, because a no-op
check against an inactive shadow proves nothing.

The scenario also records event-log evidence for A3: counts by type, transfer
directions, examples with amounts, and the event types present on spawn ticks.
On the A0 artifact this mode serves as the baseline check, since A0 has no
shadow components.

## Executed runs (A0 artifact, 2026-11-08/09, suite version before review)

These runs used the suite as it stood before the review fixes. The fixes
include exact strategy namespaces, full raw object rows, full-diff masking,
console completeness and the vacuity guards. The final suite was re-executed
on the master artifact, see the next section.

The artifact is `build/strategy/main.js`, buildId `b-e6370259106c5ea6`, sha256
`4ce52524268cafd2906dff827262221f26a23d2d8f31a8f759c14ac2e45e617f`, 243 809
bytes, contract A.2, schemaVersion 1, 38 bundled modules, `testBuild:false`. It
was built from master `c9aba7c`. The baseline is 22 `dist2/*.js` modules
(everything except `mock-game.js`). The seed is the packaged `db.json`. All
runs used 100 steps (gameTime 1→101).

| runId | mode | verdict | key numbers |
|---|---|---|---|
| `strat-load-1794116514332-3276062` | load (`--steps 15` smoke) | PASS | development smoke only; 15 steps, 26 s |
| `strat-load-1794116554707-3277164` | load | PASS | static load ok (loop=function, no Game/Memory touched); uploaded {main} sha = manifest; step 1: resourceManager + 9 creepOrders + loggerState; first legacy spawn `harvester_088407718c7f377_0` [m,c,w,w] seen at gameTime 11; 1 init (step 1); 100 console messages, 0 error lines/notifications; max Memory 8 975 B; 140 s |
| `strat-reset-1794116562835-3277736` | reset, first suite version (2 instances) | **FAIL**, superseded by a corrected oracle (see below) | legacy Memory/resources differed from the no-reset control at 95 ticks from gameTime 6 (`mule_build_<source>` orders); objects 0 diff; spawned creeps equal; inits [1,5,10,37,100] |
| `strat-reset-1794133878806-3597957` | reset (4 instances) | PASS | inits {1,5,10,37,100} in both reset runs, {1} in both controls; artifact-reset vs baseline-reset and artifact-control vs baseline-control: 0 diff ticks (Memory, resources, objects); reset effect 95 ticks in both trees and identical; 0 duplication/Game-ref/error findings; final resources 6 constructionOrder / 11 creepOrder / 2 source / 0 spawnProcess in all four runs |
| `strat-reset-1794177767707-214385` | reset (4 instances, repeat on final suite code) | PASS | same result as the previous run: inits {1,5,10,37,100} / {1}; artifact vs flat dist2 0 diff ticks in both reset and control; identical 95-tick reset effect; all clean |
| `strat-legacy-eq-1794116562926-3277738` | legacy-eq | PASS | 0 diff ticks for structure, values, resources, action types, objects and event logs; same single spawned creep; init at step 1 in both; no extra non-strategy keys; no `strategy*` keys (A0) |
| `strat-shadow-noop-1794116562980-3277737` | shadow-noop (A0 baseline check) | PASS | baseline vs baseline2: 0 diff ticks, so the window is fully deterministic; artifact residual: 0 value / 0 object / 0 event diff ticks; no `strategyShadow` (expected for A0) |

All instances completed 100/100 steps, each taking roughly 140–150 s. Every
instance root was destroyed after a clean teardown verification. None were
quarantined, and `e2e/server/.runs/` of this worktree is empty after the runs.

### Why the first RESET run failed

The FAIL comes from the suite's oracle, not from the artifact.

The first version of the RESET scenario demanded that the reset run equal the
no-reset control tick for tick. That demand is stricter than the brief, which
only requires no duplicated orders or spawn processes. It is also wrong for
dist2: dist2 itself behaves differently after a reset. In `dist2/main.js`, and
identically in the LegacyAdapter, `BuildController.initialize()` runs before
`SourceController.initialize()`. The flow is:

1. On a cold start, Memory holds no `source` resources when `BuildController`
   runs, so the per-source `mule_build_<sourceId>` creepOrders
   (`dist2/BuildController.js:50-61`) are skipped.
2. On a reset, `resourceManager.load()` restores the sources first, so
   `initialize()` creates `mule_build_$source1` and `mule_build_$source2`.
3. The no-reset control only creates them at the `Game.time % 100` reconcile.

These are two new distinct orders, not duplicates. No duplication invariant was
broken in that run.

The corrected scenario adds flat-dist2 control and reset runs with the same
reset schedule. In two reruns on the final suite code (`…1794133878806…`,
`…1794177767707…`), flat dist2 showed the same 95-tick difference as
the artifact, path for path, and the artifact matched dist2 exactly in both the
reset and control runs. The first run is therefore classified as a suite defect
(the oracle confused legacy reset sensitivity with an artifact difference). It
is not an artifact behaviour. The artifact reproduces dist2's reset behaviour
exactly.

## Executed runs (master `fae9b2e` artifact, final suite, 2026-11-09)

The artifact was built outside the repository checkout: `git archive
origin/master | tar -x -C /tmp/strat-master`, then `npm ci && npm run
build:strategy` there. Facts:

- buildId `b-249182e8917c90e2`;
- sha256 `02906bd4443ac9e82571c0a92abb1460f2ae89cbba0a0f5961525a9e939a0bcb`;
- 353 496 bytes, 47 bundled modules, `testBuild:false`;
- `stageA.js` wires the A1 Reader and the A2 StateStore, with `components: []`;
- the master `dist2/` is byte-identical to the baseline used here.

All four modes ran in parallel on disjoint ports: load 32520, reset 32522,
shadow-noop 32530, legacy-eq 32536. The command for each mode was:

```sh
node e2e/strat/strat.js --mode <mode> --port-base <base> \
  --artifact /tmp/strat-master/build/strategy/main.js --manifest /tmp/strat-master/build/strategy/manifest.json [--expect-strategy]
```

| runId | mode | flags | verdict | key numbers |
|---|---|---|---|---|
| `strat-load-1794178709272-234621` | load | `--expect-strategy` | UNKNOWN | the only reason is `Memory.strategy absent in every frame`; no FAIL |
| `strat-reset-1794178709281-234622` | reset | `--expect-strategy` | UNKNOWN | the only reasons are the strategy absence (2 artifact runs plus identity unproven); no FAIL |
| `strat-legacy-eq-1794178709276-234623` | legacy-eq | `--expect-strategy` | UNKNOWN | the only reason is the strategy absence; no FAIL |
| `strat-shadow-noop-1794178709276-234624` | shadow-noop | `--expect-strategy` | UNKNOWN | the only reason is the strategy absence; no FAIL; residual 0/0/0, calibration 0/0/0 |
| `strat-load-1794179306673-248432` | load | none | PASS | uploaded `{main}` sha = manifest = file; static load ok; step 1 resourceManager + 9 creepOrders + loggerState; first spawn at gameTime 11; console 100/100 complete; 1 init; activity 1 spawn / 99 action ticks / 197 events; no strategy namespace written |
| `strat-reset-1794179306706-248433` | reset | none | PASS | inits {1,5,10,37,100} in both reset runs, {1} in both controls; console complete in all 4; artifact vs flat dist2: 0 diff ticks (Memory, resources, full object rows) in both reset and control; reset effect 95 ticks, identical in both trees; strategy identity `absent` at all 4 resets; strategyControlVsReset 0 ticks |
| `strat-legacy-eq-1794179306716-248435` | legacy-eq | none | PASS | 0 diff ticks for structure, values, resources, action types, full object rows and event logs; equal frame counts; same spawned creep |
| `strat-shadow-noop-1794179306714-248434` | shadow-noop | none | PASS | calibration baseline vs baseline2: 0/0/0 diff ticks (values/objects/events); residual 0 with 0 masked; no `strategyShadow`; event counts identical to A0 (HARVEST 86, TRANSFER 4, BUILD 10, UPGRADE_CONTROLLER 97) |

All 18 instances were destroyed after a clean teardown verification. None were
quarantined, and `e2e/server/.runs/` is empty.

**Memory.strategy behaviour on `fae9b2e`.** No `strategy`, `strategyShadow` or
`strategyMigration` key, and no stray `strategy*` key, appeared in any frame of
any artifact run, with or without resets. This is the documented StateStore
contract, not a defect. The StateStore header (`src/bot/state/StateStore.js`)
says: "namespace absent -> empty schema1 in the session (written lazily on the
first accepted write or checkpoint, so a read-only tick writes nothing)". With
`components: []` and no checkpoint caller, nothing writes.

Consequences:

- The `--expect-strategy` runs are UNKNOWN by construction. They were kept as
  proof that the guard does not pass vacuously.
- The reset identity oracle is still not applicable, so persistence of
  `Memory.strategy` across resets remains unproven.
- Wiring the A1 Reader and A2 StateStore caused no observable difference from
  flat dist2: Memory size was 8 975 B for both (9 132 B in the reset runs, for
  both trees), with identical objects, actions and event logs.

## Executed runs (final A5 shadow artifact, 2026-11-10, coordinator)

Artifact: branch `autonomy/issue-25` (STRAT-A5 after independent review fixes), buildId `b-b5b7b3891cc31ff1`, `main.js` sha256 `8c38b061…2617`, contract A.4, 61 modules. Seed (`--seed-memory`): `Memory.strategy` schema1 with `control.rooms.W9N8 = {requestedMode: 'shadow', effectiveOwner: 'legacy', epoch: 0, …}` applied symmetrically to baseline and artifact runs (dist2 ignores it). 100 steps each; all instances destroyed after verified teardown.

| run id | mode | flags | verdict |
|---|---|---|---|
| `strat-load-1794296954391-2532277` | load | `--expect-strategy` | PASS |
| `strat-shadow-noop-1794296954411-2532278` | shadow-noop | `--expect-shadow` | PASS |
| `strat-legacy-eq-1794296954393-2532279` | legacy-eq | `--expect-strategy` | PASS |
| `strat-reset-1794296954399-2532280` | reset | `--expect-strategy` | PASS |

- SHADOW-NOOP: legacy Memory (all keys except `strategy`, `strategyShadow`, `strategyMigration`), full object rows/action logs and raw event logs identical between flat dist2 and the shadow artifact (calibration baseline vs baseline2: no differences). Shadow actually ran: at gameTime 101 `strategyShadow.rooms.W9N8` held 4 decision records, a closed flow window, a forecast summary and 5 observed bindings; `strategy.lastClosedTick = 100`, revision 111, no component faults.
- RESET findings (not failures): (1) the known dist2 reset sensitivity (`mule_build` orders), identical in flat dist2; (2) `Memory.strategy` differs between the artifact's reset and no-reset runs from gameTime 2 (`recentPatchIds`, `revision`): after a reset the previous snapshot is gone, so reconcile records an UNKNOWN/EVENT_GAP delta and the forecast cache is recomputed — expected, see SHADOW-A.md. Identity fields (`schemaVersion`, `buildId`, non-decreasing `revision`, unchanged `control`/`migrations`) held across all resets.
- A pre-fix A5 artifact (`b-003544fc5aa70751`) gave the same four PASS verdicts (`strat-load-1794213111381-904309`, `strat-shadow-noop-1794213320200-909181`, `strat-legacy-eq-1794213320222-909182`, `strat-reset-1794213320228-909183`).
- Not measured here: CPU on the server runtime per tick (the suite does not record per-tick CPU of the strategy code).

## Executed runs (STRAT-VIEW artifact with overlay, 2026-11-11, coordinator)

Artifact `b-f153c080e0fca6df` (contract A.5, presenter), seed = shadow control for W9N8 plus `Memory.strategyView = {rooms:{W9N8:{overlay:true}}, console:true}`. First run FAILed only because the oracle did not know the new operator namespace `strategyView` (seeded into both baseline and artifact); it is now in the exact allowed set. Rerun: `strat-shadow-noop-1794352539706-3627120` PASS (`--expect-shadow`), `strat-legacy-eq-1794352539703-3627121` PASS — overlay/console leave legacy Memory, objects, action logs and event logs identical to flat dist2.

## Findings

1. **Load.** The artifact loads as the single module `main`, exports `loop`,
   touches no Game/Memory at require time, and initialises legacy on the first
   `loop()`. This is the same tick as dist2's require-time initialisation, and
   on A0 there is no observable difference in Memory, objects, actions or
   events over 100 ticks.
2. **Legacy reset sensitivity (dist2 defect, carried over unchanged).** Every
   global reset re-runs all `initialize()` paths. Because of the init order, a
   reset creates the `mule_build_*` orders earlier than a cold start does.
   Order counts converge at the tick-100 reconcile. Behaviour is therefore
   reset-history dependent, but no duplication was observed: annotations dedupe
   orders, and the heap id counter restarting only renames `spawnProcess_<T>_<n>`
   ids. Any later reset or shadow work must not treat "Memory differs from the
   no-reset path" as an error.
3. **Determinism.** Two flat-dist2 runs on fresh instances were identical over
   100 ticks: Memory values, objects, actionLog and event logs. With S1 there
   was no legacy nondeterminism to calibrate away.
4. **Legacy activity in the window.** Only one creep is spawned
   (`harvester_<S1>_0` at Game.time 10, appearing at frame gameTime 11). The
   spawn then waits for energy. `spawnProcess` is 0 at the end. There are 9
   creepOrders from step 1 to Game.time 99, and the 2 `mule_build_*` orders
   are added by the Game.time 100 reconcile (11 at the end). dist2 creates no
   construction sites (known BuildController defects, see `e2e/README.md`); the
   `Unknown pattern type: path` debug lines come from that code.

### Event-log facts for A3

Source: raw `roomEventLog:<room>` env hash value per post-step frame. Frame
gameTime G holds the events of processing tick G−1, which is what
`room.getEventLog()` returns at Game.time G. Counts over the artifact run of
STRAT-SHADOW-NOOP were identical in both baseline runs:

| type | count | example (normalised) |
|---|---|---|
| `EVENT_HARVEST` (5) | 86 | `objectId:$creep:har1, data:{targetId:$source1, amount:2}`: 1 WORK yields 2 |
| `EVENT_TRANSFER` (12) | 4 | creep→spawn: `objectId:$creep:mul1, targetId:$spawn, amount:50`; withdraw: `objectId:$container, targetId:$creep:upg1, amount:50` |
| `EVENT_BUILD` (4) | 10 | `objectId:$creep:bld1, data:{targetId:$site, amount:5, structureType:'road', x, y, incomplete:true}`: amount equals energy spent (5 per WORK) |
| `EVENT_UPGRADE_CONTROLLER` (9) | 97 | `objectId:$creep:upg1, data:{amount:1, energySpent:1}` |

- **Withdraw has no event type of its own.** The engine logs it as
  `EVENT_TRANSFER` with the direction reversed: `objectId` is the structure
  giving energy and `targetId` is the creep (`engine/src/processor/intents/creeps/withdraw.js:59`).
  A3 must read direction from object types, not from the event type.
  Transfer directions seen: `$creep→$spawn` ×2 and `$container→$creep` ×2.
- **There is no spawn event.** The engine constants contain no `EVENT_SPAWN`
  (events 1–12 only). The spawn-tick frame (gameTime 11) carried only
  `UPGRADE_CONTROLLER` and `BUILD`. Spawning is visible only through objects:
  a new creep row with `spawning`, and the change in spawn store or
  `energyAvailable`.
- **Pickup produces no event.** No pickup event was found in the engine. Mule
  ground pickup is therefore invisible in the event log.
- Unknown event types: 0. Parse errors: 0. The pre-step frame has no log yet
  (counted once as missing).

## Limits / not proven

- One fixture and one room, 100 ticks, A0 artifact only. Resets were tested at
  steps 5, 10, 37 and 100. Each reset lands between ticks: phases inside the
  artifact's tick cannot be interrupted from the CLI. Mid-tick resets (CPU kill
  or exception inside a phase) are not covered.
- Intents are compared through post-processing `actionLog`, object state and
  event logs. `rooms.intents` is consumed by the processor before the barrier,
  so raw intents are not read. A rejected intent that leaves no trace would go
  unseen.
- In this window dist2 exercised only one spawn and no spawnProcess
  completion→active transition with a live order. Duplication of spawn
  processes during an in-flight spawn (a reset at Game.time 10–11) was covered
  only by the reset at step 10 (Game.time 10, the spawn tick).
- Console capture uses pubsub, which is not a journal. Completeness (one
  message per step, contiguous sequence) is enforced, and any gap makes the
  verdict UNKNOWN. Error detection relies on console patterns and
  notifications. Silent logical errors are found only through cross-run
  comparison.
- The Game-object detector is a heuristic, covering Room, RoomObject with
  `pos.roomName`+`room`, structures and creeps.
- **SHADOW-NOOP on A0 and `fae9b2e` is only a baseline check.** Neither artifact
  writes strategy state. Rerun on the A5 artifact with `--expect-shadow` (which
  implies `--expect-strategy`). Add `--seed-memory` holding the shadow control
  record in the shape A2 accepts, if the room mode has to be seeded. Until
  then, the namespace exclusion, the stray-key check against real writers and
  the reset identity oracle are exercised only by unit tests.
- Instances whose post-run oracle FAILs are still destroyed; see the STRAT
  deviation under "Evidence layout".
