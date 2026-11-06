# Quiescence / fault / overhead probes (E2E-SRV)

Research evidence only. None of these probes admits the step gate for HAR or
scenario tests; `tick-protocol.md` stays at admission BLOCKED. Every probe uses
only `createIsolatedServer` (e2e/server/instance.js), dedicated ports in
32320–32339, a fresh runId under `e2e/server/.runs/`, and honors the contract:
`assertIdentity`, `stop()`+`destroy()` on PASS, quarantine (dir left in place)
on FAIL/UNKNOWN. The live server (21025/21026) is never touched.

**Execution status: EXECUTED 2026-11-02 (coordinator run).** The delegated
session had no exec permission; the coordinator ran all probes itself.
Fixes applied during verification: compact CLI evals (sandbox `print` runs
`util.inspect` — payloads >~10K chars are truncated before the end marker and
time out), `keepCron`/`seedEnv` factory options, `cron-tolerant-mod.js` control,
fault-file retarget in hold-probe. Real verdicts:

- cron-probe **PASS** (disabled `cron-neg-1793635884663-18458`: marker+backend pid, zero cron log lines, zero DB diffs across startup+hold, prepared trigger untouched, `runCronjob` refused "not found"; control `cron-ctl-1793635894803-18458`: all 11 stock jobs fired, W6N5 activated, deposit/invaderCore/rampart objects created, `runCronjob` OK). **Environmental defect:** fresh packaged seed leaves `env.activeRooms` absent even after the logged v9 migration (persisted env has `databaseVersion:9`, no key) → `roomsForceUpdate`/`genInvaders` send `{_id:{$nin:undefined}}` → `{_id:{}}` → lokijs "fun is not a function" → unhandled rejection → backend crash-loop (captured by DIAG mod on `cron-ctl-1793631764324-8713`).
- env-expiry-probe **PASS** (`env-expiry-1793635584129-17362`): all field-set keys (`gameTime`, `activeRooms`, `memory:<uid>`, `tickRate`, `mainLoopPaused`, `accessibleRooms`, `roomStatusData`, `terrainData`) TTL −1, no expiry doc entries on disk; scratch `setex` keys expired correctly.
- restart-probe **EXPECTED-UNKNOWN** (`restart-1793635648727-17664`): killed runner → step rejected, client poisoned, gameTime frozen, epoch change detected; launcher restarted the process 11×, each failing closed `exit 78` on stale participant `wx` registration.
- hold-probe **PARTIAL** (`hold-1793635998474-18721`): 30s and 60s inter-step holds PASS — gameTime frozen, zero resets, subsequent steps complete with correct sequence/time. Fault calibration FAIL: `access-rooms-fault.json` 6500ms did not engage (step ~1.1s); coverage shows `envWrapped:[]`/`dbWrapped:{}` in every process — detached-writer wraps don't intercept (likely destructured call sites); activate-fault never engages on pre-active rooms either. **Superseded by `hold-1793658484572-48702` (PASS, expected calibration UNKNOWN)** after the journal rework (see "2026-11 journal rework" below): same holds PASS, and the 6500 ms access-rooms fault now engages the real wrapped writer, fires the in-cycle watchdog (`Main loop reset!` ×1), yields ack-3 `resetDuringCycle:true`/`status:unknown`, step rejected, controller poisoned.
- overhead-probe **PARTIAL** (`ovh-gated-1793636008521-18800` gated PASS: 8 steps, latency 0.28–1.03s, 96 jiffies/10s hold across launcher/storage/backend/engine processes; baseline `ovh-base-1793636027637-18800` UNKNOWN — ungated stock cron hit the crash-loop above, eval died with backend).

Original BLOCKED-era expected-verdict text follows for probe design rationale.
Commands:

```sh
~/.local/node22/bin/node e2e/server/cron-probe.js
~/.local/node22/bin/node e2e/server/env-expiry-probe.js
~/.local/node22/bin/node e2e/server/restart-probe.js
~/.local/node22/bin/node e2e/server/hold-probe.js
~/.local/node22/bin/node e2e/server/overhead-probe.js
```

## cron-probe.js — backend-cron disabler (ports 32320–32323)

Two sequential factory instances in one run.

- **Negative (32320/32321, `cron-neg-*`)**: `step-mod.js` + `step-preload.js`,
  default env ⇒ `cronDisabled=true`. Verified:
  - `step-backend-cron-disabled.json` readback `{pid, runId, cronDisabled:true}`;
    `/proc/<pid>/cmdline` contains `@screeps/backend` and its cwd is the run
    root — proves the disabler ran inside the real backend process.
  - Prepared trigger: seed rooms lack `nextForceUpdateTime`, so
    `roomsForceUpdate` (cronjobs.js:178-192, `gameTime >= nextForceUpdateTime`
    or missing) would activate rooms on the first 1s cron tick. One room is
    explicitly set to `nextForceUpdateTime: 0`; the pre-hold diff window must
    contain *only* that write (`onlyPreparedDiffBeforeHold`).
  - 8s hold (≥7 cron ticks): zero diffs in `rooms.objects`, room cron fields
    (`invaderGoal`, `powerBankTime`, `nextNpcMarketOrder`,
    `nextForceUpdateTime`) and `activeRooms`; zero `Running cronjob` lines in
    the *entire* `backend.log` — this also covers requirement (d): the mod
    runs at `configManager.load` (backend/lib/index.js:14) strictly before
    `setInterval(cronjobs.run, 1000)` (index.js:20), so no in-flight stock job
    can exist; the startup+hold window shows zero cron writes.
  - `system.runCronjob('roomsForceUpdate')` must be refused; exact expected
    response is rejection `Cronjob "roomsForceUpdate" not found`
    (cli/system.js:46-48) — recorded verbatim either way; a post-call snapshot
    must show no writes.
  - mods.json contents + SHA-256 of mods.json and every listed mod file are
    stored in `probe-cron-mods.json`. **Limitation:** an unknown extra mod
    could add or replace cron jobs; the hash record only proves what ran here.
- **Control (32322/32323, `cron-ctl-*`)**: no step-mod, no preload — stock
  `config.cronjobs` stays populated. NOTE: the factory cannot forward
  `SCREEPS_E2E_KEEP_CRON=1` into the child env (spawn env is fixed), so a
  modless instance is the equivalent enabled-cron control. Expect `Running
  cronjob '<name>'` lines within ~1s of backend start plus observable effects
  (non-empty `activeRooms`, room cron fields set, non-seed object types).
  `system.runCronjob` should return `OK`.
- Artifacts in run dir: `probe-cron-mods.json`, `probe-cron-marker.json`,
  `probe-cron-snapshot-{neg,ctl}.json`, `probe-cron-evidence-{neg,ctl}.json`,
  `probe-cron-backend-{neg,ctl}.log`. **Expected verdict: PASS.**

## env-expiry-probe.js — env key expiry (ports 32324/32325)

Gated instance (frozen `gameTime` ⇒ nothing rewrites the keys during the hold,
so persistence proves absence of expiry rather than refresh).

- Method for the `ttl == -1` ambiguity (db.js:614-628 returns -1 both for "no
  expiration record" and "deadline already passed"): `storage.env.ttl(key)`
  is recorded but *not* treated as proof. Proof is threefold:
  1. Control keys — `setex('e2e-expiry-scratch',5)` and `expire(...,4)` —
     must actually disappear inside the hold, demonstrating the 10s purge
     cycle (db.js:295-315) and the observation window work;
  2. all mandatory keys still readable after a 25s hold (≥2 purge cycles):
     `gameTime` (unchanged value), `memory:<userId>`, `activeRooms`
     (contains the user's room), plus fixture keys `accessibleRooms`,
     `roomStatusData`, `mainLoopPaused`, `tickRate`,
     `memorySegments:<userId>`;
  3. `db.json` Loki readback: env collection `$loki:1` = values doc,
     `$loki:2` = expiration doc (`data[name] = absolute ms deadline`,
     db.js:582-600). No mandatory key may appear in the expiration doc.
     Autosave lag ≤10s < hold length; torn reads retried.
- Queue-related keys: none exist. users/rooms queues are in-memory in the
  storage process (RPC `queueFetch`/`queueAdd`/..., storage/lib/queue.js);
  `tickStarted`/`roomsDone`/`queueDone:` are pubsub channels, not env keys.
  Documented, not probed.
- Artifacts: `probe-expiry-evidence.json`, `probe-expiry-envdoc.json`.
  **Expected verdict: PASS.**

## restart-probe.js — process-loss fault (ports 32326/32327)

Gated instance, `StepClient.connect`, then SIGKILL the **runner** during a
hold. Kill safety: the victim pid is taken from `step-participant-runner.json`,
its recorded `start` must match `/proc/<pid>/stat`, its cwd must be the run
root, and its process-group leader's cwd must be the run root (the leader is
the launcher — never killed).

- Expected: the next `step()` rejects (recorded participant pid is dead →
  `epoch()` read fails → `participants()` throws → client poisons
  `step-control/poisoned.json`), `gate.failed === true`, no `command-N.json`
  was published, `gameTime` unchanged.
- Launcher restart behavior (start.js:143-149 restarts any exited child after
  ~1s): the restarted runner re-runs mods, hits the `wx` participant file and
  exits 78 → an observable crash loop, recorded from `launcher.log`
  (`exited with code … restarting` lines), transient runner pids sharing the
  run root cwd, and `logs/engine_runner1.log` tail. After restart the
  recorded epoch necessarily differs from any live participant:
  `integrity.participants(root, baseline)` must keep throwing (recorded).
- The instance is stopped and **always quarantined** (poisoned by design).
- Artifacts: `probe-restart-evidence.json` (timeline, launcher lines, log
  tails). **Expected verdict: EXPECTED-UNKNOWN** (probe PASS criterion is
  that every check failed closed).

## hold-probe.js — long inter-step holds (ports 32328/32329)

Previously only 6.5s holds were tested. The watchdog `setInterval` is armed
*inside* `loop()` (engine/dist/main.js:22-26) and cleared in the loop's
`.finally()` (~line 90), so no watchdog exists while the gate parks the
scheduler between loops — verified empirically:

- 30s hold before the first command, then `step()` → sequence 1, `gameTime`+1;
- 60s hold between steps, then `step()` → sequence 2, `gameTime`+1 again.
  During each hold `gameTime` is sampled every ≤5s and `Main loop reset!`
  occurrences in `engine_main.log` are counted; both must stay flat.
- Calibration (not a defect): `step-control/activate-fault.json`
  `{delayMs:6500}` > `mainLoopResetInterval` (5000, driver/lib/index.js:22)
  during a step must fire the in-cycle watchdog → `queue.resetAll` →
  `resetDuringCycle` → `ack-3.json` status `unknown` → `step()` rejects →
  poisoned. The ack file is read back and recorded.
- Instance quarantined after the deliberate fault. Artifacts:
  `probe-hold-evidence.json`, `probe-hold-engine-main-tail.txt`.
  **Expected verdict: PASS (with expected calibration UNKNOWN).**

## overhead-probe.js — CPU/latency measurement (ports 32330–32333)

**Measurement only — explicitly not a coherence proof.**

- Gated (32330/32331, `ovh-gated-*`): wall latency per `step()` (8 default,
  `--steps N`), and CPU = `utime+stime` jiffies from `/proc/<pid>/stat`
  (fields 14-15; ~100 jiffies/s) summed over all processes whose `/proc` cwd
  is the run root, classified as launcher/storage/backend/engine_main/
  engine_runner/engine_processor. Also CPU during a 10s parked hold.
- Baseline (32332/32333, `ovh-base-*`): modless instance, normal free-running
  tick loop; `system.setTickDuration(500)` (sets env `tickRate` + pubsub,
  cli/system.js:61-71) then a 20s window measuring `gameTime` advance rate
  and the same per-process CPU.
- **Known asymmetry, reported not hidden:** the baseline runs fully stock —
  backend cron is enabled and will write/activate rooms, inflating its CPU
  versus the cron-disabled gated instance. Empty-world steps also understate
  real load. Jiffies deltas only count pids alive in both samples.
- Artifacts: `probe-overhead-gated.json`, `probe-overhead-baseline.json`.
  **Expected verdict: PASS = measurements collected; numbers go in this doc
  after the first real run.**

## Verdicts

| Probe | Run IDs | Verdict |
|---|---|---|
| cron-probe | (not run this session) | BLOCKED — expected PASS |
| env-expiry-probe | (not run this session) | BLOCKED — expected PASS |
| restart-probe | (not run this session) | BLOCKED — expected EXPECTED-UNKNOWN |
| hold-probe | (not run this session) | BLOCKED — expected PASS + calibration UNKNOWN |
| overhead-probe | (not run this session) | BLOCKED — measurement only |

## 2026-11 journal rework (detached-writer coverage fix)

The storage-write journal moved to `RpcClient.prototype.request`
(common/lib/rpc.js:125), armed at mod load before `storage._connect()` in
every process — the old facade-wrap armed on empty `env={keys}`/`db={}`
objects and silently wrapped nothing (`resolved:true` with zero methods).
Detached writers are now wrapped by whitelist (processor `activateRoom`,
`history.saveTick`/`upload`, `roomsStatsSave`; runner `sendConsoleMessages`/
`sendConsoleError`/`sendNotification`; main `activateRoom`,
`updateAccessibleRoomsList`, `updateRoomStatusData`) — the regex sweep
promisified the sync factory `getRoomStatsUpdater` and broke room
processing. Ack `gameTime` is bound by wrapping `driver.incrementGameTime`.
New/updated constraints these probes now rely on:

- **gameTime > lastUpdate + 20 gate** (engine/dist/main.js:79): the two main
  writers only run spontaneously from tick ~21. A present
  `access-rooms-fault.json`/`room-status-fault.json` makes the mod invoke the
  real wrapped writer at the `incrementGameTime` stage (journaled, drained)
  — fault coverage below tick 21 is this forced path only; spontaneous
  writer behavior at tick ≥21 remains unprobed.
- **delayMs > 5000 can never produce a stretched ack**: the in-cycle
  watchdog (`mainLoopResetInterval`) fires `queue.resetAll` first →
  `resetDuringCycle` → ack `unknown`. Only `delayMs` < 5000 exercises the
  drain-as-delay path (observed ~1.6s for 1200 ms faults).
- **Rejected writers stay in the drain set**: a reject that settles before
  the drain snapshot is still observed (fail closed → UNKNOWN + poison).
  A storage-mutation rejection in a healthy run would wedge subsequent
  drains — deliberate, but watch for false positives.
- **Drain tracking covers mutations and queue writes only** — `queueFetch`/
  `queueWhenAllDone` long-polls are journaled but not drain-tracked (a
  parked fetch in the drain set deadlocked markDone once: processor.js does
  not await its detached `processRoom→markDone` chain before the next
  `fetch`). `runner_threads` must remain 1.

Real run IDs for the rework: `snapshot-basic-1793658477254-48590` (PASS, 3
bound coherent snapshots), `snapshot-negative-1793658318635-46658`
(expected-detection), `snapshot-fault-*-47794` (9/9: 5 observed-delay, 4
unknown-quarantined), `hold-1793658484572-48702` (PASS + calibration
UNKNOWN), step-selftest PASS.

## Limitations for the reviewer

- Executed results are recorded in the bullet list at the top and in the
  2026-11 journal-rework section; the verdicts table above remains the
  original BLOCKED-era expectations. Any unexpected result must be reported
  UNKNOWN/FAIL, and a failed cleanup voids PASS.
- The cron negative proves silence for *this* mod set only; unknown mods can
  add jobs (hashes recorded, not a general guarantee).
- env expiry is proven for the enumerated keys and this storage version;
  `ttl == -1` alone remains ambiguous by design (db.js:618).
- restart-probe kills only the runner; main/processor loss and kill *during*
  an in-flight step are separate cases.
- Long holds >60s, repeated restart cycles, and CPU under a loaded world are
  unmeasured.
- A parallel worker may run another instance concurrently — all probes use
  dedicated ports and their own run dirs; CPU numbers are still subject to
  host noise.
